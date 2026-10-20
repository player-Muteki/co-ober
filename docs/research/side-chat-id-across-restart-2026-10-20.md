# 重启后，/btw 线程的 id 也要跟着标签页壳回来（2026-10-20，0.2.88）

## 验收标准

一个标签页带着打开过的 /btw 侧聊线程退出（或 kernel 死掉）之后，插件重启：

1. 该线程的 id 必须还被某处记录着，`deleteSession` 删除父会话时能把线程一起忘掉；
2. 侧聊面板关闭后，盘上的记录必须同步消失——不能让下一次启动复活一个已经被释放的线程；
3. 记录里若是一个已经不存在的 id，整条链路必须保持沉默——不能因为"删不掉"而谎报 `sideChatDeleteUnconfirmed`。

## 修改前行为

`sideChatSessionId` 只活在内存里的 `SessionRuntime` 上。TabShell（data.json 的
`openTabs`）只存 `tabId / sessionId / draft`。于是：

- 退出 Obsidian（或 kernel 进程死掉）后重启，标签页回来了，线程 id 没了；
- 0.2.87 的删除兜底 `const sideId = rt?.sideChatSessionId ?? null` 读到 null——删除只带得走父会话，fork 行留在库里，
  挂着指向已删父行的 `fork_session_id`，被 0.2.85 的 lineage 过滤从所有列表里藏起来。没有任何手势还能再点名它。

## 依据的实测（rig：Temp/co-ober-rig/fork-restart.mjs，v2.0.28，本机库）

先杀 kernel 再验"泄漏是持久的"，再验"幽灵 id 是否安全"：

| 读数 | 结果 |
| --- | --- |
| p1.rows（杀进程前） | main `fork_session_id=null, title "ALPHA"`；fork `fork_session_id=main, title "ALPHA (fork #1)"` |
| 杀掉 kernel 进程后直接读库（between.rows） | main 与 fork 两行**原样存活** |
| 新进程 `session/load` 旧 fork id | ok |
| 新进程 `session/delete` 旧 fork id | ok `{}`，随后行消失 |
| 对新进程再删同一个（已删）id | ok `{}` |
| 删一个从未存在的 id（`ses_neverexisted0000000000`） | ok `{}` |
| final.rows | main=null, fork=null（rig 自清理） |

结论三条：

1. fork 行跨 kernel 进程死亡存活——重启不消灭泄漏，只是忘掉地址；
2. 新进程完全能够负荷 load/delete 旧 fork——只要有人持有 id；
3. 对"已删除"和"从未存在"的 id，delete 都回答 ok `{}`——持久化的陈旧 id 永远不会触发
   `sideChatDeleteUnconfirmed`，这条兜底天然不会说谎。（注：这三条是 kernel 事实；"壳里带 id"、
   "恢复时赋值"、"关闭时抹掉"是本插件自己的契约，不来自 rig。）

## 修复（单点：把 id 放进壳，并让它随生随灭）

- `src/types.ts`：`TabShell` 增加可选字段 `sideChatSessionId?: string`；
- `persistTabShell`：运行时若持有侧聊 id 就写进壳；`startSideChat` 开面板后立即 `persistTabShell()`
  （id 一存在就上盘），`endSideChat` 清 id 后也 `persistTabShell()`（id 一死就从盘上抹掉）；
- `restoreTabShells`：恢复循环里把壳上的 id 赋回对应 runtime——注意赋值发生在末尾的
  `persistTabShell()` 重写之前，恢复出来的线程不会在下一次落盘时被丢掉；
- `pluginDataMigration.migratePluginDataTabs`：消毒器逐字段重建壳，必须显式放行该字段——
  字符串且非空才带过来，数字/空串一律视同没有。
- `session.ts` 的 `hydrateTabShell/setTabShell` 是 `{...tab}` 展开拷贝，字段自动随行，无需改动。

下游无需改动即自动获益：`deleteSession`（0.2.87）读的就是 `rt.sideChatSessionId`；
空闲关闭走 0.2.86 的静默 release；同一标签再次 /btw 复用旧 id（fork 连续性），与重启前行为一致。

## 边界测试（4 个新测试）

1. `migratePluginDataTabs` 带回首发的 id；数字与空串被抹掉、标签页保留；
2. `startSideChat` 后，`setTabShell` 末次调用的壳上带 `forked-session`；
3. `endSideChat` 前壳上必须已带 id（正向锚点，保证测试可判别）、之后壳上不再有 id；
4. 模拟重启：`restoreTabShells` 只交回带 id 的壳（内存从未有过 id），随后 `deleteSession`
   必须对父会话与 `fork-a` 各删一次、共两次，且不说 `sideChatDeleteUnconfirmed`。

## 回归计数

- 回退验证：备份三个生产文件后 `git checkout --` 还原，全套只剩这 4 个新测试红——
  X = 23 = 19（平台绑定，永不修）+ 4；恢复修复后复跑全绿。
- 全套：2588 = 2584 + 4（86 文件；失败恰好为原有 19 个平台绑定用例）。
- `npx tsc --noEmit` 0；`npm run lint` 0。

## 仍未闭合

1. 本版本之前遗留的孤儿线程无法追认——它们的 id 从未上过盘，库里那些挂着悬空
   `fork_session_id` 的行仍需要一个清理入口（见 0.2.87 文档 §7 的同一问题）；
2. 重启恢复的是线程的"身份"而不是面板本身：用户需再次 /btw 才会接上旧线程，
   面板不会自己弹回来（有意为之，壳不该记住 UI 开合）;
3. 侧聊线程没有自己的标题/历史入口，列表页仍然看不见它（同 0.2.87 遗留）；
4. 0.2.86 §8 的 hasSubmittedPrompt 空闲审计问题不变。
