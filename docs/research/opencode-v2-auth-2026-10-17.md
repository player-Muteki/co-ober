# OpenCode 下一阶段：v2 内核的认证契约

日期：2026-10-17。实现版本：Co-Ober 0.2.63。

## 1. 先复核参考仓库

Claudian 本地 `main` 从 `6c0c9587` / 2.3.20 快进到 `31dd256b` / 2.3.22，
领先 34 个提交。本轮 OpenCode provider **有实质变化**（23 个文件），其中
一条与本项目直接相关：

`c5ed1a3b fix(opencode): distinguish discovery failures from empty catalogs (#1649)`

它的实质是：`OpencodeMetadataService.#runProbe` 的 `catch { return null; }`
把**所有**异常压成沉默，于是"发现失败"和"没有内容"不可区分。修复后失败会
带着真实错误说话，并且显式区分 abort（仍是沉默）与真正的失败：

```ts
} catch (error) {
  if (signal?.aborted || probeSignal?.aborted) return null
  return onError?.(error) ?? null
}
```

本项目的目录读取正处在它修复之前的状态。

## 2. 前提复核：本机安装已经是 v2

上一轮调研记录的实测基线是 **1.18.33（V1）**。本轮发现本机安装已不同：

- `/home/kys/.opencode/bin/opencode` 报告 **v2.0.32**（vault 中
  `.obsidian_linux` 的 `opencodePath` 正是这个路径）；
- 备份二进制 `/home/kys/opencode-backup-v1/opencode-v1.19.0` 仍可复现 V1 行为。

差距分析第 3 节写下的限定仍然成立——"不能因为本项目在某个版本上读到了
`/api/*`，就把这个安装视为与 Claudian 的 V2 协议兼容"——所以本轮仍然
先测量，再改代码。

## 3. 测得的结论：v2 的 `/api/*` 需要认证

以隔离的 `OPENCODE_DB` 与 `OPENCODE_CONFIG` 启动真实的 `opencode serve`
（不触碰用户配置），实测：

| 项目 | OpenCode 2.0.32 | OpenCode 1.19.0 |
| --- | --- | --- |
| 就绪输出 | `server listening on http://127.0.0.1:PORT` | `opencode server listening on http://127.0.0.1:PORT` |
| 未认证 `GET /api/agent` | **401** | 200（默认不设密码） |
| 认证后 `GET /api/agent` | 200 | 200 |
| `GET /api/model` 的 `{data:[…]}` 方言 | 保持不变 | 保持不变 |
| `POST /api/session`（V1 嵌套 body） | 200，`{data:{id,…}}` | 保持不变 |
| `POST /api/session/{id}/fork` | 404 JSON（V1 是 HTML catch-all） | HTML catch-all |

**因此 0.2.53–0.2.58 写下的探针契约本身没有过期：变的是认证。**

### 用本项目已发布的代码复现

把当时的 `OpencodeCatalog.ts` 单独 bundle 后，对同一个存活的服务器执行，
返回：

```json
{ "status": "unavailable",
  "routes": { "models": "unavailable", "commands": "unavailable", "agents": "unavailable" } }
```

而该服务器当时实际持有 **19 个模型、2 个命令、7 个 Agent**。面板因此会显示
"无法读取原生目录 — `opencode serve` 未应答"。**服务器应答了**，它回答的是
`401 {"_tag":"UnauthorizedError","message":"Authentication required"}`。

这就是本轮要修的那类谎：**一个可命名的拒绝，被写成了一句从未观察到的事实**，
并且把读者指向错误的排查方向（去查安装，而不是查凭据）。

## 4. 契约的来源：读 OpenCode 自己的源码

不靠黑盒猜测，逐条对照 v2.0.32 的源码：

- `packages/server/src/auth.ts`：`username` 为 `"opencode"`；`password` 仅在
  无人提供时为 `Option.none()`；`authorized()` 比较用户名与密码（或会话令牌）。
- `packages/cli/src/server-process.ts:86-92`：非 service 模式下密码是
  **必需的**（`if (!password) … "Missing server password"`）。
- `packages/cli/src/env.ts:10-11`：先读 `OPENCODE_PASSWORD`，回退
  `OPENCODE_SERVER_PASSWORD`。
- `packages/cli/src/server-process.ts:202-203`：就绪行在默认模式是纯文本，
  `--stdio` 才打印 JSON；**只有调用方没有提供密码时才会打印
  `server password <值>`**。
- 1.x 的 `packages/cli/src/commands/handlers/serve.ts` 只取
  `OPENCODE_SERVER_PASSWORD`，缺失时打印
  `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.`。

两条线都接受 `OPENCODE_SERVER_PASSWORD`（实测：两版本下认证后均 200、未认证
均 401），所以本项目**同时写入两个变量名**，并覆盖宿主继承来的值——否则一个
遗留的 `OPENCODE_PASSWORD` 会让服务端采用读者从未选择过的凭据。

## 5. 本轮选择并落地的边界

1. **stage A — 认证读取**：插件自选凭据、随子进程下发、每次请求出示。
   覆盖目录探针与 turn / stream / fork 三个探针（含 fork 的 raw 请求与
   stream 的 SSE 事件流）。凭据不打印、不持久化、不显示。
2. **stage B — 拒绝必须自己说话**：`OpencodeCatalogStatus` 增加
   `unauthorized`，`classifyCatalogRoute` 把 401/403 与"没有应答"分开；
   设置页与 Diagnostics 各自新增一句可区分的文案；并修复
   `OpencodeCatalogService.refresh` ——它此前把任何非 `observed` 的观测
   **整个丢弃**，只留下 `unavailable: true`，正是会把新状态再次吞掉的地方。

### 一处顺带测得、与本项目无关但值得记录的行为

`/api/command` 与 `/api/agent` 的内容由服务端**自身的工作目录**决定，
与 `location[directory]` 查询参数无关（实测：cwd 为临时目录时 2 命令 /
7 Agent；cwd 为 vault 时 0 / 0，两者的查询参数都一样）。本项目传入 vault
作为 cwd 是正确的（vault 就是项目根），因此"命令与 Agent 为空"是该
vault 的真实情况，不是映射丢失。

## 6. 回归与实测证据

修复后用同一份已发布代码、同一个存活服务器复测：

```text
status : observed
routes : {"models":"observed","commands":"observed","agents":"observed"}
models : 9（隔离配置） / 19（vault 配置），均带真实 context 窗口
```

从 `unavailable` 变为 `observed`，三个路由全部观察到。

全套：**83 个测试文件、2,444 项通过**；TypeScript 与 ESLint 通过。

## 7. 保留的差距

- turn / stream / fork 三个探针本轮只接入认证，**没有**新增"拒绝"状态：
  它们仍把任何失败折叠为 `unavailable`。认证修好后这条路径只在真实失败时
  可见，属于既有的小一类谎，单独一轮处理。
- 本轮**没有**运行任何模型回合：未提交 prompt、未创建会话、未调用模型。
  `OPENCODE_SIMULATE` 未启用。
- 目录发现仍是现有 loopback 方言；无 V2 stdio 启动、共享 HTTP lease、
  插件级 provider registry 或协议选择契约。
- 来源比较仍不包含可执行文件内容、符号链接或数据库文件身份指纹。

下一阶段可以重新评估差距分析第 7 阶段的可选原生 HTTP 纵向最小闭环，但必须
先测出该闭环在 2.0.32 上的真实契约，不能因为"现在是 v2"就照搬 Claudian。
