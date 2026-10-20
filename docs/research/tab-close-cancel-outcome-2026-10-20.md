# 关闭标签页时，停止的答案该留在哪里（0.2.78）

- 日期：2026-10-20
- 内核：OpenCode `v2.0.28`（`opencode acp`）
- 范围：`CoOberViewController.closeTab`（及经由它的 `deleteSession`）、取消文案
- 结论：关闭运行中的标签页时保留 `cancel()` 的三态；`unsupported` / `unknown` 写入继承该位置的会话，`stopped` 保持安静，空闲关闭不作任何声明

## 1. 本轮验收标准

0.2.74 的“仍未覆盖”把取消结果的丢弃点列为：标签页关闭、视图关闭、侧边聊天。0.2.77 修掉了 `/compact` 这个“客户端自己接着发送”的最危险路径，并在文档中写明：其余路径发生时承载消息的界面正在被移除，必须先决定“关闭后由谁接收这条事实”。

本轮只取其中一处，并把接收者定清楚：

> 当关闭一个正在运行的标签页、而 agent 未能确认该回合停止时，关闭后仍然存在的那个会话必须说明这一点；agent 确认停止时不得重复声明。

选择标签页关闭优先，因为它是三处中唯一有明确继任者的：关闭后要么有下一个标签页，要么有空白的占位运行时，读者就在那里。

## 2. 修改前的行为

```ts
if (rt.busy) {
  rt.busy = false;
  rt.state.isStreaming = false;
  rt.streamCtrl.finalizeBufferedToolCalls();
  if (client && rt.sessionId && this.canAddressSession(rt.sessionId, client)) {
    try {
      await client.cancel(rt.sessionId);
    } catch (e) {
      console.error('[co-ober] cancel closed tab:', e);
    }
  }
}
```

`cancel()` 自 0.2.74 起返回三态，自 0.2.76 起由 `AgentRuntime` 转发；这里既不读返回值，也把异常只交给控制台。随后标签页从 strip 上删除、面板被 `disposeTabPanel` 移除。也就是说：客户端**刚刚问过** agent 能不能停下、也**拿到了答案**，然后把唯一能写这条答案的界面销毁了。

## 3. 依据的实测（不新跑 rig）

本轮没有新的内核行为需要测量；它复用前两轮已经测得的两个事实：

1. **2.0.28 没有取消方法。** 0.2.74 对九种写法（`session/cancel`、`cancel`、`session/abort`、`abort`、`session/interrupt`、`interrupt`、`session/stop`、`stop`、`session/cancel_notification`）逐一实测，全部返回 `-32601 "Method not found"`，而同一连接上的 `session/set_mode` 正常应答；已提交的 prompt 在 Stop 之后仍在 transcript 中，回合仍在运行。
2. **取消往返的时间。** 0.2.76 的空闲看门狗 rig 测得：4000 ms 窗口触发后，`cancel` 用时 545 ms 返回 `unsupported`，本地流计数归零。因此关闭标签页时的 `unsupported` 不是“没来得及问”，而是问过并被拒绝。

本轮改变的是这条事实**被写到哪里**，不是 agent 收到取消后做什么。UI 层的边界用判别性单元测试覆盖即可，live rig 不会看到 Obsidian 面板，因此不新跑。

## 4. 修复

### 4.1 保留三态

```ts
let cancelOutcome: AcpCancelOutcome | null = null;
if (rt.busy) {
  ...
  if (client && rt.sessionId && this.canAddressSession(rt.sessionId, client)) {
    try {
      cancelOutcome = await client.cancel(rt.sessionId);
    } catch (e) {
      console.error('[co-ober] cancel closed tab:', e);
      // Nothing came back, and nothing read is not evidence of a stop.
      cancelOutcome = 'unknown';
    }
  }
}
```

`null` 表示“没有发起取消”，与 `unknown`（发起了、但没读到结果）区分开。旧代码把两者混为一谈：都只剩一行 console。

### 4.2 在继任者里说明

```ts
this.notifyTabsChanged();
this.persistTabShell();
if (!this.disposed && (cancelOutcome === 'unsupported' || cancelOutcome === 'unknown')) {
  this.activeRuntime.renderer.addSystemMessage(
    cancelOutcome === 'unsupported' ? t().error.tabClosedUnsupported : t().error.tabClosedUnknown,
  );
}
```

- 位置放在激活逻辑之后：关闭活动标签页时 `activeRuntime` 已切到下一个标签页；关闭最后一个时已切到占位运行时（它的面板由 `createTabPanel` 创建，是当前可见面板）。
- 关闭后台标签页时 `activeRuntime` 不变，说明落在读者正在看的会话里。
- `stopped` 不写：关闭动作本身已经兑现了它声称的事。
- `disposed` 时跳过：视图正在拆除，没有任何存活的阅读面。
- `deleteSession` 经由 `closeTab` 关闭，因此自动继承该行为。

文案（中英各两条）说明三件事：关闭发生在回合运行中；原因是 agent 没有取消方法，或没有确认停止；没有标签页能再显示这一轮接下来做了什么。

## 5. 边界测试

新增 6 个测试（2,537 → 2,543），全部在 `CoOberViewController.multiTab.test.ts`：

1. `unsupported`：关闭后台运行中的标签页，说明出现在存活标签页；被关闭标签页的 renderer 没有被写入。若退回“await 后丢弃”，即失败。
2. 取消抛出：说明为 `tabClosedUnknown`。旧代码只 `console.error`，即失败；把抛出折叠为 `stopped` 同样失败。
3. `stopped`：存活标签页既没有 `tabClosedUnsupported` 也没有 `tabClosedUnknown`。若“每次关闭都报告”，即失败。
4. 空闲标签页：不调用 `cancel`，占位运行时没有系统消息。若“没发起取消也报告”，即失败。
5. 关闭最后一个运行中的标签页：`listTabIds()` 为空，说明落在新建占位运行时的 renderer 上。若写进已销毁的标签页，即失败。
6. `deleteSession` 在回合中删除会话：沿用同一路径，说明出现在存活标签页。

## 6. 回归计数

- 全量：86 个文件 / 2,543 个测试；本 Windows 主机 2,524 通过，19 失败。
- 19 个失败与 0.2.75–0.2.77 完全相同：`NativeSessionReader.test.ts` 18 个、`commandResolution.test.ts` 1 个，均为既有平台绑定问题，未修改。
- 控制器两个测试文件：411 个测试全部通过（150 + 261）。
- `tsc --noEmit`、ESLint（`--max-warnings=0`）均无输出。

## 7. 仍未闭合

1. **视图关闭（`cancelAllStreams`）仍丢弃结果。** 关闭视图时没有任何标签页存活，面板也不复存在。可用的存活界面只剩 Obsidian 的 `Notice`（toast），但那是全局表面，是否该在关窗时弹出、弹几条、如何聚合，需要单独决定。
2. **侧边聊天关闭（`abortSideChat`）仍丢弃结果。** 面板关闭时父标签页通常还在，理论上可以写回父标签页；但关闭标签页时 `endSideChat` 也会走到它，彼时父面板正在销毁，写进去仍然没有读者。需要区分“只关侧栏”和“连标签页一起关”。
3. **`stopped` 分支只由 mock 覆盖。** 2.0.28 没有取消方法，无法在本机产生真实的 `stopped`；等遇到实现了取消的 agent 才能实测。
4. **关闭后会话仍在 agent 内。** 本轮只是把“可能仍在运行”说出来；`releaseAgentSession` 会尝试 `session/close`（若 agent 声明支持），但它是否终止一个正在运行的回合，尚未测量。
5. **只测了 2.0.28。**

## 8. 与 0.2.74–0.2.77 的关系

- 0.2.74：Stop 不再谎报“已停止”，取消返回三态。
- 0.2.76：看门狗放弃等待时，把三态写进超时错误。
- 0.2.77：客户端要发下一条 prompt 时，把三态变成发送条件。
- 0.2.78：用户要移走阅读面时，把三态交给仍然存在的阅读面。

四轮共享同一条规则：**没有证据的“已停止”不允许被当作事实使用。** 动作各不相同——如实叙述、拒绝发送、换一个地方叙述——但都不把“没有答案”说成“已经停下”。
