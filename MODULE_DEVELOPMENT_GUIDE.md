# 新版网页端模块开发指南

本指南只适用于 `editor/` 与浏览器 Mock。它不改变原生协议、SQLite 或桌面兼容编辑器。

## 文档模块

在 `editor/src/builtin-document-modules.ts` 注册唯一 `id`、创建文案、图标、创建函数和完整 `DocumentRuntime`。运行时负责 `open/update/close/flush/focusBlock/restoreHistory`；`document-router.ts` 负责切换分派，工作区菜单按注册顺序生成。数据仍沿用带稳定 ID 的文档与块、现有保存队列、历史和导航。新增类型的 `WorkspaceItemKind` 与 Mock 创建行为需要对应扩展，不能仅返回一个空页面。

文档定义的 `dashboardSource` 决定它能否进入 Dashboard 的工作区统计与来源选择；`countsAsDocument` 只对“文档数量”等文档类指标生效。Dashboard 本身不声明该能力，避免把组件文档再次当作数据源。浏览器 Mock 的五类创建共用 `createWorkspaceItem` 登记 ID、标题、目录位置及初始快照；类型方法只建立各自的 Canvas 几何、默认组件或数据表 Sheet。

文档还必须提供 `liveContext`，决定即时编辑状态是否成为 Dashboard 的来源，并生成右栏 `PanelContext`；读书笔记可在 `changed` 钩子同步未打开的读物状态。Dashboard 打开及来源刷新时，右栏上下文由 Dashboard 的 `liveContext.create` 生成：`state` 始终是 Dashboard 文档，`sourceState` 才是来源文档。可选 `canvasLink` 定义拖入 Canvas 的节点形态及初始尺寸；未声明时使用普通文档预览节点。Canvas 插入菜单的名称和图标读取文档注册项，导航仍走统一文档打开入口。

新版入口通过编辑器宿主事件回调将 `documentLoaded` 和 `focusBlock` 交给 `document-router.ts`；新增文档类型应复用该路径，不能让核心编辑器另开一条正文加载路径。

## 块模块

在 `editor/src/block-modules.ts` 注册唯一块类型。基础接口是 `create/label/typeLabel/icon/bodyText/sourcePrefix/preview/suggestion/locate/readSnapshot/editor`，并声明 `reference`、`search` 等能力；声明 `date`、`location` 或 `search` 时必须提供相应提取器。所有新块都通过 `createRegisteredBlock` 创建，`document-model.ts` 只生成无类型特化的普通对象骨架；默认值（例如待办的勾选状态和创建日期）放在对应块定义的 `configure` 中，禁止从 Mock、Canvas 或正文再开第二条工厂路径。`preview` 是只读引用预览，`suggestion` 是 `[[` 候选中的紧凑预览；后者应避免在一行候选里挂载完整地图或媒体播放器。`typeLabel/icon/bodyText/sourcePrefix` 为 Canvas、引用和其他特化视图提供统一的块呈现能力，避免各个管理器重新判断标题、待办等块类型。块需要在 Canvas 标题卡中自定义文本、允许引用局部覆写或提供新节点尺寸时，分别注册 `canvasTextValue`、`canvasReferenceEditable`、`canvasNodeDefaults`；标题卡根块、Dashboard 组件和读书笔记读物/标注通过注册定义上的角色字段声明。块特化的注释摘要使用 `commentSummary`，Canvas 节点预览、文档缩略预览、待办控件和标题拆分分别使用 `canvasPreview`、`canvasDocumentPreview`、`canvasDecorate`、`canvasTextBehavior`。`referenceRow` 和 `referenceRowClass` 提供块在引用卡中的专用投影及样式，引用卡本身只负责行结构和事件，不得重新判断块类型。`editor` 适配器负责块行的挂载、按需刷新及是否整行重建；现有文本、标题、待办、媒体、位置、数据表和引用适配器在 `block-editor.ts` 及各自的特化模块中，新类型可复用适配器或提供自己的实现，不向 `core.ts` 增加块类型分支。标题/待办的文本渲染变体和快照读取分别由 `heading-block-editor.ts`、`todo-block-editor.ts` 提供，`text-block-editor.ts` 只处理无类型的通用变体。`readSnapshot` 从当前编辑行读取内容和属性，静态块可复用 `block-snapshot.ts` 的读取器，文本和位置块分别由各自编辑模块读取。它不生成块 ID、归属或顺序，也不发保存命令；这些仍由正文的统一快照和保存队列负责。面板读取带 `documentId`、`blockId` 的标准条目。块数据须可序列化，预览须只读，引用目标继续使用稳定 ID。特化编辑控件应留在负责该界面的控制器中，不能为同一块再建一套保存状态。

块的通用布局规则集中在 `block-layout.ts`：`blockDepth`、列索引、旧列容器迁移、加载时父子关系规范化和标题/数据库属性规范化都从快照入口调用。新增布局兼容逻辑放在这里，不能在正文、Canvas 各自复制一份。块的注释摘要由 `commentSummary` 能力提供；Canvas 的非文本预览、待办控件和标题拆分分别通过 `canvasPreview`、`canvasDecorate`、`canvasTextBehavior` 注册。Canvas 管理器只消费这些能力，不再按媒体、位置、待办或标题类型复制分支；选择、拖拽、落点和保存仍属于公共交互层。

独立引用块声明 `referenceInstanceHost`；Mock 在 Canvas 保存时据此保留引用实例，在移除引用时只删除这种独立宿主块。普通段落中的行内链接不能因该角色被删除。跨文档拖入创建引用宿主时使用块注册工厂。

阅读书签、高亮和注释通过 `readingRole` 声明功能，并必须提供 `readingAnnotationLabel`。读书笔记的标注列表、页内标记、编辑字段和跨文档预览读取这些定义；`reading-annotation.ts` 不再维护另一份运行时类型名单。位置块的 `attachment` 角色仍让它出现在读书笔记的注释标签中。

## 右栏面板

面板定义还可以声明 `slotId`；`panel-host.ts` 使用该契约创建特殊内容槽，不能再为单个面板维护宿主侧 ID 映射。

在 `editor/src/builtin-panels.ts` 注册唯一面板 ID、名称、图标、顺序、可用条件与 `mount`。`initialTab` 声明首次打开的标签，`fallbackTab` 声明上下文面板不可用时的回退标签；两者各只能声明一次，回退面板必须在空上下文可用。`main.ts` 组装面板依赖并把注册表注入 `mountShell()`；Shell 只按注册表管理标签、显隐和内容槽，不逐个接线面板业务回调。`panel-host.ts` 生成标签和内容槽，向面板句柄调用 `update(PanelContext)`，卸载时调用 `dispose()`。可用条件由面板定义读取 `PanelContext.capabilities`，Shell 只发布当前选中对象的通用能力，不按面板 ID 判断业务规则。新面板应在自己的槽内渲染，只读取 `PanelContext`、公共块能力条目和工作区命令；Canvas、Dashboard 等特化设置可由其管理器发布选中对象及操作适配器，面板只生成控件。历史、外部覆写、反向链接、日历、注释、CSS、数据表属性、地图管理、Canvas 对象设置、Dashboard 组件设置和实时引用已由独立面板模块的注册句柄管理；日历的日记预览、创建和待办汇总在 `calendar-panel.ts`，正文气泡与右栏共用 `block-comments.ts` 的注释控件。实时引用的分组列表与分栏预览由 `reference-sidebar-panel.ts` 管理，引用卡片结构与行控件在 `reference-card.ts`，引用实例的编辑、覆写和断开操作在 `reference-editor-controller.ts`，通过 `core.ts` 的显式回调执行保存与模式切换。迁移已有渲染器时应一次只保留一个更新路径。

注册表可供无 UI 的清单检查；实际挂载面板时，缺少历史、反链、覆写等命令依赖会明确报错，不再以空函数假装成功。Dashboard 设置面板接收管理器筛过的来源文档，不自行判断文档种类。

Dashboard 的摘要型组件（引用、反链、覆写、注释、历史、日历、位置、样式、数据库）由 `dashboard-renderers.ts` 提供默认注册项和图标；`dashboard-widget-body.ts` 统一解析范围筛选、数据视图、可信外部组件和摘要 renderer；查询模块的 `dashboardMetricPresets` 集中定义指标预设，待办查询和日历摘要通过块的 `date` 提取器读取，不得重新判断 `todo` 类型；`dashboard-manager.ts` 只负责组件实例生命周期、布局拖动、数据范围、外部组件和保存。新增摘要组件应注册 renderer，不要在管理器增加同类 `if` 分支。
Dashboard 的文档范围筛选由 `dashboard-filter-widget.ts` 提供；它只管理选项、勾选状态和 `onChange` 回调，保存、重渲染和多个组件的数据交集仍由 `dashboard-manager.ts` 统一协调。

拖拽摘要和列属性变换属于无 DOM 的共享逻辑：`block-drag.ts` 通过块注册表生成拖拽文本并判断块子树，`block-layout.ts` 负责清除或设置列成员属性。它们不是拖拽控制器，也不拥有选择状态或事件监听。拖拽事件、位置计算、渲染和保存仍由 `core.ts` 协调；新的块类型不应在拖拽代码里增加名称分支。块选择、拖拽事件、键盘拆块、媒体拖放和联想菜单都保留在公共编辑器交互层，不按文档类型拆成控制器。

## 数据表编辑

`database-block-row.ts` 生成数据表块的工具栏和源码入口；`database-view-ui.ts` 生成视图工具栏及看板、画廊记录卡；`database-field-menu.ts` 生成字段设置弹层；`database-cell-editor.ts` 处理各类单元格输入、双链解析与预览；`database-table-editor.ts` 组装行列并处理列宽和行顺序交互。`database_table` 与 `data_view` 的表/查询身份由块注册的 `databaseRole` 提供，数据表面板、Sheet、声明和行渲染器消费该角色，不再各自比较类型字符串。`database-sheet-tabs.ts` 处理工作表标签、可见范围和未激活 Sheet 的快照保留，`database-declaration.ts` 生成与校验源码声明，`database-conversion.ts` 处理 GFM 转换，`database-data-view.ts` 呈现查询结果。它们通过回调使用 `core.ts` 的命令和保存流程；后续迁移须维持相同的输入光标和 ACK 行为。

`database-records.ts` 负责新记录的默认字段值和稳定顺序，`database-views.ts` 负责视图名称与初始配置以及记录筛选排序；`database-editor-controller.ts` 组装这些 UI 的回调、Sheet 操作和宿主命令。`core.ts` 只提供公共状态、保存和渲染回调，不能重新复制字段类型或视图类型分支。

## 特化编辑

`media-editor.ts` 管理媒体块预览、caption 和图片缩放；`reference-instance-editor.ts` 处理引用实例的数据变换，`reference-editor-controller.ts` 处理行内容、插入位置、局部覆写、断开引用时的块克隆及保存命令；`heading-block-editor.ts` 管理标题等级、折叠可见性和标题文本变体；`todo-block-editor.ts` 处理待办源码标记、待办文本变体及 Enter 拆分。新块有特殊的源码拆分规则时，通过其编辑器适配器的 `splitSource` 接入。它们不另建保存队列，实际文档状态、引用命令和保存 ACK 仍由 `core.ts` 协调。
`media-editor.ts` 同时提供 `renderMediaAsset`，正文预览、媒体块和 Canvas 预览都通过它按 `MediaAsset.kind` 创建媒体元素；视图只负责外壳、布局和 caption，新增媒体种类不能在各视图重复增加分支。

引用目标解析和只读投影位于 `reference-preview.ts`：它负责稳定目标解析、整行/单元格投影、子树裁剪、普通链接归属及只读块预览。`core.ts` 只负责悬浮层、右栏打开和导航回调；不要把新的投影分支重新写回核心文件。

`block-projection.ts` 提供标题/正文的只读投影和读书注释预览，使用 `link-rendering.ts` 注入的解析方法；新增只读预览应放在块/投影模块，不在 `core.ts` 增加类型判断。

`reference-row-content.ts` 提供引用行的通用渲染器（阅读标注、位置、数据表和普通文本）；具体块通过 `blockModules` 的 `referenceRow`/`referenceRowClass` 注册选择渲染器，`reference-card.ts` 只组装行结构、事件和引用实例生命周期。新增块的引用行特殊呈现应通过注册入口接入，不能再把类型分支写回卡片组件。

读书笔记的标注类型映射集中在 `reading-annotation.ts`：书签、高亮、注释的类型判断、右栏标签映射、页内标记规则和显示文案由该模块提供。`reading-manager.ts` 只负责书架、阅读窗口、标注生命周期、拖动调整、导航和统一保存，不再复制这些类型分支；位置块作为读书笔记的附着条目由同一过滤器读取，但不伪装成阅读标注类型。

## 双链与验证

`queryLinkSuggestions` 负责候选查找，`suggestionWikiTarget` 负责目标路径及显示别名；正文、Canvas 和 textarea 各自只处理光标与插入。整行使用 `#@记录ID`，单元格再加 `.字段key`，块使用 `#^块ID`。改动公共能力后运行 `npm run build:editor`、`web/tests/editor/module-contract.spec.mjs` 和受影响的 Playwright 测试；创建／切换、失败保存和重试、历史、跨类型引用及反向链接、右栏更新与导航须按实际操作覆盖。浏览器 Mock 刷新即重置，不证明 SQLite 落盘。

Markdown/HTML 与双链的 DOM 转换集中在 `link-rendering.ts`。它通过状态 getter 解析当前文档 ID，提供 `renderLinkedHtml`、`resolveWikiTargets`、`markdownHtml` 和两种内容快照读取；输入控件只负责光标和事件，不再复制解析正则或目标匹配规则。
