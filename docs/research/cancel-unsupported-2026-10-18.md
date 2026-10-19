# 中断不留后台工作:实测结果是否定的

日期:2026-10-18。实现版本:Co-Ober 0.2.74。

## 1. 参考仓库

Claudian `main` 仍为 `8a7de7c6`(2.3.24),`src/providers/opencode` 未改动。

## 2. 这是差距分析最后一条验收项

前三条里前两条已经测过,第三条(不重复执行)上一轮测了。这一轮是第四条:
**中断不留后台工作**。它是四条里唯一一条我此前一直没敢下的结论——因为它要求
杀掉一个正在跑的回合,装置最容易搭砸。

## 3. 现场:Stop 一直在说谎

`AcpClient.cancel()` 的原样是:

```ts
cancel(id: string): Promise<void> {
  // …丢掉本地 stream…
  for (const candidate of getAcpMethodCandidates('cancel')) {
    transport.notify(candidate, { sessionId: id });   // 通知,不是请求
  }
  return Promise.resolve();                            // 无条件成功
}
```

三件事同时发生:**丢掉本地 stream**(界面不再显示)、**把取消扔进虚空**、
**无条件报告成功**。界面上那一轮因此"停了",而内核那一轮没有任何人确认过。

注释里写着"通知的未知方法按 JSON-RPC 可忽略,所以两个名字都发,agent 会认其中一个"。
问题不在这个策略,在于**通知带不回任何回答**——这个形状在原理上就永远学不到
"agent 根本没有这个方法"。

## 4. 实测:agent 根本没有取消方法

对 `opencode acp`(2.0.32)逐个发,每个都在同一条连接上:

```
session/cancel              -> ERR -32601
cancel                      -> ERR -32601
session/abort               -> ERR -32601
abort                       -> ERR -32601
session/interrupt           -> ERR -32601
interrupt                   -> ERR -32601
session/stop                -> ERR -32601
stop                        -> ERR -32601
session/cancel_notification -> ERR -32601
session/set_mode            -> OK          ← 对照组
```

对照组是关键:同一条连接、同一时刻,`session/set_mode` 正常返回。所以这是
**agent 在回答"没有这个方法"**,不是管道死了、也不是我发错了格式。

**OpenCode 2.0.32 的 ACP agent 完全没有实现取消。**

再验证一次后果:提交提示词 → 取消 → 起新进程 `session/load`:

```
session/cancel -> {"code":-32601,...}
PROMPT STILL IN TRANSCRIPT after cancel? true
```

提示词留在会话里,那一轮还在跑。

## 5. 结论:第四条验收项实测为**不成立**

"中断不留后台工作"在这颗内核上**不成立**。按 Stop 之后内核照跑。

这不是本插件能修的——它缺的是 agent 的能力。插件能做、也该做的,是
**不要宣称一个自己没有观察到的东西**。

## 6. 修法

`cancel()` 改为发**请求**(带 2 秒上限,Stop 不会挂住),返回实测到的三态:

- `stopped` —— agent 确认了取消。
- `unsupported` —— 候选全部答"没有这个方法"。**那一轮还在内核里跑**,读者必须知道,
  因为"我停掉了"和"我不看了"是两回事。
- `unknown` —— 连接断了或没人回答。**不是停止的证据。**

Stop 按钮现在只在 `stopped` 时保持沉默;其余两种都说一句实话。
本地 stream 无论如何都会摘掉——这是"停止观看",和"停止内核"分开说。

## 7. 顺带解释了 0.2.73 的重发风险

上一轮我说超时/拒绝路径上的重发 chip 是本轮最大的缺口。**现在它有了解释**:

一个"超时"的回合并不是死掉的回合——它在内核里活着,而且**按下去也停不掉**。
所以那条路径上的重发不是"可能重复",而是**必然叠在一个活的回合上**。
守卫扩展到那条路径只是时间问题;真正的修复取决于 agent 是否有取消能力。

## 8. 边界(三向都确认能分辨新旧)

- agent 确认 → `stopped`,且请求带 `ACP_CANCEL_TIMEOUT_MS` 上限(Stop 不会挂)。
- `-32601` → `unsupported`,两个候选都试过。
- 任何其他失败 → `unknown`,**绝不是 `stopped`**。这一条是防止"狼来了"的关键。

回退成旧的"通知 + 无条件 resolve"后,前两条按预期失败。

## 9. 回归

全套:**86 个测试文件、2,519 项通过**(基线 2517/86);TypeScript 与 ESLint 通过。

三个旧测试原本把旧行为钉死了(`resolves.toBeUndefined()`、断言走通知),
它们编码的正是那句谎话,已按新契约重写;另一个多会话测试的假 transport 会挂住,
已让它对 cancel 给出回答。

## 10. 未覆盖

- 只测了 OpenCode 2.0.32。若别的 agent **有**取消方法,现在会如常工作并报
  `stopped`——这一版不再丢失这个能力(旧版是通知,压根不知道 agent 有没有)。
- tab 关闭、view 关闭、side chat 三处仍丢弃结果,没有出提示。只有 Stop 按钮
  报了实话——**这是本轮剩下的缺口**。
- 0.2.73 说的超时路径重发守卫仍未加。
- 聊天后端仍是 ACP。
