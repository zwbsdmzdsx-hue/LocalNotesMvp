# 技术说明

核对日期：2026-09-24。本文是实现边界说明，不是第二份产品路线图。当前行为以代码、测试和 [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) 为准；协议字段和命令的权威定义仍在 [protocol/protocol.md](protocol/protocol.md)。

## 运行时边界

项目有两条独立的编辑器路径：

| 路径 | 入口 | 数据 | 结论 |
| --- | --- | --- | --- |
| 新版网页编辑器 | `editor/index.html` → `editor/src/main.ts` | `BrowserMockHost` 页面内存 | 当前交互开发和新版 Playwright 验证入口，刷新会重置 |
| 桌面兼容编辑器 | Avalonia `EditorPage.Load()` → `web/dist` | C# `NoteStore` → SQLite | 现有桌面默认入口，不能因为新版页面通过就视为同步 |

`editor/src/desktop.ts`、`host/` 和 `storage/` 是新版接入真实宿主的边界，但当前桌面项目仍加载 `web/dist`。`npm run build:editor` 只生成 `editor/dist`；`npm run build` 生成桌面兼容资源 `web/dist`。

## 唯一事实来源

新增能力必须先确定稳定对象和所属范围，再接入 UI。当前规则如下：

- 文档、Canvas、块、书签和笔记本使用稳定 ID；标题只是显示值。
- 标题语义在 `Block.type="heading"` 和 `properties.headingLevel`，Markdown 的 `#` 只负责源码往返。
- 分栏复用普通块，使用 `columnGroup`、`column`、`columnWidths`；没有持久化的“第一列/第二列”容器。
- 智能表数据由 `data_sources`、`data_fields`、`data_records`、`data_values` 统一拥有；正文数据表块只保存 `databaseId`。
- 位置由 `GeoLocation` 目录拥有；正文位置块只保存 `locationId` 和可选标签覆盖。
- Todo 的创建、目标、实际完成日期属于同一块的 `BlockProperties`，日历从块读取，不另建日历数据源。
- Canvas 节点复用正文 `Block`、媒体和引用模型，只额外保存位置、尺寸、层级、视口、显示模式、Icon 和字号。Canvas 文档/Canvas 节点是打开关系，不改变左侧目录父子关系。

兼容字段只能在加载迁移时读取，保存时不能重新写出。例如旧列容器 `layout`、旧数据库 `databaseViewId` 以及旧 Canvas `text/content` 节点都属于兼容入口。

## 保存与历史

普通编辑的链路是：

```text
DOM 输入
  -> core.ts 保存队列
  -> EditorHostApi
  -> Host / BrowserMockHost
  -> SaveTransaction 或等价 Mock 事务
  -> ACK/NACK
  -> EditorState 与历史面板
```

保存请求必须携带 `documentId`、`mutationId` 和 `clientVersion`。相同 mutation 重放要幂等；新 mutation 的请求版本必须大于持久化版本，提交版本只递增一。切换文档、导航和关闭前都要等待保存和命令队列排空。

Ctrl+Z、Ctrl+Y、Ctrl+Shift+Z、工具栏按钮和历史恢复都走同一历史语义。Canvas 的节点、布局、视口、引用实例和标题进入 Canvas 快照；新版浏览器的快照仍在 Mock 内存中，桌面 SQLite 历史才是跨进程持久化路径。

## 编辑模式与引用

正文提供编辑、源码、预览三态：

- 编辑态只编辑当前块内容，渲染后的标题、Markdown、HTML/CSS 和媒体布局保持一致。
- 源码态按块显示可往返的 Markdown；引用锚点使用稳定块 ID，不能把渲染投影写回正文文本。
- 预览态只读渲染 GFM、HTML/CSS、表格、媒体、位置和引用。

默认关联统一使用 `[[笔记本/文档/块#^块ID]]`。六点菜单只复制稳定链接。用户明确选择正文直显、折叠卡片或右侧分栏时，才通过 `create-reference` 创建 `reference_instance`。引用实例的覆写、隐藏、移动、新增和显示模式保存到宿主，并进入当前文档历史；普通双链预览不写源文档。

Canvas 复用相同的联想筛选、标题区间、只读预览和引用实例命令。Canvas 中的实时引用不能另造一套投影或数据源；直接或间接的 Canvas 循环必须拒绝。

## 专项能力边界

### Todo 与日历

Todo 正文保留创建日期、目标日期和实际完成日期。日历只在目标日期显示状态点：未到期黄色、逾期未完成红色、完成绿色；创建日期不生成点。正文状态使用提前完成绿勾、逾期完成红勾、逾期未完成红色感叹号。选中日期后，日历下方同时预览日记和 Todo。

### Canvas

Canvas 是可平移、缩放的自由布局。节点可为文档、Canvas、正文块、媒体、手绘或曲线；文档节点可以调整窗口大小，Canvas 节点可显示预览或固定 Icon。曲线端点吸附到块边中点，支持多个连接、颜色、粗细、实线/虚线/点线和中点描述。节点宽度改变时正文和媒体自动换行/适配。当前这些数据由 Browser Mock 保存，未写入 SQLite `placements/edges`。

### 数据库、样式、位置和媒体

数据库字段、公式、规则、关系、汇总和 DQL 使用 `protocol/types.ts` 的 DTO，通过 `executeCommand` 访问。公式是受限表达式，禁止 `eval`；DQL 只开放 `TABLE/FROM/WHERE/SORT/GROUP BY/LIMIT`。CSS 分 system、notebook、document 三个 scope；数据库面板仅在激活数据表时显示。位置由地图管理创建/编辑/软删除，媒体先 `storeMedia` 再创建统一的 `media` 块。

## 修改检查清单

修改新版能力时按以下顺序检查：

1. 先更新 `protocol/types.ts` 和 [protocol/protocol.md](protocol/protocol.md) 中的 DTO、命令和持久化边界。
2. 在 `workspace-api.ts` 定义宿主能力；不要在 `core.ts`、`shell.ts` 或 Canvas 代码里直接调用原生桥。
3. 同步 `BrowserMockHost` 的成功、失败、版本、幂等和归属校验；未知命令必须明确失败。
4. 确认只保存稳定 ID，渲染投影、日历点和查询结果不产生第二份事实数据。
5. 运行 `npm run build:editor`、受影响的 `web/tests/editor/*.spec.mjs` 和 `git diff --check`。
6. 若触及桌面协议、SQLite 或 `web/`，额外运行对应 C#、存储契约和兼容编辑器验证；否则不要声称桌面已接入。

