# 模型切换报 "Method not found":根因、实测与修法

日期：2026-10-18。实现版本：Co-Ober 0.2.72。

## 1. 现象

工具栏换模型（或 `/model X`）弹：

> Setting failed; reverted to the agent-side value: The agent returned an
> error: "Method not found": setSessionModel

## 2. 为什么会报这个名字

`AcpMethodNames.ts` 里 `setModel` 的候选是 `['session/set_model', 'setSessionModel']`。
`acp.ts` 的 `requestWithFallback` 会在 `-32601` 上换下一个候选，最后一个失败就把
**最后一个**的错误抛出去。所以报出来的是 `setSessionModel`——也就是说**两个都试过，
两个都不存在**。

## 3. 实测（真实内核，OpenCode 2.0.32 `opencode acp`）

直接对 `opencode acp` 发 JSON-RPC，逐个探：

| 方法 | 结果 |
|---|---|
| `session/set_model` | `-32601 "Method not found"` |
| `setSessionModel` | `-32601 "Method not found"` |
| `session/set_mode` | `{}` ✅ |
| `session/set_config_option` | ✅（参数名报 `-32602: configId: expected string`） |

**ACP 里根本没有"设置模型"这个方法。** 键入模型的错误信息把字段名直接说了出来：
`configId`,不是我们发的 `optionId`。

## 4. 模型真正的位置：它是一个 config option

`session/new` 的返回里就有：

```json
{ "id": "model", "name": "Model", "category": "model", "type": "select",
  "currentValue": "fakeprov/m", "options": [ … ] }
```

旁边还有 `effort`、`mode`。随后 `config_option_update` 通知也推同样形状。
也就是说 agent 把模型和 effort、mode **一样当成配置项**暴露，根本没有单独的动词。

按正确的形状再测一次：

```
session/set_config_option {sessionId, configId:"model", value:"opencode/space-bunny-free"}
→ result.configOptions[model].currentValue = "opencode/space-bunny-free"   ✅
```

所以这不是"插件调错了参数"，是**插件调了一个不存在的接口**。模型切换在 OpenCode
ACP 上从来就没通过过。

## 5. 修法

- `AcpClient.setModel` 改为写 config option：`setConfigOption(id, 'model', modelId)`。
- 从候选表里**删掉** `setModel` 这个逻辑方法。留着等于继续宣称两个没人实现的方法名,
  这正是模型切换会带着原始协议错误码失败的原因。删除本身是实测结论,不是遗漏。

## 6. 顺带量出的第二处越界

`setConfigOption` 原来是无条件应用解析结果：

```ts
const configOptions = parseConfigOptions(raw);
this.applyConfigOptions(configOptions, id);   // raw 可能是 undefined
```

`parseConfigOptions(undefined)` 返回 `[]`——**"没说话"和"空列表"被读成了同一件事**。
于是一条只是**没带** `configOptions` 字段的回复，会把会话上的模型整个抹掉（实测为
`null`）。agent 从来没说过这句话。

这条在模型走这条路之后才真正要紧：agent 改成功了但没回显列表，模型选择器就会变空。
现在只在**线上真的带了数组**时才应用;返回给调用方的列表不变。

## 7. 关于 "accepted ≠ landed"

0.2.44 A 定了规矩：当前模型 id 只由 agent 自己的 config 数据写,不接受"请求发出去了"。
改动没有破坏它,反而把它收得更紧——现在落地的依据是 `set_config_option` 返回里
agent **自己回显的** `currentValue`,比我们发出去的值更强。

`CoOberViewController` 那段注释也随之更新:它过去担心的"`setModel` 解决了但 agent
可能没动",在改动前根本不可能发生,因为那个方法压根不存在。

## 8. 边界（两条都确认能分辨新旧）

- `setModel` 发的是 `('setConfigOption', {sessionId, configId:'model', value})`;
  回复不带列表时,快照里的旧模型 id 保持不变。把 `setModel` 改回旧实现 → 失败。
- agent 回显 `currentValue` 时,快照采用 **agent 说的**那个 id。去掉 `Array.isArray`
  判断 → 第一条失败,拿到 `null`。

## 9. 回归

全套:**86 个测试文件、2,515 项通过**(基线 2514/86);TypeScript 与 ESLint 通过。

## 10. 未覆盖

只对 OpenCode 2.0.32 的 ACP 表面实测过。其他 agent 若真有自己的 `session/set_model`,
这一版不再尝试它——但保留两个已证实不存在的方法名,比删掉更糟。若日后遇到实现该方法的
agent,应当作为**实测**再加回来,而不是凭猜测预留。
