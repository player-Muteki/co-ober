# 面板关闭后，谁来说“可能还在跑”（0.2.79）

- 日期：2026-10-20
- 内核：OpenCode `v2.0.28`（`opencode acp`）
- 范围：`CoOberViewController.cancelAllStreams`（视图关闭）、取消文案
- 结论：聚合本轮所有取消结果；`unsupported` / `unknown` / 抛出计为“未确认停下”，用一条 `Notice` 在面板消失后说明数量；`stopped` 不计，全部确认时保持安静

## 1. 本轮验收标准

0.2.78 关闭了标签页关闭时的丢弃点，并在“仍未闭合”中写明：视图关闭（`cancelAllStreams`）没有任何存活的标签页，标签页关闭时 `endSideChat` 又会销毁可能写入说明的面板，因此必须先给这类事实选一个接收者。

本轮取视图关闭：

> 当视图关闭时，客户端取消了若干正在运行的回合；凡 agent 未确认停止的，必须在视图消失之后仍有一个界面说清有几轮可能还在运行。

## 2. 修改前的行为

```ts
async cancelAllStreams(): Promise<void> {
  const client = this.deps.runtime.getClient();
  for (const rt of this.runtimes.values()) {
    if (!rt.busy) continue;
    ...
    if (client && rt.sessionId && this.canAddressSession(rt.sessionId, client)) {
      try {
        await client.cancel(rt.sessionId);
      } catch (e) {
        console.error('[co-ober] cancel on close:', e);
      }
    }
  }
  this.deps.input.setStreaming(false);
  this.deps.toolbar.setSending(false);
}
```

三态既不读取也不聚合。`CoOberView.onClose` 紧接着执行 `dispose()`，销毁所有面板、标签条与 welcome；也就是说，唯一能写“没停下”的地方在同一段代码里被移除了。

## 3. 依据的实测（不新跑 rig）

与 0.2.78 相同，本轮没有新的内核行为：

1. 2.0.28 没有取消方法：0.2.74 实测九种写法全部 `-32601`，同一连接上的其它方法正常应答；Stop 之后 prompt 仍在 transcript 中。
2. 取消往返约 545 ms（0.2.76 看门狗 rig），因此 `unsupported` 是“问过并被拒绝”，不是“没来得及问”。

本轮改变的是答案的接收者，不是 agent 的行为；Obsidian 的 toast 不出现在 Node rig 中，live rig 无法观察，故边界用判别性单元测试覆盖。

## 4. 修复

### 4.1 聚合并计数

```ts
let unconfirmed = 0;
let sawUnknown = false;
...
try {
  const outcome = await client.cancel(rt.sessionId);
  if (outcome === 'stopped') continue;
  unconfirmed++;
  if (outcome === 'unknown') sawUnknown = true;
} catch (e) {
  console.error('[co-ober] cancel on close:', e);
  // A cancel that threw observed nothing, so it cannot count as a stop.
  unconfirmed++;
  sawUnknown = true;
}
```

规则：

- `stopped`：不计。
- `unsupported`：计为未确认，但不标记 `sawUnknown`。
- `unknown` / 抛出：计为未确认，并标记 `sawUnknown`。
- 没有发起取消（无 client、无 sessionId、无法寻址）：不计；这一点与标签页关闭一致，不对没有问过的事作声明。

### 4.2 用 Notice 作为唯一存活的界面

```ts
if (unconfirmed > 0) {
  const key = sawUnknown ? t().error.panelClosedUnknown : t().error.panelClosedUnsupported;
  new Notice(key.replace('{count}', String(unconfirmed)));
}
```

- 为什么不是系统消息：面板即将全部销毁，写进去没有读者；会话记录在 `persistTabShell` 与 `save` 之后也不再落盘。
- 为什么不是“永远按 unsupported”：混合结果里只要有一轮是 `unknown`，就不能声称“这个 agent 没有取消方法”——那不是每一份答案支持的事实。此时选择更弱、但覆盖全部计数的说法：“没有确认它们停下”。
- 全部确认时保持安静：关闭动作已经兑现了它声称的事。
- 文案说明数量与不确定性，不承诺 agent 会自己结束。

## 5. 边界测试

新增 4 个测试（2,543 → 2,547），位于 `CoOberViewController.multiTab.test.ts` 的 teardown 组：

1. 一轮 `unsupported` + 一轮 `stopped`：Notice 为 `panelClosedUnsupported`，计数 1。若退回“await 后丢弃”，即失败。
2. 一轮 `unsupported` + 一轮 `unknown`：Notice 为 `panelClosedUnknown`，计数 2，且不出现 `panelClosedUnsupported`。若混用时仍声称“没有取消方法”，即失败。
3. 一轮 `stopped` + 一次抛出的取消：Notice 为 `panelClosedUnknown`，计数 1。若把抛出当作停止，即失败。
4. 两轮都 `stopped`：Notice 列表为空。若“每次关闭都报告”，即失败。

## 6. 回归计数

- 全量：86 个文件 / 2,547 个测试；本 Windows 主机 2,528 通过，19 失败。
- 19 个失败与 0.2.75–0.2.78 完全相同：`NativeSessionReader.test.ts` 18 个、`commandResolution.test.ts` 1 个，均为既有平台绑定问题，未修改。
- 控制器两个测试文件：415 个测试全部通过（154 + 261）。
- `tsc --noEmit`、ESLint（`--max-warnings=0`）均无输出。

## 7. 仍未闭合

1. **侧边聊天（`abortSideChat`）仍丢弃结果。** 它有两个入口：只关侧栏时父标签页还活着，可以写回父标签页；而 `endSideChat` 在关闭标签页与视图拆除时也会调用它，那时父面板正在销毁。必须先区分“只关侧栏”与“连父级一起关”，才能决定写到哪里——这是下一轮。
2. **`stopped` 分支只由 mock 覆盖。** 2.0.28 没有取消方法，本机无法产生真实的 `stopped`。
3. **`session/close` 是否终止运行中的回合未测量。** 关闭标签页会尝试释放 agent 会话，但它与“取消”是两回事。
4. **只测了 2.0.28。**

## 8. 与 0.2.74–0.2.78 的关系

- 0.2.74：Stop 不再谎报“已停止”，取消返回三态。
- 0.2.76：看门狗放弃等待时，把三态写进超时错误。
- 0.2.77：客户端要发下一条 prompt 时，把三态变成发送条件。
- 0.2.78：标签页关闭时，把三态交给继承位置的会话。
- 0.2.79：视图整体关闭时，把三态交给面板之外仅存的全局提示。

五轮共享同一条规则：**没有证据的“已停止”不允许被当作事实使用。** 每轮只是换一个动作或换一个接收者。
