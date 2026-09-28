# 实测验证记录 (VERIFICATION)

环境：DeepSeek Harness（profile `web`，Windows/macOS 本机）、`ctx.ptcRuntime` = `dsh-ptc-runtime-node`、`ctx.subagents` provider = `spawn`、模型 deepseek-flash。

## 1. 离线回归测试（mock 两条缝，无需 Harness）

```bash
node test-mock.mjs
```

`test-mock.mjs` mock 掉 `ctx.ptcRuntime`（每个 cell 用独立 `vm` context 执行，模拟 PTC 的进程隔离）与 `ctx.subagents`（返回罐头答案），覆盖：

| 用例 | 断言 | 结果 |
|---|---|---|
| cell 1：3 次事实生成 + 1 次汇总 | 返回 `count=3`，trace 4 条 | ✅ |
| cell 2（同 session，不 reset） | `facts`/`summary`/`__scope__`/`__history__` 全部跨 cell 存活 | ✅ |
| 预算熔断 | 第 33 次 invoke 抛 `JazInvokeError`，catch 后正常收尾（n=32） | ✅ |
| `prev_history: __history__` 自引用 | 不产生循环引用，cell 正常完成 | ✅ |
| 失败 cell 的 journal | cell 抛错后历史 +1 且带 `cellFailed: true` | ✅ |

## 2. 真实 Harness 端到端

### 2.1 `jaz` 工具（会话 "usage-demo"）

| 步骤 | 观测 |
|---|---|
| cell 1（`reset: true`） | 3 次事实生成 + 1 次汇总 invoke → `count=3`；trace 4 条（1750/1347/1878/1837 ms，全部 `completed`）；第 4 次调用传 `prev_history: __history__` 不再触发 `invalid-output`（循环引用修复确认） |
| cell 2（同 session） | 直接读到上一 cell 的 `facts`（未重新声明）；1 次 invoke 回忆起第 2 个城市；`historyBeforeThisCell=4`（历史跨 cell 累积） |

### 2.2 `jaz_agent`（JAZ 模式子代理）

子代理工具表被 `toolFilter` 收窄到只有 `jaz`，任务「算 17×23 与 9+10」→ 返回 `{"product": 391, "sum": 19}`，正确；`stopReason=completed`，并在会话轨迹里生成子代理记录。

### 2.3 `jaz_mode`（运行时进入/退出 JAZ 模式）

由第三方子代理独立执行并观测（不是引用工具返回文本，而是看自己下一步的真实工具表）：

| 步骤 | 观测 | 结论 |
|---|---|---|
| `enter` 后下一步 | 只剩 `jaz`/`jaz_mode`；`read`/`write`/`bash`/`glob`/`grep`/`web_search`/`subagent` 全部消失；系统提示被替换成 JAZ 协议段；技能目录清空 | ✅ 收窄真实生效 |
| JAZ 模式下工作 | 2 次 `invoke` 均 `completed`（42 / 64） | ✅ 仍可工作 |
| `exit` 后下一步 | 全部工具与技能目录恢复 | ✅ 退出真实恢复 |
| 白名单精确性 | 直接调用未被允许的 `jaz_agent` → `Error: unknown tool "jaz_agent"` | ✅ 白名单精确（此前"jaz_agent 越过白名单"的观察是显示字段误导） |

## 3. 已修复的问题（均由上述实测暴露）

| # | 问题 | 修复 |
|---|---|---|
| 1 | 容量内的 `__jazCap` 返回活引用 → `prev_history: __history__` 形成循环引用 → PTC 报 `invalid-output` | 改为返回 `JSON.parse(s)` 深拷贝快照（同时符合 REPL 历史"记录当时快照"的语义） |
| 2 | 失败 cell 的 invoke 从记忆中消失（token 已花） | 宿主侧 journal 在 cell 失败时合并回持久 `__history__`，标 `cellFailed: true` |
| 3 | `jaz_mode` 的 `visible now` 传错 scope 键（`ScopeKey` 是 **agent 对象**，不是 session id）→ 状态误报全部工具消失 | 改为 `ctx.tools.schemas(agent)`（**需重启 Harness 加载**） |
| 4 | `allow: ["bash"]` 被误判为未知工具（shipped 工具挂在 agent plane，全局视图看不到） | allow 解析改用 `ctx.tools.get(name, agent)`（**需重启加载**） |
| 5 | 部署级 `mode: "jaz"` 的 restrict 失败会中断插件加载 | 加 try/catch + 可操作告警（**需重启加载**） |

> 问题 3–5 的修复已写入代码；由于"替换已安装 bundle 需要重启才能加载新的 JS 模块生成"（`application: restart-required`），需重启 Harness 后在 `jaz_mode status` 中确认。

## 4. 真实用户会话复现（《寻找 dsh 工作区相关插件》）与根因修复

用户在一个普通会话里让 agent 用 `jaz` 做 DSH 仓库侦察，连撞三次报错。原始证据（会话 `session-406cbc25`，事件 `tool/result`）：

| # | 报错原文 | 触发点 |
|---|---|---|
| 1 | `invalid-output: program completion must be lossless JSON` | cell 执行了 `globalThis.__fs = fs`（`fs` 是 `node:fs` 模块命名空间） |
| 2 | （同一会话后续）`exception: TypeError: fs.readdirSync is not a function` | 下一格读 `globalThis.fs`，拿到的是被 JSON 往返**掏空**的普通对象 |
| 3 | `invalid-output`（无定位信息） | 任何非无损 JSON 的完成值 |

**根因（本插件的 bug）**：postlude 的"环境收割"把**任意** `globalThis` 新增变量用 `JSON.parse(JSON.stringify(v))` 持久化——

- 遇到模块命名空间/类实例这类非 JSON 值时，错误进入 `__env`，使整个完成值被 PTC 拒绝 → 报错 1；
- 侥幸能 `JSON.stringify` 的值（函数被丢掉）被静默存成普通对象 → 下一格 `fs.readdirSync is not a function`（报错 2）；
- 返回值本身不合法时只有 PTC 的裸 `invalid-output`，没有路径信息（报错 3）。

**修复**

1. guest 侧新增 `__jazWhy(value, path)`：按 PTC 同一套规则（普通对象/稠密数组/有限数/circular/symbol/class 实例）判定"无损 JSON 数据"；**不是就跳过并记录带路径与原因的理由**，绝不再做会掏空值的 JSON 往返。
2. 返回值单独判定：不合法时返回 `resultIssue`，宿主渲染成可操作错误（含出错路径与修复建议），而不是 `invalid-output`。
3. 结果渲染新增 `## not persisted` 段落，明确"这些变量在下一格不存在，请在需要它的那一格里重新创建"。
4. 工具描述补充：只有无损 JSON 数据会跨格；沙箱内的文件侦察应改用 `read`/`glob`/`grep`/`bash`。

**修复前后的实测对比**（在独立镜像 profile 上逐条重放原场景：`dsh --profile jazcheck web` 换端口 3099 + 临时 profile，完全不触碰正在使用的 GUI profile）：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| A. `globalThis.__fs = fs`（模块命名空间） | 整轮失败 `invalid-output`，`result=null` | ✅ 成功返回结果；`## not persisted` 列出 `__fs.Dir: function is not JSON data`，`__root` 正常持久 |
| B. 下一格读 `__fs` | 掏空成对象 → `fs.readdirSync is not a function` | ✅ `typeof __fs === 'undefined'`（诚实），并附"未持久化"说明 |
| C. 返回 `{ when: new Date() }` | 裸 `invalid-output` | ✅ `the cell's return value is not lossless JSON — return value.when: only plain objects and arrays are JSON data (this is a class instance or module namespace)` |
| D. 纯 JSON 变量跨格 | 正常 | ✅ 仍正常（回归） |

## 5. JAZ preset 的真实链路验证

用独立镜像 profile（`dsh-base` + `dsh-web-app` + 两个 @local bundle，webserver 换到 3099）走 GUI 同一条会话命令路径：

| 检查 | 结果 |
|---|---|
| `agentPresets.list()` | `jaz` 出现在名册，**无 `broken` 诊断**（`standard/ptc/minimal/cordis/jaz`） |
| `sessionController.create({agentPreset:'jaz'})` | ✅ 返回 `{sessionId, agentPreset:"jaz"}` |
| 该会话可见工具（`ctx.tools.schemas(agent)`） | ✅ **恰好只有 `jaz`** —— shell/文件/网络/委派/compaction 全部不在 |
| 驱动一轮真实对话（DeepSeek） | ✅ 模型调用 `jaz`，cell 返回 42；`turn/end reason=completed` |
| cell 内 `invoke`（论文核心原语） | ✅ 2 次并行 invoke 均 `completed`（42 / 19），trace 正常 |

## 6. 全 profile 镜像下的 preset 复验（发现"本层注册"限制）

把镜像 profile 的 bundle 列表调成与真实 GUI profile **完全一致**（`dsh-base` + `dsh-web-app` + `dsh-experimental-agent-team-profile` + `dsh-experimental-auto-review` + `@local/dsh-jaz-invoke` + `@local/dsh-jaz-mode` + `@local/prompt-manager` + `@local/dsh-jaz-preset`）后重测：

| 阶段 | 该 JAZ 预设会话可见工具 | 结论 |
|---|---|---|
| 初版 preset | `jaz_mode, jaz_agent, jaz, spawn_teammate, send_message, list_agents, wait_agent, interrupt_agent, team_task_create/list/get/update`（12 个） | 全局注册的工具会漏进任何 preset |
| preset 挂 restriction-only 的 mode 插件（`registerTools:false`） | `jaz, spawn_teammate, send_message, list_agents, wait_agent, interrupt_agent, team_task_*`（7 个） | `jaz_mode`/`jaz_agent` 已滤除 |
| 同上 + 白名单不再保留 `jaz_mode` | 同上（7 个） | ✅ 当前发布状态 |

**根因（DSH 注册表契约，不是本插件缺陷）**：`ToolRuntime.restrict` 只过滤**该 scope 继承**的工具（全局层 + 祖先层），**永不过滤本层注册**。实测证据：

- 在带 agent-team 的会话里执行 `jaz_mode enter`（restriction 装进 agent 本层）→ `read/write/bash/glob/grep/web_search/job_*/skill/ask_user_question/...` 全部消失，但 `spawn_teammate/send_message/list_agents/wait_agent/interrupt_agent/team_task_*` 与 `subagent` **仍在** —— 这些是插件直接注册进 agent 本层的；
- 子代理的 `toolFilter: { allow: ['jaz'] }` 同样滤不掉它们（实测 child 的 `ctx.tools.schemas` 仍含这些名字）。

**尝试过的解法（不可行）**：给 preset 加 `isolate: { tools: true }` 让 preset 拥有自己的工具注册表 → 预设挂载直接失败：

```
RemoteError: jaz-invoke (@local/dsh-jaz-invoke): waiting for tools
jaz-restrict (@local/dsh-jaz-mode): waiting for tools
```

被隔离的组内没有提供 `tools` 服务的插件，所以该组永远等不到依赖，会话创建失败。已回滚。

**结论**：插件侧能做到的极限是"滤除继承层工具"；要得到**严格只有 `jaz` 一个工具**的会话，需要在这个 profile 里停用那些"按 agent 注入工具"的 bundle（如 `@deepseek-ai/dsh-experimental-agent-team-profile`，在 Plugin Manager 里关掉即可）。这不是 JAZ 插件能单方面决定的——它属于 profile 的组合选择。

## 7. 已知边界（非缺陷）

- REPL 会话状态驻留插件内存，重启即清空（论文的"记忆即状态"不引入外部存储）；
- JAZ 模式下 agent 无法调用 `write`/`bash` 等 —— 这是论文"无外部系统"的刻意设定，需要时用 `allow` 放行；
- 预算按 invoke **调用次数**计（`SubagentResult` 不携带 token 计量），单 cell 另有 PTC 墙钟上限。
