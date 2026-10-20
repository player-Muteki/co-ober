# 内核把 Windows 路径归一成斜杠，插件却拿反斜杠形态去精确匹配（0.2.84）

- 日期：2026-10-20
- 内核：OpenCode `v2.0.28`（活体 rig + 本机真实数据库 `~/.local/share/opencode/opencode.db`）
- 范围：`NativeSessionReader` 四个目录过滤 SQL builder（v1/v2 列表与搜索）、新导出 `normalizeNativeDirectory`
- 结论：2.0.28 在写入 `session_v2.directory` 前把 cwd 的分隔符归一成正斜杠（`D:\vault` → `D:/vault`）；插件把 Obsidian 给的原始 cwd 直接嵌进 `directory = '…'`，在 Windows 主机上永远匹配 0 行。目录过滤现在统一在内核实际存放的形态上进行。

## 1. 本轮验收标准

0.2.83 §7.5 留题：内核存正斜杠；插件传的 cwd 形态能否匹配，本机没有正面证据。验收标准：

> 活体 rig 实测：把反斜杠形态的 vault 路径交给 `session/new`，看内核在 `session_v2.directory` 里写下什么形态；再把两种形态分别灌进插件的目录过滤 SQL，在本机真实数据库上数行数。若不匹配，做单点修复，判别测试必须能区分修复前后。

这也是 0.2.83 那句"修好了看不见现代会话"的兑现检验——换表之后，如果斜杠形态再挡住，用户依然什么都看不见。

## 2. 修改前的行为

四个 builder 都用同一个前提：`cwd` 字符串原样就是内核存的形态。过滤条件是

```sql
(directory = '<cwd>' or directory like '<cwd>/%' escape '\')
```

`=` 是精确匹配。Windows 上 `getVaultCwd()` 走 Obsidian `adapter.getBasePath()`，该形态含反斜杠时，精确匹配对着满库正斜杠的行就是零。LIKE 分支也救不了：`escapeLikePattern` 会把 `\` 双写后按 ESCAPE 当字面反斜杠匹配——还是零。

## 3. 实测

### 3.1 真实数据库目录形态普查（slash-dump.mjs）

```
session_v2.directory 去重：
  "D:/ObsidianVaults/kys-in-whu-cs"                       rows=16
  "C:/Users/Public/.../DigitalClock_2025302114095"        rows=1
  "C:/Users/LEGION"                                        rows=4
session.directory（化石表）去重：同样全是正斜杠。
```

对每个存库形态，分别用正斜杠与反斜杠两种 cwd 灌插件的过滤谓词：

```
cwd="D:/ObsidianVaults/kys-in-whu-cs"  matches=16
cwd="D:\\ObsidianVaults\\kys-in-whu-cs" matches=0
cwd="C:/Users/LEGION"                   matches=4
cwd="C:\\Users\\LEGION"                 matches=0
```

**库里没有一行反斜杠形态的 directory**；反斜杠 cwd 匹配 0 行。

### 3.2 活体 rig：归一发生在内核写入时（slash-live.mjs）

只靠"库里全是斜杠"还不能定罪——也许是用户恰好都从 CLI 用斜杠建的会话。于是直接问内核：用反斜杠形态 `D:\ObsidianVaults\kys-in-whu-cs` 作 cwd 发 `session/new`，成功拿到 id 后立刻查库：

```
new(backslash cwd)   -> ses_ea6e40305f…（成功）
db.row               -> directory: "D:/ObsidianVaults/kys-in-whu-cs"  ← 内核写入时归一
pluginSql.backslash.findsNewRow -> 0   ← 插件的旧谓词找不到自己刚建的会话
pluginSql.slash.findsNewRow     -> 1
acp.list.rowCwd      -> "D:\\ObsidianVaults\\kys-in-whu-cs"（ACP 列表回显原始形态）
```

三条事实同时成立：内核在落库前把分隔符换成 `/`（盘符大小写原样保留）；插件经 ACP 拿到的 cwd 回显仍是给它的形态——**归一只发生在 sqlite 写入侧**，所以按 ACP 回显去匹配 sqlite 也不可行；旧谓词对插件自己刚建的会话都是 0 命中。rig 会话用完即 `session/delete`，库里没留残行。

## 4. 结论与修复

`NativeSessionReader.ts` 新增导出：

```ts
export function normalizeNativeDirectory(cwd: string): string {
	return cwd.split('\\').join('/');
}
```

四个 builder（`buildNativeSessionsSql`、`buildNativeSessionsSqlV2`、`buildNativeSessionSearchSql`、`buildNativeSessionSearchSqlV2`）在计算 `exact`/`prefix` 前先归一。选择归一而不是"两种形态都匹配"的理由：§3.2 证明内核写入侧只有一种形态（斜杠），谓词与库同步即可，往 OR 里塞第二个形态是为一个不存在于库中的形态做防御。归一对斜杠形态的输入是恒等变换（§3.1 的全部行、既有测试的 `/vault`），所以非 Windows 主机与 CLI 场景逐字节不变。v1 builder 一并归一：§3.1 显示化石表存库同样是斜杠形态。

用户可见后果：0.2.83 把表换对之后，Windows vault 的原生历史此前仍是 0 行（`D:\…` 对 `D:/…`）；本轮之后同一查询返回 16 行（§5 末）。两个修复叠加，"看见自己的历史"才真正成立。

## 5. 边界测试与回归计数

新增 4 个（2,571 → 2,575）：

1. `normalizes a Windows cwd to the slash shape the kernel stores`：helper 三形态（反斜杠→斜杠、斜杠恒等、POSIX 恒等）。
2. `builds every directory predicate in the normalized shape`：四个 builder 灌 `D:\vault`，谓词必须出现 `= 'D:/vault'` 与 `like 'D:/vault/%'`，且不得出现 LIKE 双写形态的反斜杠字面量。
3. `lists the vault session when the caller hands a backslash cwd`：fake 库只对含 `= 'D:/vault'` 的 `from session_v2 s` 查询应答存库行——列表必须给出现行会话，并断言实际执行过斜杠谓词。
4. `finds the vault session by content search with a backslash cwd`：同一 fake 库对搜索成立。

回退检验：把四个 builder 的归一行撤掉，恰有测试 2、3、4 失败（21=18+3），其余不动；恢复后回到 18。测试 1 不依赖 builder，故意让它继续通过——helper 本身不是被撤销的对象。

全量：86 文件 / 2,575 测试；本 Windows 主机 2,556 通过、19 失败（与 0.2.75–0.2.83 完全同一批平台绑定失败）。`tsc --noEmit`、`npm run lint` 无输出。

真实数据库终验（real-db-slash-check.mjs）：同一 vault、同一条谓词，归一形态 16 行、原始反斜杠形态 0 行——修复上线后用户下拉里的原生历史从"没有会话"变成 16 条真实会话。

## 6. 仍未闭合

1. **尾分隔符**：如果哪个 Obsidian 版本让 `getBasePath()` 带回尾 `\` 或 `/`，精确匹配 again 零、前缀形态 `x//%` 也匹配不上。本机 rig 没有观测 getBasePath 的真实返回值（插件跑在 Obsidian 里，测试跑在 Node 里），这条只能等来自插件运行时的正面证据，不做预防性 trim。
2. **盘符大小写**：内核原样保留传入大小写（`D:` 进 `D:` 存）。若哪天 cwd 以 `d:` 小写形态进来，`=` 区分大小写会零命中（LIKE 分支对 ASCII 不区分，能兜住前缀形态但兜不住精确匹配里盘符之后的部分）。无证据，不修。
3. **UNC 路径**：`\\server\share` 归一成 `//server/share`，与内核行为是否一致未测。
4. **v1 builder 的外推**：化石表存库是斜杠（§3.1），但那几行也可能是迁移时归一过的产物；"老内核直接写入的形态"没有独立样本。归一对斜杠输入是恒等，所以最坏情况与修复前相同，没有新增风险。
5. **幽灵侧聊会话**：0.2.83 起可见，现在连斜杠也通了——Windows vault 的下拉原生历史会第一次列出侧聊 fork（title 为 null，显示 id）。处置决定（关闭时是否 delete）仍是产品问题，见 0.2.83 §7.1；本轮让它从"理论可见"变成"实际可见"。
