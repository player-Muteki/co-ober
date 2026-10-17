# OpenCode 下一阶段：终态词汇补全与探针会话清理

日期：2026-10-17。实现版本：Co-Ober 0.2.67。

## 1. 参考仓库

Claudian `main` 仍为 `31dd256b` / 2.3.22。

## 2. 补全最后一个未测的终态名

0.2.66 明确记录了仍然未知的项：**`session.execution.failed` 这个事件名本身**
从未被观测到，因为 500 场景下内核一直在重试，探针窗口内走不到终点。

先读源码确认这条路径能否走完：`packages/core/src/session/runner/retry.ts` 写明
重试计划是**硬编码**的，没有配置项：

> Exponential from 2s capped at 10s per gap, for 10 retries: 2, 4, 8, then 10 × 7,
> about 84s of waiting when every attempt fails (67–101s with jitter).

所以它不是"配不出来"，而是**固定要熬约 84–101 秒**。这对一个设置页按钮不可接受，
但作为**一次性测量**完全可行。于是把观察窗口拉到 170 秒跑了一次：

```
session.step.started      ×11
session.retry.scheduled   ×10
session.step.failed       {error: {type:"provider.internal", message:"always refused", status:500}}
session.execution.failed  {sessionID, error:{type:"provider.internal", ...}}   ← 补上了
transcript: idle 行 outcome = "failed" + error 字段
           assistant 行 finish = "error" + error 字段
```

**三个终态事件名至此全部实测完毕**：

| 事件 | 载荷 | idle `outcome` |
| --- | --- | --- |
| `session.execution.succeeded` | `{sessionID}` | `succeeded` |
| `session.execution.failed` | `{sessionID, error}` | `failed` |
| `session.execution.interrupted` | `{sessionID, reason}` | `interrupted` |

并且它们**携带的字段不同**：成功不带什么，失败带 `error`，中断带 `reason`。
reducer 因此改为"存在哪个读哪个"，而不是假定某一种形状。

## 3. 另一处同类泄漏：turn 与 stream 探针

0.2.66 修好了 fork 探针的清理，但只修了那一个。回头核对发现**另外两个探针
更糟**：它们根本**只 interrupt、不 delete**，所以每跑一次就把一次性会话留在
内核历史里，而且面板上没有任何提示。

也就是说 0.2.64 和 0.2.65 两次写下"遗留项"时，都只盯着 fork 探针，漏掉了
范围更大的一半。

修法上，三个探针需要同一段"按本世代路由删除"的逻辑，因此没有第三次复制粘贴，
而是抽成 `OpencodeServeSession.deleteOpencodeServeSession`：2.x 路由优先、
1.x 路由兜底，404/405 视为"此路由不存在"继续尝试，而 5xx 或连接失败**不**被
当成"路由缺失"而走过场——"服务器拒绝删除"与"这台服务器没有这个路由"会把读者
引向不同的地方。

turn / stream / fork 三个读数都带上 `leftover`，设置页各有对应文案。

## 4. 实测验证

失败路径（fake provider 恒返回 500，探针窗口 6 秒）：

```json
{"status":"failed","enqueued":true,"delivered":true,"started":true,"streamed":false,
 "confirmed":false,"modelId":"fakeprov/fake-model","errorType":"provider.internal",
 "errorMessage":"always refused","retries":3,"leftover":false}
```

**在 6 秒内**给出具名失败，而不是熬过约 84 秒的重试预算——这正是 0.2.66 写下
的设计意图，现在对真实内核复核通过。`leftover: false` 说明清理也走了存在的路由。

## 5. 回归

全套：**85 个测试文件、2,494 项通过**（基线 2485/84）；TypeScript 与 ESLint 通过。
未消耗真实模型回合，未使用真实凭据。

## 6. 仍未解决

- **重试预算是硬编码的**（`retry.ts`，10 次、约 84–101 秒），没有配置项可以
  调低。因此一条**失败**的回合无法在设置页探针的合理窗口内走完——这也是本轮
  把 `failed` 判定挂在"内核具名的那一刻"而不是终态事件上的原因。若将来要把
  后端接成产品路径，这条延迟本身就是一个需要面对的约束。
- 聊天后端仍是 ACP；闭环探针只测量，不接线。差距分析第 7 阶段的开放条件
  （工具/权限未覆盖时的后端开放范围）仍未满足。
