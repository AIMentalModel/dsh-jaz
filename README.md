# dsh-jaz — JAZ 框架的 DeepSeek Harness 实现

> 论文：*Harness as a Language: A Minimalist Agent Framework With Maximal Expressivity*（[arXiv:2609.26891](https://arxiv.org/abs/2609.26891)，MIT CSAIL）
> 复刻 JAZ 的两条定义性质：`invoke` 是"实现由 LLM 在每次调用时提供"的语言原语；一切对 LLM 可见的东西（含 REPL 历史）都是代码环境里的变量。

本仓库包含两个 Harness bundle：

| 包 | 提供 | 说明 |
|---|---|---|
| [`./`](./index.js) · `@local/dsh-jaz-invoke` | `jaz` 工具 + `invoke` 原语 + 持久 REPL | 论文的核心原语与 REPL（[完整手册](#1-一句话理解)见下） |
| [`packages/dsh-jaz-mode/`](./packages/dsh-jaz-mode) · `@local/dsh-jaz-mode` | `jaz_agent`、`jaz_mode`、部署默认 JAZ 模式 | 论文的"最小 harness"：把 agent 收窄成只剩 invoke REPL |

## 快速开始

```bash
git clone https://github.com/AIMentalModel/dsh-jaz.git ~/Code/dsh-plugins/dsh-jaz

# 两个 bundle 都装上（幂等；profile 级生效；target 需绝对路径）
plugin_manager install_bundle  target=$HOME/Code/dsh-plugins/dsh-jaz
plugin_manager install_bundle  target=$HOME/Code/dsh-plugins/dsh-jaz/packages/dsh-jaz-mode
```

需要 `ctx.ptcRuntime`（`@deepseek-ai/dsh-ptc-runtime-node`）与 `ctx.subagents`（`dsh-subagent-spawn-in-process`），DSH 默认 profile 已具备。
包名保留 `@local/` 前缀是刻意的：它们作为本机 profile bundle 安装，不发布到 npm。

## JAZ 模式（`@local/dsh-jaz-mode`）

论文的 harness 只有一条 `invoke` 原语——没有工具列表、没有文件系统、没有记忆系统。本插件把它做成**可运行时开关、按 agent 作用域、可逆**的模式：

### 方式 A：让一个子代理跑 JAZ 模式（零风险，推荐先试）

```
jaz_agent({ task: "把这三篇材料的要点整理成对比表", session: "compare-1" })
```

子代理的工具表被 `toolFilter` 收窄到**只有 `jaz`**，系统提示装入 JAZ 协议（写 cell、用 `invoke`、状态存变量、历史够长就尾递归委托）。它除了写 cell 什么也做不了——这正是论文的"最小 harness"。结果以文本返回，并在 DSH 会话轨迹里生成子代理记录。

### 方式 B：把当前会话切成 JAZ 模式（运行时、可逆）

```
jaz_mode({ action: "enter" })            # 隐藏除 jaz / jaz_mode 之外的全部工具，并装入 JAZ 协议提示
jaz_mode({ action: "enter", allow: ["bash"] })   # 想保留个别工具就加白名单
jaz_mode({ action: "exit" })             # 恢复原工具表
jaz_mode({ action: "status" })           # 查看当前状态
```

收窄是**该 agent 作用域**的（`agent.ctx`），不影响其他会话；下一个模型步生效，退出后恢复。实测：进入后 `read`/`write`/`bash`/`web_search`/`subagent` 全部消失、技能目录清空，退出后全部恢复。

### 方式 C：把 JAZ 模式设为部署默认

```yaml
- insert:
    - id: dsh-jaz-mode
      name: '@local/dsh-jaz-mode'
      config:
        mode: jaz            # 部署级收窄（对齐论文的最简 harness）
        allowTools: []       # 例如 ["bash","read"] 保留少量工具
        provider: spawn
        maxDepth: 2
        model: null
```

部署级配置改动需重启 Harness 生效。

**注意**：JAZ 模式下 agent 只能写 cell，因此它也无法调用 `write`/`bash` 等工具——这是论文"无外部系统"的设计，不是缺陷；需要落地文件时用 `allow: [...]` 放行。

---

# dsh-jaz-invoke 使用手册

> JAZ 风格 `invoke` 语言原语 + 持久代码 REPL，为 DeepSeek Harness 实现。
> 设计与取舍：[DESIGN.md](./DESIGN.md)

## 1. 一句话理解

`jaz` 是**模型可调用的一个工具**：你（LLM）写一段 JS（一个 REPL cell），在沙箱里执行；cell 里可以调用 `invoke({...})`——这是一个**"函数实现由 LLM 在每次调用时现场提供"**的原语（每次调用 = 启动一个子代理，把命名输入渲染成 JSON 给它，子代理的最终回答就是返回值）。

两条定义性质：
1. **可写任意代码、可递归 invoke** —— cell 里能写控制流，子代理自己也能再调 `jaz`，递归委托是默认行为；
2. **一切可见皆是变量** —— `__inputs__`、`__history__`、`__scope__` 以及你写的变量，都是代码环境里的普通 JS 变量（"代码即上下文"，不需要外部记忆库）。

## 2. 工具参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `program` | ✅ | REPL cell：纯 JavaScript（不是 TS），按 async 函数体执行，支持顶层 `await`/`return`；`return` 的 JSON 值即工具结果的 `result` |
| `inputs` | | 本次调用的命名输入，cell 内以 `__inputs__` 访问（prompt 也是变量） |
| `session` | | 命名 REPL 会话。同名 cell 共享持久变量、`__history__`、`__scope__` 与预算计数；省略 = 一次性无状态运行 |
| `reset` | | 先清空该 session（变量/历史/作用域/预算）再执行 |

**cell 内可用全局量**

```js
await invoke(inputs, opts?)   // opts: { schema?, provider?, model?, scope? }
__inputs__                    // 本次工具调用的 inputs
__history__                   // 本 session 内每次 invoke 的记录数组：{seq, ok, ms, stopReason, childId, inputs, output}
__scope__                     // 可变对象；每次 invoke 前会把它合并进该次输入（动态作用域）
```

## 3. 四种典型用法

### 3.1 单次生成（替代一次 subagent 调用）

```js
const idea = await invoke({ task: '给这个插件起 3 个中文名，每个不超过 6 字', tone: '技术向' });
return { idea };
```

### 3.2 扇出 + 汇总（map-reduce 风格）

```js
files = ['a.ts', 'b.ts', 'c.ts'];
reports = [];
for (const f of files) {
  reports.push(await invoke({ task: `审查 ${f} 的边界条件`, file: f }));
}
const merged = await invoke({ task: '把以下审查报告合并成一份清单', reports });
return { merged, count: reports.length };
```

### 3.3 结构化返回（`opts.schema`）

```js
const score = await invoke(
  { text: '这家餐厅环境好但上菜慢，价格偏高。' },
  { schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
        score: { type: 'integer' },
        reasons: { type: 'array', items: { type: 'string' } }
      },
      required: ['sentiment', 'score', 'reasons']
  } }
);
return score;            // 直接是对象，不是字符串
```

### 3.4 长程记忆 / 尾递归委托（论文的核心场景）

上下文快满时，把**整个 REPL 历史按引用传给子代理**，让它接着干——历史是普通变量，可无损传递：

```js
// cell 1：记录
ledger = [];
for (let i = 1; i <= 12; i++) {
  ledger.push({ round: i, fact: await invoke({ round: i, instruction: '虚构一条含人名/数字/地点的事实，一句话' }) });
}
return { count: ledger.length };

// cell 2（同 session）：回忆 + 委托
const answers = await invoke({
  task: '只依据 prev_history 和 ledger 回答以下问题，你没有别的记忆',
  prev_history: __history__,
  ledger,
  questions: ['第 2 轮的事实是什么？', '第 7 轮的是什么？', '第 11 轮的是什么？']
});
return { answers };
```

### 3.5 会话内跨 cell 累计状态

```js
// cell A
notes = [];
notes.push(await invoke({ task: '总结刚才的讨论要点' }));
return notes.length;

// cell B（同 session，notes 仍是那个数组）
const next = await invoke({ task: '基于已有笔记，提出下一步 3 个动作', notes });
notes.push(next);
return { total: notes.length, next };
```

## 4. 持久化规则（重要）

```js
facts = [];                 // ✅ 裸赋值 → 落 globalThis → 跨 cell 存活
globalThis.summary = '...'; // ✅ 显式全局 → 存活
let tmp = 1;                // ❌ cell 局部（const/var 同理），下个 cell 取不到
```

- `__history__` / `__scope__` 与预算计数**随 session 自动持久**；
- 不可 JSON 序列化的变量（函数、Symbol、循环结构）不会持久，会出现在结果的 `skippedVars` 里；
- **cell 抛错时**：该 cell 的变量/作用域变更不落盘（不污染后续），但它**花掉的 invoke 会补记进历史**（标记 `cellFailed: true`）；
- session 存在插件内存里：插件重载 / Harness 重启即清空（有意为之——"记忆即状态"，不引入外部存储）。

## 5. 约束与监控（hooks）

| 机制 | 默认 | 表现 |
|---|---|---|
| 调用预算（BudgetPool） | 每 session 32 次 invoke | 超限时 `invoke` 抛 `JazInvokeError`，**可 catch 优雅收尾** |
| 递归深度（RecursionLimit） | `maxDepth: 4` | 映射到 subagent 委派深度上限，超限的子代理启动被拒绝 |
| 单 cell 墙钟 | 15 分钟 | 由 PTC 运行时执行；超时 kind=`timeout` |
| 调用追踪（TrajectoryRecorder） | 始终开启 | 工具结果里的 `## invoke trace` 表（seq / ms / stopReason / childId / 输入字符数 / 返回类型），另有全局 `subagent/start`·`end` 事件进会话轨迹 |
| 历史条目上限 | 每条 8000 字符 | 超出转成 `{__jazTruncated, chars, preview}`，不会撑爆运行输出 |

预算内优雅降级的写法：

```js
const partial = [];
try {
  for (let i = 0; i < 100; i++) partial.push(await invoke({ i }));
} catch (e) {
  if (e.name !== 'JazInvokeError') throw e;   // 预算/深度类拒绝
}
return { done: partial.length, partial };
```

## 6. 什么时候用 jaz / workflow / subagent

| 场景 | 用什么 |
|---|---|
| 一两次独立委托、要读文件或跑命令 | `subagent` / `subagent_fork` |
| 确定性大规模扇出（审计 N 个文件、多角度调研、pipeline） | `workflow`（写死的编排脚本，同质工人，`parallel`/`pipeline`） |
| **LLM 现场决定递归结构**、需要跨上下文窗口的记忆、自我改进循环 | **`jaz`**（每次 invoke 的实现由 LLM 现场写，状态就是变量） |

一句话：workflow 是"写好的乐谱"，jaz 是"会自己写谱的指挥"。

## 7. 配置与运维

**调整默认值**（provider / maxDepth / maxInvokes / 超时 / 模型）——编辑插件行的 `config`：

```yaml
- insert:
    - id: dsh-jaz-invoke
      name: '@local/dsh-jaz-invoke'
      config:
        provider: spawn        # invoke 子代理使用的 provider（spawn | fork）
        maxDepth: 4            # 递归深度上限
        maxInvokes: 32         # 每 session 的 invoke 预算
        maxInvokeInputChars: 24000   # 单次 invoke 输入渲染上限
        maxHistoryEntryChars: 8000   # 历史条目快照上限
        runTimeoutMs: 900000   # 单 cell 墙钟（毫秒）
        model: null            # 可选：强制子代理模型
```

**安装 / 卸载**

```bash
# 安装（幂等）
plugin_manager install_bundle  target=~/Code/dsh-plugins/dsh-jaz-invoke

# 卸载
plugin_manager remove_bundle   target=@local/dsh-jaz-invoke
```

> 注意：**替换已安装 bundle 的代码需要重启 Harness**（`application: restart-required`）；首次安装才通过 HMR 即时生效。

**本地回归测试**（不需要 Harness，mock 掉 PTC 与 subagent 两条缝）：

```bash
cd ~/Code/dsh-plugins/dsh-jaz-invoke && node test-mock.mjs
# 覆盖：跨 cell 持久化 / __scope__ 动态作用域 / __history__ 累积 /
#       __history__ 自引用传参 / 预算熔断 / 失败 cell 的 journal 合并
```

## 8. 已知边界

- 子代理是**完整 agent**（有工具、独立会话），不是论文里"纯 LLM 写代码在同一 REPL 执行"——因此跨 invoke 边界只能传无损 JSON，函数不能当输入传；
- 变量持久是**插件内存**级，进程重启即失（有意取舍）；
- 预算按**调用次数**而非美元计（subagent 缝不返回 token 计量）；
- `invoke` 是**顺序**的；要并发扇出请用 `workflow` 的 `parallel`，或在 cell 里 `Promise.all([...])`（注意 PTC 绑定的并发限制）。

## 9. 照着论文用（两种 case study 的复刻配方）

论文是 **prompt-only** 的：不给工具、不给文件系统、不给记忆系统，全靠把 `invoke` 当函数 + 把状态当变量。对应到本插件，论文里的"顶层 invoke"由 DSH 主 Agent 承担（它写 cell），"sub-invoke"就是 cell 里的 `invoke()`。

### 9.1 长程记忆（论文 §4.1 StuLife）

论文的提示词要点（Appendix E.1.1）：
- **把 `prev_history` 当"上一任 agent 的 REPL 历史"**，需要回忆时**检索它**，而不是看 `__history__`——论文原话：`prev_history` 与你自己的 `__history__` 不同，`__history__` 已完整可见，检索它无意义；
- 检索规则：用**具体、独特**的检索词；命中时**显示上下文窗口**而不是只给前缀；**这一步只做检索**，把后续工作留给下一轮；
- 上下文将满时（E.1.2）：**把剩余工作全部委托给子代理**，并且 `prev_history + __history__` 都传过去，保证已有工作不丢。

本插件等价写法（`prev_history` 由 session 持久化天然承担）：

```js
// 第一次调用：instructions / guidance 作为变量落进 REPL（论文的 instructions、guidance 变量）
// inputs: {"instructions": "...", "guidance": "..."}
instructions = __inputs__.instructions;
guidance = __inputs__.guidance;
prev_history = [];        // 论文里"上一任的历史"，session 持久
progress = { done: [], summary: '' };
return 'state initialized';

// 后续每次调用：一步工作；判满则按 E.1.2 模板尾递归委托
const step = await invoke({ instructions, guidance, prev_history, progress, next: 'do exactly one step' });
progress.done.push(step);

// 触发条件：历史条目数 / 字符数超阈值（论文 ContextWindowWarning 的等价物）
const heavy = __history__.length > 20 || JSON.stringify(__history__).length > 40000;
if (heavy) {
  const carried = prev_history.concat(__history__);   // 论文：prev_history + __history__ 都传
  prev_history = carried;
  return invoke({
    instructions, guidance,
    prev_history: carried,
    prev_progress_summary: progress.summary,
    next_steps: progress.done.slice(-5)
  });
}
return { steps: progress.done.length, heavy };
```

> 论文里这步写 `return invoke(...)`（尾递归、由 harness 做尾调用优化）。本插件里 `return await invoke(...)` 即是同一件事；跨 cell 时用 `prev_history` 变量接力，效果等价。

### 9.2 持续自我改进（论文 §4.2 AppWorld）

论文方法论（Appendix E.2）：
1. **按批次**解题，一个子代理负责一个任务；
2. 先用 **~5 个任务的种子批次**跑起来并分析结果；
3. 之后**交替**做「prompt/tool 优化」与「下一批验证」，直到任务队列耗尽；
4. prompt 是**主杠杆**；编辑必须是**跨任务通用的模式**，不许针对单个任务的失败形状；
5. 表现好就加大批次、减小改动；几乎全对就**别改**，直接换批验证；
6. 错误信息是有价值的反馈，让工具/子代理该报错就报错；要**观测工具使用率**，不可靠的工具删掉。

本插件等价写法（把 prompt 当被优化的状态变量，`opts.schema` 让改进结果结构化）：

```js
prompt = globalThis.prompt || { text: '你是解题子代理，先规划再用工具执行。', notes: [] };
queue = globalThis.queue || ['t1', 't2', 't3', 't4', 't5'];
batch = queue.slice(0, 3);

const results = [];
for (const t of batch) {
  results.push({ task: t, out: await invoke({ prompt: prompt.text, task: t }) });
}
queue = queue.slice(batch.length);

const improved = await invoke(
  { task: '从这批轨迹中提炼一条跨任务通用的 prompt 改进；不要针对单个任务的失败形状。', prompt: prompt.text, results },
  { schema: { type: 'object', additionalProperties: false,
              properties: { newPrompt: { type: 'string' }, rationale: { type: 'string' } },
              required: ['newPrompt', 'rationale'] } }
);
if (improved && improved.newPrompt) prompt = { text: improved.newPrompt, notes: prompt.notes.concat(improved.rationale) };

return { optimized: prompt.text, remaining: queue.length };
```

### 9.3 hooks 的 local vs scoped（论文 §3）

论文：`with BudgetPool(max_cost=5):` 是 **scoped**（覆盖块内所有调用含递归子调用）；`invoke(ReturnType(float), ...)` 是 **local**（只管这一次）。翻译：

| 论文 | 本插件 |
|---|---|
| `invoke(ReturnType(float), ...)`（local 校验） | 该次调用传 `opts.schema`，只约束这一次 |
| `with BudgetPool(max_cost=5):`（scoped 预算） | 用 `session` —— 预算在该 session 内累计（`maxInvokes`） |
| `with scope(web_search=tool):`（scoped 能力可见） | 写 `__scope__`，自动合并进之后每一次 invoke 的输入 |
| `with ConfigOverride(llm=...):` | 子代理模型：插件 config `model`，或单次 `opts.model` |

论文的成本策略是**顶层用强模型、sub-invoke 用便宜模型**：

```js
const draft = await invoke({ task: '...' }, { model: 'deepseek-flash' });      // 便宜模型批量干
const final = await invoke({ task: '审校并定稿', draft });                      // 默认模型定稿
```

### 9.4 论文有、本插件暂缺的 hook（以及替代）

| 论文 hook | 状态 | 替代做法 |
|---|---|---|
| `ContextWindowWarning` | ❌ 未实现 | cell 内自测 `__history__` 体量并触发 §9.1 的委托分支 |
| `BudgetForcing`（强制收尾） | ❌ | `try { ... } catch (e) { if (e.name === 'JazInvokeError') return 收尾结果 }` |
| `TrajectoryReplay`（可重放） | ❌ | `session` + `__history__` 已保存全部输入输出，足以自行重放，未提供 replay driver |
| `ValidateREPLCode`（校验 cell） | ❌ | 无（PTC 沙箱本身是隔离边界） |
| `PrintLogger` / `FileLogger` | ✅ 部分 | PTC `logs` + 结果里的 trace 表（不写文件，符合论文"无外部系统"） |
| `TrajectoryRecorder` | ✅ | trace 表 + `subagent/start`·`end` 会话事件 |
