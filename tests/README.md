# 契约与桌面集成验证

这些测试与浏览器操作测试互补，所有数据库均在系统临时目录中创建。

## 不依赖桌面的存储契约

在仓库根执行：

```powershell
dotnet run --project tests/Storage.Contracts/Storage.Contracts.csproj
```

项目直接编译生产 `NoteStore`、模型和协议控制器，不依赖 Avalonia，也不触发前端构建。运行原有存储自测后，再验证跨文档/实例归属、失败回滚、幂等、版本、父块和空值。`contracts/save-cases.json` 同时由 `web/tests/editor/host-contract.spec.mjs` 消费，避免 Mock 与 SQLite 各自通过不同规则的测试。

关闭协调器测试覆盖并发排空、错误/过期 ACK、NACK、超时和重试。

## 真实便签与进程重启

需要 Windows、WebView2 和桌面环境。在仓库根执行：

```powershell
dotnet build tests/Desktop.Contracts/Desktop.Contracts.csproj
if ($LASTEXITCODE -ne 0) { throw 'Desktop contract build failed' }
$contractDb = Join-Path $env:TEMP ('local-notes-desktop-contract-' + [guid]::NewGuid().ToString('N') + '.db')
dotnet run --project tests/Desktop.Contracts/Desktop.Contracts.csproj --no-build -- write $contractDb
if ($LASTEXITCODE -ne 0) { throw 'Desktop write contract failed' }
dotnet run --project tests/Desktop.Contracts/Desktop.Contracts.csproj --no-build -- read $contractDb
if ($LASTEXITCODE -ne 0) { throw 'Desktop restart contract failed' }
```

两个命令分别启动独立 EXE 进程，使用相同临时数据库。测试引用生产应用，启动真实 `StickyWindow` 和 WebView；测试逻辑不加入发布应用。write 阶段拦截保存请求模拟在途和失败，检查窗口不能关闭、草稿仍可编辑，再恢复桥接重试并检查 ACK、关闭和 SQLite 内容。read 阶段在新进程中确认正文恢复。

输入由页面脚本派发 input 事件，这能验证生产保存及关闭链路，不能替代鼠标键盘和输入法验收。该测试不占用调试端口 9222，不访问默认笔记库。

## 浏览器验证

在 `web/` 运行 `npm run test:editor`。测试默认独占 4273，使用当前仓库 Vite 服务；可设置进程级 `EDITOR_TEST_PORT` 更改端口。不会复用 4173 开发页。新增 `workspace-contract.spec.mjs` 从真实菜单验证重命名、失败阻止切换、删除后导航及继续保存。

架构仍有边界：新侧栏的原生工作区适配未实现，新版 `editor` 尚未替代 EXE 的 `web/dist`；完整引用契约、持久化失败草稿和大编辑器核心的进一步拆分仍待后续工作。
