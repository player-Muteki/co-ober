# 新建会话留下没人说过的话：原生历史里的空壳行（0.2.90）

- 日期：2026-10-20
- 内核：OpenCode `v2.0.28`（本机真实数据库 `C:\Users\LEGION\.local\share\opencode\opencode.db`）
- 范围：`v2RegistryWhere`（同时服务 `buildNativeSessionsSqlV2` 与 `buildNativeSessionSearchSqlV2`）
- 结论：`session_v2` 里有 1/22 行从来没有 `user` 事件（只有 1 条 `agent-switched`），插件把它当历史列进下拉，标签退化成裸 `ses_…` id，点开还原得到一个空面板；本轮起，注册表读取只列"至少有人说过一句话"的行

## 1. 本轮验收标准

0.2.89 §6 留了三条尾巴，其中一条写着"零消息 shell 会话仍未定，需要用户侧证据"。本轮先去找证据，再决定改不改：

> 在本机真实注册表里找出"从未被使用过"的会话行，确认它到底会不会被插件列出来、列出来时标签是什么、点开还原能得到什么；若它确实污染历史，就读侧过滤，并让判别测试能区分"列了空壳"与"没列空壳"。

顺带把 §6 另一条尾巴（"`session_v2` 是否总有 `agent` / `model` 列"）量掉，因为它决定 v2 列表少选两列算不算缺陷。

## 2. 修改前的行为

`v2RegistryWhere('session_v2')` 只有三个条件：`parent_id is null`、`fork_session_id is null`、`time_archived is null`。任何一行注册表记录，只要没被归档、不是子会话或 fork 草稿，就会进历史列表——哪怕它一行用户消息都没有。列表侧的标签回退是 `title` 为空就用 `sessionId`（`listNativeSessions`，0.2.50 起如此），所以空壳显示成一串 `ses_…`。

还原侧不背这个锅：`readNativeSessionTranscript` 对空壳老老实实返回 `[]`，问题是列表根本不该把它递过去。

## 3. 实测

### 3.1 注册表普查

| 查询 | 结果 |
| --- | --- |
| `session_v2` 行数 | 22 |
| 有 `user` 事件的行数 | 21 |
| 没有 `user` 事件的行数 | 1（`ses_ec5edcbb4ffeRUIZo2iWSeNPEb`）|
| `time_archived` 非空 | 0 |
| `parent_id` 非空 | 0 |
| `fork_session_id` 非空 | 0 |
| 该目录（vault）行数 | 16 |

空壳行的全部事件只有一条：

```
[1] agent-switched :: {"time":{"created":1791975634154},"agent":"build"}
```

注册表行本身：`title = null`、`model = null`、`path = ""`、`slug = "happy-pixel"`、`version = "2.0.28"`、`time_created = 1791975634140`、`time_updated = 1791975634154`（创建后 14 ms）。它后面 1.3 s 又出现一条新的注册表行（`ses_ec5edc66e…`），那一行才带着用户消息——也就是说上一行被丢弃了。

第一版这段写的是"`agent-switched` 事件与时间差支持'点 New 就建行并写这条事件'的解释，但本轮没跑 rig"。交完 0.2.90 之后补跑了（§3.4），**那句解释是错的**：`session/new` 建的行生下来一条事件都没有，`agent-switched` 不是新建写的，是后来有人给它设过 agent 才出现的。空壳这件事的成因因此比我当时写的更宽——连一条事件都没有的行同样会被列进历史。

### 3.2 插件流水线读数（改前 / 改后）

同一台机、同一个真实库、同一份 harness（`listNativeSessions` / `searchNativeSessions` / `readNativeSessionTranscript`，cwd `D:/ObsidianVaults/kys-in-whu-cs`）：

| 读数 | 改前 | 改后 |
| --- | --- | --- |
| 列表条数 | 16 | 15 |
| 标签退化成裸 id 的条目 | 3 | 2 |
| 空壳 `ses_ec5edcbb4…` 还原 | 0 条消息 | 不再出现在列表里 |
| `ses_ec5edc66e…` 还原 | 1 条 user 消息 | 同前（保留）|
| 内容搜索 `Dashboard` | 4 命中 | 4 命中 |

被保留的两条是"用户问了、回合死了"的会话：`idle_outcome = "failed"`，`error.type = "provider.auth"`（403，`cat-jam-free` 上游不可用），内核因此从未给它们起标题。它们的第一条 `user` 事件长 7339 字符，开头是插件的 Co-Ober 人格提示，结尾才是用户真正打的那句（"按照前面的范式重写2.9.1"）。所以"没标题"绝不等于"没内容"，过滤条件不能写成 `title is not null`——那样会把两段真实问答藏掉。

### 3.3 `session_v2` 到底有没有 `agent` / `model`（关 0.2.89 §6 第二条）

36 列，其中有 `agent:TEXT` 与 `model:TEXT`；本机 22/22 行 `agent` 非空、18/22 行 `model` 非空。`model` 存的是对象 JSON（`{"id":"minimax-m3.1-flash-free","providerID":"opencode","variant":"max"}`），legacy `session` 表（30 列）里也是同样的对象形状。`agent` 有两种形状：`build`（11 行）与 `build-<uuid>`（11 行）。

但**少选这两列至今不构成缺陷**：全仓库没有一处读 `SessionMeta.agent` / `SessionMeta.model`。`grep -rn "\.agent" src --include=*.ts` 去掉测试后只剩写入点（`NativeSessionReader.ts:962-963`）与一堆无关的 `agentCapabilities` / `agentProtocolVersion` 标识符；`\.model\b` 的读取点只有 `OpencodeTurnProbe.ts:85`（读的是另一个查询的行）和 `renderer.ts:1178`（读 `usage.modelId`）。所以 0.2.89 注释里"forked 库不保证有这两列"的说法，本机是被推翻的（列在、且有值），只是没人用。v2 列表维持不选它们：在没有消费方之前，选进来只会多两个没人看的字段，而 `model` 还得先拆 JSON 才能显示。

### 3.4 活体 rig：`session/new` 到底留下什么（补测，0.2.90 提交之后）

`opencode acp` 起在临时目录 `…/co-ober-rig/shell-origin-wd`（不是用户的 vault），`initialize` 后连做两次 `session/new`，**完全不 prompt**，每步同时看 sqlite 与插件流水线，退出前把两个 id 都 `session/close` + `session/delete`：

| 步骤 | 实测 |
| --- | --- |
| 建库行数 | 22 → 24（两次 new）|
| 第一次 `session/new` 后立刻读行 | `title null`、`slug "stellar-cabin"`、`path ""`、`agent null`、`model null`、`time_created == time_updated == 1792503880555` |
| 该行的 `session_message` | **`[]`，一条事件都没有** |
| 第二次 new | 同上，另一行（`proud-orchid`），间隔 38 ms |
| `listNativeSessions(该 cwd)` | `[]`（原始注册表同 cwd 有 2 行）|
| `readNativeSessionTranscript(裸行)` | `[]` |
| `session/close` / `session/delete` | `ok {}` / `ok {}` |
| 残留 | 两行都查不到、事件各 0 条、行数 22 → 22 |

三条结论，其中第一条推翻上一节的解释：

1. 空壳不需要任何后续动作就会诞生——`session/new` 自己就在注册表落一行，`title`、`agent`、`model` 全空，`session_message` 空。本机历史里那条只有 `agent-switched` 的行，是这条裸行**之后又被写过 agent**（配置项或首个回合）的结果，不是新建直接写成那样的。
2. 过滤前提比 §3.1 写的更强：裸行连一条事件都没有。rig 里同一 cwd 的原始注册表有 2 行、插件列表读出 `[]`——两侧读数同库同刻，这一条就是 0.2.90 那个 exists 子查询在 live 内核上的直接效果。（去掉子查询会读出 2 条这句是推理，本轮没有回退代码去跑第二次；§5 的夹具测试已经覆盖了这个反事实。）
3. 顺带量到 `session/delete` 是硬删：注册表行与它的全部事件一起消失，零残留。0.2.90 §3.1 普查显示库里没有 fork 残留，与此一致。

## 4. 改动

`v2RegistryWhere` 在 `session_v2` 分支上加一个 exists 子查询：

```ts
if (registry !== 'session_v2') return 'where s.parent_id is null and s.time_archived is null';
return [
	'where s.parent_id is null and s.fork_session_id is null and s.time_archived is null',
	`and exists (select 1 from session_message sm where sm.session_id = s.id and sm.type = 'user')`,
].join(' ');
```

三点设计约束：

- **只在 `session_v2` 注册表上加**：注册表是 `session` 的库不保证有 `session_message` 表，加上去就是一次 prepare 期报错——0.2.89 刚为同一类错误付过学费；
- **条件用"有 user 事件"而不是"有标题"或"有 idle"**：3.2 量过，标题会漏藏真实问答，`time_idle` 会把正在输入、还没跑过回合的当前会话也藏掉；
- **列表与搜索共用同一个 where**：搜索本来就要求文本或标题命中，空壳永远进不来，所以这条对搜索是语义上的 no-op；把它放进共享函数是为了两侧语义一致，而不是为了修搜索。

## 5. 判别测试

夹具仍是**真实 SQLite 文件**（`os.tmpdir()`，`afterAll` 清掉含 `-wal/-shm`），行形状照 3.1 的实测结果写：

1. `hides the abandoned shell and keeps the errored conversation`：注册表里同时放化石行、当前行、fork 草稿、空壳（只有 `agent-switched`，且 `time_updated` 最新）、无标题但有 user 事件的失败会话。断言列表为 `['ses_now','ses_errored']`（空壳被隐藏）、空壳的 transcript 为 `[]`（隐藏它的前提）、`ses_errored` 能还原出 1 条 user 消息且标签是 id（保留它的前提）。
2. `keeps a titled-less session searchable by its question`：中文子串搜索命中无标题会话、不命中空壳。
3. 0.2.85 那条 SQL 形状测试里补了两组断言：`session_v2` 分支必须带 user 事件过滤，`session` 分支必须不带（否则点名一张不保证存在的表）。

revert-check（只回退生产文件、保留新测试）：`20 = 18 + 2`。两条新测试里**只有第 1 条在旧代码下失败**；第 2 条（搜索）在旧代码下同样通过——空壳没有文本也没有标题，旧代码的搜索也命中不了它，所以它是"别藏过头"的边界护栏，不是判别测试，如实记录。第 3 组是 SQL 形状断言，失败但不测行为。

全量：`npx vitest run` → 86 文件，**2594 用例，2575 通过，19 失败**，失败集合与既有的 19 条平台绑定失败（18 `NativeSessionReader` + 1 `commandResolution`）逐条一致；`npx tsc --noEmit` = 0。

### 5.1 补测之后（同一天，仍算 0.2.90）

§3.4 的 rig 推翻成因解释之后，夹具里加了第 4 条测试 `hides the bare row a rig session/new actually leaves behind`：注册表一行、`session_message` 一条都不写（rig 实测形状），断言它不出现在列表里且 transcript 为空。这一轮**没有生产行为改动**（只有注释与测试），所以不另起版本号。

只删掉 exists 子查询那一行做 revert-check：`21 = 18 基线 + 3`——三条里两条是行为测试（空壳、裸行），一条是 SQL 形状断言；搜索那条仍两侧都过，依旧是边界护栏。改回后本文件回到 18 失败 / 100 用例。

## 6. 仍未闭合

- ~~"点一次 New 会话就建一行"仍是推断~~：§3.4 跑完了，成立且比推断更空——新建的行连 `agent-switched` 都没有。剩下没量的是那条 `agent-switched` 具体由谁写（`session/set_config_option`？首个回合？），需要再来一次 rig。
- ~~空壳行删不掉？~~：§3.4 量到 `session/delete` 把注册表行与全部事件一起删干净（22 → 24 → 22，零残留）。所以"清理从未使用的会话"如果真要做，删除路径是现成的；要不要做仍是产品决定。
- 空壳该不该顺手删掉？读侧隐藏之后，这些行还在库里，`session/list` 与内核自己的历史仍看得到。要不要插件提供一个"清理从未使用的会话"入口，是产品决定。
- 无标题会话在列表里显示裸 `ses_…` id 仍然难看。内核另有 `slug` 列，本机该目录 16 行全部非空（`happy-pixel`、`cosmic-knight` 这类），其中 13 行同时有 `title`——也就是说 `slug` 是"每条都有、但从没被插件读过"的候选标签。它是不是用户想看到的标签，没有证据；本轮没动标签逻辑。
- 第一条用户消息以插件人格提示开头（7339 字符）。还原时用户看到的是"我发给内核的系统提示"而不是自己那句问题的开头，问题在结尾。要不要在 transcript 重建里把人格前缀剥掉，需要先量哪些内核版本把它存成 `user` 事件、以及 ACP `session/load` 回放时内核自己怎么呈现它。
- 面板级集成测试（0.2.86 §8 那条）仍在队列里。
