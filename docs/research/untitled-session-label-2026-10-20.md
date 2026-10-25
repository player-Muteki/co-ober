# 未命名的原生会话不再把自己的主键当名字（2026-10-20，0.2.94）

一句话：0.2.90 那轮把"从没被人说过的"注册表行藏起来了，剩下的**有用户发言但没有标题**的行仍然顶着 `ses_ec5edc66effevS…` 这样的 30 字符主键出现在历史下拉的"名字"位置上。本轮先验证排队的方案（改用 `slug`），实测把它否决：`slug` 在 2.0.28 里是一个**只写不读**的列，内核自己给无标题会话的措辞是 `"Untitled session"`。最终改动是：读取层报告"没有标题"这个事实，措辞交给下拉面板按当前语言说，主键退到悬停文本并且仍然可被搜索框匹配。

## 1. 验收标准

- 数据库里 `title` 为空的原生会话，下拉列表与内容检索结果的"名字"位置不再出现 `ses_…` 主键。
- 该行的标识符不丢：仍能在悬停文本里读到，仍能通过在搜索框键入它来筛出。
- 有标题的会话一个字节都不变（名字就是标题，不带悬停键）。
- 措辞属于显示层：切换语言后重新打开下拉，未命名行要说当前语言的那句，不能把上一次打开时的英文烤进缓存。
- 本地会话那一栏（`renderItems` 里的 `s.title || s.sessionId`）不在本轮范围内，不动。

## 2. 修改前的行为

`src/opencode/NativeSessionReader.ts` 两处映射把主键当标签交给上层：

```ts
title: typeof row.title === 'string' && row.title.trim() ? row.title : sessionId,
```

`src/view/sessionDropdown.ts` 的原生行与内容检索行都渲染 `s.title || s.sessionId`，并且过滤只用 `s.title?.toLowerCase().includes(filter)`。合起来的效果：名字位置上是一串被 CSS 截断的 base62 键（截断后连"能不能拿去别处查"都成问题），而它恰恰是这套代码里唯一可搜索的字段。

## 3. 测量

对象：`opencode v2.0.28`，真实数据库 `C:\Users\LEGION\.local\share\opencode\opencode.db`，真实已安装内核二进制 `C:\Users\LEGION\AppData\Roaming\npm\node_modules\@opencode\cli\bin\opencode.exe`（212,916,616 字节，内嵌 JS 以明文出现，可字符串检索）。脚本在 `co-ober-rig/usage-0.2.91/`：`slug-label.mjs`（slug 普查）、`title-source.mjs`（标题与首条用户消息的关系）、`persona-event2.mjs`（用户事件负载形状）、`persona-hit.mjs`（注入词在内容检索里的误命中）。

### 3.1 `slug` 普查：存在、必填、但不唯一

| 断言 | 实测 |
| --- | --- |
| `session_v2` 行数 | 22 |
| `slug` 非空 | 22/22，`slug_null = 0`，`slug_empty = 0` |
| `title` 为空 | 4 行：`happy-pixel`、`cosmic-knight`、`quick-tiger`、`neon-nebula` |
| 经 0.2.90 过滤后仍在列表里的无标题行 | 3 行（`happy-pixel` 没有 `user` 事件被藏掉；`neon-nebula` 目录是 `C:/Users/LEGION`，不属于本 vault） |
| slug 唯一性 | 20 个不同 slug / 22 行 —— **`hidden-nebula` 出现 2 次、`crisp-sailor` 出现 2 次** |
| 重复的 slug 属于哪些行 | 4 行全部**有**标题，所以按"标题优先"的规则今天不会撞名；风险是将来两行无标题恰好同名 |
| 旧版 `session` 表 | 29 列且**含 `slug`**，2/2 行有值，0 行无标题 |
| slug 形状 | 最长 14 字符，全部匹配 `^[a-z0-9-]+$` |

### 3.2 内核二进制里 `slug` 的全部出现（22 条去重上下文）

`slug` 在 2.0.28 里只出现在三类位置：DDL（`` `slug` text NOT NULL ``）、schema 探针（`slug:"required"`）、以及写入路径（`session/new` 时 `slug:lh.create()`，共 2 处；迁移时 `slug:i.data.slug`）。检索不到任何读取用途：

- `\.slug===`、`slug ==`、`bySlug`、`slugTo`、`fromSlug` —— 各 0 命中；
- 没有任何 `title ?? slug` 形式的兜底。

而内核**自己**给无标题会话的措辞在两处显示代码里都是同一个字面量：

```
CLI 列表：  t.map((o)=>[o.id,(o.title??"Untitled session").replace(/[\r\n\t]/g,…)])
TUI 头部：  Ht=()=>n?.session.get(he.sessionID)?.title??he.title??"Untitled session"
```

结论（带保留）：`slug` 是 2.0.28 的只写列；内核在名字缺失时说的是 "Untitled session"，并且把 `id` 与它并排显示。保留项：这是对一个单文件可执行体的字符串检索，邻域里能看到乱码（说明附近有编码/压缩载荷），所以"内核从不读 `slug`"是强证据而非证明。

**排队方案就此否决**：把标签换成 `quick-tiger` 会让 co-ober 的下拉与内核自己的 UI 说两套话，而且引入一个今天没发生、但发生就无法区分的重名（生成器确实会撞：22 行里 2 对）。

### 3.3 另一个候选：拿首条用户消息当名字

也被实测否决。`session_message` 的 `user` 事件负载顶层键是 `time, text, files`（**没有** `content` 数组），即内核把 co-ober 发过去的多个 text part 拍平成一条 `$.text`。两条 vault 内无标题行的首条用户消息长度是 7,338 与 7,339 字符，开头是：

```
You are Co-Ober, an AI assistant living inside the user's Obsidian vault. …
```

尾巴才是用户真正打的那句（`… === END NOTE ===\n按照前文范式重写2.9.1`）。全库 99 条带 `$.text` 的 `user` 事件里 **13 条以注入前缀开头**，分布在 4/21 个会话；这些注入事件长度 7,070–10,004 字符，而全体用户文本中位数只有 22 字符。也就是说：需要起名字的恰恰是"注入了 7k 上下文然后 turn 失败"的行，直接取首条消息会把 co-ober 自己的提示词印成会话名。

顺带量到"标题来自首条提示"只能算推断：18 个有标题行里，标题是首条用户消息**字面子串**的 **0/18**（`看看我的obsidian` → `查看 Obsidian 内容`；`美化一下各个svg` → `美化 ch02.md 中的各个 SVG`）。语义相关是读出来的，不是数据证明的。

### 3.4 采用的措辞

直接用内核的字面量 `"Untitled session"`（英文），中文侧 `未命名会话`。这样同一会话在 co-ober 的下拉里与在 OpenCode 的列表里说的是同一句话，而 `id` 仍然以悬停文本的形式留在行上——与内核把 `id` 并排印出来是同一信息设计。

## 4. 改动

- `NativeSessionReader.ts`：`listNativeSessions` 与 `searchNativeSessions` 不再造标签，`title` 只在非空时挂上（`SessionMeta.title` 本来就是可选）；`types.ts` 给这个字段补了一句"没有名字时就缺着"；0.2.90 那段注释里"labels with the raw `ses_…` id"改为"would have labelled"，并补了无标题行的去向。
- `sessionDropdown.ts`：原生行与内容检索行的标签改为 `s.title || t().sessionDropdown.untitledSession`，无标题时把 `sessionId` 放进行的 `title` 悬停属性；原生过滤同时匹配标签与 `sessionId`（否则把主键从标签里拿走，就再也搜不到它了）。
- `i18n/en.ts`、`i18n/zh.ts`：新增 `sessionDropdown.untitledSession`。

标签不再唯一之后，两行未命名会话在列表里同名，靠已有的时间列与悬停键区分；导出文件名不受影响，因为导出用的是本地 store 的标题并自带时间戳后缀（`CoOberViewController.ts:3469`）。

## 5. 验证

`npx tsc --noEmit` 干净；`npx eslint src --ext .ts --max-warnings=0` 干净；全量 `npx vitest run`：**2,606 项，2,587 通过，19 失败**，19 全部是既有的平台绑定失败（`NativeSessionReader.test.ts` 18 项 POSIX fakeFs、`commandResolution.test.ts` 1 项），与本轮无关。新增 4 项（`sessionDropdown.test.ts` 72 → 76），另改写 4 处既有断言。

回退检查分两半做（因为读取层与显示层各有独立判据）：

| 回退 | 结果 |
| --- | --- |
| 只把读取层改回"空标题就用主键" | 两个文件合计 **20 = 18 + 2** 失败：`hides the abandoned shell and keeps the errored conversation`、`keeps a titled-less session searchable by its question` |
| 只把显示层改回 `s.title \|\| s.sessionId` 并去掉悬停/过滤 | `sessionDropdown.test.ts` **4 = 0 + 4** 失败，新写的 4 项全灭 |

不判别的项，按惯例点名：

- `NativeSessionReader.test.ts` 里 `maps rows to session metadata` 与 `maps rows to session metadata with trimmed snippets` 两处新断言（`not.toHaveProperty('title')`）**在本平台不判别**——它们所在的 fakeFs 用例回退前后都因为 POSIX 路径原因失败。
- 过滤用例的后半段"有标题的行不挂悬停键"（`hasAttribute('title') === false`）对读取层回退不判别：旧代码本就不设悬停。它只保证改动没有溢出到有标题的行。
- 名称为 `re-speaks an untitled row when the language changes` 的用例对读取层回退不判别（它不经过读取层），它是显示层"措辞不烤进状态"这一性质的判据。

未做：没有在真实 Obsidian 面板里目视确认这两行——jsdom 断言 + 现有 CSS（`.session-label` 截断）推理。

## 6. 仍未闭合

1. **本轮最大的副产物**：co-ober 把身份提示词、整篇被引用笔记、历史块作为**用户消息**发出去（`CoOberViewController.ts:3389-3395` 把 `sysPrompt + notesBlock`、`historyBlock` 排在用户文本之前作为多个 text part，内核拍平成一条 `$.text`）。后果至少三处：恢复出来的 transcript 把 7k 注入印在用户气泡里；原生内容检索的 user 侧匹配的是注入内容而非用户说过的话——`persona-hit.mjs` 实测 `wikilinks`、`backlinks`、`bi-directional linking` 三个只存在于 co-ober 身份提示词里的词，各匹配到 **13 条 `user` 事件 / 4 个会话**，而这些词用户一个都没打过；snippet 可能引用别的笔记正文。精确切分需要写入侧留一个 co-ober 自己能认出的边界，而在没有边界的旧行上任何读取侧剥离都是猜——本轮**没有**动它，也拒绝用启发式冒充精确。
2. 两行未命名会话现在同名；若将来出现两行无标题且同 `slug`，本轮不受影响（不用 slug），但列表里只剩时间可辨。
3. `slug` 是否会被后续内核版本读回来（分享链接、`--session` 按名寻址），未测。
4. 本地会话行仍用 `s.title || s.sessionId`：占位行（`:371`）的标题就是会话 id，本轮按验收标准排除。
5. 原生行没有 `role="option"`/`aria-selected`（只有本地行有，`sessionDropdown.ts:116-117`），这是另一个可及性缺口，本轮未动。
