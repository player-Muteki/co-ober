# 侧边聊天的停止结果，交给养活它的标签页（0.2.80）

- 日期：2026-10-20
- 内核：OpenCode `v2.0.28`（`opencode acp`）
- 范围：`CoOberViewController.endSideChat` / `abortSideChat` / `closeTab` / `cancelAllStreams`、侧边聊天取消去重与文案
- 结论：每个侧边会话只发一次取消；`unsupported` / `unknown` / 抛出的结果写进仍然存在的父标签页（标签页关闭时写进继任标签页，视图关闭时计入同一条 Notice）；`stopped` 保持安静；没有发起取消时不作声明

## 1. 本轮验收标准

0.2.74 的“仍未覆盖”清单里只剩侧边聊天这一处取消结果被丢弃。0.2.79 在文档中把难点写清楚了：它有两个入口——只关侧栏时父标签页还活着；而 `endSideChat` 在关闭标签页与视图拆除时也会走到它，那时父面板正在销毁。

本轮验收标准：

> 当侧边聊天在运行中关闭、而 agent 未能确认停止时，仍然存在的父标签页必须说明这一点；当父标签页也一起关闭时，这条事实必须并入标签页关闭的报告；视图关闭时计入同一条面板级提示。

## 2. 修改前的行为

```ts
// SideChatPanel.close()
if (this.busy) this.deps.abort?.();   // → controller.abortSideChat(tabId)
...
this.deps.onClose?.();                // → controller.endSideChat(rt)

endSideChat(rt) {
  if (sideId) this.abortSideChat(rt.tabId);   // → 第二次 cancel
  rt.sideChatSessionId = null;
  ...
}

abortSideChat(tabId?) {
  ...
  void client.cancel(sideId).catch((e) => console.warn('[co-ober] side chat cancel:', e));
}
```

三个问题叠在同一个动作里：

1. **同一个手势发两次取消。** 面板忙碌时先 abort，随后 `endSideChat` 再 abort 一次。
2. **两次答案都被丢弃。** 一次只写 warn，一次什么都不做。
3. **没有接收者。** 面板随即被移除；`closeTab` 之后会删除父标签页；视图关闭时 `dispose` 在 `cancelAllStreams` 的 Notice 决定之后才取消侧栏。

在 2.0.28 上，这两次取消都会得到 `unsupported`（0.2.74：九种写法全部 `-32601`）；也就是说客户端问了两次“能停吗”，被拒绝了两次，然后忘记了两遍。

## 3. 依据的实测（不新跑 rig）

与前两轮相同：

1. 2.0.28 没有取消方法：0.2.74 的九写法实测全部 `-32601`，同连接的其它方法正常应答；Stop 后 prompt 仍在 transcript 中。
2. 取消往返约 545 ms（0.2.76 看门狗 rig）。

本轮改变的是“谁发取消、答案写到哪里”，不是 agent 对取消的反应；界面归属由判别性单元测试覆盖。Obsidian 面板不在 Node rig 中，live rig 看不到，故不新跑。

## 4. 修复

### 4.1 每个侧边会话共享一个取消

```ts
private sideCancels = new Map<string, Promise<AcpCancelOutcome | null>>();

private cancelSideChat(sideId: string, rt: SessionRuntime): Promise<AcpCancelOutcome | null> {
  const client = this.deps.runtime.getClient();
  if (!client) return Promise.resolve(null);
  if (rt.state.sessionId && !this.canAddressSession(rt.state.sessionId, client)) {
    return Promise.resolve(null);
  }
  const pending = this.sideCancels.get(sideId);
  if (pending) return pending;
  const cancel = client.cancel(sideId)
    .catch((e): AcpCancelOutcome => {
      console.warn('[co-ober] side chat cancel:', e);
      return 'unknown';
    })
    .finally(() => this.sideCancels.delete(sideId));
  this.sideCancels.set(sideId, cancel);
  return cancel;
}
```

- 面板的 `abort` 与 `endSideChat` 拿到同一个 Promise，只发一次请求。
- 抛出异常得到 `unknown`：没有结果不等于停止。
- 没有 client 或会话无法寻址时返回 `null`——没有问过的事不作声明，与标签页关闭的空闲路径一致。

### 4.2 `endSideChat` 返回结果，默认写进父标签页

```ts
endSideChat(rt, report: 'tab' | 'none' = 'tab'): Promise<AcpCancelOutcome | null> {
  const sideId = rt.sideChatSessionId;
  rt.sideChatSessionId = null;           // 同步清掉，重入即无事可做
  if (!sideId) return Promise.resolve(null);
  const cancel = this.cancelSideChat(sideId, rt);
  ...
  if (report === 'none') return cancel;
  return cancel.then((outcome) => {
    if (outcome && outcome !== 'stopped' && this.stillOpen(rt)) {
      rt.renderer.addSystemMessage(
        outcome === 'unsupported'
          ? t().error.sideChatClosedUnsupported
          : t().error.sideChatClosedUnknown,
      );
    }
    return outcome;
  });
}
```

- `report: 'tab'`：只关侧栏，父标签页还在——写进它的 transcript；若它是后台标签页，切换回去时能看到，与其他持久消息一致。
- `report: 'none'`：`closeTab` 与 `cancelAllStreams` 自己决定接收者。
- `stillOpen(rt)`：视图拆除或标签页已删除时不写进死面板。

### 4.3 三条关闭路径各自的接收者

- **只关侧栏**：`endSideChat(rt)` 默认 `'tab'`，写进父标签页。
- **关闭标签页**：`const sideOutcome = await this.endSideChat(rt, 'none')`，随后与主回合的结果一起写进继任标签页。两者分开陈述，因为 agent 可以给出不同答案（例如主回合 `unsupported`、侧栏 `unknown`）。
- **关闭视图**：`cancelAllStreams` 在计数前对每个运行时执行 `endSideChat(rt, 'none')`，把侧栏结果并入同一条 `Notice`。旧代码把侧栏取消留在 `dispose`，那时 Notice 早已决定，结果无处可去。
- **`/clear` 与 `dispose`**：`/clear` 仍用默认 `'tab'`（清理后说明仍然成立且可读）；`dispose` 在 `disposed = true` 之后调用，`stillOpen` 为假，不会写进死面板。

## 5. 边界测试

新增 7 个测试（2,547 → 2,554）：

1. `unsupported`：关闭侧栏后，父标签页出现 `sideChatClosedUnsupported`。旧代码不报告，即失败。
2. 取消抛出：出现 `sideChatClosedUnknown`。旧代码只 warn，即失败；把抛出折叠为 `stopped` 同样失败。
3. `stopped`：两条侧栏文案都不出现。若“每次关闭都报告”，即失败。
4. 面板手势：`abortSideChat()` 后紧跟 `endSideChat()`，`cancel` 恰好一次，且仍然报告。旧代码是两次且无报告，即失败。
5. 关闭同时有主回合与侧栏的标签页：主 `unsupported`、侧栏 `unknown`，继任标签页同时出现 `tabClosedUnsupported` 与 `sideChatClosedUnknown`。若不 await 侧栏结果，即失败。
6. 只有侧栏在运行的标签页：只报告侧栏文案，不出现 `tabClosedUnsupported`。
7. 视图关闭：主回合空闲、侧栏运行，`cancelAllStreams` 调用 `cancel('fork-a')`，Notice 计数为 1。若侧栏仍留在 `dispose` 里，即失败。

## 6. 回归计数

- 全量：86 个文件 / 2,554 个测试；本 Windows 主机 2,535 通过，19 失败。
- 19 个失败与 0.2.75–0.2.79 完全相同：`NativeSessionReader.test.ts` 18 个、`commandResolution.test.ts` 1 个，均为既有平台绑定问题，未修改。
- 控制器两个测试文件：422 个测试全部通过（265 + 157）。
- `tsc --noEmit`、ESLint（`--max-warnings=0`）均无输出。

## 7. 仍未闭合

1. **`stopped` 仍只由 mock 覆盖。** 2.0.28 没有取消方法，本机无法产生真实的 `stopped`。
2. **`session/close` 是否终止运行中的回合未测量。** 关闭侧栏时先发 cancel、随后发 closeSession（若 agent 声明支持）；后者对一个仍在运行的回合做了什么，未知。
3. **只测了 2.0.28。**
4. **后台标签页的说明不会把读者拉过去。** 这是与所有 transcript 消息一致的选择：留在那个标签页里，等读者切回去。不是丢弃，但也不是即时提示。

至此，0.2.74 列出的取消结果丢弃点（Stop、看门狗、`/compact`、标签页关闭、视图关闭、侧边聊天）都已有了接收者。下一轮不再是“再找一个丢弃点”，而是回头测量：实现取消的 agent 上的 `stopped`、`session/close` 与活回合的关系。

## 8. 与 0.2.74–0.2.79 的关系

- 0.2.74：Stop 不再谎报“已停止”，取消返回三态。
- 0.2.76：看门狗把三态写进超时错误。
- 0.2.77：`/compact` 把三态变成发送条件。
- 0.2.78：标签页关闭把三态交给继任会话。
- 0.2.79：视图关闭把三态交给面板之外仅存的全局提示。
- 0.2.80：侧边聊天把三态交给父标签页；标签页/视图关闭时并入既有报告。

六轮共享同一条规则：**没有证据的“已停止”不允许被当作事实使用。** 这一轮还多了一条：**同一次关闭不应该问两遍，然后把两个答案都丢掉。**
