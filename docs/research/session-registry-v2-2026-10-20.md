# 内核把会话注册表搬进了 `session_v2`，插件的历史还在读化石（0.2.83）

- 日期：2026-10-20
- 内核：OpenCode `v2.0.28`（本机真实数据库 + `opencode acp` 活体 rig）
- 范围：`NativeSessionReader` 的 schema 探测、`buildNativeSessionsSqlV2`、`buildNativeSessionSearchSqlV2`、`listNativeSessions`、`searchNativeSessions`
- 结论：2.0.28 上 `session` 表停更（本机只剩迁移前的 2 行），所有新会话只写 `session_v2`；原生列表与内容搜索从此改读真正承载会话行的注册表

## 1. 本轮验收标准

0.2.82 §7.4 留下方向：`endSideChat` 的 fork 会不会以幽灵会话污染历史？要回答它，先要搞清历史到底从哪张表读。验收标准随之变成：

> 在本机真实数据库上实测：会话行究竟写进哪张表、`session` 还是不是活的、`session/fork` 写不写 `parent_id`；若插件读的不是内核在写的那张表，列表与搜索就要改，并且判别测试必须能区分"读到化石"与"读到现状"。

## 2. 修改前的行为

`resolveNativeReadFormat` 把 forked 数据库的内容读切到 `session_message`，但**注册表**（会话行本身）无论 v1 还是 v2 都从 `session` 读。代码注释里写着前提："After a fork, `session` rows stay current (session_message foreign-keys to them)"——即迁移只搬消息，不搬会话行。

这个前提在本机被实测推翻。

## 3. 实测（活体 rig + 真实数据库）

### 3.1 fork 痕迹 rig（fork-trace.mjs）

`session/new` → 短回合 → `session/fork` → `session/close` → `session/delete`，每步同时看 ACP `session/list` 与 sqlite：

```
forkCap               -> {} （声明支持 fork）
fork                  -> { ok: true, newId: ses_… }
list.main / list.fork -> true / true   （ACP 列表两个都在）
db.main / db.fork     -> null / null   ← session 表里根本没有这两行
db.newest5            -> 只有两行一周前的旧会话
db.count              -> 2
closeFork             -> {} ；list.fork 仍 true   （0.2.81 语义：close 只释放）
deleteMain            -> {} ；fork 仍在列表；prompt(fork) -> -32602（因为 fork 早被 close，0.2.81 语义，非级联）
```

顺带修正 rig 初稿的一个混淆：`afterDelMain.promptFork` 的 `-32602` 不是"删父会话导致子会话死亡"，而是 fork 在本 rig 第 3 步已被 close——close 杀 id 是 0.2.81 测过的事实。父/子级联问题回到"仍未闭合"。

### 3.2 真实数据库取证（本机 `~/.local/share/opencode/opencode.db`）

```
session 行数      -> 2（最后更新 ≈ 一周前；这两行在 session_v2 里也各有一份）
session_v2 行数   -> 25，含今天全部会话（vault D:/ObsidianVaults/kys-in-whu-cs、各 rig）
session_v2 列     -> 完整：id,parent_id,fork_session_id,title,directory,
                     time_updated,time_archived,summary_* 等
parent_id 非空行  -> 0（全库）；fork_session_id 非空行 -> 0
```

两个结论同时成立：

1. **注册表迁移了。** 新会话只进 `session_v2`；`session` 是化石。同目录对照实测：旧 SQL（`from session`）返回 0 行，新 SQL（`from session_v2`）对同一 directory 过滤返回 4 行真会话。插件的下拉历史与内容搜索在 2.0.28 上一直只读化石——迁移之后的会话（也就是用户全部现代工作）从来搜不到。
2. **fork 不记父。** 2.0.28 的 `session/fork` 产出的行 `parent_id`、`fork_session_id` 皆为 null——fork 在数据层面就是普通新会话。`where parent_id is null` 的过滤**挡不住**侧聊幽灵；它此前不被看见纯属另一个 bug 的副产品（列表读的是化石表）。幽灵问题因此原样移交"仍未闭合"。
   > **0.2.85 修正**：本条结论错在零样本泛化——当时库现存 21 行里没有任何一行是 fork（rig 行用完即删），"全库皆 null"被外推成"内核不写族谱"。活体 rig 实测：`session/fork` 把父 id 写进 `fork_session_id`，幽灵完全可区分；原生列表已按该列过滤。见 `ghost-fork-lineage-2026-10-20.md`。

## 4. 结论与修复

### 4.1 注册表判定（fork 证据查询扩展）

`SCHEMA_FORK_SQL` 增加一列：`(select count(*) from pragma_table_info('session_v2')) as registry_v2_rows`（pragma 对不存在的表返回空，不抛错）。schema 探测缓存从裸 kind 变为 `{kind, registry}`；判定规则：

- 非 forked（v1/unknown/incompatible）→ `session`，与旧行为逐字节相同；
- forked 且 `registry_v2_rows > 0` → `session_v2`；
- forked 但 `session_v2` 无行/读不到证据 → 仍 `session`。老式 fork（v1.18：共享注册表、只搬消息）保持原样；证据查询失败时宁可留在 `session`，因为"读不到证据"不是"证据表明在 `session_v2`"——读一张不存在或空的表会回答"没有会话"，那比读到化石更糟。

### 4.2 列表与搜索跟着注册表走

`buildNativeSessionsSqlV2(cwd, limit, registry?)`、`buildNativeSessionSearchSqlV2(cwd, query, limit, registry?)` 新增缺省为 `'session'` 的第三/四参——缺省输出与旧函数逐字节相同，`from ${registry} s`。`listNativeSessions`/`searchNativeSessions` 在 `format === 'v2'` 时把探测缓存里的注册表传进去。`V2_TIME_UPDATED_EXPR`（对 `session_message` 的 max 子查询）不动：它按会话 id 关联，与注册表所在表无关。用量/todos/转写各读事件表，不涉及注册表，未改。

### 4.3 顺带修正的两处注释

`SCHEMA_PROBE_SQL` 上方与 v2 变体段首的注释记录的是"注册表共享"旧前提，按本轮实测改写为"新内核连注册表一起搬走，forked 库在 `session_v2` 有行时读它"。

## 5. 边界测试

新增 4 个（2,567 → 2,571）：

1. `lists sessions from session_v2 when the kernel writes the registry there`：fork 证据 `{migrated:0, v2_rows:1591, registry_v2_rows:25}`，同一 fake DB 对 `from session_v2 s` 返回现行行、对 `from session` 返回化石行——列表必须给出现行 id。改回不传注册表即失败（回退检验见 §6）。
2. `searches session_v2 when the registry lives there`：同上对搜索成立，并断言实际执行过含 `like` 的 `from session_v2 s` 查询。
3. `keeps reading the shared session registry for an older fork without session_v2 rows`：证据 `{migrated:1, v2_rows:8}` 无 registry 行 → 仍读 `session` 的化石行。防"见到 forked 就切表"的过头修复。
4. `builds registry-scoped listing and search SQL on request`：builder 缺省输出含 `from session s`、指定时含 `from session_v2 s`。

测试基座显式传 `databasePath`，绕开本机路径发现（既有 18 个平台绑定失败正源于该发现只在类 Unix 环境成立），使判别在任何平台一致。

## 6. 回归计数

- 全量：86 个文件 / 2,571 个测试；本 Windows 主机 2,552 通过，19 失败。
- 19 个失败与 0.2.75–0.2.82 完全相同（`NativeSessionReader.test.ts` 18 个、`commandResolution.test.ts` 1 个）。
- `tsc --noEmit`、`npm run lint` 均无输出。
- 回退检验：把两处调用改回不带注册表参数，恰有测试 1、2 失败（20=18+2），其余不动；恢复后回到 18。
- 真实数据库对照（§3.2 末）：同目录过滤旧 SQL 0 行、新 SQL 4 行。rig 遗留的 4 行已用 `session/delete` 清库。

## 7. 仍未闭合

1. **侧聊幽灵原样在案**：fork 不写 `parent_id`，`session_v2` 列表把侧聊会话当普通会话端出来（标题 null 时下拉显示 id）。本轮修好了"看不见现代会话"，同时让"看得见幽灵"成为真问题——侧聊关闭时是否顺手 `session/delete`（0.2.82 已有该能力）是下一轮的产品决定，决定前需要先测：用户是否曾想找回侧聊。（0.2.85 已按实测的 `fork_session_id` 把幽灵滤出列表，见 §3.2 修正注。）
2. **注册表判定的外推**：判定依据只有本机 2.0.28 与既有 forked 库的形态。一个"双写"注册表的内核（两表同时更新）两条路都对；一个"搬到第三张表"的内核会落回 `session` 化石——那需要新的实测，不是这行 pragma 能猜到的。
3. **`session` 表将来整个消失**：`SCHEMA_PROBE_SQL` 仍以 `session` 表的存在与列数为可读性门槛；届时纯 `session_v2` 库会被判 incompatible、原生读整体降级（降级路径本身是 0.2.50 立下的诚实行为，不会谎报空列表）。门槛换表是另一个单点修复。
4. **父删子活的级联**：3.1 的混淆修正后，"delete 父会话时 fork 会怎样"重新变成没测过的问题（fork 不记父，预期无事发生，但没实测就没有断言）。
5. **目录过滤的斜杠语义**：内核存正斜杠；插件传的 cwd 形态（反斜杠盘符等）能否匹配，本机 18 个平台失败与真实 vault 都还没给出正面证据。本轮只换表，没动过滤语义。

## 8. 与 0.2.82 的关系

0.2.82 回答"删除会不会真删"；本轮回答"历史是不是历史"。同一套取证方法（活体 rig + 数据库直读）第二次推翻了一条写在注释里的内核前提——第一次是"close 不碍删除"，这次是"fork 不搬注册表"。范式不变：前提错了，行为跟着实测改，错了的那半句注释也一起改。
