# 断线实测补齐，以及它量出的一句话越界

日期：2026-10-18。实现版本：Co-Ober 0.2.71。

## 1. 参考仓库

Claudian `main` 推进到 `8a7de7c6`（版本号仍是 2.3.24），经镜像取回 12 个提交。
`src/providers/opencode` 的源码与 `AGENTS.md` **均未改动**——本轮没有新的参考约束
可搬。

## 2. 上一轮欠下的东西

0.2.70 修了"运行途中连接断掉被报成从未开始"，并在发布说明里写明：
**活体实测没有做成**，装置（挂起 20 秒的 stub provider、第 3 秒 SIGKILL）没跑出
结果，所以那次断线从未在真实内核上复现过。这一轮先把它补上。

## 3. 上一轮装置为什么没成

关键在于探针**自己会 spawn 一个 serve**：装置另外起了一个服务端并在第 3 秒杀掉它，
杀掉的是探针根本没用上的那一个。这条装置测不到任何东西。

修法：用探针已有的 `deps.spawn` 接缝包一层，把它派生的那个 child 抓出来，
再从外面把它杀掉。装置要够的连接，就是**探针自己握着的那条**。

## 4. 实测结果（真实内核）

- provider 挂起 25 秒；第 5 秒 SIGKILL 探针自己的 serve 子进程。
- 修复后：`status=disconnected`，`enqueued=true delivered=true started=true`，
  无回答、无 outcome。
- 把 0.2.70 的修复回退后跑同一装置：`status=unavailable`，
  `enqueued=false delivered=false started=false`。

也就是说那句谎话是真的：一次**已入队、已投递、已开始执行**的回合，在连接断掉后
被报成"准备从未完成"，三个已经挣到的事实被一并抹掉。修复把这件事从断言变成了
实测。

## 5. `leftover=true` 不是虚报

顺手查了一下断线后那句"可能仍有残留会话"。查的是数据库而不是接口——
`OPENCODE_DB` 是 sqlite，表名是 `session_v2`。服务端被杀之后：

```
session_v2: 1 rows
session_message: 1 rows
```

会话行**确实还在**。以后再用同一个库起一次 `opencode serve`，那条被遗弃的
会话就在那儿。所以 `leftover=true` 是老实的，不是把"删不掉"泛化成了"服务端没了"。

## 6. 实测顺带量出的一句话越界

读数是 `status=disconnected, enqueued=true, delivered=true, started=true`——
但 `started` **不总是** true。实测路径里，探针在提示词被接收之后、任何
`session.execution.started` 帧到达之前就断了，`started=false` 而状态仍是
`disconnected`。

问题出在 0.2.70 给这一行写的标题：

> The kernel took the prompt **and began executing**, then stopped answering

标题是 `setName`，三条腿是紧接着的 `setDesc`。`started` 为 false 时，
标题说"已开始执行"，下一行说"execution started: no"——**这一行自己和自己打架**，
而且标题说的正是它没有观察到的事。

改法不是加状态：内核并没有把这两种情形分开，处置也一样（都是查链路）。
改的是**句子**——标题只说 `disconnected` 本身意味着的事（提示词已被接收、
随后停止应答），"是否开始执行"交给下面那条腿如实报。

顺带把 `settings.test.ts` 里 `fakeSlice` 的状态联合类型补上了 `disconnected`：
这个桩的联合类型落后了一个版本，虽然 tsc 不会报错（它是本地声明，不来自被
mock 的模块），但它意味着**测试环境根本构造不出这一行的读数**。

## 7. 边界

两条，都确认能分辨新旧：

- 探针级：断线发生在 `execution.started` 之前 → `disconnected` 且 `started` 保持
  false（不编造一个开始）。
- 界面级：`disconnected` + `started=false` 时，渲染文本不得包含 `began executing`，
  且必须包含 `execution started: no`。把标题改回旧文案，该边界按预期失败。

## 8. 回归

全套：**86 个测试文件、2,514 项通过**（基线 2512/86）；TypeScript 与 ESLint 通过。

## 9. 仍未完成

- 另外两条验收项（中断不留后台工作、fallback 不重复执行）未测量。
- 聊天后端仍是 ACP。
