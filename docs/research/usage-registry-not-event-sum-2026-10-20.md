# 原生用量读数改回内核自己的账（2026-10-20，0.2.91）

一句话：插件过去把 `session_message` 里所有 assistant 事件的 token 相加当作一个会话的用量，并去事件里找内核根本不写的 `step-finish` 与 `tokens.total`。实测下来，这本事件账既**少记**（真实会话每个都少），又在侧聊线程里**多记**（把父会话的一生算进来）。内核在 `session_v2` 行上本来就有那六个账目列，v1 读法一直在用；v2 读法改回同一来源。

## 1. 验收标准

- 打开一个真实会话，footer 的 Input/Output/Thinking 应当等于内核为同一个会话 id 记在注册表行上的数，而不是"看得见的那些消息带了多少"。
- `/btw` 侧聊线程的用量只能是它自己出生之后的开销；它的事件表里被内核复制进来的祖先消息，不得算到它头上。
- 数据库里没有 token 记录时宁可报"未上报"，不能报 0。

## 2. 修改前的行为

`buildSessionUsageSqlV2(sessionId)` 不碰注册表行：

- `cost` ← 对每条 assistant 事件的 `$.content[]` 做 `json_each`，累加 `type='step-finish'` 部件的 `$.cost`；
- `tokens_*` ← 对每条 assistant 事件的 `$.tokens.input/output/reasoning/cache.read/cache.write` 求和；
- `context_tokens` ← `seq` 最大的一条带 `$.tokens.total` 的 assistant 事件。

这个形状是 0.2.89 为了让"fork 之后旧登记可能落后于事件日志"而写的，本轮实测：那句把方向说反了（§3.3）。

## 3. 测量

只读 `C:\Users\LEGION\.local\share\opencode\opencode.db`（`opencode v2.0.28`），脚本在 `co-ober-rig/usage-0.2.91/`（`deep.mjs`、`tables.mjs`、`seq.mjs`、`shape.mjs`、`identity.mjs`、`fork-usage.mjs`、`pipeline.mts`）。

### 3.1 两条派生子句读的是内核不写的形状

整库统计，非抽样：

| 断言 | 实测 |
| --- | --- |
| `session_message` 里 `type='assistant'` 的行数 | 1,389 |
| 其中带 `step-finish` 部件的 | **0** |
| 其中带 `tokens.total` 的 | **0** |
| 其中带 `tokens` 对象的 | 1,383（6 行整个没有） |
| 一条真实 assistant 事件的顶层键 | `time,agent,model,content,finish,rawFinish,cost,tokens` |
| `$.content[]` 里出现过的部件类型 | `tool` 1,371 / `reasoning` 779 / `text` 438 —— 没有第四种，`step-finish` 一次都没有 |
| 除 assistant 外任何事件带 token | 无（user/model-switched/idle/agent-switched/system/synthetic 全为 0） |

所以在这个内核上，`cost` 子句恒为 0，`context_tokens` 恒为 undefined。本机 `cost` 在注册表里也全是 0（用的都是 free 模型），因此 cost 只有形状证据、没有数值差异可报。

`total` 到底怎么算，内核自己给了答案：v1 遗留的 `message` 表（整库 15 行）里 12 行带 `tokens.total`，**12/12 满足 `total = input + output + reasoning + cache.read`**；这 12 行的 `cache.write` 全是 0，所以 write 该不该进这个和无法判定，本轮不计入。

### 3.2 事件求和 vs 注册表行：16 个真实会话全都少读

同一份库，`session_v2` 行 vs 事件求和（in/out，节选）：

| 会话 | 注册表 | 事件求和 | 少读 | 事件空位 |
| --- | --- | --- | --- | --- |
| `ses_ea7757543f` | 852,017 / 88,033 | 849,163 / 88,019 | 2,854 / 14 | 1,828 |
| `ses_ec5a64d2cf` | 96,098 / 44,447 | 91,962 / 44,432 | 4,136 / 15 | 660 |
| `ses_ebca3a643f` | 116,427 / 30,096 | 115,491 / 30,084 | 936 / 12 | — |
| `ses_ebaa22749f` | 15,366 / 493 | 15,340 / 487 | 26 / 6 | — |
| `ses_ea77ac8e1f` | 250,663 / 15,519 | 250,644 / 15,513 | 19 / 6 | — |
| `ses_f043d8dd1f` | 21,235 / 888 | 21,235 / 888 | **0** | **0** |

方向无一例外：注册表 ≥ 事件求和。最后一行是天然对照——那个会话的 13 条事件一条没少（`max(seq)+1 == count(*)`），两本账完全相等，说明注册表不是重复累加出来的虚高，而是两本账里更全的那一本。

（`seq` 是按会话编号的：全库 1,740 行里 `seq=1` 出现 17 次。所以同一会话内 `max(seq)+1 > count(*)` 的空位意味着有事件行被删过；这与"少读"正相关，但本轮没有把差额归给删除的独立证据，见 §6。）

### 3.3 活体 rig：差额在第一轮就产生，fork 会把父会话的一生算进子线程

`opencode acp`（shell:true），cwd `D:/ObsidianVaults/kys-in-whu-cs`，建两个会话、prompt 三次、`session/fork` 一次，读完即删：收尾 residue 0 行，库回到 22 会话 / 1,740 事件。

| 时刻 | 该会话注册表 in/out | 该会话事件求和 in/out |
| --- | --- | --- |
| T1 父会话第 1 轮后 | 11,979 / 9 | 11,527 / 4 |
| T2 fork 刚出生（还没说话） | **0 / 0** | **11,527 / 4** |
| T3 fork 说完自己那一轮 | 2,467 / 4 | 13,994 / 8 |
| T4 父会话第 2 轮后 | 12,399 / 14 | 11,947 / 9 |

两条结论：

1. T4 相对 T1，两本账各自 +420/+5，完全同步。差额不是"越久越偏"的漂移，而是第 1 轮里内核多记了一次没有落成 assistant 事件的开销。**最可能是给会话起标题的那次调用——这一句是推断，本轮未证明。**
2. T2/T3 是决定性的：`session/fork` 把祖先的 assistant 事件复制进新线程，而新线程自己的注册表行从 0 记起。所以 0.2.89 注释里那句"fork 之后旧登记会落后于事件日志"方向说反了——落后的是事件账本，被祖先污染的也是事件账本。按旧读法，一个还没开口的侧聊线程会显示父会话的整条用量历史。

### 3.4 插件自身流水线的读数（同一台机、同一份真实库）

`readNativeSessionUsage` 经 `listNativeSessions` 列出的同一批 id（tsx + `file:///` 直接 import `src/`）：

| 会话 | 改前 read in/out | 改后 read in/out | 内核注册表 | 改前 context | 改后 context |
| --- | --- | --- | --- | --- | --- |
| `ses_ea7757543f` | 849,163 / 88,019 | 852,017 / 88,033 | 852,017 / 88,033 | undefined | 472,253 |
| `ses_ea77ac8e1f` | 250,644 / 15,513 | 250,663 / 15,519 | 同上 | undefined | 148,113 |
| `ses_ebaa22749f` | 15,340 / 487 | 15,366 / 493 | 同上 | undefined | 15,569 |
| `ses_ebc7770d9f` | 381,728 / 52,348 | 382,302 / 52,361 | 同上 | undefined | 192,242 |
| `ses_ebc791f0bf` | 22,490 / 778 | 23,041 / 787 | 同上 | undefined | 23,121 |
| `ses_ebca6a34ef` | 490,546 / 69,173 | 491,113 / 69,189 | 同上 | undefined | 272,378 |

六个抽样会话，`cost/tokens_input/tokens_output/tokens_reasoning/tokens_cache_read/tokens_cache_write` 六列逐个与注册表相等。列表仍是 15 条（0.2.90 的空壳过滤未受影响）。

## 4. 改动

`buildSessionUsageSqlV2(sessionId, registry)`：六个账目列直接取注册表行——`registry === 'session_v2'` 时读 `session_v2`，否则读 `session`（老式 fork 仍共用旧登记）——与 v1 读法同形；`context_tokens` 取 `seq` 最新的一条**带 `tokens` 对象**的 assistant 事件的 `input + output + reasoning + cache.read`。`readNativeSessionUsage` 复用现成的 `resolveNativeSessionRegistry`，走同一份 probe 缓存，不多一次查询。

三条约束：

1. 没有 `tokens` 对象的 assistant 事件被跳过，而不是当 0——计量条要区分"没上报"和"空窗口"，这是前面几轮已经立过的规矩。
2. `cache.write` 不进 context：12/12 样本的 write 都是 0，把它加进去是猜。
3. 只改 v2 分支。v1 分支本来就读注册表行，未动；`buildSessionUsageSql` 的 `message.data.tokens.total` 那条子句经实测在遗留 `message` 行上是成立的（12/13 带 total），保留。

用户可见面：`CoOberViewController.refreshNativeUsage`（`src/view/CoOberViewController.ts:2757`）把 `inputTokens/outputTokens/reasoningTokens` 写进 `rt.state.usage`，经 `renderer.ts:1173-1178` 的 `tokenSuffix` 打进 usage tooltip。`contextTokens` 本轮也终于有值，但它要等 `contextWindow` 先到（只有在线帧会给），重启后未发言的会话仍显示"—"——那是诚实的空，不是这次的缺陷。

## 5. 判别测试

fixture 用的是**真实 SQLite**（`:memory:`），并把 2.0.28 测得的形状写进库：`ses_live` 两条 assistant 事件带顶层 `tokens`（无 `total`、无 step-finish 部件），注册表行记 12,000/900/40/88,000（事件求和是 11,948）；`ses_fork` 注册表行全 0，事件里第一条是复制来的祖先消息。`session` 与 `session_v2` 两张表都补齐了六个账目列。

- `reads usage from the registry row and the newest event tokens`（SQL 形状断言，改写）：断言读 `from session_v2 s where`、六列来自 `s.`、context 用事件 parts 相加，且 `not.toContain('step-finish')`、`not.toContain('$.tokens.total')`——把死形状钉住，防止再写回去。
- `reports what the kernel booked for the session rather than what its messages carried`：注册表 12,000 而不是同库算出的 11,948；并断言事件求和确实是 11,948，这样"少读"这条事实本身也在测试里。
- `does not bill a side chat for the conversation it was forked from`：fork 行读 0/0，同时断言它的事件求和确实是 13,994——旧读法会报的那笔父会话账。
- `leaves context unreported when no assistant turn gave tokens`：`context_tokens` 为 NULL、`tokens_input` 取注册表的 5。
- `returns fork-correct results`（既有）：`ses_a` 的 usage 期望值从事件求和（0.5/10/5/2/90/3，context 17）改成注册表行（0.42/1,000/200/50/9,000/0，context 107）。

revert-check：只把 `src/opencode/NativeSessionReader.ts` 退回 HEAD，本文件 `23 = 18 + 5` 失败；修复恢复后回到 18。全套 86 文件 / 2,598 测试（基线 2,595 加三条新测试），`NativeSessionReader.test.ts` 103 条、18 条平台绑定失败原样不动。`tsc --noEmit`、`eslint --max-warnings=0` 干净。

诚实标注最后一条：`leaves context unreported…` 里"无 tokens 事件不落成套 0"的 context 断言两侧都成立（旧读法也返回 NULL），它回退后失败是因为 `tokens_input` 的来源变了。也就是说这条测试整体判别，但只有它的一半在判别。

本轮没有改任何用户可见文案，无新增 i18n key。

## 6. 仍未闭合

- **cost 的数值差**：本机全库 `cost` 为 0（free 模型），只能证明旧子句恒读 0、形状内核不写，不能证明"有价模型上注册表 `cost` 等于各步花费之和"。这一句仍是推断。
- **同源缺陷没一起修**：`buildMessageStatsSqlV2` 带着完全一样的两处死形状——cost 从 step-finish 求（0/1,389）、`total_tokens` 从 `$.tokens.total` 求（恒 0）。它的消费者 `attachNativeUsage` 因此给每条重放消息挂上 `cost: 0` / `totalTokens: 0`；这两个值 falsy，footer 现在不会把 0 印出来，下一轮应该把它接到消息自己的 `$.cost`（顶层键，实测 1,383/1,389 行带，与带 `tokens` 的是同样那 6 行缺失）与 parts 相加的 total 上。
- **内核多记的那次调用是不是标题生成**：未证明；要另一轮 rig（对照一个不会起标题的会话形状）。
- **被删事件是否也参与差额**：真实库里空位最多达 1,828（`ses_ea7757543f`），空位与少读同向，但没有独立证据把某一笔差额归给某一次删除。
- `cache.write` 是否属于内核的 `total`：12/12 样本 write=0，判不出来。
- 0.2.90 队列里的其余项不变：`agent-switched` 由谁写、要不要提供清理从未用过的会话、`slug` 是否替代裸 id 标签、重放 transcript 里的 persona 前缀剥离、0.2.86 §8 的面板级集成测试、分支标签页的历史可见性、ghost 处置入口。
