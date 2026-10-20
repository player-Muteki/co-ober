# 分子已经知道，分母从未报出：恢复后的上下文环不再报"什么都没报告"（2026-10-20，0.2.93）

一句话：0.2.91 让恢复出来的会话从内核账上答出了"这条会话现在占多少 token"，但头顶的上下文环照旧画一根破折号 —— 那根破折号在这套代码里的意思是"什么都没报告"，而此刻明明报告了一半。本轮实测：内核在恢复这一刻**从不**发窗口大小（`session/load` 与 `session/resume` 两条路都测了），所以百分比永远算不出来；能做的诚实改动是把已知的分子显示出来，同时不假装有分母。

## 1. 验收标准

- 恢复一个真实会话：数据库答得出上下文占用而本次进程从未收到窗口大小时，环上应显示那个占用数，而不是"未报告"。
- 没有分母就不许出现百分比、不许给 `aria-valuenow`、不许把弧填上 —— 显示的是**数**，不是**比例**。
- 两边都没有数时，行为与今天完全一致：破折号、`empty` 灰化、`aria-valuetext` 说"未报告"、无 tooltip。
- 有分母的路径一个字节都不变。

## 2. 修改前的行为

`src/view/CoOberView.ts` 的 `updateContextMeter` 把两种不同的事实渲染成同一根破折号：

```ts
const pct = usage ? contextPercentage(usage) : null;
if (!usage || pct === null) { /* '—' + empty + notReported */ }
```

而 `contextPercentage`（`src/view/renderer.ts:68-76`）在 `used === undefined` **或** `window <= 0` 时都返回 null。也就是说"没分子"与"没分母"共用一个出口。0.2.91 之后，恢复的原生会话落在后者：`refreshNativeUsage` 写 `contextTokens: usage.contextTokens`，而 `contextWindow: rt.state.usage?.contextWindow` —— 打开标签时 `rt.state.usage` 是 `null`（`CoOberViewController.ts:1412`、`:3704`），于是分母是 undefined，环上什么都看不见，尽管 472,253 这样的数就在手上。

## 3. 测量

`opencode v2.0.28`，真实数据库 `C:\Users\LEGION\.local\share\opencode\opencode.db`，真实 ACP 子进程。脚本在 `co-ober-rig/usage-0.2.91/`：`window-source.mjs`（数据库侧普查）、`restore-frames.mjs`（新建会话→提示→另起进程 load）、`restore-resume.mjs`（resume/list 的帧与结果）、`resume-result.mjs`（resume 返回值递归扫窗口键）。

### 3.1 数据库里没有窗口大小

| 断言 | 实测 |
| --- | --- |
| `session_v2` 36 列中名字形如 limit/context/window/size 的 | **无** |
| 1,740 条 `session_message` 事件里键名含 `context` / `contextWindow` / `size` / `window` 的 | **0 条** |
| 事件类型分布 | assistant 1,389 / user 99 / model-switched 92 / idle 90 / agent-switched 51 / system 10 / synthetic 9 |
| `session_v2.model` 形状 | `{"id":"minimax-m3.1-flash-free","providerID":"opencode","variant":"max"}`（22 行里 4 行整个为 null） |

`limit` 这个词在事件里出现过，但那是工具部件自己的入参，不是窗口：递归扫描恢复帧与恢复返回值时 `size/limit/context/window/budget` 全无命中（§3.3）。数据库给不出分母，只能问内核。

### 3.2 恢复这一刻，内核不发窗口大小；提示一开始就发

`restore-frames.mjs`：进程 A 新建会话（`ses_ea63f486effe…`）并提示一句，另起进程 B 只做 `session/load`、等 3 秒、不开口。

| 观察 | 实测 |
| --- | --- |
| A：`session/prompt` 期间的 `usage_update` | 1 条：`{"used":11842,"size":1000000,"cost":{"amount":0,"currency":"USD"}}` |
| A：`session/prompt` 的**响应**里的 usage | `{"inputTokens":11271,"outputTokens":2,"totalTokens":11842,"cachedReadTokens":569}` —— 没有 size |
| B：`session/load` 的 5 条重放帧 | agent_message_chunk 1、user_message_chunk 1、config_option_update 1、available_commands_update 2 —— `usage_update` **0 条**，含 size/used 的帧 **0 条** |
| B：load 之后第一次提示 | 立刻收到 `{"used":14042,"size":1000000}` |

结论一句话：**窗口大小只在一次提示的生命周期里出现**。恢复出来的标签若没人再开口，插件永远等不到分母。

### 3.3 换一条恢复路径也没有

`session/resume`（`agentCapabilities` 里 `loadSession: true`，`sessionCapabilities` 含 `close/delete/fork/list/resume`）单独测：

| 观察 | 实测 |
| --- | --- |
| `session/resume` 的返回结果键 | 只有 `configOptions` |
| 返回值 + 重放帧里递归匹配 `size/limit/context/window/budget` 的键 | **0 处命中** |
| resume 期间的重放帧 | 两次实测：恢复一个刚提示过一句的会话得 **3 条**（available_commands_update ×2、config_option_update ×1）；恢复注册表里事件最少（1 条）的既有会话得 **2 条**。两次的 `usage_update` 都是 **0 条** |
| `config_option_update` 里的选项 id | `model`、`effort`、`mode` —— 有当前模型名，没有窗口 |
| `session/list` 每条会话的键 | `sessionId, cwd, title, updatedAt`（外加 `nextCursor`）—— 不带任何用量 |

所以"问内核要分母"在恢复时刻无解。插件内唯一持有窗口大小的另一处是原生目录（`OpencodeNativeModel.context`，来自 `opencode serve` 的 `/api/model`），但它今天只在设置页里渲染一行说明文字（`src/settings.ts:949`），要拉起一个临时本地服务才能刷新 —— 不属于本轮的"单点"改动。

### 3.4 rig 的清洁性（真实数据库上跑过）

两个一次性会话（各一句提示）都以 `session/delete` 收尾，返回 `{}` 被接受；resume 测试复用本 vault 里事件最少（1 条）的既有会话，不新建任何东西。两次测前/测后计数相同：**22 会话 / 1,740 事件**；被 resume 的那行 `time_viewed` 仍为 `null`。

顺带测到一个与本轮无关但值得记的形状：注册表里 `directory` 存的是正斜杠（`D:/ObsidianVaults/kys-in-whu-cs`，另有 4 行 `C:/Users/LEGION`、1 行 `C:/Users/LEGION/Desktop/new`、1 行别的项目路径）。

## 4. 改动

`updateContextMeter` 的 null 分支按"分子到没到"分成两条，并把 `fmt` 提到分支之前共用：

- **分子已知（`usage.contextTokens !== undefined`）而比例算不出**：环上显示 `fmt(used)`（如 `472.3k`），去掉 `empty` 灰化（这不是空读数），弧仍然 `0 …` 不填，**不设** `aria-valuenow`，`aria-valuetext` 用新句 `contextUsedOnly`（"Context {used} used; window not reported" / "上下文已用 {used}；窗口未报告"），tooltip 写成 `Context: 472.3k / — tokens` —— 分母那一格用破折号，正是这套代码里"内核没告诉我们"的既有记号。
- **分子也未知**：与改动前逐字一致（破折号、`empty`、`notReported`、无 tooltip）。
- 有分母的路径、告警/危险阈值、locale 重绘（`lastMeterUsage` + `refreshLocale`）都未动。

`used === 0` 归入"已知"一侧显示 `0`，与既有的"0 是一次真实读数"纪律一致。

新增 i18n 一处两套：`usage.contextUsedOnly`（en/zh 同步，`{used}` 占位符一致）。

## 5. 判别测试

`npx vitest run` 全量：**2,602 tests（2,583 passed，19 failed）** = 基线 2,599 + 本轮 3 条新测试；19 条失败仍是那 19 条与平台绑定的既有失败，未新增、未去修。`tsc --noEmit` 与 `eslint --max-warnings=0` 均干净。`CoOberView.test.ts` 该文件 69 条（原 66 条）全通过。

回退检验：只把 `src/view/CoOberView.ts` 还原到 HEAD，该文件 **2 条失败 / 67 通过**，失败的正是两条新测试 —— `shows the context the kernel reported when no window ever arrived`（`472.3k` 对 `—`，并钉住"无 `%`、无 `aria-valuenow`、`empty` 不加、tooltip 里 `472.3k / —`）与 `re-speaks a window-free reading when the language changes`（zh 下 tooltip 与 aria 重说）。

不判别的部分，按纪律点名：第三条新测试 `keeps the dash for the state where neither side was reported` 在改动前后都通过 —— 它是"别把没分子的情况顺手改了"的边界护栏，不是本轮修复的证据。另外既有的 `dashes an unreported figure instead of calling the window empty`（有分母、无分子）也仍然两侧通过，守的是另一半语义。

**本轮没有真实 Obsidian 窗口里的目测**：Obsidian 插件没有可驱动的浏览器实例，改动是通过插件自己的视图代码在 jsdom 里跑的（`.co-ober-arc-meter` / `.co-ober-pct` 真实元素、真实属性），布局层面 6 个字符的 `472.3k` 挤不挤得下头部，只在 CSS 上做了判断（`.co-ober-arc-pct` 是 `min-width: 24px`、10px 字号、无 max-width、`flex-shrink: 0` 的兄弟），未肉眼确认。

## 6. 仍未闭合

- 分母本身仍然只能等一次提示。可行的办法是把内核报过的窗口大小随会话持久化，恢复时与注册表里的 `model` 比对（`session_v2.model` 有 `providerID/id/variant`，22 行里 4 行 null），只对得上才复用；这需要给 `SerializedSession` 加字段并想清楚换模型的失效条件，不属于本轮。
- 没有分母时也就没有告警色：`warning`/`critical` 阈值是按百分比定义的，只显示计数意味着恢复出来的会话在真正逼近上限之前不会变橙。要不要另设一条"无窗口的告警"，是产品决定。
- zh 的 `tokensUnit` 仍是英文 `tokens`（既有状态，本轮未改）。
- `session/resume` 只回 `configOptions`、`session/list` 不带用量，这两条是"内核此刻答不出"的证据，不是"内核永远答不出"：2.0.28 之后的版本若补上恢复期用量帧，本轮的选择就要重估。
