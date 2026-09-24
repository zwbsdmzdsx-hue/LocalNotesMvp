# 开发交接

核对日期：2026-09-24。接手时先读 [AGENTS.md](AGENTS.md)、[PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md)、[TECHNICAL_GUIDE.md](TECHNICAL_GUIDE.md) 和 [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md)。本文件只记录操作入口、当前边界和交接检查，不复制协议定义。

## 当前交付边界

- 本轮工作重点是新版 `editor/` 与 Browser Mock。
- 新版开发页默认是 `http://localhost:4173/`；新版测试默认使用独占端口配置，不要复用正在打开的开发页。
- Avalonia 当前加载 `web/dist` 的兼容编辑器。不要用新版构建结果推断桌面已更新。
- Browser Mock 是页面内存数据，刷新会恢复 fixture；它不是 SQLite，也不是多页面共享存储。
- 当前工作区已有大量未提交功能改动。接手或继续修改时必须先看 `git status --short`，不要 reset、checkout 或清理未知改动。

## 快速验证

在仓库根目录：

```powershell
git status --short
git diff --check
```

新版编辑器：

```powershell
Push-Location web
npm run build:editor
npm run test:editor
Pop-Location
```

桌面兼容路径只有在本轮确实修改 `web/`、C#、Host 或 SQLite 时才运行：

```powershell
Push-Location web
npm run build
Pop-Location
dotnet build src\LocalNotesMvp\LocalNotesMvp.csproj --no-restore
dotnet run --project src\LocalNotesMvp\LocalNotesMvp.csproj --no-build -- --self-test
```

桌面测试应使用临时 `LOCAL_NOTES_MVP_DB`，不要对用户真实笔记库做破坏性验证。

本次交接前实际验证：`npm run build:editor` 通过；`npm run test:editor` 为 `185` 项，其中 `180 passed / 5 failed`。失败项是 4 个仍寻找已删除“嵌入为实时引用”菜单的旧测试，以及 1 个仍要求正文普通块建立父子级的旧测试；它们与当前 `[[` 默认关联、右栏明确升级显示方式、正文普通块不建立普通子级的收敛规则冲突。

## 接手检查

1. 确认改动属于新版 `editor/` 还是桌面兼容 `web/`，不要按页面外观推断两者共用代码。
2. 沿输入、宿主请求、ACK/NACK、状态更新和存储读取检查问题，不以按钮文案或 DOM 存在作为完成证据。
3. 新能力先核对 canonical 模型：稳定 ID、单一数据源、明确 scope、历史和版本语义。
4. 涉及引用时确认投影没有写入源正文；涉及日历、查询或预览时确认只读计算没有生成第二份数据。
5. 涉及 Canvas 时确认节点、曲线、手绘、媒体、引用、撤销/重做和前进/后退仍走同一状态边界。
6. 修改协议、入口或重要边界后同步更新全景、技术说明、路线图和本文件的相关段落。

## 已知限制

- `editor/` 的 Mock 刷新重置，不能验证真实 SQLite 落盘、跨页面同步或桌面重启恢复。
- `editor/src/core.ts` 仍然较大，拆分时必须保持保存队列、引用实例和模式切换语义不变。
- Canvas 的新版交互已在浏览器态实现；真实桌面宿主、SQLite Canvas 存储和统一新版桌面入口仍在路线阶段 D。
- 旧兼容路径仍保留旧消息路由和独立编辑器；不能只修改 `editor/` 后宣称两端一致。
- 失败恢复草稿、跨窗口实时源更新、多人协作和云同步不属于当前 MVP。

## 交付前说明

提交前只包含本次授权范围的源码、协议、文档和测试；排除数据库、缓存、构建产物和截图。最终说明应列出实际运行的命令、通过/失败数量以及尚未验证的边界，不把历史测试结果当成本轮证据。
