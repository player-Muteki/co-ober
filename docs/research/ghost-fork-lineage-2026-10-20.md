# 侧聊幽灵其实带着族谱：`fork_session_id` 才是内核写父链接的列（0.2.85）

- 日期：2026-10-20
- 内核：OpenCode `v2.0.28`（活体 rig ×2 + 本机真实数据库）
- 范围：`buildNativeSessionsSqlV2`、`buildNativeSessionSearchSqlV2` 的注册表 where 子句（仅 `session_v2` 分支）
- 结论：`session/fork` 把父会话 id 写进 `fork_session_id`（`parent_id` 保持 null）；原生列表与内容搜索在读取 `session_v2` 注册表时按 `fork_session_id is null` 隐藏派分会话，与既有 `parent_id is null` 的"只列顶层"意图对齐。本轮同时修正 0.2.83 §3.2 的一句过度概括。

## 1. 本轮验收标准

0.2.83 §7.1 说 fork 不记父、幽灵不可区分；0.2.84 打通斜杠后，幽灵从理论可见变成实际可见。验收标准：

> 活体 rig 走完侧聊全生命周期（new → prompt → fork → prompt fork → close fork），逐列查族谱、试恢复、读转写；若内核其实记了父，列表就该按它过滤；若没记，才轮到处置性方案（delete 或标注）。

## 2. 0.2.83 那句结论怎么错的

0.2.83 的取证查了全库：`parent_id` 非空 0 行、`fork_session_id` 非空 0 行——数据没错，错在把"现存 21 行里没有一行带族谱"外推成"内核不写族谱"。本轮复核（lineage-count.mjs）：现存 21 行仍然 `parent_set=0, fork_set=0`——因为那批行里根本没有 fork：rig 用完即删，插件侧聊功能用户还没在真会话上用过。**零样本泛化**是本案根因。范式照旧：前提错了，行为跟着实测改，错了的那半句结论也一起改。

## 3. 实测

### 3.1 幽灵全生命周期（ghost-fork.mjs）

`session/new` → prompt(ALPHA, end_turn) → `session/fork`(带 cwd；注意 `session/fork` 参数不带 cwd 会被 -32602 拒绝——插件的 `forkSession` 一直带着，rig 初稿漏了) → prompt fork(BRAVO, end_turn) → `session/close` fork（= endSideChat 的语义）：

```
fork                      -> ses_…（成功）
closeFork                 -> {}
listed.forkPresent        -> true    ← 0.2.84 后的列表 SQL 里幽灵在列
listed.forkRow            -> { title: null, parent_id: null,
                                fork_session_id: "ses_…(main)" }  ← 族谱在！
load.closedFork           -> ok:true  ← close 之后仍能 load
prompt.closedFork         -> ok:true  ← 甚至能接着聊
acp.list.hasFork          -> true
session_message.rows      -> fork 10 行 / main 3 行（转写在库，可读）
```

三条独立事实：

1. **内核写族谱，写在 `fork_session_id`。** `parent_id` 是留给别的层级的（全库至今无人写过），`where parent_id is null` 挡不住 fork——0.2.83 §7.1"挡不住"的结论歪打正着，但"不可区分"是错的：它完全可区分。
2. **空闲时 close 不杀 id。** 这修正了本仓库对 0.2.81 的转述边界：0.2.81 实测的是 close 打断**直播中的回合**——那次确实把 prompt 判成 cancelled 并让后续请求吃 -32602；本轮 close 的是一个已经 `end_turn` 的 idle 会话，load/prompt/list 全部正常（也与 0.2.82 的对照会话一致："closed 会话仍在列表、可 load"）。推论：`endSideChat` 给空闲侧聊发 close 只是"释放"，幽灵还是个**可复活**的内核会话——只是 UI 再也端不出它的入口。
3. **转写可读**：`session_message` 里问答齐全，0.2.50 的原生转写路径按 id 能全量重建——幽灵不是坏数据，是"没人索引的档案"。

### 3.2 过滤对照（ghost-filter.mjs，真实数据库）

同一目录谓词，只换 where 的族谱条件：

```
oldListing: 18 行，含幽灵（title null，下拉显示 ses_…）
newListing: 17 行，无幽灵，父会话仍在
forkRowLineage: fork_session_id === mainId（真）
```

rig 两行用完即 `session/delete`，库中无残留。

## 4. 结论与修复

- `NativeSessionReader.ts` 新增 `v2RegistryWhere(registry)`：`registry === 'session_v2'` 时 where 为 `s.parent_id is null and s.fork_session_id is null and s.time_archived is null`；`session` 分支保持逐字节不变——legacy `session` 表根本没有 `fork_session_id` 列（schema 探测数到 6 列），把条件硬塞上去会让整个 v2-内容/共享注册表形态的老 fork 库读挂。
- 列表与搜索两个 v2 builder 共用这个 where。默认参（registry='session'）的输出与 0.2.84 逐字节相同。
- 处置理由：原生历史节的意图从写下 `parent_id is null` 那天起就是"只列顶层会话"；侧聊按设计是用完即弃的草稿线程（标题为 null、id 不可读、复活入口没有），把它从历史里藏起来与既有意图一致，而不是发明一个"幽灵专区"。用户在标签页里手动 fork 的会话另有本地 store 镜像兜底，不经这一节也能找回。
- 不选 delete-on-close：0.2.82 有该能力，但 §3.1 显示幽灵是可读的档案（事实 3），静默删除会烧掉"知道 id 的人还能读回来"的最后一扇窗；删除与否是下一轮带着用户证据的产品决定。

## 5. 边界测试与回归计数

新增 2 个（2,575 → 2,577）：

1. `filters fork_session_id only when the registry is session_v2`：两个 v2 builder 指名 `session_v2` 时必须含 `s.fork_session_id is null`；默认参及两个 v1 builder 必须完全不见 `fork_session_id` 字样。防"见 forked 就加列"的越界。
2. `lists and searches through the lineage-filtered session_v2 query`：fake 库（族谱证据 `registry_v2_rows: 25` → 注册表 session_v2）断言列表与实际执行过的搜索 SQL 都带上了族谱过滤。

回退检验：把 `v2RegistryWhere` 退回无分支的旧 where，恰有这两题失败（20=18+2），其余不动；恢复后回到 18。全量：86 文件 / 2,577 测试，19 个平台绑定失败原样；`tsc --noEmit`、`npm run lint` 无输出。

## 6. 仍未闭合

1. **侧聊删除与否**仍是产品决定：本轮把它藏出列表（不再污染视线），但数据继续躺在内核库里；close-idle 不杀 id（§3.1 事实 2）意味着幽灵其实还可复活——如果哪天要做"找回侧聊"，入口得自己造（记住 fork id），因为列表不再显示它。
2. **`fork_session_id` 列的存在性外推**：判定仍以探测缓存里的注册表为准；一个"注册表在 `session_v2` 但没有 `fork_session_id` 列"的怪内核会让 SQL 抛错、被 `listNativeSessions` 的 reject 语义如实报成"不可用"（不会谎报空列表），但那是没测过的形态。
3. **close 的确切生死语义**：0.2.81（直播合被 close → 杀）与本轮（idle 被 close → 不杀）都有实测，中间态（close 时回合恰好在同一毫秒自然结束）没测过。
4. **父删子级联**：本轮 rig 是先删子再删父，级联仍未测——幽灵被列表隐藏后，这个问题对产品行为的影响变小，但对内核行为的认识仍是空白。
   > 0.2.87 已闭合：`fork-cascade` rig 先删父测得级联不发生——子行与其转录完好保留，`fork_session_id` 仍指向已消失的父，`session/load`、`session/prompt`、ACP `session/list` 对孤儿子照常应答（内核看得见，0.2.85 的过滤让它们对插件历史永久隐形）。据此插件删除一段会话时必须显式带走它的侧边线程。详见 docs/research/fork-parent-delete-cascade-2026-10-20.md。
5. **4 行 title 与 time_updated 双 null 的现存会话**：不是 fork（无族谱），像 `session/new` 后从未使用的空壳；列表会把它们以 id 为标题端出来。是否该过滤"零消息会话"未实测其成因，不动。
