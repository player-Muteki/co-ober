# 内核兼容门的锚：当前注册表是 session_v2（2026-10-20，0.2.89）

## 1. 这一轮要判定什么

历史列表、内容搜索与用量读取都先过一道门：`probeNativeSchema()` 把数据库分类成
`v1 / forked / incompatible / unknown`，再由 `resolveNativeSessionRegistry()` 决定
会话注册表到底读 `session` 还是 `session_v2`。本轮的验收标准：

- 判门不能因为"某张表不存在"就把当前数据判成旧数据；
- 若内核已经把注册表搬进 `session_v2`，列表必须读出 `session_v2` 里的会话；
- 若 `session_v2` 缺列表所要的列，宁可不读它，也不能回答"没有会话"；
- 若内核彻底删掉了 legacy `session` 表，只要 `session_v2` 完整可用，就不能判
  `incompatible` 而把整个原生历史关掉。

## 2. 真机测量（opencode 2.0.28，本机 `~/.local/share/opencode/opencode.db`）

只读打开，不改写任何一行。

| 事实 | 测得 |
| --- | --- |
| `data_migration` 表 | **不存在**（内核的迁移记账表叫 `migration`，50 行） |
| legacy `session` 表 | 存在，形状完整（6 个必需列都在），全库仅 2 行 |
| `session_v2` | 存在，22 行；本 vault（`D:/ObsidianVaults/kys-in-whu-cs`）占 16 行 |
| `session_message` | 1735 行 |
| `session_v2` 的列 | 36 列，列表所需的 10 列（含 `fork_session_id`）全部在场 |

把插件自己的读管线跑在这份真库上（`tsx` 直接调 `listNativeSessions` 等）：

```
修复前： probe kind: forked     listed count: 1
         ses_f043d8dd1ffe…  "提交并推送 Dashboard 更改"  2026-10-02T08:40:35Z
修复后： probe kind: forked     listed count: 16
         ses_ea7757543ffe…  "优化 ch02 一阶逻辑笔记的 SVG 附件"  2026-10-20T12:23:00Z
         ses_ea77ac8e1ffe…  "拉取 Dashboard.md"                  2026-10-20T10:55:59Z
         …
修复后其它读路： searchNativeSessions("Dashboard") = 4 命中；
         readNativeSessionTranscript(ses_ea7757543ffe…) = 234 条消息；
         readNativeSessionUsage(…) = input 849163 / output 88019 / reasoning 153490。
```

用户可见的后果是：**历史列表只交出 2026-10-02 那一条化石，把 10 月 20 日当天的
会话全部吞掉**，而内核里明明有 16 条。搜索跑在同一条注册表判定上，本轮只测到它修
复前对 "fork" 返回 0 命中（修复后 "Dashboard" 命中 4 条），没有逐一复测其它关键词。

## 3. 为什么门会判错（插件事实，非内核事实）

旧的证据读是一条静态 SQL：

```sql
select (select count(*) from data_migration) as migrated,
       (select count(*) from session_message) as v2_rows,
       (select count(*) from pragma_table_info('session_v2')) as registry_v2_rows
```

SQLite 在 **prepare 阶段**就拒绝引用不存在的表——测得 `THROWS: no such table:
data_migration`。三个计数被一个查询绑在一起，于是整条读失败；`readForkEvidence()`
的 catch 按既定策略返回 `{diverged: true, registry: 'session'}`（"读不到计数 ≠
证明了 session_v2 在场"，这个默认当时是对的）。结果：分类仍然是 `forked`（内容走
v2 事件表没错），但**注册表被判回 legacy `session`**，而那张表在这台机器上只剩 2
行迁移时的化石。三条后端路径（进程内 node:sqlite、spawn node、sqlite3 CLI）跑同
一条 SQL，全都失败，所以这不是运行时差异。

顺带纠正两处注释里的事实：`registry_v2_rows` 这个别名其实数的是**列数**（36）而不
是行数；旧注释说 v1.18 会保留 `data_migration` 记账表，本机 2.0.28 上没有这张表，
该说法按"当前证据不支持"记录，不重解释。

再说清 0.2.85 那轮的"过滤对照"为什么没抓到这个 bug：那节（`ghost-fork-lineage`
§3.2）是 rig 直接对数据库跑两条 SQL 比行数，**没有跑插件自己的读管线**，所以它证明
的是 where 子句的形状，不是插件当时选了哪张注册表——而插件当时根本没选 `session_v2`。
两份旧文档（0.2.83 结论、0.2.85 未闭合第 2 条）都已就地加注。

## 4. 改动（单点）

`src/opencode/NativeSessionReader.ts`：

1. 证据读拆成两步，**先问存在性，再数行**：
   - 形状查询只用不会失败的表达式——`sqlite_master` 是一张清单，
     `pragma_table_info('不存在的表')` 返回空集（本机测得 0 行而非报错）；
   - 计数查询按形状**动态拼接**：在场才 `select count(*) from <表>`，不在场直接
     `(select 0)`。缺一张表从此只值一个诚实的 0，不再赔上整份列表。
2. 注册表判定改为 `registryReady`：`session_v2` 齐备列表所读的 10 列、
   `session_message` 在场、且 `session_v2` 自己真的有行——三者同时成立才读它，
   否则留在 `session`（空注册表会把满库答成"没有会话"）。
3. 兼容锚重设：legacy `session` 的形状不再是"可读"的唯一证明。legacy 不成形状
   但 v2 注册表 ready → `forked` + `session_v2`；两边都不行才 `incompatible`。
   `session_v2` 存在但缺 `fork_session_id` 列的库，判 `v1` 读 legacy 表，不投
   入一场必然报错的 v2 查询（这正是 0.2.85 留的那条告诫）。

没有新增用户可见文案，故本轮无 i18n 改动。

## 5. 判别测试

`src/opencode/NativeSessionReader.test.ts` 新增 `fork evidence against a kernel
without data_migration (0.2.89)`：**真 SQLite 文件**做夹具（本机 Node 的
`node:sqlite` 可用，缺则整块 skip），因为"引用不存在表就报错"这件事只有真引擎会
骗人。

- 2.0.28 形状（legacy 化石 + `session_v2` 当前 + 无 `data_migration`）：列表与搜索
  都必须读出 `ses_now`，并且 `fork_session_id` 指派的草稿行不外露；
- `session_v2` 缺 `fork_session_id`：判 `v1`，列表读 legacy 行，不 reject；
- 彻底没有 legacy `session` 表：判 `forked`，照常读出 `ses_now`；
- 两边注册表都没有：仍判 `incompatible`，列表按"读不能跑"拒绝而不是报空。

夹具跑完按 `afterAll` 删除自己写的临时库（含 `-wal/-shm`），不碰真库。

测试桩里"这是 fork 证据读"的标记从 `sql.includes('data_migration')` 换成
`sql.includes('registry_v2_rows')`，并按本机实测形状回答 `data_migration` 不在场。

revert-check（只回退生产文件、保留新测试）：`21 = 18 + 3`，即 4 条新测试里有 3 条
在旧代码下失败（前三条），第 4 条"两边都没有注册表→incompatible"在旧代码下同样通
过，它是新分支的边界护栏而非判别测试——如实记录，不冒充判别力。

全量：`npx vitest run` → 86 文件，**2592 用例，2573 通过，19 失败**，失败集合与既
有的 19 条平台绑定失败（18 `NativeSessionReader` + 1 `commandResolution`）逐条一
致；`npx tsc --noEmit` 与 `npx eslint` 均为 0。

## 6. 仍未闭合

- 真实内核是否曾把 `data_migration` 作为记账表（v1.18 说法）仍未证实；本轮只证明
  了"2.0.28 没有这张表，且门不该依赖它"。若日后出现别的记账表名，形状读的语义
  （`migrated`）应换成实测在场的那张，而不是再加一个别名猜测。
- `session_v2` 是否总有 `agent` / `model` 列未测：v2 列表本就不选它们，所以原生
  历史条目的 agent/model 在 forked 库上一直缺席。这是既有边界，本轮没动。
- 面板级集成测试（0.2.86 §8 那条）仍在队列里。
- 零消息 shell 会话、分支页的原生历史可见性、ghost 处置入口：仍未定，需要用户侧
  证据或产品决定。
