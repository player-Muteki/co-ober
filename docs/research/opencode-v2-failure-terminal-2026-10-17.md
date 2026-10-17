# OpenCode 下一阶段：失败与中断的具名终态

日期：2026-10-17。实现版本：Co-Ober 0.2.66。

## 1. 参考仓库

Claudian `main` 仍为 `31dd256b` / 2.3.22（GitHub API 复核）。

## 2. 0.2.65 留下的未知项与本轮如何关掉

0.2.65 只跑通了成功路径，把失败与中断的终态**事件名**留作未知——当时写下的
理由是"只驱动了成功路径"。本轮把两条路径都驱动了，仍用本地 fake provider，
不消耗真实回合。

### 失败路径

把 fake provider 改为恒定返回 **500**。实测：内核**不立即失败**，而是进入
重试，`session.retry.scheduled` 连续出现 8 次，`attempt` 递增，而**等待间隔
本身也在增长**（实测 +2.2s / +9s / +10s / +10s / +8s / +10s / +11s）。观察
窗口内**没有任何终态事件**。

但失败**并不是不可观察**：`session.retry.scheduled` 每次都带一个具名错误：

```json
{"attempt": 2, "at": ...,
 "error": {"type": "provider.internal", "message": "fake upstream refused",
           "status": 500, "response": {...}}}
```

**这是本轮最重要的测量结论**：如果把"失败"的判定挂在终态事件上，就必须先
熬过一条会不断变长的退避链，而它可能在探针窗口内根本走不到终点——那会把
一台**正在明显失败**的机器报成"还在进行中"。具名错误早到得多。

### 中断路径

让 fake provider 接受请求后**挂起 25 秒**，在第 3 秒发
`POST .../interrupt?resume=false`（实测 200）。实测：

```
session.step.failed          {assistantMessageID, error:{type:"aborted", message:"Step interrupted"}}
session.execution.interrupted{sessionID, reason:"user"}
transcript:  idle 行 outcome = "interrupted"
             assistant 行 finish = "error", error = {type:"aborted", ...}
```

于是 `session.execution.interrupted` 这个名字终于有了实测依据，`reason`
字段（`"user"`）也已读出。

## 3. 落地的边界

### 状态桶增至五个，且不合并

| 状态 | 何时成立 | 读者的下一步 |
| --- | --- | --- |
| `answered` | 真的读到非空 assistant 文本 | — |
| `interrupted` | 内核记录了 `interrupted` 终态 | 是谁停的（`reason`） |
| `failed` | 内核**具名**了一个失败 | 去看那个错误类型 |
| `admitted` | 已开始执行，无回答也无成功终态 | 等一等 |
| `unavailable` | 准备失败 | 去查安装 |

`interrupted` 与 `failed` 分开，是因为**内核自己就分开命名**，且补救方式
不同：前者是读者自己按下的停止，后者是要去修的东西。0.2.46 的
`terminalUnknown` vs `terminalGone`、0.2.47 的 exhausted vs retrying 都是
同一形状的先例。

`failed` 在**具名那一刻**成立，不等终态——理由见第 2 节。错误取**第一次**：
把第八次重试的错误给读者，读者已经看不到最初出问题的那个了。

### fork 探针不再静默留下会话

0.2.65 记录的遗留项：fork 探针的清理仍打 `DELETE /session/{id}?directory=`，
在 v2 上是 **405**，异常被 `catch {}` 吞掉，两个一次性会话留在内核历史里而
读者毫不知情。现在按"本世代存在的路由优先、1.x 形式兜底"的顺序尝试两条
删除路由，并在读数里带上 `leftover`；设置页有对应文案。

## 4. 回归与实测证据

- 真实内核（慢 provider、窗口内未完成）：`{"status":"admitted","enqueued":true,
  "delivered":true,"started":true,"streamed":false,"confirmed":false,"retries":0,
  "leftover":false}` —— 一个仍在进行的回合不会被报成任何终态。
- 失败与中断两条路径的边界，直接钉住实测得到的线路形状。
- 全套：**84 个测试文件、2,485 项通过**；TypeScript 与 ESLint 通过。
- 未消耗真实模型回合，未使用真实凭据。

## 5. 仍未解决

- `session.execution.failed` 这个**具体事件名仍未实测**：500 场景下内核一直
  在重试，未走完。失败信息是从 `retry.scheduled` 的 `error` 与 transcript 的
  `error` 字段读到的，不是事件名。reducer 仍把未见的 `session.execution.*`
  原样记录，不映射为任何含义。
- 聊天后端仍是 ACP；闭环探针只测量，不接线。差距分析第 7 阶段的开放条件
  （工具/权限未覆盖时的后端开放范围）仍未满足。
