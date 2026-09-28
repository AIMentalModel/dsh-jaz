# @local/dsh-jaz-mode

JAZ 模式 for the DeepSeek Harness — after [arXiv:2609.26891](https://arxiv.org/abs/2609.26891) *Harness as a Language*.

论文的 harness 只有一条原语 `invoke`：模型写代码、代码里递归调用 `invoke`、一切都是变量。本包把这种"最小 harness"做成 DSH 里可开关的**模式**。

依赖 [`@local/dsh-jaz-invoke`](../..) 提供 `jaz` 工具（`invoke` 原语与持久 REPL 都在那一侧）。

## 提供的两件东西

### 1. `jaz_agent` — 跑一个 JAZ 模式子代理

```
jaz_agent({ task: "...", session?: "...", model?: "..." })
```

- `toolFilter: { allow: ['jaz'] }` → 子代理的工具表只有 `jaz`，**没有**文件系统、bash、web、记忆系统；
- 子代理的系统提示装入 JAZ 协议（persona）：写 cell、`invoke` 是运行时由 LLM 提供的函数、状态存变量、历史够长就尾递归委托剩余工作；
- 子代理返回的文本即工具结果，同时在 DSH 会话轨迹里生成一条子代理记录。

### 2. `jaz_mode` — 把当前 agent 切成 / 切出 JAZ 模式

```
jaz_mode({ action: "status" })
jaz_mode({ action: "enter", allow?: ["bash"] })   // 收窄 + 装入 JAZ 协议提示
jaz_mode({ action: "exit" })                      // 恢复
```

- 通过 `agent.ctx.tools.restrict({ allow })` 与 `agent.ctx.systemPrompt.section(...)` 实现 → **只作用于该 agent**，其他会话不受影响；
- `jaz` 与 `jaz_mode` 始终保留可见，因此随时可以 `exit` 恢复；
- 下一个模型步生效（工具表在每步组装）。

## 配置（`cordis.patch.yml` 的 `config`）

| 字段 | 默认 | 含义 |
|---|---|---|
| `mode` | `native` | `jaz` = 部署级收窄（对齐论文最简 harness）；需重启生效 |
| `allowTools` | `[]` | JAZ 模式下额外保留的全局工具名（如 `["bash","read"]`） |
| `provider` | `spawn` | `jaz_agent` 使用的 subagent provider（需支持 `toolFilter`） |
| `maxDepth` | `2` | 子代理委派深度上限 |
| `model` | 无 | 子代理模型覆盖 |

## 已验证（实测）

| 项目 | 结果 |
|---|---|
| `enter` 后工具表收窄 | ✅ `read`/`write`/`bash`/`glob`/`grep`/`web_search`/`subagent` 全部消失，只剩 `jaz`/`jaz_mode`（技能目录同时清空） |
| `exit` 后恢复 | ✅ 全部工具与技能目录回归 |
| `jaz_agent` 正确性 | ✅ 子代理在只有 `jaz` 的条件下用 `invoke` 算出 17×23=391、9+10=19 |
| JAZ 模式下仍可工作 | ✅ cell 内两次 `invoke` 均 `completed`，trace 正常 |

## 与 PTC 模式的区别

DSH 自带的 `dsh-tools` `mode: 'ptc'` 把模型面收窄成 `run_code`，程序里调用的仍是**已有工具**。JAZ 模式的收窄目标是 `invoke`——那个"实现由 LLM 每次调用时现场提供"的原语。两者可叠加：在 JAZ 模式下你依然可以通过 `allow` 放行 `run_code`（若该模式已启用）。

## 已知边界

- JAZ 模式下的 agent **无法**调用 `write`/`bash` 等（这正是论文的"无外部系统"设定）；需要落地产物时用 `allow` 放行；
- REPL 会话状态驻留在插件内存（重启即清空）；
- `jaz_mode` 的收窄是**运行时状态**，不写入持久配置：会话结束/进程重启后回到部署默认。
