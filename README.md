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

本地数据保存到 `%LOCALAPPDATA%\LocalNotesMvp\notes.json`。编辑器支持段落、标题、待办、自动保存、新建笔记和独立便签窗口。

## Note on NativeWebView

最新版 `NativeWebView` NuGet 当前要求 .NET 10，而本开发环境提供 .NET 9 SDK。因此这个可运行 MVP 使用同路线的 `WebView.Avalonia` 兼容实现，它在 Windows 上使用 WebView2 原生引擎。升级到 .NET 10 后，可将项目包替换为 `NativeWebView` 及对应平台包，业务模型和前端消息协议无需改变。
