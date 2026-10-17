# OpenCode 下一阶段：v2 执行闭环的实测线路

日期：2026-10-17。实现版本：Co-Ober 0.2.64。

## 1. 先复核参考仓库

Claudian 本地 `main` 仍停在 `31dd256b` / 2.3.22——`git fetch` 后
`31dd256b..origin/main` 为 0 个提交。参考基线未变，本轮的实测对象是
OpenCode 自身。

上一轮定下的规矩在这里直接生效：Claudian 的
`src/providers/opencode/AGENTS.md:13` 要求"against a real installed
`opencode serve` with an isolated database and **fake LLM**；mock 无法确立原生
注册或调用者身份"。本轮照此执行，并发现 `OPENCODE_SIMULATE` 正是那个
"fake LLM"的入口——它不是伪造模型，而是**网络闸门**。

## 2. 前提：0.2.63 修好了认证，但方言本身也变了

0.2.63 补上认证后，目录读取恢复正常（19 个模型）。但另外三个探针
（turn / stream / fork）仍然对着 1.x 线路说话。以隔离数据库与
`OPENCODE_SIMULATE=1` 启动真实 2.0.32，逐条实测：

| 环节 | 本项目编码（1.x） | 2.0.32 实测 |
| --- | --- | --- |
| prompt body | `{id, prompt:{text}}` | **`{id, text}`**（顶层）。旧形状 → `400 {"_tag":"InvalidRequestError","message":"Missing key at [\"text\"]"}` |
| 生命周期事件 | `session.next.text.delta` / `.ended` | **`session.execution.started`**、`session.inbox.enqueued`、**`session.inbox.delivered`**、`session.step.started`、`session.retry.scheduled` |
| user 行 | `content:[{…}]` | 顶层 `text` |
| 读回信封 | `{data:[…]}` | `{data:[…], cursor:{previous,next}}` |
| interrupt | 204 | 200 |
| 删除会话 | `DELETE /session/{id}?directory=` | **`DELETE /api/session/{id}?directory=` → 204**；旧路由 → **405** |
| fork（旧路由） | 可用 | **405** |
| fork（v2 路由） | HTML 兜底 | **404 JSON** |

**两个后果，都是谎：**

1. 三个探针的 prompt 全部被 400 拒绝 → 落到各自的 `unavailable` →
   面板显示"内核未应答"。**内核应答了**，并给出了精确原因。
2. fork 探针的清理仍打旧删除路由 → 405 被 `catch {}` 吞掉 →
   一次性会话**静默留在** OpenCode 历史里。

差距分析第 3 节当初记下 Claudian 的 prompt 是 `{id, text, files?}`，与本次
实测一致；0.2.55 记下本项目实测的是嵌套 `{id, prompt:{text}}`。两条记录都是
真的，只是不同时代。

## 3. 本轮落地的边界

### stage A — 执行闭环探针（`OpencodeV2SliceProbe`）

一条有界的纵向路径：创建 → 提示词 → 执行开始 → steer 投递 → 读回 →
中断 → **在存在的路由上删除**。状态保持三个互不合并的桶：

- `unavailable` —— 准备阶段失败；内核对"能否执行"一言未发；
- `admitted` —— 内核接收了提示词并**开始了执行**，但窗口内没读回回答；
  执行通道可用，**回答未确认**；
- `answered` —— 真的在 transcript 上读到了非空 assistant 文本 part。

三个生命周期事实（`enqueued` / `delivered` / `started`）**分别**呈现，
因为它们不是同一件事：只进队（enqueued）而未投递（delivered）的 steer
**没有被本轮消费**，这正是 Claudian 等待 `session.inbox.delivered` 的原因。

**本探针不声称什么**：不声称见过成功回答。产出真实回答需要可用的 provider
凭据，本机在 `OPENCODE_SIMULATE=1` 下观测到的终态是**具名的传输失败**
（`session.retry.scheduled` 携带 `provider.transport` 错误），不是 assistant
文本。因此 `answered` 这一桶在本次发布中**未被观测到**，它被保留为独立桶
正是为了让将来有凭据的一轮能填上它，而不会与 `admitted` 合并。

### 过程中被自己的字段抓出来的 bug

`leftover` 字段最初在 `finally` 里计算——而返回值早已定型，这个字段
**永远到不了读者面前**，属于装饰品。改为在返回前完成清理并并入读数后，
它立刻暴露了第二个问题：`response.json()` 在 **204 无正文**上抛异常，于是
探针会声称"留下了会话"，而它其实刚刚删掉了它——**同一个谎，指向反方向**。
两处都已修正，`parseOpencodeServeBody` 为此单独成为可测的纯函数。

## 4. 回归与实测证据

用已发布代码对真实内核复测：

```text
turn probe (1.x body)   -> {"status":"unsupported"}
slice probe (measured)  -> {"status":"admitted","enqueued":true,"delivered":true,"started":true,"leftover":false}
```

同一台内核上，旧探针从 `unavailable`（"未应答"）变成 `unsupported`
（"拒绝了本探针的请求形状"），新探针观测到完整闭环并干净清理。

全套：**84 个测试文件、2,466 项通过**；TypeScript 与 ESLint 通过。

**未消耗任何模型回合**：`OPENCODE_SIMULATE=1` 阻断了出站请求，产生的
是具名传输失败而非回答；未使用真实凭据。

## 5. 明确延后

- **没有**把聊天改走 HTTP 后端。ACP 仍是聊天后端，闭环探针只是测量。
  差距分析第 7 阶段的开放条件是"工具/权限未覆盖时必须限制后端开放范围"，
  该条件未满足。
- turn / stream / fork 三个 1.x 探针**保留**为 1.x 线路的记录，本轮只给它们
  加上 `unsupported` 这个诚实的桶，没有改写它们的方言。它们的删除清理仍打
  旧路由（405），因此在 v2 上仍可能留下一次性会话——这一点由 fork 探针的
  `unsupported` 读数间接暴露，但清理本身尚未修复，单独一轮处理。
- 未测量 `session.execution.succeeded/failed/interrupted`：模拟闸门让运行
  停在重试阶段，终态事件从未出现。这仍是未知项。

## 6. 下一阶段

可以开始评估把闭环探针的实测线路接成一条**受限**的执行路径，但必须先
解决：真实凭据下的 `answered` 读数、终态事件命名、以及工具/权限未覆盖时
的后端开放范围。仍不能因为"现在是 v2"就把探针成功写成能力可用。
