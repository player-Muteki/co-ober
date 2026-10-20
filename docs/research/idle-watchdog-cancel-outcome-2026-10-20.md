# 空闲看门狗：把取消结果还给读者（0.2.76）

- 日期：2026-10-20
- 内核：OpenCode `v2.0.28`（`opencode acp`）
- 范围：`AgentRuntime.sendMessage` 的空闲看门狗、`AcpTimeoutError`、错误文案
- 结论：看门狗现在上报取消的三态结果；流中止的拒绝不再抢先结算；实测 4000 ms 窗口在 4545 ms 结算，结果为 `unsupported`

## 1. 本轮验收标准

0.2.75 的“仍未覆盖”清单第一条是：

> 空闲看门狗仍然 `void this.acp.cancel(id)`，丢弃结果；在本内核上该 cancel 返回 `-32601`，于是一轮“超时”被报告出来，而它可能仍然活着。

把它转成可判定的验收标准：

> 当空闲看门狗因超时终止一轮时，最终呈现给读者的错误必须携带看门狗实际观察到的取消结果；三种结果（已停止 / 不支持取消 / 未确认）必须产生不同的句子；流中止不得覆盖该结果。

这不是“让取消变得可用”——0.2.74 已测出 2.0.28 根本没有取消方法，本轮无法改变内核。本轮只保证：**客户端不再假装没有测量过**。

## 2. 修改前的行为

`src/client/agent.ts` 的看门狗：

```ts
timeout = window.setTimeout(() => {
  if (this.permissionHolds > 0) { resetTimeout(); return; }
  void this.acp.cancel(id);
  reject(new AcpTimeoutError('session/prompt', timeoutMs));
}, timeoutMs);
```

`void` 丢弃了 `cancel()` 的三态返回值。`AcpTimeoutError` 只有方法名与毫秒数：

```ts
export class AcpTimeoutError extends AcpTransportError {
  constructor(public readonly method: string, public readonly timeoutMs: number) { ... }
}
```

`humanizeError` 因此只能输出一句对三种情况都成立的模糊话：

> The agent did not answer “session/prompt” within 300000 ms. It may still be working.

这句话在 `stopped` 时是假的（agent 已确认停下），在 `unsupported` 时又掩盖了原因（不是“可能”，而是“这个 agent 没有取消方法”）。

## 3. 为什么不能只把 `void` 改成 `await`

`AcpClient.cancel()` 的第一步是中止本地流，第二步才向 agent 发取消请求：

```ts
async cancel(id: string): Promise<'stopped' | 'unsupported' | 'unknown'> {
  const stream = this.activeStreams.get(id);
  this.activeStreams.delete(id);
  stream?.abort.abort();
  if (!this.transport) return 'unknown';
  try {
    await this.requestWithFallback('cancel', { sessionId: id }, ACP_CANCEL_TIMEOUT_MS);
    return 'stopped';
  } catch (e) { ... }
}
```

本地流一中止，外层包装里的 `this.acp.sendMessage(...)` 立刻以 `AcpAbortError` 拒绝。如果看门狗只是等待 `cancel()` 再拒绝，包装的 `.catch` 会先结算外层 Promise：

1. 读者看到的是 `AcpAbortError`，不是超时；
2. 控制器对该错误的处理路径不同（不会给出超时文案）；
3. 随后取消结果返回时，Promise 已结算，结果被无声丢弃。

这正是 0.2.74 在 Stop 路径上修过的同类问题，只是这里发生在内部竞态里。

## 4. 设计

### 4.1 在错误上携带结果

```ts
export type AcpCancelOutcome = 'stopped' | 'unsupported' | 'unknown';

export class AcpTimeoutError extends AcpTransportError {
  constructor(
    public readonly method: string,
    public readonly timeoutMs: number,
    public readonly cancelOutcome?: AcpCancelOutcome,
  ) { ... }
}
```

第三参可选，所有既有的 `new AcpTimeoutError(method, ms)` 调用点（`session/load`、`terminal/wait_for_exit`、传输层超时、测试）无需改动，行为不变：没有取消尝试就没有取消结论。

### 4.2 看门狗接管结算权

```ts
let timedOut = false;
...
timedOut = true;
this.acp.cancel(id)
  .catch((): 'unknown' => 'unknown')
  .then((outcome) => {
    reject(new AcpTimeoutError('session/prompt', timeoutMs, outcome));
  });
...
this.acp.sendMessage(id, parts, heartbeatHandler)
  .then((res) => {
    window.clearTimeout(timeout);
    if (timedOut) return;
    resolve(res);
  })
  .catch((err) => {
    window.clearTimeout(timeout);
    if (timedOut) return;
    reject(...);
  });
```

三个要点：

1. `timedOut` 在调用 cancel **之前**置位。本地流中止的拒绝可能同步/微任务级到达，晚一步就会被它抢先。
2. `.catch(() => 'unknown')`：`AcpClient.cancel` 当前不会拒绝（内部已捕获），但若未来契约变化，看门狗不能永远 pending。抛异常的取消只能算“未确认”，不能算“已停止”。
3. 等待有上限：`ACP_CANCEL_TIMEOUT_MS = 2_000`。最坏情况下超时文案比窗口晚 2 秒到达，换来的是一个可陈述的事实。

### 4.3 文案三态

`humanizeError` 按 `cancelOutcome` 分支：

| 结果 | 英文要点 | 中文要点 |
| --- | --- | --- |
| `stopped` | 已取消，agent 确认停下；不再说 may still be working | 已取消，agent 确认它已停下 |
| `unsupported` | 这个 agent 没有取消方法，那一轮可能还在跑 | 同义 |
| `unknown` | 已发送取消，但没有确认停下 | 同义 |
| 无结果 | 保持原句：可能仍在处理 | 同义 |

`cancelled` 是一个动作，`stopped` 是 agent 的确认。文案只在后者成立时才允许使用确定语气。

## 5. 实测

### 5.1 方法

- 用 esbuild 将仓库中的真实 `AgentRuntime` + `AcpClient` 打包为 Node ESM（`globalThis.window = globalThis`，因为运行时使用 `window.setTimeout`），不经过 Obsidian。
- 本地 stub provider 接受 chat 请求后一直持有 SSE 响应，不返回内容。
- 临时 `OPENCODE_CONFIG` / `OPENCODE_DB`，模型指向 stub；`opencode acp` 由 `AcpClient` 自己 spawn。
- `runtime.idleTimeoutMs = 4000`。
- 调用 `runtime.sendMessage(sessionId, [{type:'text', text:'hold this turn forever'}], () => {})`，等待看门狗结算。

### 5.2 原始输出

```text
opencode v2.0.28
connected in ms: 672
session: ses_ea75796b2ffe5os46HfNJ3s6dg version: 1
[stub] chat request #1, holding
[stub] chat request #2, holding
provider reached; waiting for the 4000 ms idle window
watchdog settled after ms: 4545 kind: rejected
error name: AcpTimeoutError
cancelOutcome: unsupported
method: session/prompt timeoutMs: 4000
humanized: The agent did not answer "session/prompt" within 4000 ms. This agent has no cancel method, so the turn may still be running inside it.
active streams after watchdog: 0
second send within 1500 ms: {"kind":"rejected","e":{"method":"session/prompt","code":-32603,"data":{"service":"session"},"name":"AcpProtocolError"}}
provider requests after second start: 2
```

### 5.3 解读

1. **结果被带出来了。** 修改前 `cancelOutcome` 字段不存在；修改后为 `unsupported`，与 0.2.74 对 2.0.28 的独立测量一致（九种取消拼写全部 `-32601`）。
2. **流中止没有赢。** 错误是 `AcpTimeoutError` 而不是 `AcpAbortError`，说明竞态中的抑制生效。`activeStreamCount() = 0` 说明本地流已清空，下一次发送不会被 “A stream is already active” 挡住。
3. **等待取消的代价是 545 ms。** 4000 ms 窗口在 4545 ms 结算。这是 `requestWithFallback` 的往返与别名尝试成本；它远小于 2 s 上限。修改前这一刻的取消结果不可见——不是因为不存在，而是因为没人等它。
4. **`unsupported` 的警告是写实的。** 第一轮仍被内核持有时，第二次 `session/prompt` 在 1.5 s 内以 `-32603` 拒绝。0.2.75 的转录守卫会阻止这个重发；本轮的文案则解释了为什么应当阻止。
5. **`stopped` / `unknown` 无法在本内核上实测。** 2.0.28 没有取消方法，`stopped` 分支只能由单元测试覆盖；`unknown` 由取消抛异常的分支覆盖。文档不把它们写成实测结论。

## 6. 边界测试

新增/加强 7 处断言，其中 6 个是新测试（2,525 → 2,531）：

1. `rejects on timeout`（加强）：默认 `cancel` 返回 `stopped`，错误必须携带该值。改回 `void cancel` 时 `cancelOutcome` 为 `undefined`，失败。
2. `carries an unsupported cancel into the timeout instead of discarding it`：`cancel` 返回 `unsupported`，错误必须原样携带。
3. `reports the cancel outcome even when the stream aborts before cancel answers`：cancel 实现先同步拒绝底层流、再延迟 500 ms 返回 `stopped`；最终必须是 `AcpTimeoutError` 且结果为 `stopped`，不能是 `AcpAbortError`。让包装先结算即失败。
4. `treats a throwing cancel as an unconfirmed stop instead of leaving the turn pending`：取消拒绝时必须得到 `unknown`，而不是悬挂。
5. `errorText`：`stopped` 文案不得包含 “still”，并逐字匹配 i18n 模板。
6. `errorText`：`unsupported` 与 `unknown` 必须是不同句子，且分别指出“没有取消方法”与“没有确认停下”。
7. `AcpErrors`：构造器保存第三参；两参构造时 `cancelOutcome` 为 `undefined`，保证 `session/load` 等非看门狗超时不受影响。

## 7. 回归计数

- 全量：86 个文件 / 2,531 个测试；本 Windows 主机 2,512 通过，19 失败。
- 19 个失败与 0.2.75 完全相同，均为既有平台绑定问题：`NativeSessionReader.test.ts` 18 个（POSIX 夹具经 win32 `path.join`）、`commandResolution.test.ts` 1 个（宿主 PATH 分隔符）。两个文件本轮未修改。
- 定向：`agent.test.ts`、`errorText.test.ts`、`AcpErrors.test.ts` 共 86 个测试全部通过。
- `tsc --noEmit` 与 ESLint（`--max-warnings=0`）均无输出。

## 8. 仍未闭合

1. **取消结果的其他丢弃点**：标签页关闭、视图关闭、侧边聊天路径仍不报告 `cancel()` 的结果（0.2.74 起记录）。本轮只修了看门狗。
2. **内核状态没有改变**：`unsupported` 仍然是“超时的那一轮还在里面跑”。0.2.75 的转录守卫拒绝重发，但真正的停止要等 agent 实现取消。
3. **超时文案延后最多 2 秒**：这是为了获得取消结果而付出的确定性代价。若未来需要“先报超时、后补结果”，需要错误对象之外的通知通道，本轮未做。
4. **晚到的回答被丢弃**：看门狗触发后，包装层的 resolve 被忽略。修改前也是如此（立即 reject），但等待取消把这一窗口从 0 扩大到最多 2 秒。
5. **只测了 2.0.28**。`stopped` 路径在真正实现取消的 agent 上未实测。

## 9. 与前一轮的关系

0.2.75 让重发前先问转录，回答“这一轮是否已经到达 agent”。本轮回答另一个问题：“看门狗放弃时，这一轮是否已经停下”。两个问题都指向同一个事实：**没有回答不等于没有执行，取消不等于停止**。前者阻止重复执行，后者阻止错误的安心。
