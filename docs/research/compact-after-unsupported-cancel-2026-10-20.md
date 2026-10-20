# `/compact` 不该在未确认停止时发出（0.2.77）

- 日期：2026-10-20
- 内核：OpenCode `v2.0.28`（`opencode acp`）
- 范围：`CoOberViewController.compactSession`、`cancelActiveGeneration`、取消文案
- 结论：只有取消结果为 `idle` 或 `stopped` 时才发送 `/compact`；`unsupported` / `unknown` 拒绝发送并说明原因

## 1. 本轮验收标准

0.2.74 的“仍未覆盖”清单把取消结果的丢弃点列为：标签页关闭、视图关闭、侧边聊天。0.2.76 修了空闲看门狗。继续排查后，`/compact` 这条路径更值得先修：

> 当 `/compact` 需要打断一轮正在进行的回合时，只有 agent 确认该回合已停止，才允许发送压缩提示；未确认时必须拒绝，并在该标签页说明原因。

理由不是文案，而是发送者：其余路径只是“关掉视图、停止观看”，`/compact` 是**客户端自己**在取消之后立刻发送下一条 prompt。若取消未生效，这条 prompt 会进入一个仍在运行的会话。

## 2. 修改前的行为

```ts
async cancelActiveGeneration(rt: SessionRuntime = this.activeRuntime): Promise<void> {
  ...
  try {
    await client.cancel(sessionId);
  } catch (e) {
    console.error('[co-ober] cancel:', e);
  }
  this.deps.permissionBanner.dismiss([sessionId]);
}

async compactSession(rt: SessionRuntime = this.activeRuntime): Promise<void> {
  if (this.promptParkedFor(rt)) {
    rt.renderer.addSystemMessage(t().permission.queueBlocked);
    return;
  }
  await this.cancelActiveGeneration(rt);
  await this.sendTextToAgent('/compact', undefined, rt);
}
```

`cancel()` 在 0.2.74 已返回三态，但这里既不返回也不读取；`compactSession` 无条件发送。取消抛异常时同样继续发送。

## 3. 实测

### 3.1 方法

- 用 esbuild 打包仓库中真实的 `AcpClient`（Node ESM，`globalThis.window = globalThis`），不经过 Obsidian。
- stub provider 接受 chat 请求后一直持有 SSE 响应；临时 `OPENCODE_CONFIG` / `OPENCODE_DB`。
- 会话 A：发送一个普通 prompt，确认 provider 已被触达，然后 `cancel(sessionId)`，记录结果；随后在同一会话发送 `/compact`，记录响应与耗时。
- 对照组：新建空闲会话，把同样的 `/compact` 作为它的第一条 prompt。
- 每条 prompt 最多等待 2.5 s（对照组 8 s）观察是否结算。

### 3.2 原始输出

```text
connected, protocol: 1
[stub] chat request #1, holding
[stub] chat request #2, holding
first prompt reached provider: true requests: 2
cancel outcome: unsupported in ms: 2 active streams: 0
compact-after-unsupported within 2500ms: settled ms: 2
compact error code: -32603 name: AcpProtocolError
compact humanized: The agent hit an internal error: Internal error: Session already has an active ACP prompt: ses_ea751af70ffehknzIeu0qcil8q
provider requests after busy compact attempt: 2
control /compact reached provider: false requests: 2
control /compact within 8000ms: settled ms: 9980
control response: {"stopReason":"end_turn","_meta":{}}
first turn final state: rejected
first error: AcpAbortError undefined ACP request 'session/prompt' was aborted
```

### 3.3 解读

1. **旧路径在本内核上必然失败。** 取消返回 `unsupported` 后 2 ms，同一会话的 `/compact` 就被内核以 `-32603` 拒绝，原因被内核自己写清楚了：`Session already has an active ACP prompt: ses_...`。这不是插件推断，是 agent 的原文。
2. **失败发生在发送边界，不是等待模型。** 第二次发送没有产生新的 provider 请求（仍为 2）；它连模型都没有到达。
3. **对照组排除了“`/compact` 本身不可用”。** 空闲会话接受同样的 `/compact` 并返回 `{stopReason:"end_turn"}`。该会话为空，压缩是平凡操作，所以这条只证明“在无活动 prompt 时被接受”，不证明摘要成功。
4. **本地流中止与内核状态分离。** 第一轮在本地因 `cancel()` 中止流而以 `AcpAbortError` 结束，但内核仍持有它——正是 `unsupported` 文案描述的状态。
5. **在本内核上，`unsupported` 不会造成“叠加执行”，而是造成确定的内部错误。** 对实现了真正取消的 agent，取消会返回 `stopped`，路径照旧；对会并发接受 prompt 的 agent，旧代码才会叠加。两种情况都不该由客户端主动发送。

## 4. 修复

### 4.1 让 `cancelActiveGeneration` 汇报结果

```ts
async cancelActiveGeneration(
  rt: SessionRuntime = this.activeRuntime,
): Promise<'idle' | 'stopped' | 'unsupported' | 'unknown'> {
  const client = this.deps.runtime.getClient();
  if (!client || !rt.busy || !rt.state.sessionId) return 'idle';
  const sessionId = rt.state.sessionId;
  let outcome: 'stopped' | 'unsupported' | 'unknown';
  try {
    outcome = await client.cancel(sessionId);
  } catch (e) {
    console.error('[co-ober] cancel:', e);
    outcome = 'unknown';
  }
  this.deps.permissionBanner.dismiss([sessionId]);
  return outcome;
}
```

`idle` 是必要的新状态：没有回合可取消时，`/compact` 不应被拒绝。抛出异常的取消只观测到“没有结果”，因此是 `unknown`，不是 `stopped`。

### 4.2 `/compact` 只在确认停止后发送

```ts
const cancelOutcome = await this.cancelActiveGeneration(rt);
if (cancelOutcome !== 'idle' && cancelOutcome !== 'stopped') {
  rt.renderer.addSystemMessage(
    cancelOutcome === 'unsupported'
      ? t().error.compactBlockedUnsupported
      : t().error.compactBlockedUnknown,
  );
  return;
}
await this.sendTextToAgent('/compact', undefined, rt);
```

文案（中英各两条）说明两件事：压缩没有发出；如果没有停止，那条 prompt 会进入一个仍在运行上一轮的会话。它们不承诺“等待后一定成功”，只承诺客户端不再主动制造这次失败。

## 5. 边界测试

新增 6 个测试（2,531 → 2,537）：

1. `stopped`：取消确认后，`/compact` 恰好发送一次，发送内容为 `[{type:'text', text:'/compact'}]`，且不出现阻断文案。移除发送条件中的 `stopped` 分支即失败。
2. `unsupported`：不发送，出现 `compactBlockedUnsupported`。改回“取消后总是发送”即失败。
3. `unknown`：不发送，出现 `compactBlockedUnknown`。
4. 取消抛出：不发送，出现 `compactBlockedUnknown`。
5. 空闲标签页：不调用 `cancel`，直接发送 `/compact`。若把 `idle` 当作阻断，即失败。
6. `cancelActiveGeneration` 直接断言：取消抛出时必须解析为 `unknown`（而不是 `undefined` 或 `stopped`）。删除 catch 中的赋值即失败。

此外，两个测试文件的默认 `cancel` mock 从 `undefined` 改为 `'stopped'`，与 `AcpClient` 的真实契约一致；旧默认值会让任何读取结果的代码把“正常取消”误判为未知。

## 6. 回归计数

- 全量：86 个文件 / 2,537 个测试；本 Windows 主机 2,518 通过，19 失败。
- 19 个失败与 0.2.75、0.2.76 完全相同：`NativeSessionReader.test.ts` 18 个、`commandResolution.test.ts` 1 个，均为既有平台绑定问题，未修改。
- 控制器两个测试文件：405 个测试全部通过。
- `tsc --noEmit`、ESLint（`--max-warnings=0`）均无输出。

## 7. 仍未闭合

1. **`closeTab`、`cancelAllStreams`、`abortSideChat` 仍丢弃结果。** 与前几处不同，它们发生时承载消息的界面正在被移除：写进即将销毁的标签页没有读者。要报告，必须先决定“关闭后由谁接收这条事实”，这是产品决定，不是再读一次返回值。
2. **没有取消方法的 agent 上，活动回合期间无法压缩。** 现在的行为是拒绝并解释；等回合结束或换会话后可再试。旧行为是必然得到 `-32603`。
3. **本地流与内核状态仍会分离。** 取消后 `activeStreamCount()` 为 0，但内核仍报告 `active ACP prompt`。这是 2.0.28 没有取消方法的结果，不是本轮能修复的。
4. **只测了 2.0.28**；`stopped` 分支仍只由单元测试覆盖，未在真正实现取消的 agent 上实测。
5. **对照组为空会话。** `/compact` 的“成功摘要”路径未被测量；本轮只验证接受/拒绝边界。

## 8. 与前两轮的关系

- 0.2.75：重发前问“这一轮到达 agent 了吗”。
- 0.2.76：看门狗放弃时问“agent 确认它停了吗”。
- 0.2.77：客户端自己要发下一条 prompt 时，把同一个答案变成发送条件。

三轮共享一条规则：**没有证据的“已停止”不允许被当作事实使用。** 区别只在证据不足时的动作：0.2.75 拒绝重发，0.2.76 如实叙述，0.2.77 拒绝发送。
