# OpenCode 下一阶段：v2 终态与流式回答的实测

日期：2026-10-17。实现版本：Co-Ober 0.2.65。

## 1. 参考仓库

Claudian `main` 仍为 `31dd256b` / 2.3.22（经 GitHub API 复核；本地
`git fetch` 在本轮多次因 TLS 中断失败，未能刷新远端引用，但 API 确认无新提交）。
参考未动，本轮继续以 OpenCode 自身为测量对象。

## 2. 上一轮留下的两个未知项，本轮如何关掉

0.2.64 的研究文档第 5 节写下了两条未知：

1. **`answered` 桶未被观测** —— 产出真实回答需要 provider 凭据，而
   `OPENCODE_SIMULATE=1` 只是网络闸门，会让运行停在重试阶段；
2. **终态事件命名完全未观测** —— `session.execution.succeeded/failed/interrupted`
   一个都没出现过。

`OPENCODE_SIMULATE` 并不是唯一的选择。OpenCode 支持在配置里声明一个
OpenAI 兼容的 provider 并指定 `baseURL`。于是可以起一个本地的极小
chat-completions 端点，让内核**真正跑完一个回合**——不需要任何真实凭据。

做法：以 `OPENCODE_CONFIG` 指向一份只含 `fakeprov` provider 的配置，
`baseURL` 指向 `http://127.0.0.1:<port>/v1`，`model` 默认值设为
`fakeprov/fake-model`；另起一个 Node 进程回答标准 OpenAI 流式 SSE。
数据库仍用隔离的 `OPENCODE_DB`。

## 3. 实测到的完整生命周期

一次真实回合的事件序列（同一 sessionID，已过滤）：

```
session.inbox.enqueued   {inboxID, item:{type:'user', payload:{text}, delivery:'steer'}}
session.execution.started{sessionID}
session.inbox.delivered  {sessionID, inboxID}
session.step.started     {sessionID, agent, model:{id,providerID}, assistantMessageID, started}
session.text.started     {sessionID, assistantMessageID, ordinal:0}
session.text.delta       {sessionID, assistantMessageID, ordinal:0, delta}
session.text.ended       {sessionID, assistantMessageID, ordinal:0, text}
session.step.streamed    {sessionID, assistantMessageID}
session.step.ended       {…, finish:'stop', rawFinish:'stop', cost, tokens:{input,output,reasoning,cache}}
session.execution.succeeded {sessionID}
session.usage.updated  (×2)   session.renamed
```

**三条此前未知的事实，全部落地：**

1. **流式通道是 `session.text.*`，不是 `session.next.text.*`。**
   由 `assistantMessageID` + `ordinal` 定位；`ordinal` 区分同一步里的不同片段。
   0.2.56 的 stream 探针即便能被准入，也匹配不到任何帧。
2. **终态事件是 `session.execution.succeeded`。**
3. **transcript 上会追加一行 `type: "idle"`，带 `outcome` 字段**
   （本次读到 `"succeeded"`）。这是比事件名更稳的终态来源：它读的是**字段**，
   因此一个本构建从未见过的 outcome 也能原样到达读者，而不必被猜成"成功"。

另外 assistant 行在 v2 上确实带 `content: [{type:'text', text}]`，与
0.2.55 在 1.x 上的读法一致——这一条跨代成立。

## 4. 落地的边界

`OpencodeV2SliceProbe` 的读数扩为一个真正覆盖闭环的证据面：

- `reduceV2SliceEvents` 现在还归约 `session.text.delta` / `.ended`（只取
  `ordinal === 0` 的**回答通道**，避免把别的片段拼进答案）、终态事件名、
  `session.step.ended` 的 `finish` / `cost` / `tokens`、以及
  `session.step.started` 宣布的 model。
- 新增 `v2TerminalOutcome`：从 transcript 的 `idle` 行读取 `outcome`，**原样**返回。
- 状态桶从三个增为四个，且不合并：
  - `unavailable` 准备失败；
  - `failed` **内核自己记录的终态不是成功**（带具体 outcome，如
    `provider.transport`）；
  - `answered` **真的读到了非空 assistant 文本**；
  - `admitted` 内核接了提示词并开始执行，但既无回答也无成功终态。
- `streamed` / `confirmed` 把"由 delta 帧重建"与"内核自身 ended 帧一致"
  拆成两个独立事实——这正是 0.2.56 为 1.x stream 探针立下的规矩。

**未观测的终态名不被发明。** 只测到 `succeeded`，因此 reducer 对任何其它
`session.execution.*` 名称只**原样记录**，不映射为任何含义。

## 5. 过程中被测试抓出的一个自相矛盾

状态一度只由 transcript 读数（`answerCell`）决定，而 `answer` 字段却由
transcript **或** delta 组装两者共同决定。结果是：一条只在流里出现答案、
transcript 尚未可见的读数会**一边显示答案、一边报告"没有读回回答"**。
同一个字段对同一次运行说两句互相矛盾的话。已改为先解析出唯一的 answer，
状态与载荷共用它，并由一条"流里有答案"的新边界钉住。

## 6. 回归与实测证据

用已发布代码对真实内核（本地 fake provider，无凭据）复测：

```json
{ "status": "answered", "enqueued": true, "delivered": true, "started": true,
  "streamed": true, "confirmed": true, "answer": "OK",
  "modelId": "fakeprov/fake-model", "outcome": "succeeded",
  "finish": "stop", "cost": 0, "outputTokens": 0, "leftover": false }
```

0.2.64 只能报 `admitted` 且无法说明为什么；本轮拿到完整闭环、真实回答、
内核确认与具名终态。

全套：**84 个测试文件、2,474 项通过**；TypeScript 与 ESLint 通过。
**未消耗任何真实模型回合**：使用的是本地 fake provider，不是用户凭据。

## 7. 仍未解决

- `failed` / `interrupted` 的**具体终态事件名**仍未实测——本轮只跑到成功
  路径，`provider.transport` 那一类是通过 transcript 的 `outcome` 字段
  观察到的，而非事件名。
- fork 探针的清理仍打 405 路由，在 v2 上仍可能留下一次性会话。
- 聊天后端仍是 ACP；闭环探针只测量，不接线。
