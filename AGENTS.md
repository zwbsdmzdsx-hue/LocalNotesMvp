# AI 开发指南

适用于本仓库。先读本文件，再按任务阅读 [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) 与实际代码。用户本轮指令优先；不要从文档中的未来路线自行扩大任务范围。

## 快速定位

- 新版网页功能：`editor/src/core.ts`、`editor/src/style.css`、`editor/src/browser-mock-host.ts`。
- 桌面兼容编辑器：`web/src/`。它与新版不是同一个入口。
- 主窗口/便签：`src/LocalNotesMvp/MainWindow.axaml.cs`、`StickyWindow.axaml.cs`。
- 协议：`protocol/types.ts`、`protocol/ProtocolModels.cs`、`protocol/protocol.md`。
- 新协议控制器：`host/EditorHostController.cs`。
- 真正的 SQLite 实现：`src/LocalNotesMvp/NoteStore.cs` 及 `NoteStore.Interactions.cs`。
- 保存快照归属与块树校验：`src/LocalNotesMvp/NoteStore.Validation.cs`；两端共享案例：`tests/contracts/save-cases.json`。
- 侧栏能力接口：`editor/src/workspace-api.ts`；浏览器适配：`browser-workspace.ts`；正文序列化：`block-content.ts`。
- 主窗口/便签共用关闭协调：`host/EditorFlushCoordinator.cs`。
- 仓储接口：`storage/INoteRepository.cs`；领域模型主要还在 `src/LocalNotesMvp/Models.cs`。
- 新版交互测试：`web/tests/editor/`；兼容交互测试：`web/tests/interactions.spec.mjs`。
- 存储自测：`src/LocalNotesMvp/StorageSelfTest.cs`。

## 开工前必须确认

1. 执行 `git status --short`，保留用户与已有未提交改动；阅读更深目录中存在的指导文件。
2. 明确要修改新版网页、桌面兼容路径，还是两者。不要凭页面相似假定共用代码。
3. 核对实际服务或 EXE、加载的资源与测试数据库。4173 是浏览器开发页，不是 SQLite 服务；默认桌面数据库是用户真实数据。
4. 修 bug 先沿输入 → 请求 → ACK/错误 → 状态 → 数据库读取定位。必要时先写能复现用户操作的测试。

## 架构边界

- 编辑器核心通过 `EditorHostApi` 调用宿主。原生桥访问收敛在 transport 中，不向 core 散落 `chrome.webview` 或 `window.external` 调用。
- C# 处理窗口、宿主能力、协议和存储，不新增对 `.block-text`、`.grip` 等 DOM/CSS 的业务依赖。现存兼容注入不是新增耦合的模板。
- 新命令同步检查 TS 类型、C# 路由、Mock、SQLite 行为和错误响应。不要只补一个返回成功的 Mock 分支。
- `requestId` 用于请求匹配，`mutationId` 用于保存幂等，`documentId` 用于归属；都不能用标题替代。
- 不未经需求替换 Avalonia、重写全部编辑器、引入新前端框架或改变数据库布局。
- `editor/dist` 是新版 Vite 产物；`web/dist` 是当前桌面兼容产物。不要只修改生成文件；`web/dist` 已被跟踪，兼容源码改动后应重新生成。

## 数据与保存约束

- SQLite 使用现有表。保留用户数据、稳定 ID、软删除语义、块树和实例归属。
- 普通编辑保留串行保存、队列合并、事务、ACK 与明确错误处理。不能靠延迟定时器或状态文案假装保存完成。
- 切换文档/工作区、导航和关闭的变更，需要检查等待队列行为；失败时保留可恢复内容，不能用静默丢弃来解除阻塞。
- SQLite 现有版本规则：相同 mutation 幂等；新请求版本必须大于当前版本，允许跳号，数据库提交版本仅递增一，返回实际 ACK。更改前补契约测试。
- 块 `revision` 与文档 `clientVersion` 职责不同，不能混用。空值、`undefined`、重复块 ID、跨文档请求都需要明确处理。
- 只读展示不能触发源内容写入。父段落序列化必须剥离引用投影，只存空 `data-reference-host-id` 锚点及本身内容。
- 引用编辑携带实例 ID；覆写、隐藏、移动、新增只影响当前实例。源更新保留局部覆写并提供通知；恢复继承读取最新源。
- 块引用只投影目标块及子树，不能误读整篇源文档。结构操作保存目标块、父块与顺序。

## 已约定的交互

- 引用位于插入位置和所属最小正文单元，前后文字不能消失，不统一追加到文末。
- 视觉克制：正文排版保持一致，最多浅色细线和小控件；不要恢复大色块、大卡片、重复标题条。
- 纯标题链接：悬停约 400ms 出现固定 320×220 小窗；内容适应窗口并可滚动；单击分栏、双击源文档。
- 正文引用有展开/折叠两态，由箭头切换并经 ACK 保存。折叠正文有箭头，纯标题模式无箭头，两者不能混淆。
- `inline/collapsed/link/sidebar` 是当前实例显示模式。切换呈现不复制源内容、不丢覆写、不无故创建新实例。
- 分栏正文只留入口，右栏不重复渲染同一个实例。普通链接的预览只读；已有引用实例的分栏可局部编辑。
- 新版右侧面板的标签选择和 section 显隐只由 `shell.ts` 管理；core 仅更新内容槽。引用 ACK、源刷新、空列表不能隐藏当前面板或抢切标签。检查实际可见性与标题，不能仅数隐藏 DOM 中的卡片。
- 保留 `[[` 联想、六点菜单、前进后退与稳定 ID 导航；不恢复已删除的正文上方旧链接工具整行。
- 保存、刷新引用和模式切换时关注光标、选择范围、输入法及快速连续输入；已修复的尾部文字被链接吞入问题不能回归。

## 当前缺口，不能当成已完成

- 浏览器 Mock 是内存数据，刷新重置；它不是 SQLite、不是多页面共享存储，也不验证真实落盘。
- Mock 的保存幂等、版本与快照校验有共享契约测试；未知能力和命令返回失败。引用命令仍需逐项核对，不能当成完整 SQLite 替身。
- `desktop.ts` 虽存在，当前 EXE 仍加载 `web/dist`。新 UI 在网页通过不意味着桌面也具有该 UI。
- `StickyWindowHostAdapter` 存在不意味着便签已全面接入新协议。便签关闭流程需独立验证。
- 失败恢复草稿、跨窗口源更新广播、完整全局搜索、任意字段锁定/合并和复杂嵌套引用尚未完整实现。
- `storage/DomainModels.cs` 不是完整领域层；`views/placements/edges` 是未来视图预留表。
- 无云同步后端、账号系统或多人协同；不要从版本号推断已经支持协作冲突解决。

## 可直接使用的命令

在仓库根首次准备：

```powershell
dotnet restore src/LocalNotesMvp/LocalNotesMvp.csproj
Push-Location web
npm ci
Pop-Location
```

在 `web/`：

```powershell
npm run dev:editor
npm run build:editor
npm run test:editor
npm run build
npx playwright test -c playwright.config.mjs interactions.spec.mjs --output=compat-test-results
```

开发服务器会持续运行，应与测试分开终端。兼容测试要先 `npm run build`。不要不加文件筛选就套用兼容 Playwright 配置跑新版测试；两者的服务器配置不同。

在仓库根：

```powershell
dotnet build src/LocalNotesMvp/LocalNotesMvp.csproj --no-restore
dotnet run --project src/LocalNotesMvp/LocalNotesMvp.csproj --no-build -- --self-test
dotnet run --project src/LocalNotesMvp/LocalNotesMvp.csproj --no-build -- --acceptance-test
dotnet run --project tests/Storage.Contracts/Storage.Contracts.csproj
git diff --check
```

`--acceptance-test` 自动使用临时库。结果读取 `%TEMP%\local-notes-acceptance-result.json`，核对本次修改时间与 `passed`。不要对测试结果文件里的陈旧成功信息作结论。

## 验证标准

按改动风险选择验证，不机械重复所有测试：

| 改动 | 必要证据 |
| --- | --- |
| 纯文档 | 核对文件/命令/入口存在、链接有效、描述符合代码；不必启动完整应用 |
| 新版 UI/引用交互 | TS/Vite 构建、受影响的 Playwright 操作；视觉改变打开截图检查布局 |
| 保存或 SQLite | 临时库自测、幂等/版本/归属/重开读取；相关前端 ACK/NACK 与切换操作 |
| 桌面兼容资源 | 兼容构建与交互测试、C# 构建、真实 EXE 验收 |
| 原生协议或入口迁移 | 新版浏览器、SQLite 和真实 WebView 全链路；主窗口与便签分别验证 |
| 重启恢复 | 关闭并以同一临时数据库启动第二个 EXE 进程，验证内容；仅 new NoteStore 不足以证明 |

浏览器测试优先通过元素、角色和文本操作。原生 WebView 可通过程序设置的调试端口 9222 检查页面，确认目标进程后再连接。不要以编译成功、DOM 存在或截图文件生成代替用户可用的证据。

用户曾反复遇到：正文黑屏、菜单无响应、旧资源未更新、保存卡住、版本冲突、切换/重启丢内容。修复这些问题时必须沿真实路径复测，不说“应该好了”便结束。

## 工作区、进程与交付

- 不在用户真实笔记库做破坏性测试。使用 `LOCAL_NOTES_MVP_DB` 指向唯一临时路径；环境变量只限定在需要的测试进程/终端。
- `--diagnostics` 内部会初始化仓储，不能视为完全无副作用的读操作。
- 4173 是开发服务；新版测试默认独占 4273（可用 `EDITOR_TEST_PORT` 指定），不复用已有服务。先辨认服务目录再决定重启，不按端口盲杀，不批量关闭 Node/浏览器/EXE。
- 保留用户未提交修改。不要重置 Git 历史；提交只包含当前授权范围，排除数据库、凭据、缓存、大型打包文件与测试截图。
- 收尾写清改了什么、作用于哪条入口、运行了哪些验证及实际结果。尚未验证/尚未接入的部分明确说明，不将旧结果当本轮结果。
- 架构、协议、构建入口或重要边界改变时同步更新 `PROJECT_OVERVIEW.md`、本文件或 `protocol/protocol.md`。维护一份事实，不复制多套相互矛盾的规则。
