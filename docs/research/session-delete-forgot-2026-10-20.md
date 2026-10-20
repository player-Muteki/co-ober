# `close` 只是放手，`delete` 才是忘记——删除会话的兑现与不兑现（0.2.82）

- 日期：2026-10-20
- 内核：OpenCode `v2.0.28`（`opencode acp`），本轮重新搭 rig 实测
- 范围：`AcpClient.deleteSession`、`CoOberViewController.deleteSession`、`AcpMethodNames`、`AgentCapabilities.sessionCapabilities.delete`、i18n en/zh
- 结论：2.0.28 提供 `session/delete` 且真的忘记（列表、载入、进程重启后都不回来）；`close` 只释放连接，会话留在数据库里。删除路径接上内核，删不掉时如实说，没承诺过的不瞎报

## 1. 本轮验收标准

0.2.81 实测发现 close 的副作用边界："close 之后会话仍在 `session/list`，重启后回来"。而插件里用户点"删除会话"时，0.2.81 之前的流程是 `closeTab`（内含 close）+ 本地镜像 `sessionStore.remove`——内核那行记录从没被要求消失。验收标准：

> 在真实内核上测量 `session/delete` 与 `close` 的语义差异：应答、列表、重启后存在性、对已删 id 的操作、以及 close 之后 delete 还能不能寻址。若内核支持，删除路径必须让内核真的忘记；做不到或失败时，读者必须能分辨"删了"与"只是本地不显示了"。

## 2. 修改前的行为

```ts
// CoOberViewController.deleteSession（0.2.81 版）
if (rt) await this.closeTab(rt.tabId);      // close 释放，不忘记
this.deps.sessionStore.remove(sessionId);   // 只删本地镜像
await this.deps.sessionStore.save();
```

用户看到的"删除"在内核侧只是 close：会话仍在 `session/list` 里、仍可 `session/load`、插件进程重启后照旧出现。本地列表把它藏起来了，历史从哪来、往哪回去，都没有一句话说明。

## 3. rig 与实测

两个临时装置（不入库），spawn `opencode acp`，newline-delimited JSON-RPC。

### 3.1 能力声明

`initialize` 返回 `sessionCapabilities: { additionalDirectories:{}, close:{}, delete:{}, fork:{}, list:{}, resume:{} }`。`normalizeAgentCapabilities` 按组动态拷贝键，`{}` → `true`，所以 `delete: true` 无需改归一化代码。

### 3.2 close 与 delete 的语义差（session-delete.mjs）

同一次运行里开两个会话 A、B，A 走 close，B 走 delete，再断连重连对照：

```
A.close               -> {} （应答为空对象）
A.inListAfterClose    -> true            ← close 不除名
B.delete              -> {}
B.inListAfterDelete   -> false           ← delete 除名
B.promptAfterDelete   -> ERR -32602 "Invalid params: session not found: ses_…"
A.stillListed         -> true
重连后 A.inList        -> true
重连后 A.load          -> OK（configOptions 完整返回）
重连后 B.inList        -> false          ← 重启/重连后 delete 仍有效
重连后 B.load          -> ERR -32602 "session not found"
```

**close = 释放（停回合、松开连接占用），delete = 忘记（数据库行消失）。** 二者应答同为 `{}`，语义完全两样。

### 3.3 close 之后 delete 仍可寻址（delete-after-close.mjs）

0.2.81 遗留的一个疑问：先 close 再 delete，id 会不会已经不可寻址？

```
previously-closed session found: ses_ea700a85bffe…
deleteAfterClose: { ok: true }   （应答 {}）
goneFromList: true
```

close 不影响 delete 的寻址。删除流程可以放心地"先关标签页（含 close），再 delete"。

## 4. 结论与修复

### 4.1 client 层

- `AcpMethodNames`：逻辑名 `deleteSession` → 线名 `['session/delete', 'deleteSession']`。
- `AcpClient.deleteSession(id): Promise<boolean>`：先清 `loadedSessionIds`/`sessionMeta`（与 `closeSession` 一致），请求成功 → `true`，任何失败 → `false` 且不抛出。
- `index.ts` / `agent.ts` / `types.ts`（`sessionCapabilities.delete?: boolean`）逐层接通。

### 4.2 视图层门槛

```ts
const deletable =
  !!client?.getAgentCapabilities?.()?.sessionCapabilities?.delete &&
  !!client && typeof client.deleteSession === 'function' &&
  this.canAddressSession(sessionId, client);
const deleted = deletable ? await client.deleteSession(sessionId) : false;
this.deps.sessionStore.remove(sessionId);
await this.deps.sessionStore.save();
if (deletable && !deleted && !this.disposed) {
  this.activeRuntime.renderer.addSystemMessage(t().error.sessionDeleteUnconfirmed);
}
```

三种世界各得其所：

1. **内核承诺能忘（声明 delete）且忘了**——静默，如实，不再多一句"已删除"的邀功。
2. **内核承诺能忘却没忘掉**（delete 失败/被拒）——系统消息 `sessionDeleteUnconfirmed`："该会话已从本 vault 移除，但 agent 没有确认删除 —— 它的历史可能仍留在它内部。"本地镜像确实删了，内核那行可能还在，后半句正是读者需要的。
3. **内核没承诺过**（不声明 delete）——不指责它没提供一个它从没提供的方法，静默，与旧行为一致。

`canAddressSession` 门槛沿用 0.2.78 的绑定判定：本地镜像与内核地址对不上的会话不发 delete。

## 5. 边界测试

新增 5 个（2,562 → 2,567）：

1. `forgets a session the agent accepted for deletion`（acp.test）：应答 `{}` → `true`，meta 被清，线上证 `session/delete` + `{ sessionId }`。
2. `deleteSession delegates to acp`（agent.test）。
3. `asks the kernel to forget a session it can forget`（view）：能力声明 + 可寻址 → `client.deleteSession` 被调用，本地镜像移除。
4. `says so when a kernel that promised to forget did not`（view）：delete 答 `false` → 出现 `sessionDeleteUnconfirmed`。
5. `does not ask an agent without the delete capability, and does not claim it failed`（view）：不声明 → 不发 delete、也不出消息。

回退检验已做：摘掉视图门槛（`deletable = false`）并让 `acp.deleteSession` 直接返回 `false`，恰且 1、3、4 三个用例失败，2、5 与其余全量不受影响；恢复后 463 测试绿。

## 6. 回归计数

- 全量：86 个文件 / 2,567 个测试；本 Windows 主机 2,548 通过，19 失败。
- 19 个失败与 0.2.75–0.2.81 完全相同（`NativeSessionReader.test.ts` 18 个、`commandResolution.test.ts` 1 个），既有平台绑定问题，未修改。
- `tsc --noEmit` 无输出；`npm run lint`（`eslint src --max-warnings=0`）无输出。
- 两个 rig 在本轮收尾时重跑，读数与首次逐行一致（§3 即重跑实录）。

## 7. 仍未闭合

1. **delete 之外的存储足迹未测**：实测的是 ACP 读面（list/load/prompt/重启）。内核是否另有会话文件（日志、导出、`~/.local/share/opencode` 下的附属数据）不随 delete 消失，未测——"忘记"的断言以 ACP 可见状态为限。
2. **delete 能力门槛的外推**：与 0.2.81 §7.2 同型——一个声明 `delete` 却应答不落库的 agent 会把"已忘"当成事实。判定依据只有"应答成功"这一条实测证据。
3. **本地 sqlite 读面与 delete 的联动**：`NativeSessionReader` 读同一个数据库；delete 成功后它应当同样看不见，本轮未把这一条写进 rig（18 个平台绑定失败使该测点在主机上本来就不可靠）。
4. **侧聊 fork 会话的归宿**：`endSideChat` 仍只 close——侧聊结束后 fork 留在内核列表里。要不要顺手 delete 是产品决定，需要连同"用户是否会想找回侧聊"一起实测。
5. **历史列表/恢复路径对已删 id 的引用**（0.2.81 §7.4 延续）：`deleteSession` 清了本连接的 meta，其它模块缓存的 id 未逐一审计。

## 8. 与 0.2.81 的关系

0.2.81 证明了 close 是这颗内核上的**停止机制**；本轮证明 close 不是**遗忘机制**。同一个 `{}` 应答，两种语义——不实测就会把"释放"当成"删除"卖给用户。删除路径从此按实测分叉：停回合用 close（0.2.81），忘历史用 delete（0.2.82），各自的"没做到"各有各的措辞。
