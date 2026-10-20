# `session/close` 确实终结活回合——所以那句"可能还在跑"也可以是谎（0.2.81）

- 日期：2026-10-20
- 内核：OpenCode `v2.0.28`（`opencode acp`），本轮重新搭 rig 实测
- 范围：`AcpClient.closeSession` 返回值、`CoOberViewController.releaseAgentSession` / `closeTab` / `endSideChat` / `cancelAllStreams` 的停止证据
- 结论：close 被应答 = 回合已停的实测证据；cancel 答非所问时，成功的 close 让"可能仍在内核运行"这句话失去依据

## 1. 本轮验收标准

0.2.80 收尾时写了："下一轮不再是'再找一个丢弃点'，而是回头测量：实现取消的 agent 上的 `stopped`、`session/close` 与活回合的关系。"

本轮先兑现后半句。验收标准：

> 在真实内核上测量：`session/close` 发给一个正在运行的回合，那个回合会发生什么——close 自己怎么答、prompt 怎么收场、close 之后还有没有帧、被关的会话还能不能用。测量结果若推翻现有断言，行为与文案跟着改。

## 2. 修改前的行为

三处把 close 的应答丢弃：

```ts
// acp.ts
async closeSession(id: string): Promise<void> {
  try { await this.requestWithFallback('closeSession', ...); }
  catch (e) { console.warn(...); }        // 应答与失败在返回值上没有区别
}

// CoOberViewController.closeTab
if (!this.findRuntimeBySession(rt.state.sessionId)) this.releaseAgentSession(...); // void
// 随后无条件报告 cancelOutcome === 'unsupported' → "那一轮可能还在内核里运行"

// endSideChat
void client.closeSession(sideId).catch(...);  // 发射后不管
// cancel 的 unsupported/unknown 原样上报
```

也就是说：在 2.0.28 上，关标签页的流程是 cancel（答 `-32601`）→ close（**有应答，被扔掉**）→ 告诉读者"那一轮可能还在跑"。

## 3. rig 与实测

新装置（临时脚本，不入库）：spawn `opencode acp`，手写 newline-delimited JSON-RPC：

1. `initialize` → 能力声明：`sessionCapabilities.close = {}`（该内核声明支持 close）。
2. `session/new` → `session/prompt`（"不使用工具，连续输出 1 到 4000"）。
3. 等第一个 `agent_message_chunk` 落帧，再运行 3 秒；**有效性证明**：close 前 500ms 窗口内仍须有 chunk 到达（第一次试跑用"1 到 300"，回合在 close 前已自然结束，`end_turn` 与 close 无关，该组作废——判别性不够就换任务重跑，而不是解读它）。
4. 发 `session/close`（请求），观察 20 秒。

活回合组读数：

```
close                -> {}  (39 ms)
prompt 请求          -> 与 close 应答同一毫秒内返回 stopReason: "cancelled"
close 之后的帧        -> 0 条 message chunk，事件种类集合为空
对同一 id 再 prompt   -> ERR -32602 "session not found"
同连接 session/new   -> OK（对照组：连接活着，不是管道死）
```

本内核没有 cancel 方法（0.2.74 九写法全部 `-32601`），却把 prompt 以 `cancelled` 收了场——**`session/close` 就是这颗内核上的停止机制**，只是不叫那个名字。

## 4. 结论与修复

诚实性原则是双向的："没有证据的已停止不允许被当作事实使用"，反过来，**没有证据的"可能还在跑"也不该继续说**。cancel 答 `unsupported` 时报告是对的；但如果同一手势里 agent 随后**接受了 close**，而实测表明接受 close 就终结活回合，那句"还在跑"就成了悲观版的虚构。

### 4.1 `closeSession` 把应答带回来

```ts
async closeSession(id: string): Promise<boolean>
// 请求成功 → true；任何失败 → false（仍不抛出，清理调用方照旧发射后不管）
```

### 4.2 新证据值 `'closed'`

`AcpStopEvidence = AcpCancelOutcome | 'closed'`。`'closed'` 只有一种含义：cancel 没确认，close 确认了。它不进 cancel 的三态——那不是 cancel 的答案。

### 4.3 各关闭路径的接收者

- **`endSideChat`**：close 与 cancel 并发发出（门槛与旧代码逐字相同），`Promise.all` 后合成证据。`unsupported|unknown` + close 被接受 → `'closed'` → 父标签页沉默；close 失败或被拒 → 原样上报。close 自己抛出按 false 处理，绝不能把 cancel 的答案一起吞掉（`endSideChat` 在 `closeTab` 的 await 链上）。
- **`closeTab`**：`releaseAgentSession` 返回 Promise 并被**等待**（实测 close 往返 ~40ms）；会话被别的标签页共享时不 close、证据不成立、报告照旧。`cancelOutcome` 为 unsupported/unknown 但 close 被接受 → 沉默。
- **`cancelAllStreams`**：`'closed'` 与 `stopped` 一样不进 Notice 计数。主回合不在此处 close（视图关闭不销毁会话），所以主回合的 unsupported/unknown 仍如实计数——本轮没有为它编造证据。
- 其余 7 个 `releaseAgentSession` 清理点显式 `void`，语义不变。

## 5. 边界测试

新增 8 个（2,554 → 2,562）：

1. `closeSession` ack → `true`；请求失败 → `false` 且不抛出。
2. 侧栏 close 确认：`endSideChat` 返回 `'closed'`，父标签页两句侧栏文案都不出现。旧代码 close 应答被丢弃、仍报 `unsupported`，即失败。
3. close 应答 false：文案照旧、返回 `unsupported`。防"只要发过 close 就沉默"的过度抑制。
4. close 抛出：`endSideChat` 不 reject，仍返回 cancel 的 `unknown`。
5. 关一个 busy 标签页、close 被接受：继任标签页不出现 `tabClosedUnsupported`。旧代码即失败。
6. close 未被接受：`tabClosedUnsupported` 仍在。
7. 主+侧同时 unsupported、双双 close 被接受：继任标签页两句都不出现。
8. 视图关闭、只有侧栏在跑且 close 被接受：cancel 与 close 都发给了 `fork-a`，Notice 为空。旧代码计数 1，即失败。

回退检验已做：摘掉 `!sessionReleased` 抑制条件，用例 5 如预期失败。

## 6. 回归计数

- 全量：86 个文件 / 2,562 个测试；本 Windows 主机 2,543 通过，19 失败。
- 19 个失败与 0.2.75–0.2.80 完全相同（`NativeSessionReader.test.ts` 18 个、`commandResolution.test.ts` 1 个），既有平台绑定问题，未修改。
- `tsc --noEmit`、ESLint（`--max-warnings=0`）均无输出。
- rig 输出如 §3 所录；有效性证明失败的第一组（`end_turn`）保留在文档里作为反例，不是被删掉的 inconvenient data。

## 7. 仍未闭合

1. **`stopped` 仍只由 mock 覆盖**——本轮换了个方向：不再等一个实现 cancel 的 agent，而是承认 2.0.28 用 close 应答了停止。真实 `stopped` 依然没测到。
2. **close-as-stop 只测了 2.0.28**。代码按能力门槛执行（agent 声明 `sessionCapabilities.close` 才可能得到 `'closed'`）；一个声明 close 却不对活回合终结的 agent 会把"已停"当成事实——这是本轮结论对其它内核的外推，文档如实记下。
3. **视图关闭的主回合**：`cancelAllStreams` 不关闭主会话（重开视图还要接回去），所以主回合的 unsupported 仍计数。若未来决定视图关闭也释放会话，那是行为变化，需要新的实测。
4. **close 之后旧会话 id 的所有引用路径**：实测 `-32602 session not found` 说明 id 已死；`loadedSessionIds`/`sessionMeta` 已在 `closeSession` 里清理，其它模块（历史列表、恢复流程）对已关 id 的引用本轮未逐一审计。

## 8. 与 0.2.74–0.2.80 的关系

0.2.74–0.2.80 六轮把"没有证据的已停止"逐点消灭；本轮处理镜像问题：**有反证的"可能还在跑"也要撤**。同一句话的两种说谎方式——一个是假装胜利，一个是假装失败——依据都只许是实测到的应答。
