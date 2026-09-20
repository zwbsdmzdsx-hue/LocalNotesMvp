using System.Text.Json;

namespace LocalNotesMvp;

public sealed class Note
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Title { get; set; } = "未命名笔记";
    public bool IsSticky { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public long ClientVersion { get; set; }
    public string? WorkspaceId { get; set; }
    public override string ToString() => Title;
}

public sealed class StyleSheetRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Title { get; set; } = "未命名样式";
    public string Description { get; set; } = "";
    public string Css { get; set; } = "";
    public bool Enabled { get; set; } = true;
    public string Position { get; set; } = "00001000";
    public string Scope { get; set; } = "document";
}

public sealed class Workspace
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "未命名工作区";
    public string? RootPath { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public override string ToString() => Name;
}

public sealed class Bookmark
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string WorkspaceId { get; set; } = "";
    public string Name { get; set; } = "未分类";
    public string Color { get; set; } = "#3B82F6";
    public string Position { get; set; } = "00001000";
    public string ShortName => string.IsNullOrWhiteSpace(Name) ? "?" : Name.Trim()[..1];
    public override string ToString() => Name;
}

public sealed class WorkspacePreview
{
    public Workspace Workspace { get; set; } = new();
    public int BookmarkCount { get; set; }
    public int DocumentCount { get; set; }
    public string Summary => $"{BookmarkCount} 个书签 · {DocumentCount} 篇文档";
    public override string ToString() => Workspace.Name;
}

public sealed class BlockRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string? ParentId { get; set; }
    public string Position { get; set; } = "00001000";
    public string Type { get; set; } = "paragraph";
    public JsonElement Content { get; set; }
    public JsonElement Properties { get; set; }
    public int Revision { get; set; } = 1;
}

public sealed class SaveDocumentRequest
{
    public string DocumentId { get; set; } = "";
    public string Title { get; set; } = "未命名笔记";
    public List<BlockRecord> Blocks { get; set; } = [];
}

public sealed class SaveTransactionRequest
{
    public string DocumentId { get; set; } = "";
    public string MutationId { get; set; } = "";
    public string? HistoryGroup { get; set; }
    public long ClientVersion { get; set; }
    public string Title { get; set; } = "未命名笔记";
    public List<BlockRecord> Blocks { get; set; } = [];
}

public sealed class StoreMediaRequest
{
    public string Name { get; set; } = "media";
    public string MimeType { get; set; } = "application/octet-stream";
    public long Size { get; set; }
    public string Data { get; set; } = "";
}

public sealed class MediaAssetRecord
{
    public string Id { get; set; } = "";
    public string Kind { get; set; } = "image";
    public string Name { get; set; } = "media";
    public string MimeType { get; set; } = "application/octet-stream";
    public long Size { get; set; }
    public string Url { get; set; } = "";
}

public sealed class DatabaseFieldRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string DatabaseId { get; set; } = "";
    public string Key { get; set; } = "field";
    public string Title { get; set; } = "字段";
    public string Type { get; set; } = "text";
    public string Position { get; set; } = "00001000";
    public string? Formula { get; set; }
    public string? RelationDatabaseId { get; set; }
    public string? RelationScope { get; set; }
    public string? Rollup { get; set; }
    public string? RollupFieldKey { get; set; }
}

public sealed class DatabaseSourceRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string? NotebookId { get; set; }
    public string Title { get; set; } = "新数据库";
    public List<DatabaseFieldRecord> Fields { get; set; } = [];
    public int RecordCount { get; set; }
}

public sealed class DatabaseRecordRequest
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string DatabaseId { get; set; } = "";
    public string Position { get; set; } = "00001000";
    public string? SourceDocumentId { get; set; }
    public string? SourceBlockId { get; set; }
    public Dictionary<string, JsonElement> Values { get; set; } = [];
}

public sealed class EditorCommandResult
{
    public object State { get; set; } = new { };
    public object? Result { get; set; }
    public string? Content { get; set; }
    public string? MimeType { get; set; }
    public string? FileName { get; set; }
}

public sealed class SaveOverrideRequest
{
    public string? HistoryGroup { get; set; }
    public string ReferenceInstanceId { get; set; } = "";
    public string TargetBlockId { get; set; } = "";
    public JsonElement Content { get; set; }
    public JsonElement Properties { get; set; }
}

public sealed class SetReferenceModeRequest
{
    public string ReferenceInstanceId { get; set; } = "";
    public string Mode { get; set; } = "inline";
}

public sealed class SaveInstanceBlockRequest
{
    public string? HistoryGroup { get; set; }
    public string ReferenceInstanceId { get; set; } = "";
    public BlockRecord Block { get; set; } = new();
}

public sealed class MoveReferencedBlockRequest
{
    public string ReferenceInstanceId { get; set; } = "";
    public string TargetBlockId { get; set; } = "";
    public string? ParentBlockId { get; set; }
    public string Position { get; set; } = "00001000";
}
