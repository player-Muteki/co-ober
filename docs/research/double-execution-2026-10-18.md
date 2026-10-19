# 差距分析验收项之三:已提交的请求不得因 fallback 跑两遍

日期:2026-10-18。实现版本:Co-Ober 0.2.73。

## 1. 参考仓库

Claudian `main` 仍为 `8a7de7c6`(2.3.24),`src/providers/opencode` 未改动。

## 2. 这一条为什么最危险

前两条验收项出错,读者看到的是一句不准确的说明。这一条出错,
**agent 会把同一条指令执行两遍**——两遍编辑、两遍命令、两遍提交。
前两条是"话说错了",这一条是"活干了两遍"。

## 3. 现场

`CoOberViewController` 的回合失败分支给一个 chip:

- `AcpProcessExitError` → "重启并重试" → `reconnect()` 然后 `retryTurn(...)`
- 其他错误 → "重试" → `retryTurn(...)`

`retryTurn` 直接把同样的文本再发一次。**它不问这一轮是不是已经跑过了。**

## 4. 实测:提交过的提示词会留在会话里

装置(`opencode acp`,provider 接了请求后永久挂起):

1. `initialize` → `session/new`
2. 发一条提示词,内容带一个唯一标记
3. **第 5 秒把 agent SIGKILL**(回合在飞行中)
4. 起一个全新的 `opencode acp` 进程,`session/load` 同一个 sessionId

结果:

```
prompt submitted (no reply expected — provider stalls)
user_message chunk seen before kill? false     ← 客户端什么也没看到
agent killed mid-turn
session/load after the kill: ok
update kinds on replay: user_message_chunk,available_commands_update
PROMPT MARKER PRESENT in reloaded transcript? true
tool_call frames on replay? false
```

两件事同时成立:

- **agent 已经收下并持久记录了这条提示词**,哪怕这一轮从头到尾没有回答。
- **客户端一个 `user_message_chunk` 都没收到**——kill 发生在任何一帧之前。

所以:看着这一轮的客户端和读者**看到的一样少**。"没有回答"从来就不等于
"agent 没跑"。而唯一能把这两者分开的,是记录本身。

## 5. 修法

`AcpClient.hasSubmittedPrompt(sessionId, text)`,走已有的 `loadSession` 的
`onReplayUpdate` 接缝,按 `messageId` 累积 `message_chunk`(`role: 'user'`),
判断记录里是否已经含有这条文本。

控制器在"重启并重试"这条路径上——它本来就要 `reconnect()`,而重连本身就会重载
会话——先问一句:

- `yes` → 不再发送,明确告诉读者这一轮在 agent 停下之前就提交过了,
  跑两遍会把编辑和命令重复执行,请先看记录。
- `unknown` → 同样不发送,并说明**无法从记录里判断**。
- `no` → 这次重发是安全的,照旧。

## 6. 两个刻意的取舍

**按包含匹配,而不是相等。** 上线的是读者的文本加上展开的 context refs,
相等匹配会漏掉带引用的那一类。包含匹配可能误报(更早的一轮引用了同样的字眼),
**误报的方向是拒绝一次重试,不是跑两遍活**。宁可多点一次,不可重复执行。

**读不到记录时返回 `unknown`,而不是 `no`。** "没读到"不是"不存在"的证据。
把它读成 `no` 正好会重新制造这个双重执行。两条边界都钉住了这一点。

## 7. 边界(两条都确认能分辨新旧)

- 记录里已有该提示词(分两个 chunk 到达)→ `yes`;未问过的文本 → `no`;
  展开文本的一部分 → `yes`。不累积 chunk 时失败(得到 `no`)——长回合会被
  分成多帧,只看重帧就会漏。
- 记录读不了 → `unknown`;空白文本 → `unknown`。回退成 `no` 时失败。

## 8. 回归

全套:**86 个测试文件、2,517 项通过**(基线 2515/86);TypeScript 与 ESLint 通过。

## 9. 未覆盖

- 守卫只加在 **`AcpProcessExitError`** 这一条路径上,因为只有它先重连、
  也就只有它手上有重载后的记录。超时/拒绝路径连接还在,没有便宜的
  "是否已提交"信号,目前仍会给一个未经核对的重发 chip——**这是本轮留下的
  最大缺口**,下一轮应处理。
- `unknown` 时不重发,这是偏向安全的一侧,代价是读者多点一次才能重试。
- 聊天后端仍是 ACP。
