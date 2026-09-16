# Local Notes MVP

本地优先的笔记 + 便签 MVP：Avalonia/C# 宿主、Avalonia WebView 原生引擎、TypeScript 块编辑器。

## Run

```powershell
cd web
npm install
npm run build
Copy-Item src\index.html,src\style.css -Destination dist -Force
cd ..
dotnet run --project src\LocalNotesMvp\LocalNotesMvp.csproj
```

本地数据保存到 `%LOCALAPPDATA%\LocalNotesMvp\notes.db`，使用 SQLite WAL 模式。编辑器支持独立块树、段落、标题、待办、自动保存、新建笔记和独立便签窗口。

## Editor Core Development

编辑器核心可以脱离 Avalonia 在浏览器中运行。宿主协议和 DTO 位于 `protocol/`，浏览器 Mock Host 位于 `editor/src/browser-mock-host.ts`，SQLite 接口位于 `storage/`。

```powershell
cd web
npm install
npm run dev:editor       # http://localhost:4173
npm run build:editor
npm run test:editor
```

Avalonia 当前继续使用 `web/dist` 中的兼容资源；新编辑器通过 `EditorHostApi` 与 Native WebView 宿主通信，旧 `type` 消息仅保留在兼容路径中。

正文中的 `[[文档名]]` 会建立双向链接并出现在目标文档的反向链接面板。实时引用不会复制源文档；引用位置的文字和样式变化保存为局部覆写，隐藏、移动和引用内新增保存为实例结构操作。源文档会显示这些外部覆写及源内容更新冲突。

数据库还预留了 `views`、`placements` 和 `edges`，用于后续思维导图与自由 Canvas 视图。可用以下命令验证存储协议：

```powershell
dotnet src\LocalNotesMvp\bin\Debug\net8.0\LocalNotesMvp.dll --self-test
dotnet src\LocalNotesMvp\bin\Debug\net8.0\LocalNotesMvp.dll --diagnostics
```

## Note on NativeWebView

最新版 `NativeWebView` NuGet 当前要求 .NET 10，而本开发环境提供 .NET 9 SDK。因此这个可运行 MVP 使用同路线的 `WebView.Avalonia` 兼容实现，它在 Windows 上使用 WebView2 原生引擎。升级到 .NET 10 后，可将项目包替换为 `NativeWebView` 及对应平台包，业务模型和前端消息协议无需改变。
