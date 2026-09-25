# Local Notes Host Protocol v1

The editor talks to a host through one JSON envelope. The editor does not
know whether the host is Avalonia, a browser fixture, or a future cloud host.

## Request

```json
{
  "protocolVersion": 1,
  "requestId": "unique-id",
  "kind": "saveDocument",
  "sourceDocumentId": "document-id",
  "payload": {}
}
```

Responses keep the same `requestId` and `kind`:

```json
{
  "protocolVersion": 1,
  "requestId": "unique-id",
  "kind": "saveDocument",
  "ok": true,
  "payload": {}
}
```

Failures use `ok: false` and an `{ code, message }` error object. Host-pushed
events omit `requestId`, for example `documentLoaded` and `notification`.

`documentChanged` carries `{ documentId }` after a source document changes.
Hosts supporting external change notifications can emit it without navigating
the editor. The editor reloads affected reference projections through
`loadDocument`, preserving ordinary text edits and instance overrides.
Same-document references are also refreshed after the save queue receives ACK.
The browser mock emits this event for its external-source-edit test helper;
the legacy desktop host does not yet broadcast external change notifications.

## Stable capabilities

`loadDocument`, `reloadDocument`, `saveDocument`, `openDocument`,
`navigateBack`, `navigateForward`, `executeCommand`, and `showNotification`.
Reference mutations are carried by `executeCommand` with operations such as
`save-override` or `set-reference-mode`. `create-reference` is also used when
an ordinary `[[...]]` link explicitly chooses a live display mode; default
insertion remains an ordinary link.

CSS 样式资源也通过 `executeCommand` 保存：`save-style` 携带 `id/title/description/css/enabled/position/scope`，其中 `scope` 为 `system`、`document` 或 `notebook`；`delete-style` 携带 `styleId`。`loadDocument` 和命令 ACK 的 `state` 会返回 `systemStyles`、`documentStyles` 与 `notebookStyles`。

数据表能力通过 `executeCommand` 保存：`create-database`、`save-database-schema`、`upsert-database-record`、`delete-database-record`、`execute-dql`、`export-database-markdown` 和 `export-database-csv`。数据库字段和记录属于笔记本作用域，`loadDocument` 的 state 可返回 `databases` 和 `databaseRecords`。普通 Markdown GFM 表格仍保存在块的 Markdown 内容中；智能表块使用 `type: "database_table"` 与 `properties.databaseId`，查询块使用 `type: "data_view"` 与 `properties.dataQuery`。公式使用受限属性名表达式，禁止动态脚本；DQL 只允许 `TABLE/FROM/WHERE/SORT/GROUP BY/LIMIT`，默认查询当前笔记本，跨笔记本必须显式指定。查询/导出 ACK 除 `state` 外可返回 `result` 或文本 `content/mimeType/fileName`。

数据库字段类型包含 `text`、`number`、`url`、`media`、`formula`、`rule`、`document_relation`、`record_relation` 和 `rollup`。`media` 值复用 `MediaAsset` JSON；上传仍先走 `storeMedia`，再由 `upsert-database-record` 保存。公式和规则字段在编辑模式显示运算结果，用户点击单元格时才编辑字段表达式；源码模式显示声明里的 `formula`，预览模式只显示结果。

Todo 块的 `todoCreatedAt`（记录创建日期）、`todoDueAt`（目标完成日期）和 `todoCompletedAt`（实际完成日期）属于块的 `BlockProperties`，随普通 `saveDocument`、历史、撤销和重做保存；它们不会写入待办的 Markdown 文本。新版浏览器日历直接从工作区待办块读取这些字段，只在目标日期显示状态点：未到期为黄色、逾期未完成为红色、已完成为绿色；创建日期不单独显示，日记点仍使用绿色圆点，不建立第二套日历数据源。正文同时保留三类日期，并显示提前完成的绿色勾、逾期完成的红色勾和逾期未完成的红色感叹号。

地理位置通过 `GeoLocation` 目录统一保存，支持 `global` 和 `notebook` 两种 scope。位置目录由 `list-locations` 读取，写入使用 `create-location`、`update-location` 和 `delete-location`，携带 `mutationId` 与 `expectedLocationVersion`；删除为软删除。正文位置块使用 `type: "location"`，只保存 `properties.locationId` 和可选的 `locationLabelOverride`，名称、地址与坐标不复制到块内。地图管理使用 Leaflet + OpenStreetMap；浏览器定位、IP 粗定位和 Nominatim 反向地理编码都由用户主动触发或由地图选点防抖触发，失败时保留手动坐标。

Canonical DTO 约束：标题块使用 `properties.headingLevel`（1 到 6），源码中的
`#` 只负责序列化和解析；工具栏创建的无 `#` 标题仍由该属性明确表示为 H1。
数据库正文块只绑定 `properties.databaseId`，视图通过 `databaseViews` 的
`databaseId` 关联；`databaseViewId` 是旧快照兼容字段，新编辑器不会写入。
分栏只使用下方约定的 `columnGroup/column/columnWidths`，旧 `layout` 容器字段
只在加载迁移时读取。

媒体上传使用 `storeMedia` 请求。payload 为 `{ name, mimeType, size, data }`，其中 `data` 是不带 data URL 前缀的 base64 内容；宿主返回 `{ media: { id, kind, name, mimeType, size, url } }`。宿主将内容复制到应用数据库旁的 `media` 目录并返回持久 `file:///` 地址。浏览器 Mock 返回内存 data URL。正文媒体块使用 `type: "media"`，并在 `content.media` 保存该资源对象，随 `saveDocument` 快照持久化。`kind` 支持 `image`、`video`、`audio`、`pdf` 和普通 `file`；`content.caption` 保存用户编辑的说明文字，`properties.textAlign` 保存媒体对齐方式，`properties.mediaWidth` 保存图片预览宽度百分比。文件选择、拖放和剪贴板图片都必须先调用 `storeMedia`，再创建同一种媒体块；PDF 使用统一预览组件的内嵌阅读器，普通文件提供下载链接。

Canvas 当前属于新版浏览器的 `WorkspaceApi` 能力，不是已落地的 C# Host 命令。Canvas 项目以 `kind: "canvas"` 区分，自由正文和媒体节点都携带与正文相同的 `Block`；媒体资源及说明以 `block.content.media/caption` 为准，旧节点的 `media/caption` 只在读取时迁移。节点另存稳定 ID、坐标、尺寸、层级、视口、显示模式、Icon、字号、手绘笔画和 Bezier 曲线参数。曲线端点只能吸附到普通块四边中点，支持多个连接、颜色、粗细、实线/虚线/点线及中点描述；节点移动、调整尺寸、引用、手绘、曲线和视口进入浏览器 Canvas 历史。Canvas 文档/Canvas 节点是打开关系，不改变目录 `parentId`，并拒绝直接或间接循环。当前数据由 `BrowserMockHost` 内存保存，尚未写入 SQLite `views/placements/edges`，也没有新增桌面 `executeCommand`；后续接入必须先补齐正式 DTO、事务、版本和重启恢复契约。

Dashboard 当前属于新版浏览器的 `WorkspaceApi` 能力，项目以 `kind: "dashboard"` 区分。组件使用 `Block.type: "dashboard_widget"`，其 `properties.dashboardWidget` 保存 `kind`、数据 `scope`、可选 `sourceId/query`、`description`、`style` 和 `layout`；组件渲染结果不进入快照。Dashboard 通过现有 `saveDocument` 保存标题和组件块，因此继续使用 `mutationId`、`clientVersion`、块 ID 归属和父树校验。浏览器端的 `DashboardWidgetRenderer` 注册表为后续组件扩展预留；当前内置查询指标和右栏各能力的摘要组件。该能力尚未新增 C# Host 命令或 SQLite 专用表，Mock 数据仍为页面内存。

`saveDocument` is a serialized transaction. Its payload includes the document
ID, mutation ID, client version, title, and block snapshot. The response always
returns the document ID, mutation ID, and persisted client version.

The envelope `sourceDocumentId` must match the payload document ID. Replaying a
mutation returns its original persisted version without writing again. A new
mutation must have a client version greater than the stored version; skipped
client versions are allowed and the committed version advances by exactly one.

A block snapshot contains unique, nonempty canonical block IDs owned by that
document (ownership also applies to soft-deleted IDs). Every parent must appear
in the snapshot, and parent cycles are rejected. Content must be a JSON object;
missing properties default to `{}`, but explicit null content/properties and a
null block list are rejected. Rejection rolls back the entire transaction.
The browser Mock and SQLite run the same cases in `tests/contracts/save-cases.json`.

Block content may include an optional `markdown` string alongside `text`, `html`,
and `links`. `markdown` is the lossless source; `html` is its sanitized rendered
form, while `text` and `links` remain the search and relation indexes. Older
content without `markdown` is valid and is converted from its existing safe HTML
when the new editor first enters source mode. This is a JSON payload extension
and requires no SQLite schema migration.

`EditorState.documents[]` 是跨笔记本双链目录。每项返回稳定文档 `id`、
`title`、`notebookId`、`notebookName`、可读 `path` 与只读 `blocks` 快照。
编辑器用它实现 `[[笔记本/文档/块内容` 三级联想；选择结果仍以稳定文档/块
ID 写入链接和引用。目录块只用于筛选与预览，不作为当前文档保存快照，也不
允许借联想直接写回目标文档。块候选从渲染后的纯文本建立，Markdown 标记和
CSS 规则不进入候选标题或匹配文本。

新版编辑器默认创建关联只走 `[[笔记本/文档/块#^块ID]]` 双链。块六点菜单的
“复制块链接”输出同一格式，便于粘贴到其他正文或联想输入；用户在右栏普通双链
条目中明确选择“正文直显/折叠卡片/右侧分栏”时，才通过 `create-reference`
升级为同一宿主块下的 `reference_instance` 并保存显示模式。已有实时引用仍由
`reference_instances` 读取，并保留显示模式、覆写和历史操作。

正文 multi-column layouts reuse the block tree and require no new protocol
operation. Each ordinary root block in a column group stores the same opaque
`properties.columnGroup` identifier and a zero-based `properties.column` index;
all such blocks keep `parentId: null`. The group members' optional
`properties.columnWidths` array stores the relative width for each column. A
column can contain multiple ordinary blocks, ordered by their normal
`position`; there is no persisted layout/container block and no synthetic
column child. The editor can move blocks between columns, insert a new column
by dropping at a column edge, drag blocks out to the ordinary document flow,
adjust divider widths, and restore the group to ordinary sibling blocks.
Markdown/HTML remains content inside each block and is not used as the
structural source of the column tree. Older snapshots containing a
`properties.layout: "columns"` container are migrated when loaded and are not
written back in that form.

块注释不新增独立写协议，而是保存在所属 canonical 块的
`properties.comments[]` 中。每条注释包含稳定 `id`、正文、创建/更新时间、
可选 `deletedAt` 和 `history[]`；历史动作固定为 `created/edited/deleted`。
删除使用软删除，正文气泡只统计未删除注释，右栏可以查看完整时间线。注释
随 `saveDocument` 块快照经过相同的 mutation、版本、事务和 ACK 流程，因此
新增、编辑和删除均进入现有文档撤销、重做与 SQLite 历史，不允许只在前端
另存一份状态。引用投影中的源块注释只读，不能借预览写回源文档。

## Reference presentation and placement

`set-reference-mode` persists `inline` (expanded body), `collapsed` (folded
body with a disclosure arrow), `link` (title only), or `sidebar`. The disclosure
arrow sends the same acknowledged command as the mode menu; it is not temporary
DOM state. These values reuse `reference_instances.mode`, without a schema change.

Embedded references use an empty `<span data-reference-host-id="host-block-id">`
anchor in the containing block's HTML. The reference host block has that block
as its `parent_id`. Rendering mounts the reference at the exact anchor; saving
strips its projected contents from the containing block. Only stable IDs and
local overrides are stored, never the rendered source snapshot.
In Markdown source mode the same anchor is represented as `![[#^host-block-id]]`;
the two representations must round-trip without changing the host block ID.

Title links preview after 400 ms of hover. Single click opens a non-navigating
side pane; double click navigates to the stable document/block ID. Plain-link
previews are read-only; reference instances edit via their existing override API.

## Compatibility

The legacy `type` messages remain supported by the existing Avalonia resource
until the editor bundle is fully migrated. New editor code only uses this
protocol and the `EditorHostApi` transport.

## 编辑历史

`EditorState.history` 与 `saveDocument` / 兼容 `save-ack` 的 `history` 为当前文档的历史视图：`documentId, currentId, canUndo, canRedo, entries[]`。条目包含 `id, timestamp`（Unix 毫秒）、`label, kind, title, preview`（只读文本，最多 12,000 字符）。不把可供任意客户端修改的完整恢复快照交给前端。

`saveDocument`、`save-override`、`save-instance-block` 可携带 `historyGroup`。同组连续输入在 900ms 内合并，重复 mutation 不产生历史，失败事务不产生历史。结构操作与不同编辑目标使用新分组。

通过 `executeCommand`（旧桥 `editor-command`，带 requestId）发送：

- `{ operation: "history-undo", expectedVersion }`
- `{ operation: "history-redo", expectedVersion }`
- `{ operation: "history-restore", entryId, expectedVersion }`

文档归属由 sourceDocumentId 指定；entryId 必须在该文档历史内；expectedVersion 必须等于当前版本。成功返回完整 state（含 history），恢复作为新数据库提交递增 clientVersion，不能回滚保存版本或重用旧 mutation。未知/越界/跨文档/过期请求返回错误。任意 `restore-snapshot` 命令不受支持。

SQLite 中历史、撤销栈与恢复内容原子提交。保存最近 80 个版本；分叉版本仍可列表恢复，列表恢复新增一个可撤销版本。快照只包含当前文档自有块、引用实例、覆写、实例树操作及链接索引，不保存引用源投影。恢复不改源文档，继承内容读取实时源数据。Mock 使用相同命令，但数据和历史均为页面内存，不证明落盘。
