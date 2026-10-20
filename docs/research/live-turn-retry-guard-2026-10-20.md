# 验收项之三补完:超时与拒绝路径的重发守卫

日期:2026-10-20。实现版本:Co-Ober 0.2.75。

## 1. 参考仓库

本轮未重新拉取 Claudian。沿用上一轮记录:`main` 为 `8a7de7c6`(2.3.24),
`src/providers/opencode` 未改动;这不是本轮的测量,只作为上下文。

## 2. 现场:两件事,后一件更严重

0.2.73 只守住了进程退出路径,并写明超时/拒绝仍给一个未经核对的重发 chip。
回看实现时发现更早的一层:`submittedAlready` 通过 `client?.hasSubmittedPrompt`
可选调用,而控制器手里的 client 是 `AgentRuntime`,它**没有**这个方法。于是
每一次探测都在可选链上停下,统一返回 `unknown`。

这意味着 0.2.73 的守卫上线即失效:

- 它没有造成双重执行,因为 `unknown` 的语义是不重发——**恰好** fail-closed;
- 但它也没有做过一次真正的测量。重连后的"重启并重试"永远被拒绝,
  连确实没送达的回合也发不出去;
- 防线看起来在,实际是一个常数。

## 3. 内核版本漂移

本轮机器上安装的是 OpenCode **2.0.28**;0.2.74 的测量记录是 2.0.32。
本轮所有结论都在 2.0.28 上重新做了一遍。取消能力仍然不存在:
`session/cancel` 返回 `-32601`。0.2.74 测过的九种拼写是在 2.0.32 上,
本轮只复测了主拼写,结果与旧记录一致,但不把旧的九拼写结果冒充成本轮测量。

## 4. 实测 A:回合还在飞,记录里已经有了

装置:临时 `OPENCODE_CONFIG` + 隔离 `OPENCODE_DB`,provider 指向本机
OpenAI 兼容 stub,收到请求后持有不答;spawn `opencode acp`,手工收发 JSON-RPC。

1. `initialize` → `session/new`
2. 发一条带唯一标记的提示词
3. 回合挂着时,在**同一条连接**上 `session/load` 同一个 sessionId
4. 读回放帧;再看原 `session/prompt` 是否还在 pending
5. 发 `session/cancel`

原始输出:

```
[stub] chat request #1 (2400 bytes), holding
[stub] chat request #2 (50034 bytes), holding
session/load ms: 15
replayed session/update frames: 4
replayed user chunks: 1
MARKER IN REPLAY: true
prompt after load: pending
session/cancel ms: 1
session/cancel result: {"code":-32601,"message":"\"Method not found\": session/cancel","data":{"method":"session/cancel"}}
```

三件事同时成立:

- **提交已经持久化**。回放里只有一个 user chunk,标记就在其中。
- **`session/load` 不会终止在飞的回合**。原 prompt 仍是 pending;load 不是 cancel。
- **内核仍然不能取消**。取消请求 1 ms 返回 `-32601`,回合继续活着。

所以超时 chip 上的"重试"不是"补发一次没送达的请求",而是**在一个还活着的
回合上叠第二条指令**。0.2.74 已证明"停不下来";这一轮证明"再发会叠"。

## 5. 实测 B:拒绝之后,记录里也有

装置同上,provider 对每次上游请求返回 500:

```
[stub] rejecting request #1..#12 with 500
session/prompt after ms: 84915
session/prompt result: {"code":-32603,"message":"Internal error: live rig refused this turn","data":{"service":"session","errorName":"provider.internal"}}
session/load ms: 18
replayed session/update frames: 24
replayed user chunks: 1
MARKER IN REPLAY: true
```

拒绝没有撤销提交。12 次上游重试、约 85 秒之后返回 `-32603`,记录里仍有这条
提示词。回合在失败前可能已经跑过工具;**重发会把同一段指令再执行一次**。
"没有回答"同样不是"没有发生"。

## 6. 修法

- `AgentRuntime.hasSubmittedPrompt(id, text)` 转发到 `AcpClient`。
  控制器手里的对象终于有了 0.2.73 以为它有的方法。
- `executeAgentCall` 增加 `promptAttempted` 标志,在 `sendMessage` 调用前
  一瞬置 true。所有会给出重试 chip 的失败分支按边界分流:
  - 发送之后失败 → `retryUnlessSubmitted`:先查记录,只有 `no` 才重发;
    `yes` / `unknown` 都不发,并把原因说清楚。
  - 发送之前失败 → 保持普通重试。请求没上线,就没有可查的东西。
- 进程退出路径先 `reconnect()`,再探查,再决定。重连本来就会重载会话。
- 发送前的失败不探查,理由不是省一次 RPC:包含匹配会把更早一轮的同样文本
  读成 `yes`,在请求根本没上线时拒绝重试,那是一句假话。

`promptAttempted` 的语义是"尝试过发送",不是"确认写入了管道"。
`sendMessage` 内部抛出(传输已断)也在这个边界内,因此同样会探查。
这是刻意的:插件看不见写入的那一瞬,边界只能画在调用之前或之后;
后者会把不确定性当安全,前者只可能多拒绝一次。

## 7. 边界(六条,均确认能分辨新旧)

1. **超时 + `yes`** → 不重发,提示已提交。恢复裸重发时失败
   (sendMessage 变为两次)。
2. **超时 + `unknown`** → 不重发,明确说记录读不到。把 `unknown` 当 `no`
   时失败(会重发)。
3. **超时 + `no`** → 重发一次。把守卫改成一律拒绝时失败。
4. **进程退出 + `yes`** → 先 reconnect、再探查、拒绝重发。
   去掉重连或去掉探查都会失败。
5. **发送前失败 + 探查会答 `yes`** → 不探查、照常重试。
   去掉 `promptAttempted` 分流时失败(会被一次更早的相同文本挡住)。
6. **`AgentRuntime.hasSubmittedPrompt` 转发到 acp**。不转发时,
   0.2.73 的 `unknown` 常数会原样回来。

## 8. 回归

- 86 个测试文件、**2,525** 项。本轮新增 6 项(控制器 5、runtime 转发 1),
  上一轮基线 2,519,合计 2,525。
- 本机(Windows)2,506 项通过;19 项失败全部集中在
  `NativeSessionReader.test.ts`(POSIX 夹具被 win32 的 `path.join` 改写)
  和 `commandResolution.test.ts`(按宿主 `path.delimiter` 切 POSIX PATH)。
  两个文件本轮均未改动,失败与本次改动无关;它们需要在 Linux CI 上跑,
  本机数字不能替代 CI 的 2,525。
- 定向测试:2 个文件 306/306 通过。
- TypeScript 与 ESLint 通过。

## 9. 未覆盖

- **空闲看门狗仍然丢弃取消结果**:`void this.acp.cancel(id)` 之后立刻
  reject 超时。2.0.28 上那次取消会答 `-32601`——"超时"被报告时,
  回合可能还活着,而插件没有读这个结果。下一轮。
- 0.2.74 列出的其余静默取消路径(关标签、关视图、side chat)仍未处理。
- 只在 2.0.28 上测量;2.0.32 的九种取消拼写未复测。
- 包含匹配仍可能误报(更早的相同文本),方向是拒绝重试;
  `unknown` 让读者多点一次才能重发。
- 聊天后端仍是 ACP。
