# close 与回合自然结束的竞速：把 'closed' 证据钉在实测上（2026-10-20，0.2.88 之后的测量轮）

## 1. 本轮验收标准

0.2.81 实测了"回合在飞时 close 会打断并杀死它"；0.2.85 实测了"空闲会话的 close 只是释放"。
两份文档的"仍未闭合"里都留着同一个中间态：**close 恰好落在回合自然结束的前后毫秒里**，
kernel 会给出什么？插件端后果具体而重大：`endSideChat` 的证据合并
（controller:2142：`outcome !== 'stopped' && closed ? 'closed' : outcome`）把
"close 被接受"当作回合已被停止的确认，`cancelAllStreams`（:733）与 closeTab 的停止报告
也都消费这个断言（契约原文在 AcpErrors.ts:23-29）。若存在"close 被接受但回答还在继续写"
的交织，'closed' 就是说谎；若存在"close 落在已结束回合上却报错/吞状态"，空闲释放路径可能
误报。本轮标准：把这两个交织各拿到样本为止，或如实记录拿不到的原因。

## 2. rig v1（close-race.mjs）：先记下它测到了什么、没测到什么

设计：主会话+fork（自清理），回合进行中发 close，用 sqlite 观察 transcript 是否在
close 之后继续增长。三个教训与结论：

- **对照测点全部命中"思考期早段"**：5 次在飞 close（t1、t3-t6）里，`session/update` 只出现过
  `available_commands_update`，`agent_message_chunk` 计数为 0——定时器以"第一条通知"为零点，
  而第一条通知是加载事件不是回答。所有 close 都落在回合早段。
- 早段 close 的答案高度一致：`session/close` 全部 `{}` 接受；在飞 prompt **同轮**落
  `stopReason:"cancelled"`；close 后 3-4 秒复读 transcript，行数与内容零增长（`grew:false` ×5）。
  没有任何一次"接受了 close 还在继续写"。
- **新残迹事实**：被杀回合在 `session_message` 里留下一条 `type='assistant'`、
  `finish:"error"`、content 为空（chars=0）的行。走读两个读取端：`SessionReplayCollector.finish()`
  以 `!bucket.text.trim()` 跳过空桶（sessionReplay.ts:44），原生读取同型过滤
  （NativeSessionReader.ts:805）——恢复/历史渲染都不会把这行画成空气泡。插件端无需修。
- 空闲对照（t2：回合 end_turn 之后 close）：close `{}` 接受，行保留，load ok——与 0.2.85 一致。

v1 的竞速目标（自然结束前后毫秒）**没有达成**，如实记为未闭合；为此 v2 改为等
"第一条真文本 chunk"出现后、chunk 流静默一小段（120/300/700/150ms）且 prompt 仍未落定时
发 close，直接瞄准回合的收尾窗口。

## 3. rig v2（close-race2.mjs）读数

四轮，均为 fork 上的真流式回答；close 在"chunk 流静默 quietMs 且 prompt 未落定"时发出；
每轮 close 后 3 秒复读最后一行 assistant，看是否还在长：

| 轮 | quietMs | close 时 prompt 已落定? | close 回答 | prompt 落定 | 最后一行 | 3秒后 |
| --- | --- | --- | --- | --- | --- | --- |
| r1 | 120 | 否（1 chunk 刚起） | ok `{}` | `cancelled` | `finish:"error"`, 424字, 半句截断 | 一字未长 |
| r2 | 300 | 否 | ok `{}` | `cancelled` | `finish:"stop"`, 641字, **整句收尾** | 一字未长 |
| r3 | 700 | **是**（end_turn 已回） | ok `{}` | `end_turn` | `finish:"stop"`, 1037字 | 一字未长 |
| r4 | 150 | 否 | ok `{}` | `cancelled` | `finish:"stop"`, 545字, **整句收尾** | 一字未长 |

关键交织是 r2 与 r4：**回答内容已经完整写进库里（finish:"stop"、末token是句号收尾的整句），
而 prompt 请求还在飞**——close 落在这个"内容已结束、通知未结束"的窗口里，kernel 接受 close，
prompt 随即落 `cancelled`。即便如此，close 被接受后没有任何一个字再写出来（grewAfter:false ×4，
连同 v1 是全部样本 9/9 无一例外）。r1 还量出半句截断的形态：被中断的回答以
`finish:"error"` 的部分文本行留在库里——非空，恢复时如实渲染成"它确实说过的半句"，不撒谎。

## 4. 对插件断言的判断

结论：**维持现状，这是被实测许可的诚实**，无需收窄。逐条对表插件消费端：

- `endSideChat` 合并（controller:2142）把"close 被接受"当作回合已止的证据——全部 8 次在飞
  close（v1 ×5 + v2 r1/r2/r4）之后都观测到"没有任何东西还在跑/还在写"，断言在竞速窗口内
  同样为真。r3 型交织（回合先自然结束、close 后到）在插件里根本走不进证据合并：prompt 落定
  时 ask 包装器的 finally 已同步落下 `sideChatBusy`，`wasBusy=false`，正是 0.2.86 的静默释放。
- `cancelAllStreams`（:733）与 closeTab 的停止报告消费同一证据，判定同上。
- 唯一可挑剔的偏移是 r2/r4 里 prompt 落 `cancelled` 而内容早已完整——"cancelled"这个词是
  kernel 对**请求**的说法，不是对**回答**的说法；插件只把它用作"回合不再运行"的证据，从不
  引用它的内容含义，因此不构成虚假。面板在此刻正在关闭，收不收得到这个响应都无观众。
- v1 的残迹检查在 v2 依旧成立：空 `finish:"error"` 行被两个读取端（sessionReplay.ts:44、
  NativeSessionReader.ts:805）的 `!text.trim()` 过滤；r1 证明非空截断行会被如实保留与渲染。

本轮没有用户可见改动，故无 i18n、无版本号、无代码测试新增；产出是测量本身与下方两份文档
"仍未闭合"条目的就地闭合。

## 5. 仍未闭合

- v1/v2 都只能在模型延迟上采样，"close 与 end_turn 同一毫秒"的确定性注入点在该 kernel
  上不存在（无测试钩子），本轮拿到的是窗口样本而非逐毫秒证明。
- 0.2.86 面板级集成测量（旗标分叉走读）仍未做。
- 0.2.87 §7 的分支标签页可见性与孤儿清理入口不变。
