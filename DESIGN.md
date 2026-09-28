# dsh-jaz-invoke 设计文档

> 复刻 arXiv:2609.26891《Harness as a Language》JAZ 框架的两条定义性质到 DeepSeek Harness。
> 状态：**待确认**（确认后进入实现）。

## 0. 论文设计 → DSH 概念映射

| JAZ 概念 | DSH 对应物（已实地核实） |
|---|---|
| Python REPL（代码环境） | `ctx.ptcRuntime` 抽象缝 + `dsh-ptc-runtime-node` 沙箱化 Node 进程后端。程序是 async 函数体，支持顶层 `await`/`return`，完成值必须是无损 JSON |
| `invoke` 语言原语 | PTC **binding**：`PtcBindingNamespace { global: 'jaz', functions: { invoke } }`，宿主函数在每次调用时启动子代理，由 LLM 现场提供"函数实现" |
| LLM 每次调用现场生成函数体 | `ctx.subagents.start(provider, { prompt, parent, signal, outputSchema?, maxDepth? })` → `SubagentRun.result`（一次性子代理，最后一条 assistant 输出即返回值） |
| 记忆即状态（一切皆是变量） | 沙箱程序内的普通 JS 变量 + 插件生成的 **prelude** 注入 `__inputs__` / `__history__` / `__scope__` |
| hooks（约束 + 监控） | 宿主侧 binding 包装：深度上限（映射到 subagent `maxDepth`）、调用预算、trace 记录；插件 Config 承载默认值 |
| 动态作用域 `scope()` | prelude 注入的 `__scope__` 对象，由 `invoke` 包装函数自动合并进每次调用（见 §3.3） |

## 1. 插件形态

- 包名 `@local/dsh-jaz-invoke`，Host-only bundle（无 UI、无构建）：
  - `package.json`（`dsh.bundle.patch` 指向 patch）、`cordis.patch.yml`、`index.js`、`locale/{en,zh}.json`、`icon.svg`
- `index.js` 导出 `apply(ctx, config)` + `export const inject = ['ptcRuntime', 'subagents', 'tools']` + `export const Config`（schemastery）
- 注册**一个模型工具 `jaz`**：`ctx.tools.register(defineTool(...))`，返回 disposer（`ctx.effect` 语义）

### Config（插件级默认，均可被工具参数覆盖）

| 字段 | 默认 | 含义 |
|---|---|---|
| `provider` | `'spawn'` | invoke 使用的 subagent provider 名 |
| `maxDepth` | `4` | invoke 递归深度上限（含顶层 jaz 调用链） |
| `maxInvokes` | `32` | 单次 jaz 运行内 `invoke` 调用总预算（BudgetPool 的计数版） |
| `maxInvokeInputChars` | `24000` | 渲染进子代理 prompt 的输入字符串上限（超出截断并标注） |
| `subagentModel` | 无 | 可选 `agentOptions.model` 覆盖 |

## 2. `invoke` binding 接口

### 2.1 程序内签名（模型可见，写在工具 description 与 prelude 里）

```ts
// prelude 注入后，程序中可直接使用：
async function invoke(
  inputs: Record<string, any>,          // 任意命名输入：prompt、数据、"工具描述"一视同仁（JAZ 定义性质 1）
  opts?: {
    schema?: object;                    // 结构化返回（JSON Schema 子集，直通 subagent outputSchema）
    provider?: string; model?: string;  // 路由覆盖
    scope?: Record<string, any>;        // 本调用级动态作用域，并入子代理可见输入
  }
): Promise<any>                         // 子代理最终输出（schema 存在时为 structured，否则为 text）

const __inputs__: Record<string, any>   // 顶层 jaz 调用的全部命名输入（JAZ 定义性质 2：prompt 也是变量）
const __history__: Array<{seq, inputs, output?, error?, ms, depth}>  // REPL 历史变量：本运行内每次 invoke 的完整记录
const __scope__: Record<string, any>    // 动态作用域变量（程序可写，写后影响后续所有 invoke）
```

### 2.2 宿主函数签名（binding 实际实现）

```ts
// PtcBindingFunction: (args: unknown) => Promise<PtcJsonValue>
jaz.invoke({
  inputs: Record<string, PtcJsonValue>,
  opts?: { schema?, provider?, model?, scope? },
  meta: { depth: number }               // 由 prelude 包装函数维护的客人侧深度计数
}) -> Promise<{
  ok: boolean,
  output?: PtcJsonValue,                // { kind: 'text', text } | { kind: 'structured', value }
  stopReason: string,
  childId: string,
  error?: string                        // 预算/深度拒绝也走 typed error class
}>
```

宿主侧行为：
1. 检查预算计数（`maxInvokes`）与深度（`meta.depth ≤ maxDepth`），超限 → 抛出带 `JazInvokeError` 错误类的拒绝（PTC `errorClass` 机制，程序内可 `catch` 并读取成员名）；
2. 将 `inputs`（合并 `__scope__` 快照）渲染为**紧凑字符串表示**（JSON，超 `maxInvokeInputChars` 截断并标注 `[truncated]`），套入 prompt 模板：

   > You are the runtime implementation of a function call `invoke(...)`. The caller passed the named inputs below. Treat them uniformly — some are data, some are specification. Produce the return value of this call. {{schema 指令}}

3. `ctx.subagents.start(provider, { prompt, parent, signal, outputSchema?, maxDepth: 剩余深度配额, agentOptions? })`；
4. `await run.result` → 取 `structured ?? output text`；记录 trace；`dispose()`；
5. 返回 JSON 结果。非 `completed` 的 `stopReason` 不抛错、原样返回（程序可自检），与 PTC"程序失败是结果字段"哲学一致。

### 2.3 递归的调用栈表示

- **代码内递归**：模型写的程序里 `invoke` 出现在自身由 invoke 触发的子代理再调 `jaz` 工具时，递归体现为 **subagent 委托树**——DSH 原生就有 `subagent/start` / `subagent/end` 事件对、`delegationDepthOf` 与 `maxDepth`，直接复用；
- **运行内调用栈**：prelude 包装函数维护客人侧 `depth` 计数（每次 `invoke` 内若程序再嵌套调用——实际是顺序的——深度体现在 subagent 树的 delegation depth 上）；宿主侧 trace 记录 `{seq, parentSeq, depth, childId}` 形成调用树，`parent` 指针由 subagent 缝的 lineage 天然提供；
- **尾递归委托模式**（论文长程记忆的关键 pattern）：程序在"上下文将满"时执行
  `return invoke({ task: __inputs__.task, prev_history: __history__, prev_progress_summary: ..., next_steps: ... })`
  ——历史以 JSON 值无损传入子代理，这在我们的 binding 边界上**天然支持**（PTC 要求无损 JSON，历史本来就是 JSON）。

## 3. 记忆即状态（"代码即上下文"）

### 3.1 变量注入与命名规则

- `__inputs__` / `__history__` / `__scope__` 三个 dunder 名为插件保留（PTC 保留全局集合不覆盖这些，由 prelude 以 `const` 声明，占用即约定）；
- 程序内模型自建变量任意命名，生命周期 = 本次 jaz 运行（见 §3.2 取舍）；
- `__history__` 由 prelude 的 `invoke` 包装函数在每次调用返回后 `push` 完整记录（输入+输出+耗时+深度）——**历史是普通数组变量**，程序可以 `__history__.filter(...)`、切片、传入下一次 invoke，这就是论文相对 smolagents/RLM 的核心差异点。

### 3.2 作用域规则

- 顶层 jaz 调用的工具参数 `inputs` → `__inputs__`（性质 2 的前半：prompt 是变量）；
- `__scope__` 实现 JAZ 动态作用域：`invoke` 包装函数每次调用前把 `__scope__` 的**快照**合并进 inputs（程序先写 `__scope__.web_search_spec = ...` 再 `invoke(...)`，该子代理即自动可见）；
- 子代理内部再调 `jaz` 时，拿到的是自己的 `__inputs__`（= 父调用渲染的 inputs），`__history__` 从新运行重新开始——与论文中子 invoke 收到显式传入的 `prev_history` 语义一致（历史靠显式传参跨边界，同论文代码示例）。

### 3.3 跨调用持久化：REPL session（v1 特性，按确认意见从 v2 提前）

JAZ 的 REPL 跨单元持久；PTC 运行相互隔离（缝的契约）。桥接方案：**宿主侧 session store + prelude/postlude 环境重注入**，使 `jaz` 工具的多次调用构成一个真正的 REPL：

- 工具参数新增 `session?: string`（持久会话名）与 `reset?: boolean`（清空重来）；省略 `session` 则等价单次无状态运行（同一代码路径，store 用完即弃）；
- store 内容：`{ env: Record<string,Json>, history: [], scope: {}, invokes: number }`，按 `<调用方Agent会话id>:<session名>` 键控，插件内存驻留；
- **prelude 恢复**：把 `env` 逐键写回 `globalThis`；**postlude 收割**：枚举 `globalThis` 固有键差集，JSON 序列化后作为新 `env` 返回宿主（不可序列化的键列入 `skippedVars` 并警告）；
- **持久化命名规则**（写进工具 description）：cell 内**不带声明的裸赋值**（`facts = []`，sloppy 模式落 `globalThis`）或 `globalThis.x = ...` 的变量跨 cell 存活；`let/const/var` 声明的是 cell 局部变量。保留名 `invoke`/`__inputs__`/`__history__`/`__scope__` 及 `__jaz*` 前缀不参与收割；
- cell 执行方式：prelude 用 `new AsyncFunction(cellSource)` 包裹——顶层 `await`/`return` 可用，裸赋值落全局，语义等价 JAZ 的 REPL cell；
- `__history__` / `__scope__` 也随 store 持久（history 追加、scope 可变），`maxInvokes` 预算在命名 session 内**累计**（对应 JAZ scoped BudgetPool）。

## 4. 约束与监控 hooks（对应论文 §3 Hooks / Appendix B）

| JAZ hook | 本插件实现 |
|---|---|
| `RecursionLimit` | Config `maxDepth` → 客人侧计数 + subagent `maxDepth` 双保险 |
| `BudgetPool` / `IterationLimit` | Config `maxInvokes`：宿主侧计数，超限抛 `JazInvokeError('invoke')`，程序可 catch 做收尾（对应论文 BudgetForcing 的优雅降级空间） |
| `TrajectoryRecorder` | 宿主侧 trace：每次 invoke 记 `{seq, depth, inputsDigest(前200字符), outputDigest, stopReason, ms, childId}`；工具结果返回完整 trace，并随 `logs` 输出 |
| `PrintLogger`/`FileLogger` | PTC `logs`（console 捕获）+ trace；不另写文件（demo 要求不借助文件系统） |
| `ReturnType` / `ValidateReturn` | `opts.schema` 直通 subagent `outputSchema`（provider 侧校验），v1 不做宿主侧重试循环 |
| `ContextWindowWarning` | v1 不实现（DSH 子代理上下文由宿主管理；论文中它也是提示性 hook） |

Trace 还通过既有 `subagent/start`/`subagent/end` 事件天然进入 DSH 会话轨迹（GUI 可见子代理树），监控不自造轮子。

## 5. 与 `workflow` 工具的分工

| | `workflow` | `jaz` |
|---|---|---|
| 脚本性质 | 程序员（主代理）写死的**确定性编排**：`agent()`/pipeline/parallel 扇出 | **生成式递归**：每次 invoke 的函数体由 LLM 运行时现场决定 |
| 子代理语义 | 同质批量工人（map-reduce、多路调研） | 异质递归委托：子代理拿到的"规格"本身就是变量，可再委托 |
| 状态 | 无跨调用状态（一次性脚本） | `__history__`/`__scope__`/普通变量构成"记忆即状态"，支持尾递归委托跨越上下文窗口 |
| 典型场景 | 100 个文件的审计、多角度研究 | 长程记忆任务、持续自我改进、需要"想起 10 层之前细节"的工作流 |

二者**不是替代关系**：workflow 是"写好的乐谱"，jaz 是"会自己写谱的指挥"。jaz 程序内部也允许（但 v1 不注入）workflow 式扇出——扇出请直接用 workflow。

## 6. 端到端 demo 设计（长程记忆，不用文件系统）

**任务**：模拟"记忆宫殿"——同一个命名 session（如 `memo-palace`）的两个 cell 完成 12 轮信息摄入 + 跨程回忆：

- **cell 1**（第一次工具调用）：循环 12 次 `invoke({ round: i, instruction: '生成一个包含人名/数字/地点的事实' })`，事实存入裸赋值变量 `facts = [...]`；中途一次 `invoke({ task: '阶段性小结', facts })`；`return facts.length`；
- **cell 2**（第二次工具调用，同 session）：直接读取上一 cell 的 `facts`（验证跨调用持久化，不重新声明）；执行尾递归委托 `invoke({ task: '回忆并回答', prev_history: __history__, facts, questions: [...第2/7/11轮细节...] })`——回答者只能通过传入变量回忆，无任何文件/外部记忆；`return answers`。

**验证点**：cell 2 的 `facts` 来自 store 重注入（程序内不打源码字面量）；trace 显示 14 次 invoke 的 seq/耗时/childId；回忆答案正确引用早期轮次细节；全程无文件 I/O（jaz 沙箱程序没有任何 fs binding）。

## 7. 与论文的取舍点（预先声明）

1. **子 invoke 的实现粒度**：论文的子 invoke 是"纯 LLM 写代码、在同一 REPL 执行"；我们是完整 tool-using 子代理在独立会话执行。原因：DSH 的 LLM 现场实现通道就是 subagent 缝（自带取消、深度、事件、provider 路由）；裸 LLM 写代码 + 嵌套 PTC 执行列为 v2 可选 `mode: 'raw'`。
2. **REPL 持久性**：已通过 §3.3 的 session store 实现（宿主内存 + prelude/postlude 重注入）。残余取舍：store 驻留插件内存，插件重载/Harness 重启即丢失——这是有意为之（JAZ 的论点是"记忆即状态"而非外置记忆库；且 cell 失败时该次 env/history 变更丢弃，仅保留宿主 trace，避免半截状态污染后续 cell）。
3. **预算单位**：JAZ 用美元；subagent 缝的 `SubagentResult` 不携带 token 计量，v1 预算 = 调用次数 + PTC 墙钟超时。
4. **JSON 边界**：JAZ 可传任意 Python 对象（含函数）；PTC binding 只过无损 JSON——函数型工具输入以"规格描述"替代（论文也说 invoke 不区分输入种类，实际影响小）。
5. **动态作用域**：用 `__scope__` 快照合并模拟 Python context manager 语义；无法做到 JAZ 的"作用域内后续子调用自动可见宿主函数本体"（受上一条 JSON 边界限制）。

## 8. 文件布局（实现位置）

```
~/Code/dsh-plugins/dsh-jaz-invoke/
├── DESIGN.md            # 本文件
├── package.json         # @local/dsh-jaz-invoke, dsh.bundle.patch
├── cordis.patch.yml     # insert 插件行
├── index.js             # apply(ctx, config)：注册 jaz 工具
├── test-mock.mjs        # mock 双缝的端到端回归测试（node test-mock.mjs）
├── locale/en.json, locale/zh.json
└── icon.svg
```

安装：`plugin_manager install_bundle`（target = 上述目录绝对路径）；验证：`cordis_inspect_query` 确认插件行 + 实际调用 `jaz` 工具跑 §6 demo 并展示 trace。

## 9. 实测记录（demo 驱动的修复）

首轮真实 demo（memo-palace，12 事实摄入 + 跨程回忆）暴露两个缺陷，均已修复并有回归测试：

1. **循环引用导致 `invalid-output`**（严重）：cell 把 `prev_history: __history__` 传入 invoke 时，容量内的 `__jazCap` 返回活引用，wrapper push 记录的瞬间形成 `__history__ → record.inputs.prev_history → __history__` 循环，PTC 无损 JSON 校验拒绝完成值。修复：`__jazCap` 容量内返回 `JSON.parse(s)` 深拷贝快照——这也正是 REPL 历史的正确语义（记录当时快照而非活引用）。
2. **失败 cell 的 invoke 从记忆中消失**（语义缺陷）：cell 抛错时 guest 进程内新追加的 `__history__` 条目随进程丢弃，但 token 已花。修复：宿主侧 journal 记录每次 invoke 的完整输入/输出快照，cell 失败时合并回持久 `__history__` 并标 `cellFailed: true`；预算计数本就累计（符合 BudgetPool 语义）。

另注意：**替换已安装 bundle 的代码需要重启 Harness 才能加载新 JS 模块**（`application: restart-required`），新装 bundle 才能 HMR 即时生效——迭代开发时请预留重启。
