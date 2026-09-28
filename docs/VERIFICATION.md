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

## 4. 已知边界（非缺陷）

- REPL 会话状态驻留插件内存，重启即清空（论文的"记忆即状态"不引入外部存储）；
- JAZ 模式下 agent 无法调用 `write`/`bash` 等 —— 这是论文"无外部系统"的刻意设定，需要时用 `allow` 放行；
- 预算按 invoke **调用次数**计（`SubagentResult` 不携带 token 计量），单 cell 另有 PTC 墙钟上限。
