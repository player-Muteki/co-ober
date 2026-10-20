# 逐消息统计读的是消息自己账上的数（2026-10-20，0.2.92）

一句话：0.2.91 修的是"一个会话的用量"，本轮修它的姊妹 —— "每条消息的用量"。`buildMessageStatsSqlV2` 里挂着同样两条死子句：去 `content` 部件中找内核在 v2 事件表里从不写的 `step-finish`（因此 cost 恒为 0），以及读一个 0/1,389 条事件才有的 `tokens.total`（因此每条消息的 total 恒为 0）。v1 里这两条是对的（`part` 表 12 条 step-finish，条条带 cost 与 `tokens.total`），v2 里它们只是抄过来的。

诚实边界先说在前面：本轮**没有任何读者能看见的数字发生变化**。footer 打印的是 `↑input ↓output`，这两列新旧查询完全一致；total 只在 input 与 output 都为空时才作为兜底出现，实测这种行一条都没有；cost 在全库都是 0（本机用的都是 free 模型）。改动成立的理由是形状与一致性，不是显示值的差。

## 1. 验收标准

- 重放一个真实会话，每条 assistant 消息页脚上的 Input/Output 之外的"这条消息一共多少 token"，应当等于内核给这条消息记的四个 token 部件之和 —— 也就是 0.2.91 里会话级 `context_tokens` 用的同一个定义。
- 事件里没有 token 记录的消息，必须留在结果列表里补 0，不能整条消失：不带原生消息 id 的旧转录是按位置把这些行贴回消息上的，少一行会让后面全部错位。
- v1 读法一个字都不改。

## 2. 修改前的行为

```sql
select sm.id as message_id,
  (select coalesce(sum(cast(json_extract(j.value, '$.cost') as real)), 0)
     from json_each(sm.data, '$.content') j
    where json_extract(j.value, '$.type') = 'step-finish') as cost,
  coalesce(cast(json_extract(sm.data, '$.tokens.input')  as integer), 0) as input_tokens,
  coalesce(cast(json_extract(sm.data, '$.tokens.output') as integer), 0) as output_tokens,
  coalesce(cast(json_extract(sm.data, '$.tokens.total')  as integer), 0) as total_tokens
from session_message sm
where sm.session_id = '<id>' and sm.type = 'assistant' and json_valid(sm.data)
order by sm.seq asc
```

结果被 `readNativeMessageStats` 转成 `NativeMessageStat[]`，再由 `CoOberViewController.attachNativeUsage`（约 2830 行）贴成 `msg.usage = { cost, inputTokens, outputTokens, totalTokens }`，最后由 `src/view/renderer.ts` 的 `formatMessageUsage` 渲染成消息页脚。也就是说：这条链路上每个 `cost: 0` / `totalTokens: 0` 都是从两条读不到的子句来的。

## 3. 测量

数据库只读：`C:\Users\LEGION\.local\share\opencode\opencode.db`（`opencode v2.0.28`）。脚本在 `co-ober-rig/usage-0.2.91/`：`stats-shape.mjs`（形状普查）、`stats-diff.mjs`（新旧逐消息对比）、`stats-invariant.mjs`（与 0.2.91 的一致性不变量）、`gap-cols.mjs`（列级差）。

### 3.1 step-finish 在 v1 是真的，在 v2 不存在

| 断言 | 实测 |
| --- | --- |
| v1 `part` 表中 `type='step-finish'` 的行 | 12 条，其中带 `cost` 的 12 条，带 `tokens.total` 的 12 条 |
| v2 `session_message` 中带 step-finish 部件的 assistant 事件 | 0 / 1,389 |
| v2 assistant 事件带顶层 `cost` 键的 | 1,383 / 1,389（整库非零 cost 的行数：**0**） |
| v2 assistant 事件带 `tokens.total` 的 | 0 / 1,389（整库） |
| v2 assistant 事件带非零 `tokens.cache.write` 的 | 0 / 1,389，合计 0 |

一条真实 step-finish 部件（v1，`part` 表）：

```json
{"reason":"tool-calls","snapshot":"…","type":"step-finish",
 "tokens":{"total":18185,"input":16177,"output":53,"reasoning":35,"cache":{"write":0,"read":1920}},
 "cost":0}
```

一条真实 assistant 事件（v2，`session_message` 表）的顶层键：`time, agent, model, content, finish, rawFinish, cost, tokens`；`content` 里只出现 `tool`(1,371) / `reasoning`(779) / `text`(438)。cost 与 token 都在行自己身上，`tokens` 里没有 `total`。

结论：v1 的子句不是"错"，是"属于另一张表"。所以本轮只动 v2 分支，`buildMessageStatsSql`（v1）原样保留。

### 3.2 新旧查询在同一库上的逐消息差

取 assistant 事件最多的 12 个会话，把新旧两版 SQL 都跑一遍：

| 会话（截取） | 消息数 | 旧 cost 合计 | 新 cost 合计 | 旧 total 合计 | 新 total 合计 |
| --- | --- | --- | --- | --- | --- |
| ses_ea7757543…gL8hMu | 219 | 0 | 0 | 0 | 59,106,838 |
| ses_eae166f72…W7yRNw | 213 | 0 | 0 | 0 | 38,640,915 |
| ses_ebc7770d9…ZAxGboj | 171 | 0 | 0 | 0 | 21,366,563 |
| ses_ebca6a34e…Ngk7ITd | 124 | 0 | 0 | 0 | 21,504,673 |
| ses_ebd94ca37…dg3a98 | 96 | 0 | 0 | 0 | 13,988,711 |
| ses_ec5a64d2c…lIvheR | 93 | 0 | 0 | 0 | 8,207,028 |
| ses_ebca3a643…hLg1iJt | 88 | 0 | 0 | 0 | 6,838,403 |
| ses_ea6bb77c1…zFBnM1 | 86 | 0 | 0 | 0 | 6,266,035 |
| ses_ec5b855d1…9u7L5eNe | 86 | 0 | 0 | 0 | 11,241,567 |
| ses_ea77ac8e1…s2m44V | 75 | 0 | 0 | 0 | 7,153,908 |
| ses_ecb45bf02…szt9NvX | 54 | 0 | 0 | 0 | 2,589,380 |
| ses_ec597d44f…5OkbOB1 | 25 | 0 | 0 | 0 | 1,415,731 |

- 行数在 12/12 个会话上完全一致 —— 没有任何消息被新增或丢掉。
- total 的**值**在 1,328 / 1,330 条消息上变了（0 → 四部件之和）；剩下 2 条本来就没有 `tokens` 对象，新旧都是 0。
- cost 的值在每一个会话上、整库上都没有变：0 → 0。形状对了，数值无从比较。

### 3.3 这些差别到不到屏幕上：不到

按 `formatMessageUsage`（`src/view/renderer.ts:31-38`）的规则，把两版查询的行分别渲染成页脚文本再逐条比：

| 断言 | 实测 |
| --- | --- |
| 最大会话（219 条消息）上页脚文本有差的消息数 | **0** |
| 全库"input 与 output 都为空、但 total 非空"因而页脚会新冒出 token 数的消息 | **0** |
| 全库非零 cost 的 assistant 事件 | **0** |

三条兜底逻辑各自挡住了：`↑`/`↓` 只看 input/output（两版一致）；`totalTokens` 只在两者都缺时出场（没有这种行）；金额只在 `cost > 0` 时才印（全库为 0）。会话级数字走的是另一条链路 —— `refreshNativeUsage` 用 0.2.91 的注册表列自己算 `totalTokens = input + output + reasoning`，与本轮的逐消息查询无关，也没被本轮改动。

所以本轮的措辞只能是：**修好了一条读得到形状、但本机数值恰好全为 0 的路径**。换一个按量计费的内核，同一处才会显出差别。

### 3.4 一条不变量：逐消息 total 必须等于 0.2.91 的 context

0.2.91 里会话级 `context_tokens` 的定义是"`seq` 最大的那条 assistant 事件的四个 token 部件之和"。本轮把逐消息 `total_tokens` 定义成同一条式子。那么"最新一条统计行的 total" 就必须等于"会话的 context"。12 个会话全中：

| 会话（截取） | 最新事件 seq | 新逐消息 total | 0.2.91 context_tokens |
| --- | --- | --- | --- |
| ses_ea7757543…gL8hMu | 2062 | 472,253 | 472,253 |
| ses_eae166f72…W7yRNw | 1802 | 367,946 | 367,946 |
| ses_ebc7770d9…ZAxGboj | 1403 | 192,242 | 192,242 |
| ses_ebca6a34e…Ngk7ITd | 1122 | 272,378 | 272,378 |
| ses_ebd94ca37…dg3a98 | 996 | 229,087 | 229,087 |
| ses_ec5a64d2c…lIvheR | 788 | 132,709 | 132,709 |
| ses_ebca3a643…hLg1iJt | 743 | 116,253 | 116,253 |
| ses_ea6bb77c1…zFBnM1 | 759 | 130,185 | 130,185 |
| ses_ec5b855d1…9u7L5eNe | 900 | 170,294 | 170,294 |
| ses_ea77ac8e1…s2m44V | 746 | 148,113 | 148,113 |
| ses_ecb45bf02…szt9NvX | 523 | 82,979 | 82,979 |
| ses_ec597d44f…5OkbOB1 | 202 | 68,906 | 68,906 |

**12 / 12 相等**。第一行 472,253 也与 0.2.91 §3.4 那条流水线读出的 context 是同一个数。这是本轮真正拿得出手的证据：不是"我看代码觉得对"，而是两处读数由构造变成同一个定义，并在真实库上逐一吻合。

### 3.5 顺带测到：内核账与事件账的差落在哪一列

0.2.91 记下"注册表比事件日志多记"却没能说明多在哪。按列拆开四个会话（合计口径：input+output+reasoning+cache_read）：

| 会话（截取） | 列 | 注册表 | 事件之和 | 差 |
| --- | --- | --- | --- | --- |
| ses_ea7757543… | input | 852,017 | 849,163 | 2,854 |
| | output | 88,033 | 88,019 | 14 |
| | reasoning | 153,568 | 153,490 | 78 |
| | cache_read | 58,016,863 | 58,016,166 | 697 |
| ses_ebc7770d9… | input | 382,302 | 381,728 | 574 |
| | output | 52,361 | 52,348 | 13 |
| | reasoning | 27,794 | 27,775 | 19 |
| | cache_read | 20,904,842 | 20,904,712 | 130 |
| ses_ec5a64d2c… | input | 96,098 | 91,962 | 4,136 |
| | output | 44,447 | 44,432 | 15 |
| | reasoning | 19,330 | 19,306 | 24 |
| | cache_read | 8,051,458 | 8,051,328 | 130 |
| ses_ec597d44f… | input | 68,799 | 68,246 | 553 |
| | output | 6,395 | 6,385 | 10 |
| | reasoning | 7,483 | 7,445 | 38 |
| | cache_read | 1,333,785 | 1,333,655 | 130 |

两点实测事实：`cache.write` 两侧都是 0（全库为 0），所以"差不等于 cache.write"，也说明把它排除在 context 式子之外在本机不影响任何数值；差**同时分布在四列上**，比例像一整条真实消息的开销。12 个会话里事件之和 ≤ 注册表 12/12 成立。

推断（尚未证实，记为推断）：注册表多记的是内核自己发起、且不写成 assistant 事件的那次调用（会话标题生成），或者是被删除的事件行。四个会话的 input 差在 553…4,136 之间不成常数，说明不止一种来源。留给后一轮。

## 4. 改动

`buildMessageStatsSqlV2` 只保留三条约束：

1. **cost 取行自己的**：`coalesce(cast(json_extract(sm.data, '$.cost') as real), 0)`，不再遍历 `content`。
2. **total 由部件相加**：`input + output + reasoning + cache.read`，与 0.2.91 的 context 式子逐字相同；`cache.write` 不计入 —— context 窗口里没有它，且在 v2 事件里恒为 0。
3. **没有 token 记录的行留在列表里补 0**：`where` 只按 `type='assistant'` 与 `json_valid(data)` 过滤，不加 `json_extract(... '$.tokens') is not null`。位置匹配（旧转录无原生 id 时）依赖行数，删行会让每条后续配对都错一位。

`order by sm.seq asc`、`escapeSqlLiteral`、v1 分支，均未动。

## 5. 判别测试

`npx vitest run` 全量：**2,599 tests（2,580 passed，19 failed）**。基线 2,598/2,579/19，本轮净 +1 条测试、+1 条通过；19 条失败仍是那 19 条与平台绑定的既有失败（18 条 `NativeSessionReader.test.ts` 的 POSIX fakeFs、1 条 `commandResolution.test.ts`），未新增、未去修。

回退检验：只把 `src/opencode/NativeSessionReader.ts` 还原到 HEAD（测试文件不动），该文件失败 **21 = 18 + 3**：

1. `v2 (forked database) SQL builders > reads each message its own cost and token parts, in seq order` —— 形状断言：要求出现 `json_extract(sm.data, '$.cost')` 与 `$.tokens.cache.read`，并要求**不出现** `step-finish` / `json_each` / `$.tokens.total`。
2. `v2 SQL against a real SQLite engine > … > returns fork-correct results` —— 真 SQLite 上 `total_tokens: 17 → 107`（fixture 已改成实测形状：cost 在行上、无 step-finish 部件、无 `tokens.total`）。这一条同时判别 cost：旧查询读不到 0.5。
3. `… > usage takes the registry totals, not a sum over the event log > reads each message its own cost and keeps a silent one in the list` —— `m_live_1` 期望 11,787、`m_live_2` 期望 13,995（旧查询两条都给 0）。

不判别的部分，按纪律点名：

- 第 3 条测试里 `cost: 0` 的两个期望**不判别** —— fixture 的 `cost` 键值本身就是 0，新旧查询都给 0；这条测试的判别力全在 `total_tokens` 上。
- 第 3 条测试的 `ses_sparse` 半段**不判别** —— 没有 token 的消息在两版查询里都是 `{0,0,0,0}`；它守的是"不许消失"这个回归，不是本轮的修复。
- `m_live_1/m_live_2` 的 `input_tokens`、`output_tokens` 两列两版一致（那两条子句本来就没写错），不参与判别。
- fixture 里新增的 `m_live_ctrl`（model-switched）行守的是 `type='assistant'` 过滤，与本轮改动无关。

`ses_sparse` 的两行插入从测试体内挪进了 fixture 建表段，纯重排 —— 挪动前后该测试通过状态相同。

## 6. 仍未闭合

- 3.5 的列级差只到"像一整条消息"这一步：到底是标题调用、被删事件行、还是 compaction 的开销，需要按 `seq` 把注册表增量和事件行一一对上才能定；本轮没做，也没宣称做了。
- `total_tokens` 是否应当含 `cache.write`：内核在 v1 step-finish 的 `tokens.total` 里含不含写缓存，本机无样本（v2 事件没有 total，v1 的 12 条 total 与部件之和的关系尚未逐条验证）。当前按"不含"实现，理由是 cache.write 全库为 0、且 context 窗口定义里不含它。
- 按量计费下的 cost 差别无法在本机演示（全库 0）。这条路径的数值正确性目前只有形状证据。
- 页脚上"这条消息一共多少 token"其实从没被单独显示过（`formatMessageUsage` 只在 input/output 都缺时兜底）。本轮把数读对了，但要不要真的显示出来，是产品决定，未动。
