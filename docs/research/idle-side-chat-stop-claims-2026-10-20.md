# 空闲侧边聊天的关闭，不该向不存在的回合要停止证据（0.2.86）

- 日期：2026-10-20
- 内核：OpenCode `v2.0.28`（`opencode acp`）
- 范围：`SessionRuntime`、`CoOberViewController.buildSideChatAsk` / `endSideChat`
- 结论：侧边线程只有在"确有回合在回答"时才被请求停止并合成停止证据；空闲关闭照常发出释放用的 `closeSession`，但对"停止"一事保持沉默

## 1. 本轮验收标准

0.2.80 把侧边聊天的取消结果交给了养活它的标签页，但它回答的是"关掉的回合停没停住"；它没有能力回答"有没有回合可关"。侧栏面板（`SideChatPanel`）自己清楚：`close()` 只在 `this.busy` 时才 `abort?.()`，空闲关闭不 abort。可它的 `onClose` 钩子随后无条件调 `endSideChat`，而后者在修复前的第一件事就是 `cancelSideChat`——向一个没有任何东西在跑的侧边会话发取消，并拿这个取消的回答去合成"停止证据"。

本轮验收标准：

> 关闭一个处于空闲（两次回答之间）的侧边线程：不得向内核发出取消请求，不得写"可能仍在回答"之类的行，不得计入视图关闭的未确认计数；但释放会话的 `closeSession` 必须照常执行——否则叉出的会话在 agent 侧泄漏。

## 2. 修改前的行为

```ts
endSideChat(rt, report) {
  const sideId = rt.sideChatSessionId;
  rt.sideChatSessionId = null;
  if (!sideId) return Promise.resolve(null);
  const cancel = this.cancelSideChat(sideId, rt);   // ← 不问有没有在飞的回合
  const closing = /* 有 close 能力且父会话可寻址时 closeSession(sideId) */;
  return Promise.all([cancel, closing]).then(([outcome, closed]) => {
    const evidence = outcome && outcome !== 'stopped' && closed ? 'closed' : outcome;
    ...
    if (evidence && evidence !== 'stopped' && evidence !== 'closed') // 写进行
  });
}
```

控制器此前没有任何"这个线程正在回答"的见证。面板有 `isBusy()`，但 `endSideChat` 拿不到它：`close()` 先清 DOM 再调 `onClose`，届时面板已拆；而 `closeTab` / `cancelAllStreams` / `dispose` 三条路径根本经过面板，谈不到向面板要状态。

## 3. 依据的实测（不新跑 rig）

本轮是插件层的过度声明，不需要新的内核读数；被误用的答案全是此前量过的：

- **0.2.74**：`session/cancel` 在 2.0.28 未实现，RPC 回 `-32601`；`acp.ts` 的 `cancel()` 把每个候选方法都 -32601 的情形映射为 `'unsupported'`（src/client/acp.ts:1218）。
- **0.2.81**（docs/research/session-close-live-turn-2026-10-20.md）：回合在飞时会话关闭会终止那个在飞的 prompt，故 accepted close 可以作证"停住了"。
- **0.2.85**（docs/research/ghost-fork-lineage-2026-10-20.md）：关闭**空闲**会话只是释放——之后 load/prompt/list 全部照常。释放合法，但它从不曾是对"停止"的证据：它没有终止任何东西，因为本来就没有东西在跑。

把这三条放在一起：空闲关闭发出的取消必然回答 `'unsupported'`，这个 `'unsupported'` 描述的是内核没有 cancel 方法这一事实，与"这个线程的某个回合没停住"毫无关系。拿它当后者的证据，是在对不存在的回合做声明。

## 4. 虚假何时漏出 surface

诚实起见要说清流行度：在 2.0.28 的**主路径**上，这条假话大多被掩盖——close 能力在场、父会话可寻址、空闲 close 被接受，`'closed'` 把 `'unsupported'` 顶掉，读者什么也看不见。漏出来的路径：

1. **释放被跳过时**：父会话在此 client 上不可寻址（重连、会话迁移之后），或 agent 未 advertise close。`closing` 恒为 false，`'unsupported'` 直通成"侧边聊天可能仍在回答"——一个从没人向它要过停止的线程被报告为停不住。
2. **视图关闭的计数**：`cancelAllStreams` 把每条 `endSideChat` 的非停止证据累进 "已停止 {count} 个可能仍在回答的回合" 的 Notice。空闲线程在 close 被跳过或未被接受时混进计数，虚报的个数本身就是错的。
3. **即便主路径被掩盖**，每次空闲关侧栏都白向内核发一个必然 -32601 的请求，并为它 `await` 一轮——行为的错误先于文案的错误。

## 5. 修复

见证跟着标签页走，放在 `sideChatSessionId` 旁边——`SessionRuntime.sideChatBusy`：

```ts
// buildSideChatAsk 内
rt.sideChatBusy = true;            // 在首个 await 之前同步抬起
try {
  return await client.sendMessage(sideId, [{ type: 'text', text }], onChunk);
} finally {
  rt.sideChatBusy = false;         // 答案落定（正常或抛错）即熄灭
}
```

`endSideChat` 在清掉 `sideChatSessionId` 之前记下 `wasBusy`；`closing`（释放）照旧先算先发——空闲关闭仍要释放会话，这是 0.2.85 量到的合法动作；但 `!wasBusy` 时直接返回 `null`：不 `cancelSideChat`，不合成证据，不写行，不进计数。`abortSideChat` 不加门：面板只在 busy 时才 abort，能走到它就已经是在飞的回合。

为什么用 try/finally 而不是在响应回调里清：ask 的 promise 落定即回合终（stopReason 到达），抛错同样算落定；面板的 `send()` 在自己的 finally 里复位它私有的 busy，两边互不依赖。

## 6. 边界测试

- 空闲关闭：`cancel` 不发、`closeSession` 仍发（释放）、`endSideChat`  resolves `null`、不写任何停止行。
- busy 见证的生命周期：ask 挂起期间为 `true`（首个 await 前已抬起），落定/抛错后回 `false`。
- 视图关闭计数：空闲侧线程不计入 Notice（多标签页侧新增一例）。
- 既有的 12 例"关闭在飞侧栏"测试改为如实声明前提——mock 面板不会真的跑 ask，故直接 `rt.sideChatBusy = true` 标注该场景本就是一个在回答的回合；这些测试在修复前后都应绿色（修复前恒发取消，修复后被见证放行），改动只是把剧本写在明面上。
- 停止证据的全部既有语义回归不变：`stopped` 安静、accepted close 顶掉取消的 `unsupported`、抛出的取消算 unconfirmed、broken close 不吞答案、abort 与 close 共享一次取消。

revert-check：把两个生产文件还原到提交前（门与见证消失），恰好上述 4 例新测试失败，其余全绿。全量 X=23 = 19（平台绑定的既有失败）+ 4。

## 7. 回归计数

- 0.2.85：2577 测（含 19 例既有平台失败）。
- 0.2.86：新增 4 例 → 总 2581 测；全量 `2562 passed / 19 failed`，tsc 0，lint 0。

## 8. 仍未闭合

- 见证是同步的，但面板真实的 `send()` 在 `open(question)` 里以 `void` 起跑——从"用户按下回车"到"ask 包装器抬旗"之间隔着面板的守卫判断。守卫拒绝（主聊天忙）时 ask 根本不会起跑，旗也不会抬，与本轮语义一致；没有窗口可让空闲关闭误认成在飞。此判断基于代码走读，未做面板级集成测量。
- 内核若哪天实现了 cancel，`'unsupported'` 一条会消失，但"没有回合就不问停止"的门与答案内容无关，届时仍然正确。
- `hasSubmittedPrompt` 一类"问内核要证据"的路径本轮未复查它们是否也对空闲态发过无意义的请求。
