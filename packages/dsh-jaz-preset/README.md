# @local/dsh-jaz-preset

**JAZ agent preset** for the DeepSeek Harness — [arXiv:2609.26891](https://arxiv.org/abs/2609.26891) *Harness as a Language* 的最小 harness，做成**新会话可直接选择的 preset**。

## 它是什么

DSH 的"模式"在新会话这一层就是 **agent preset**（Web UI 新建会话时选）。这个 preset 只挂两样东西：

| 行 | 包 | 作用 |
|---|---|---|
| `persona` | `@deepseek-ai/dsh-persona` | JAZ 协议：写 cell、`invoke` 原语、状态存变量、历史够长就尾递归委托 |
| `jaz-invoke` | `@local/dsh-jaz-invoke` | `jaz` 工具本身（`invoke` + 持久 REPL） |

因此选中 `JAZ` 的会话里**没有** shell、文件系统、网络、subagent/委派、compaction、skill 等工具 —— 对应论文的 prompt-only 设定："no manually designed tools, harness, or external systems (e.g., memory or the file system)"。

> **真实工具面的诚实说明**：本 preset 自己只贡献 `jaz`，并挂一个"只装 restriction"的 `@local/dsh-jaz-mode` 把**继承层**的工具（含 host 级 `jaz_mode`/`jaz_agent`）滤掉。但 DSH 的注册表契约规定 restriction **不过滤本层注册**，因此若 profile 里还启用了"按 agent 注入工具"的 bundle（例如 `@deepseek-ai/dsh-experimental-agent-team-profile` 的 `spawn_teammate`/`send_message`/`team_task_*`），这些工具仍会出现在 JAZ 会话里。要得到**严格只有 `jaz` 一个工具**的会话，请在 Plugin Manager 里停用这类 bundle。实测数据见 [docs/VERIFICATION.md](../../docs/VERIFICATION.md) 第 6 节（含尝试过的 `isolate: {tools: true}` 方案及其失败原因）。

## 安装与使用

```bash
dsh plugin --profile web add /path/to/dsh-jaz/packages/dsh-jaz-preset   # 装包
# 再用 Plugin Manager 启用该 bundle（Web UI 设置→插件，或 Agent 的 plugin_manager 工具）
```

然后**新建会话**，在 preset 选择器里选 `JAZ`。已存在的会话不会改变（DSH 规则：会话沿用启动时的插件集）。选择器里没出现就刷新一次页面。

## 前提

会话里能用 `jaz` 需要 profile 具备：

- `@local/dsh-jaz-invoke`（提供 `jaz` 工具）—— preset 会挂载它；
- `@local/dsh-jaz-mode`——preset 以 `registerTools: false` 的方式挂载它**只为装 restriction**，所以这个包也必须安装；
- `ctx.ptcRuntime`（`@deepseek-ai/dsh-ptc-runtime-node`）—— cell 的沙箱执行；
- `ctx.subagents`（`dsh-subagent-spawn-in-process`）—— `invoke` 的子代理实现。

后两者在 DSH 默认 web profile 里都已激活。

## 与其它两个包的关系

| 包 | 什么时候用 |
|---|---|
| **本包（preset）** | 想让**整个新会话**就是 JAZ 模式（最直观，工具面最干净） |
| `@local/dsh-jaz-mode` | 想**按需**开启：`jaz_agent` 跑 JAZ 子代理，或 `jaz_mode enter/exit` 运行时切换当前会话 |
| `@local/dsh-jaz-invoke` | 只需要 `invoke` 原语与持久 REPL（普通会话里作为工具使用） |

## 定制

改这个 preset 就是改 `cordis.patch.yml` 里的 `config.plugins` 列表——例如想在 JAZ 会话里保留文件读取：

```yaml
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
```

或换一套人格/协议文本（`persona.config.prefix`）。改完后重装 bundle，并**开新会话**验证。
