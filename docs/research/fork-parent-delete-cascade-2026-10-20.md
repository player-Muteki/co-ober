# 忘掉一段会话不会带走它的侧边线程（0.2.87）

- 日期：2026-10-20
- 内核：OpenCode `v2.0.28`（`opencode acp`）
- 范围：`CoOberViewController.deleteSession`、i18n（en/zh 新增 `error.sideChatDeleteUnconfirmed`）
- 结论：实测证明 `session/delete` 无级联；插件删除会话时必须在同一个动作里忘掉它的 /btw 侧边线程，否则那行数据进入任何 UI 都无法再触及的状态

## 1. 本轮验收标准

0.2.85 给历史列表加了血缘过滤（`fork_session_id is null`），并在"仍未闭合"里把父删级联记为未测。本轮把它测掉：当用户删除一段带侧边线程的会话，那个线程的下场是什么？

> 删除一段对话，agent 接受了删除，则它的侧边线程不得作为"任何列表都看不见、任何手势都摸不到"的残留留在内核库里；若 agent 没确认侧边线程的删除，这个事实要说出来。

## 2. rig 与读数（fork-cascade.mjs，2026-10-20，全盘实测）

生命周期：`session/new` 父 → prompt（ALPHA）→ 两次 `session/fork`（子 A 保持打开、子 B prompt 后 `session/close` 释放）→ 各自转录落库 → **先删父**（`session/delete`，接受，result `{}`）→ sqlite 与协议两侧各读一遍：

| 读数 | 结果 |
|---|---|
| 父行 / 父消息 | 删空（null / 0 条） |
| 子 A 行（live）/ 消息 | **保留**（6 条消息完好），`fork_session_id` = 已消失的父 id |
| 子 B 行（先 close 过的）/ 消息 | **保留**（7 条消息完好），同样带着悬空血缘 |
| `session/load` 两个子 | 都 `ok`——连被 close 释放过的子仍可重新装载 |
| `session/prompt` 子 A | 照常回答 `end_turn` |
| ACP `session/list` | 两个子都在列表里；父不在 |
| 插件侧 0.2.85 过滤视图 | 两个子都被 `fork_session_id is null` 挡掉——**内核协议看得见，插件历史看不见** |
| 事后逐个 `session/delete` 子 | 都接受（含那个曾被 close 释放的） |
| 终局 | 全部行与消息归零，库无残留 |

附带观测（记录但不依赖）：子 B 的行在删除父并 `session/load` 之后 title 从 null 变成 "ALPHA"（replay 回填）——本轮修复不建立在这个行为上。

## 3. 为什么这是插件的责任

`deleteSession(sessionId)` 现状是：先 `closeTab`（其中 `endSideChat` 只对侧边线程做**释放**——0.2.85 实测释放不等于遗忘），再对父发 `session/delete`。父消失后，侧边线程：

- 在原生历史里被 0.2.85 血缘过滤永久隐藏；
- 不在插件会话镜像里（/btw 的 fork 从不进 `sessionStore`）；
- 没有任何面板或下拉能点名它——它的 id 此前只活在 `rt.sideChatSessionId` 这个内存字段里，而标签页马上就被拆了。

"如果这次删除不带走它，就再也没有任何手势能带走它。" 级联不在内核里发生（实测），那它就是插件语义的一部分：用户说"删掉这段对话"，这段对话连同它的草稿线程一起消失。

## 4. 修复

单点，全在 `deleteSession`：

1. **在 `closeTab` 拆掉一切之前**捕获 `rt?.sideChatSessionId`——`endSideChat` 会把它清成 null，读完再删是唯一诚实的顺序。
2. 父删（原有门：advertise delete、可寻址、RPC 确认）之后，对捕获到的 side id 走**同一道门**发第二次 `session/delete`。顺序是父先子后：0.2.85 rig 量过子先父后也成立，本轮 rig 量过父先子后成立；选父先，是为了让"这段对话没了"这个主要事实先落定。
3. 报告：父被确认、子没被确认 → 新增一行 `error.sideChatDeleteUnconfirmed`（"该会话已移除，但 agent 没有确认删除它的侧边聊天 —— 那条线程可能仍留在它内部，在历史里看不见。"）。en/zh 同步。没有 delete 能力时与父同例：不发、不说。父自己没确认时的旧行不变。

## 5. 边界测试

- 带线程的删除：`client.deleteSession` 被以父 id 与子 id 各调用一次；两笔都确认时不出任何行。（此例同时鉴别"捕获必须在 teardown 前"——读晚了子 id 已是 null。）
- 父确认、子未确认：只出 `sideChatDeleteUnconfirmed`，不出旧的 `sessionDeleteUnconfirmed`。
- 无 delete 能力：两次删除都不发，什么也不说。
- 0.2.82 的删除语义与 0.2.86 的空闲侧聊释放语义回归不变。

revert-check：把控制器还原到提交前，恰好 2 例判别测试失败，其余全绿；全量 X=21 = 19（平台绑定既有失败）+ 2。第 3 例是过度声明守卫，revert 前后皆绿，不计入判别。

## 6. 回归计数

- 0.2.86：2581 测。本轮 +3 → 2584；全量 `2565 passed / 19 failed`，tsc 0，lint 0。

## 7. 仍未闭合

- **崩溃/重启路径仍会漏**：`sideChatSessionId` 只活在内存里。Obsidian 重启后，插件无法记起某个还活着的 fork id，删除会话便带不走它。堵住这条要把 fork id 持久化进标签页 shell 或 store——那是另一个单点，待有更直接的证据需求再做。
- **插件外部产生的孤儿**（用户在 opencode 自己的界面里 fork/删的）不归本修复管：插件不认识那些 id。0.2.85 遗留的"恢复侧边线程入口需要记住 fork id"与这条同源。
- **分叉标签页的可见性顺带记录**：用户级的"分叉到新标签页"（`forkSession`）同样写 `fork_session_id`，因而 0.2.85 的过滤也会把它挡在**原生**历史之外；它活在插件自己的会话镜像里（`forkSession` 会 `getOrCreate`+save，代码走读结论），下拉的已存分区仍能找到——损失限于内核原生分区与镜像被清空之后。是否该让分支会话出现在原生历史，是产品决定，本轮不动过滤。
- 被 `time_archived` 归档的会话与级联的交互、以及 delete 一个仍有**在飞回合**的子（本轮 rig 里子 A 是空闲的；插件路径是先 close 后 delete）未单独测。
