# 参考仓库复核 2.3.24：elicitation 答案键的原型链问题

日期：2026-10-18。实现版本：Co-Ober 0.2.68。

## 1. 网络与镜像

本轮开始时 github.com 反复 TLS 重置与连接超时（`git push` 需要重试六次以上）。
改用 `gh-proxy.com` 作为只读镜像：

```text
git ls-remote https://gh-proxy.com/https://github.com/YishenTu/claudian.git HEAD
```

镜像立刻回报了一个本地看不到的新 HEAD：`1e432bef`。**在 github.com 不可用时，
"参考仓库没有更新"这个结论本身就不可信**——这与本项目一贯的做法一致：没有
取到证据时，不能声称没有变化。

`gh-proxy.com` 可用于 `ls-remote` / `fetch`，推送仍走 origin。

## 2. 参考仓库确实前进了

`31dd256b` / 2.3.22 → `1e432bef` / 2.3.24，18 个提交。本轮 **OpenCode provider
有改动**（此前两轮都是空的）：

- `execution/OpencodeHTTPSessionKernel.ts`
- `normalization/opencodeToolNormalization.ts`

`AGENTS.md` 未变——约束仍然成立。而这两处 diff 的实质是**一处真实的键处理缺陷**：

```diff
- const value = response.answers[String(field.key)];
- answer[String(field.key)] = ...
+ const key = String(field.key);
+ const value = Object.hasOwn(response.answers, key) ? response.answers[key] : undefined;
+ Object.defineProperty(answer, key, { value: ..., enumerable: true, writable: true, configurable: true });
```

上游把它修在**表单应答**路径上：`Object.hasOwn` 管读，`Object.defineProperty` 管写。

## 3. 本项目同一形状的缺陷

`AcpRequestHandler.ts` 的 elicitation 回声处写着：

```ts
// Echo only keys the agent actually asked for, so a caller that hands
// back more than the schema requested cannot inject answers.
const content: Record<string, string | number | boolean> = {};
for (const field of fields) {
  const value = answer.content[field.key];
  if (value !== undefined) content[field.key] = value;
}
```

注释承诺的"只回显被请求的键"，在这两行上**并不成立**：

- **读会走原型链。** agent 把字段命名为 `toString`，若读者没有填这一项，
  `answer.content['toString']` 取到的是继承来的**函数**，它能通过
  `value !== undefined` 这道闸，于是以"读者输入"的身份发给 agent。
  该键能通过 zod 的 schema 解析，所以这条路径**真实可达**。
- **写会走原型 setter。** `content['__proto__'] = <原始值>` 对原始值是**静默丢弃**，
  于是读者填的那一项消失，而 elicitation 仍然回答 `accept`。

`permissionBanner.ts` 构造 `content` 的那处是同一种写法。

## 4. 实测修正了自己的一个假设

动手前先测了这条路径的前提，结论修正了我原本的判断：

**zod 的 `z.record()` 在解析时就把 `__proto__` 整个丢掉了**，它根本不会成为
own 键；且解析器本身也不会污染原型（实测 `({}).type === undefined`）。

因此：

- **可达且真实的是"读继承"** —— `toString` 能穿过解析，是活的缺陷，已修；
- **"写被吞"是不可达的** —— 该键在 schema 层已被丢弃。修复保留为纵深防御
  （成本极低，且 `content` 也可能从别的来源拿到这样的键）；
- 并**不存在原型污染**。此前若不测就按"污染漏洞"表述会是错的。

这一点值得单独记下：本轮最容易犯的错误，是照抄上游标题里的印象，
把它写成一个比实际严重得多的安全漏洞。

## 5. 落地的边界

`src/utils/ownKeys.ts` 提供两个纯函数，两个站点共用：

- `readOwnKey(source, key)` —— `Object.hasOwn` 决定读不读；
- `writeOwnKey(target, key, value)` —— `Object.defineProperty` 写成 own 且
  enumerable 的普通键，因此能序列上线，且 `__proto__` 只是普通键。

边界：一个 `ownKeys.test.ts`（9 项），以及 `acp.test.ts` 上两个与既有
"echoes only the keys the schema asked for" 并列的测试。

## 6. 回归

全套：**86 个测试文件、2,505 项通过**（基线 2494/85）；TypeScript 与 ESLint 通过。

已确认承重边界对旧写法确实失败：把两行改回 `answer.content[field.key]` /
`content[field.key] = value` 后，"does not satisfy an un-answered field from the
prototype chain" 失败，实际结果是 `['target', 'toString']`——**一个原型函数被当
作读者的答案发给了 agent**。

## 7. 仍未解决

- **被 zod 丢弃的 schema 键对读者不可见。** `__proto__` 这类键解析后既不在
  `fields` 也不在 `omitted`，读者因此**不会知道自己漏答了一项**。修它需要在
  schema 层换成保留 own 键的解析，属于另一件事，本轮只做到"不凭空造答案"。
- 聊天后端仍是 ACP；原生闭环探针只测量，不接线。
