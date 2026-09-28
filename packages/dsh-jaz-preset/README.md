# @local/dsh-jaz-preset

**JAZ presets** for the DeepSeek Harness — [arXiv:2609.26891](https://arxiv.org/abs/2609.26891) *Harness as a Language* 的两种读法，做成**新会话可直接选择的 preset**。

## 两个 preset

| preset id | 名字 | 内容 | 用途 |
|---|---|---|---|
| `jaz` | **JAZ** | JAZ 协议 persona + **随 DSH 一起发的 base 工具** + `jaz` | **日常推荐**：JAZ 风格（写 cell + `invoke` 递归委托），同时照常拥有 read/write/edit/glob/grep/bash/jobs/web_search/web_fetch/todo/skill/present/compaction/subagent/workflow |
| `jaz-minimal` | **JAZ (minimal)** | 只有 `jaz`（restriction 滤掉继承层工具） | 复现论文的实验设定：prompt-only、无文件系统、无记忆系统 |

两种读法的区别值得说清楚：

- 论文里的 JAZ **故意不给工具**——那是为了证明"最小 harness 就足够"的**实验条件**，不是使用建议；
- 作为**使用中的模式**，JAZ 的价值是"以 `invoke` 为原语写代码、状态即变量"，没有理由为此放弃文件与网络能力。所以 `JAZ` 保留全部 base 工具，并在 persona 里明确分工：**常规文件/终端/网络活走专用工具，`jaz` 用于 LLM 现场决定实现、长程状态、需要在代码里递归 `invoke` 的场景**。

## 安装与使用

```bash
dsh plugin --profile web add /path/to/dsh-jaz/packages/dsh-jaz-preset   # 装包
# 再用 Plugin Manager 启用该 bundle（Web UI 设置→插件，或 Agent 的 plugin_manager 工具）
```

然后**新建会话**，在 preset 选择器里选 `JAZ` 或 `JAZ (minimal)`。已存在的会话不会改变（DSH 规则：会话沿用启动时的插件集）。选择器里没出现就刷新一次页面。

## 前提

- `@local/dsh-jaz-invoke` —— 提供 `jaz` 工具（preset 会挂载它）；
- `@local/dsh-jaz-mode` —— **只有 `JAZ (minimal)` 需要**：以 `registerTools: false` 的方式挂载它，纯粹为了装那条 restriction；
- `ctx.ptcRuntime`（`@deepseek-ai/dsh-ptc-runtime-node`）—— cell 的沙箱执行；
- `ctx.subagents`（`dsh-subagent-spawn-in-process`）—— `invoke` 的子代理实现。

后两者在 DSH 默认 web profile 里都已激活。

## 实现要点（为什么这样写）

1. **工具行从 shipped `standard` 预设原样复制**（含必填 config，如 `agent-instructions.maxBytes`、`tool-fs-search.sampleOverCapGlobResults`、`tool-todo.allowParallelInProgress`）。手写这些行会在挂载时报 `invalid config: $.xxx missing required value` 并让 preset 进入 `BROKEN` 状态——实测踩过，见 [docs/VERIFICATION.md](../../docs/VERIFICATION.md) §7。
2. **`JAZ` 不挂 restriction**：目的就是"什么都有 + JAZ 风格"，不做收窄。
3. **`JAZ (minimal)` 用 restriction-only 的 mode 插件**：restriction 过滤该 agent 继承的工具。注意 DSH 契约：**不过滤本层注册**——直接往每个 agent 注入工具的 bundle（如 agent-team）无法被任何插件隐藏。

## 定制

改 `cordis.patch.yml` 里 `config.plugins` 即可。想给 `JAZ` 加/减工具：从 shipped `standard` 预设复制对应行（保持其 `config`）；想给 `JAZ (minimal)` 放行个别工具：在 `jaz-restrict` 的 `allowTools` 里加名字。
