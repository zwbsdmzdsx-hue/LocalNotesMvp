using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace LocalNotesMvp;

public sealed partial class NoteStore
{
    private sealed class DatabaseReadResult
    {
        public List<object> Sources { get; } = [];
        public Dictionary<string, List<object>> Records { get; } = [];
        public List<object> Views { get; } = [];
    }

    private DatabaseReadResult ReadDatabases(SqliteConnection connection, string? notebookId, string documentId)
    {
        var result = new DatabaseReadResult();
        using var source = connection.CreateCommand();
        source.CommandText = "SELECT id,notebook_id,title FROM data_sources WHERE deleted_at IS NULL AND (notebook_id IS NULL OR notebook_id=$notebook) ORDER BY title";
        source.Parameters.AddWithValue("$notebook", (object?)notebookId ?? DBNull.Value);
        var sourceRows = new List<(string Id, string? NotebookId, string Title)>();
        using (var sources = source.ExecuteReader())
        {
            while (sources.Read()) sourceRows.Add((sources.GetString(0), sources.IsDBNull(1) ? null : sources.GetString(1), sources.GetString(2)));
        }
        foreach (var sourceRow in sourceRows)
        {
            var databaseId = sourceRow.Id;
            var fields = new List<object>();
            using var field = connection.CreateCommand();
            field.CommandText = "SELECT id,database_id,field_key,title,type,position,formula,relation_database_id,relation_scope,rollup,rollup_field_key FROM data_fields WHERE database_id=$id AND deleted_at IS NULL ORDER BY position";
            field.Parameters.AddWithValue("$id", databaseId);
            using var fieldReader = field.ExecuteReader();
            while (fieldReader.Read()) fields.Add(new { id = fieldReader.GetString(0), databaseId = fieldReader.GetString(1), key = fieldReader.GetString(2), title = fieldReader.GetString(3), type = fieldReader.GetString(4), position = fieldReader.GetString(5), formula = fieldReader.IsDBNull(6) ? null : fieldReader.GetString(6), relationDatabaseId = fieldReader.IsDBNull(7) ? null : fieldReader.GetString(7), relationScope = fieldReader.IsDBNull(8) ? null : fieldReader.GetString(8), rollup = fieldReader.IsDBNull(9) ? null : fieldReader.GetString(9), rollupFieldKey = fieldReader.IsDBNull(10) ? null : fieldReader.GetString(10) });
            var records = new List<object>();
            using var record = connection.CreateCommand();
            record.CommandText = "SELECT id,position,source_document_id,source_block_id FROM data_records WHERE database_id=$id AND deleted_at IS NULL ORDER BY position";
            record.Parameters.AddWithValue("$id", databaseId);
            var recordRows = new List<(string Id, string Position, string? SourceDocumentId, string? SourceBlockId)>();
            using (var recordReader = record.ExecuteReader())
            {
                while (recordReader.Read()) recordRows.Add((recordReader.GetString(0), recordReader.GetString(1), recordReader.IsDBNull(2) ? null : recordReader.GetString(2), recordReader.IsDBNull(3) ? null : recordReader.GetString(3)));
            }
            foreach (var recordRow in recordRows)
            {
                var values = new Dictionary<string, JsonElement>();
                using var value = connection.CreateCommand(); value.CommandText = "SELECT f.field_key,v.value_json FROM data_values v JOIN data_fields f ON f.id=v.field_id WHERE v.record_id=$id AND f.deleted_at IS NULL"; value.Parameters.AddWithValue("$id", recordRow.Id);
                using var valueReader = value.ExecuteReader(); while (valueReader.Read()) values[valueReader.GetString(0)] = JsonDocument.Parse(valueReader.GetString(1)).RootElement.Clone();
                records.Add(new { id = recordRow.Id, databaseId, position = recordRow.Position, sourceDocumentId = recordRow.SourceDocumentId, sourceBlockId = recordRow.SourceBlockId, values });
            }
            result.Sources.Add(new { id = databaseId, notebookId = sourceRow.NotebookId, title = sourceRow.Title, fields, recordCount = records.Count });
            result.Records[databaseId] = records;
        }
        using var view = connection.CreateCommand();
        view.CommandText = "SELECT id,name,settings_json FROM views WHERE document_id=$doc AND type='table' ORDER BY created_at";
        view.Parameters.AddWithValue("$doc", documentId);
        using var viewRows = view.ExecuteReader();
        while (viewRows.Read())
        {
            var settings = JsonDocument.Parse(viewRows.GetString(2)).RootElement.Clone();
            if (!settings.TryGetProperty("databaseId", out var databaseId)) continue;
            result.Views.Add(new { id = viewRows.GetString(0), databaseId = databaseId.GetString(), name = viewRows.GetString(1), type = "table", settings });
        }
        return result;
    }

    private void RebuildBlockLinks(SqliteConnection connection, SqliteTransaction transaction, string documentId, string blockId, JsonElement content)
    {
        using var clear = connection.CreateCommand();
        clear.Transaction = transaction;
        clear.CommandText = "DELETE FROM links WHERE source_document_id=$documentId AND source_block_id=$blockId";
        clear.Parameters.AddWithValue("$documentId", documentId);
        clear.Parameters.AddWithValue("$blockId", blockId);
        clear.ExecuteNonQuery();
        var tokens = new List<LinkToken>();
        if (content.TryGetProperty("links", out var links) && links.ValueKind == JsonValueKind.Array)
            tokens = links.Deserialize<List<LinkToken>>(_json) ?? [];
        else if (content.TryGetProperty("text", out var text))
        {
            var html = content.TryGetProperty("html", out var htmlElement) ? htmlElement.GetString() ?? "" : "";
            var stable = System.Text.RegularExpressions.Regex.Matches(html, "data-target-id=\\\"([^\\\"]+)\\\"(?: data-target-block-id=\\\"([^\\\"]+)\\\")?");
            foreach (System.Text.RegularExpressions.Match match in WikiLinkRegex.Matches(text.GetString() ?? ""))
            {
                var candidates = _notes.Where(n => string.Equals(n.Title, match.Groups[1].Value.Trim(), StringComparison.OrdinalIgnoreCase)).ToList();
                var stableMatch = stable.Cast<System.Text.RegularExpressions.Match>().FirstOrDefault(x => x.Index <= match.Index && x.Index + x.Length >= match.Index);
                tokens.Add(new LinkToken { TargetDocumentId = stableMatch?.Groups[1].Value ?? (candidates.Count == 1 ? candidates[0].Id : null), TargetBlockId = stableMatch?.Groups[2].Value,
                    TargetText = match.Value, Start = match.Index, End = match.Index + match.Length });
            }
        }
        foreach (var token in tokens)
        {
            using var insert = connection.CreateCommand();
            insert.Transaction = transaction;
            insert.CommandText = """
                INSERT INTO links(id,source_document_id,source_block_id,target_document_id,target_block_id,target_text,alias,start_offset,end_offset,created_at,updated_at)
                VALUES($id,$doc,$block,$target,$targetBlock,$text,$alias,$start,$end,$now,$now)
                """;
            insert.Parameters.AddWithValue("$id", Guid.NewGuid().ToString("N"));
            insert.Parameters.AddWithValue("$doc", documentId); insert.Parameters.AddWithValue("$block", blockId);
            insert.Parameters.AddWithValue("$target", (object?)token.TargetDocumentId ?? DBNull.Value);
            insert.Parameters.AddWithValue("$targetBlock", (object?)token.TargetBlockId ?? DBNull.Value);
            insert.Parameters.AddWithValue("$text", token.TargetText);
            insert.Parameters.AddWithValue("$alias", (object?)token.Alias ?? DBNull.Value);
            insert.Parameters.AddWithValue("$start", token.Start); insert.Parameters.AddWithValue("$end", token.End);
            insert.Parameters.AddWithValue("$now", UtcNow()); insert.ExecuteNonQuery();
        }
    }

    private sealed class LinkToken
    {
        public string? TargetDocumentId { get; set; }
        public string? TargetBlockId { get; set; }
        public string TargetText { get; set; } = "";
        public string? Alias { get; set; }
        public int Start { get; set; }
        public int End { get; set; }
    }

    private List<object> ReadLinkCatalog(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT d.id, d.title, d.workspace_id, COALESCE(w.name, ''),
              COALESCE((SELECT group_concat(b.name, ' / ') FROM document_bookmarks db
              JOIN bookmarks b ON b.id=db.bookmark_id AND b.workspace_id=d.workspace_id
              WHERE db.document_id=d.id AND b.deleted_at IS NULL), ''), d.updated_at
            FROM documents d LEFT JOIN workspaces w ON w.id=d.workspace_id
            WHERE d.deleted_at IS NULL ORDER BY d.updated_at DESC
            """;
        var documents = new List<(string Id, string Title, string NotebookId, string NotebookName, string Path, string Updated)>();
        using (var reader = command.ExecuteReader())
            while (reader.Read()) documents.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2),
                reader.GetString(3), reader.GetString(3) + " / " + reader.GetString(4), reader.GetString(5)));
        return documents.Select(d => (object)new { id = d.Id, title = d.Title, path = d.Path,
            notebookId = d.NotebookId, notebookName = d.NotebookName,
            updatedAt = d.Updated, blocks = ReadBlocks(connection, d.Id) }).ToList();
    }

    // Shared by main and sticky windows so every edit has the same ACK/error contract.
    public object ExecuteEditorCommand(string documentId, JsonElement message)
    {
        RefreshNotes();
        if (Find(documentId) is null) throw new InvalidOperationException("文档已不存在。");
        string Text(string key) => message.GetProperty(key).GetString() ?? "";
        string? Optional(string key) => message.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        T Read<T>() => message.Deserialize<T>(_json) ?? throw new InvalidOperationException("无效操作。");
        var operation = Text("operation");
        if (message.TryGetProperty("referenceInstanceId", out var instanceId))
        {
            using var connection = OpenConnection();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT host_document_id FROM reference_instances WHERE id=$id AND deleted_at IS NULL";
            command.Parameters.AddWithValue("$id", instanceId.GetString());
            if (command.ExecuteScalar() as string != documentId) throw new InvalidOperationException("引用不属于当前文档。");
        }
        switch (operation)
        {
            case "save-style": SaveStyle(documentId, Read<StyleSheetRecord>()); break;
            case "delete-style": DeleteStyle(documentId, Text("styleId"), Optional("scope")); break;
            case "history-undo": case "history-redo": case "history-restore":
                MoveHistory(documentId, operation, message); break;
            case "create-reference":
                CreateReferenceAtomic(documentId, Text("hostBlockId"), Text("targetDocumentId"), Optional("targetBlockId"));
                break;
            case "set-reference-mode": SetReferenceMode(Read<SetReferenceModeRequest>()); break;
            case "save-override": SaveOverride(Read<SaveOverrideRequest>()); break;
            case "save-instance-block": SaveInstanceBlock(Read<SaveInstanceBlockRequest>()); break;
            case "move-reference-block": MoveReferencedBlock(Read<MoveReferencedBlockRequest>()); break;
            case "hide-reference-block": HideReferencedBlock(Text("referenceInstanceId"), Text("targetBlockId")); break;
            case "delete-instance-block": DeleteInstanceBlock(Text("referenceInstanceId"), Text("blockId")); break;
            case "reset-override": ResetOverride(Text("referenceInstanceId"), Text("targetBlockId")); break;
            case "reset-reference": ResetReference(Text("referenceInstanceId")); break;
            case "remove-reference": DetachReference(documentId, Text("referenceInstanceId")); break;
            case "create-database": CreateDatabase(documentId, message); break;
            case "save-database-schema": SaveDatabaseSchema(documentId, message); break;
            case "upsert-database-record": UpsertDatabaseRecord(documentId, message); break;
            case "delete-database-record": DeleteDatabaseRecord(documentId, message); break;
            case "execute-dql": return ExecuteDqlCommand(documentId, message);
            case "export-database-markdown": return ExportDatabaseCommand(documentId, message, false);
            case "export-database-csv": return ExportDatabaseCommand(documentId, message, true);
            default: throw new InvalidOperationException("未知操作：" + operation);
        }
        RefreshNotes();
        return GetEditorState(documentId);
    }

    private void SaveStyle(string documentId, StyleSheetRecord style)
    {
        if (string.IsNullOrWhiteSpace(style.Title)) style.Title = "未命名样式";
        style.Scope = style.Scope.Trim().ToLowerInvariant() switch
        {
            "system" => "system",
            "notebook" => "workspace",
            _ => "document"
        };
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        var targetId = style.Scope == "system" ? "system" : documentId;
        if (style.Scope == "workspace")
        {
            using var workspace = connection.CreateCommand(); workspace.Transaction = transaction;
            workspace.CommandText = "SELECT workspace_id FROM documents WHERE id=$id AND deleted_at IS NULL";
            workspace.Parameters.AddWithValue("$id", documentId);
            targetId = workspace.ExecuteScalar() as string ?? throw new InvalidOperationException("文档没有所属笔记本。");
        }
        if (!string.IsNullOrWhiteSpace(style.Id))
        {
            using var ownership = connection.CreateCommand(); ownership.Transaction = transaction;
            ownership.CommandText = "SELECT scope_type, scope_id FROM styles WHERE id=$id AND deleted_at IS NULL";
            ownership.Parameters.AddWithValue("$id", style.Id);
            using (var existing = ownership.ExecuteReader())
                if (existing.Read() && (existing.GetString(0) != style.Scope || existing.GetString(1) != targetId))
                    throw new InvalidOperationException("样式不属于当前作用域。");
        }
        var now = UtcNow();
        using var command = connection.CreateCommand(); command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO styles(id,scope_type,scope_id,title,description,css,enabled,position,created_at,updated_at)
            VALUES($id,$scope,$scopeId,$title,$description,$css,$enabled,$position,$now,$now)
            ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,css=excluded.css,
              enabled=excluded.enabled,position=excluded.position,scope_type=excluded.scope_type,scope_id=excluded.scope_id,
              updated_at=excluded.updated_at,deleted_at=NULL
            """;
        command.Parameters.AddWithValue("$id", string.IsNullOrWhiteSpace(style.Id) ? Guid.NewGuid().ToString("N") : style.Id);
        command.Parameters.AddWithValue("$scope", style.Scope); command.Parameters.AddWithValue("$scopeId", targetId);
        command.Parameters.AddWithValue("$title", style.Title.Trim()); command.Parameters.AddWithValue("$description", style.Description ?? "");
        command.Parameters.AddWithValue("$css", style.Css ?? ""); command.Parameters.AddWithValue("$enabled", style.Enabled ? 1 : 0);
        command.Parameters.AddWithValue("$position", string.IsNullOrWhiteSpace(style.Position) ? "00001000" : style.Position); command.Parameters.AddWithValue("$now", now);
        command.ExecuteNonQuery(); transaction.Commit();
    }

    private void DeleteStyle(string documentId, string styleId, string? scope)
    {
        using var connection = OpenConnection(); using var command = connection.CreateCommand();
        var scopeType = scope?.Trim().ToLowerInvariant() switch
        {
            "system" => "system",
            "notebook" or "workspace" => "workspace",
            _ => "document"
        };
        command.CommandText = "UPDATE styles SET deleted_at=$now WHERE id=$id AND scope_type=$scope AND scope_id=CASE WHEN $scope='system' THEN 'system' WHEN $scope='workspace' THEN (SELECT workspace_id FROM documents WHERE id=$doc) ELSE $doc END";
        command.Parameters.AddWithValue("$id", styleId); command.Parameters.AddWithValue("$scope", scopeType); command.Parameters.AddWithValue("$doc", documentId); command.Parameters.AddWithValue("$now", UtcNow()); command.ExecuteNonQuery();
    }

    private string DatabaseNotebookId(SqliteConnection connection, string documentId)
    {
        using var command = connection.CreateCommand(); command.CommandText = "SELECT workspace_id FROM documents WHERE id=$id AND deleted_at IS NULL"; command.Parameters.AddWithValue("$id", documentId);
        return command.ExecuteScalar() as string ?? throw new InvalidOperationException("文档没有所属笔记本。");
    }

    private long BeginDatabaseMutation(SqliteConnection connection, SqliteTransaction transaction, string documentId, JsonElement message, out bool duplicate)
    {
        var mutationId = message.TryGetProperty("mutationId", out var mutation) ? mutation.GetString() : null;
        if (string.IsNullOrWhiteSpace(mutationId) || !message.TryGetProperty("clientVersion", out var requestedValue))
            throw new InvalidOperationException("数据库写入缺少 mutationId 或 clientVersion。");
        using var existing = connection.CreateCommand(); existing.Transaction = transaction;
        existing.CommandText = "SELECT client_version FROM save_transactions WHERE document_id=$doc AND mutation_id=$mutation";
        existing.Parameters.AddWithValue("$doc", documentId); existing.Parameters.AddWithValue("$mutation", mutationId);
        if (existing.ExecuteScalar() is long saved) { duplicate = true; return saved; }
        using var current = connection.CreateCommand(); current.Transaction = transaction;
        current.CommandText = "SELECT client_version FROM documents WHERE id=$doc AND deleted_at IS NULL"; current.Parameters.AddWithValue("$doc", documentId);
        var currentVersion = Convert.ToInt64(current.ExecuteScalar());
        if (requestedValue.GetInt64() <= currentVersion) throw new InvalidOperationException("数据库写入版本已过期，请重新载入。");
        duplicate = false; return currentVersion + 1;
    }

    private void FinishDatabaseMutation(SqliteConnection connection, SqliteTransaction transaction, string documentId, JsonElement message, long version)
    {
        var mutationId = message.GetProperty("mutationId").GetString()!;
        using var command = connection.CreateCommand(); command.Transaction = transaction;
        command.CommandText = "UPDATE documents SET client_version=$version,updated_at=$now WHERE id=$doc; INSERT INTO save_transactions(document_id,mutation_id,client_version,created_at) VALUES($doc,$mutation,$version,$now)";
        command.Parameters.AddWithValue("$version", version); command.Parameters.AddWithValue("$now", UtcNow()); command.Parameters.AddWithValue("$doc", documentId); command.Parameters.AddWithValue("$mutation", mutationId); command.ExecuteNonQuery();
    }

    private void CreateDatabase(string documentId, JsonElement message)
    {
        var id = message.TryGetProperty("databaseId", out var idValue) ? idValue.GetString() : null;
        if (string.IsNullOrWhiteSpace(id)) id = Guid.NewGuid().ToString("N");
        var title = message.TryGetProperty("database", out var database) && database.TryGetProperty("title", out var titleValue) ? titleValue.GetString() : "新数据库";
        var fields = message.TryGetProperty("fields", out var fieldValue) ? fieldValue.Deserialize<List<DatabaseFieldRecord>>(_json) ?? [] : [];
        using var connection = OpenConnection(); using var transaction = connection.BeginTransaction();
        var mutationVersion = BeginDatabaseMutation(connection, transaction, documentId, message, out var duplicate); if (duplicate) return;
        var historyBefore = CaptureHistory(connection, transaction, documentId, id);
        var notebookId = DatabaseNotebookId(connection, documentId);
        using (var source = connection.CreateCommand()) { source.Transaction = transaction; source.CommandText = "INSERT INTO data_sources(id,notebook_id,title,created_at,updated_at) VALUES($id,$notebook,$title,$now,$now) ON CONFLICT(id) DO UPDATE SET title=excluded.title,updated_at=excluded.updated_at,deleted_at=NULL"; source.Parameters.AddWithValue("$id", id); source.Parameters.AddWithValue("$notebook", notebookId); source.Parameters.AddWithValue("$title", title ?? "新数据库"); source.Parameters.AddWithValue("$now", UtcNow()); source.ExecuteNonQuery(); }
        SaveDatabaseFields(connection, transaction, id, fields);
        using (var view = connection.CreateCommand())
        {
            view.Transaction = transaction; view.CommandText = "INSERT INTO views(id,document_id,name,type,settings_json,created_at,updated_at) VALUES($id,$doc,$name,'table',$settings,$now,$now) ON CONFLICT(id) DO UPDATE SET name=excluded.name,settings_json=excluded.settings_json,updated_at=excluded.updated_at";
            view.Parameters.AddWithValue("$id", "view-" + id); view.Parameters.AddWithValue("$doc", documentId); view.Parameters.AddWithValue("$name", title ?? "表格视图");
            view.Parameters.AddWithValue("$settings", JsonSerializer.Serialize(new { databaseId = id, fieldKeys = fields.Select(field => field.Key).ToArray() }, _json)); view.Parameters.AddWithValue("$now", UtcNow()); view.ExecuteNonQuery();
        }
        RecordHistory(connection, transaction, documentId, historyBefore, "创建数据库");
        FinishDatabaseMutation(connection, transaction, documentId, message, mutationVersion);
        transaction.Commit();
    }

    private void SaveDatabaseSchema(string documentId, JsonElement message)
    {
        var id = message.GetProperty("databaseId").GetString() ?? throw new InvalidOperationException("缺少数据库 ID");
        using var connection = OpenConnection(); using var transaction = connection.BeginTransaction();
        var mutationVersion = BeginDatabaseMutation(connection, transaction, documentId, message, out var duplicate); if (duplicate) return;
        var historyBefore = CaptureHistory(connection, transaction, documentId, id);
        var notebookId = DatabaseNotebookId(connection, documentId);
        using (var check = connection.CreateCommand()) { check.Transaction = transaction; check.CommandText = "SELECT COUNT(*) FROM data_sources WHERE id=$id AND notebook_id=$notebook AND deleted_at IS NULL"; check.Parameters.AddWithValue("$id", id); check.Parameters.AddWithValue("$notebook", notebookId); if (Convert.ToInt32(check.ExecuteScalar()) != 1) throw new InvalidOperationException("数据库不属于当前笔记本。"); }
        if (message.TryGetProperty("database", out var database) && database.TryGetProperty("title", out var titleValue))
        {
            using var title = connection.CreateCommand(); title.Transaction = transaction; title.CommandText = "UPDATE data_sources SET title=$title,updated_at=$now WHERE id=$id";
            title.Parameters.AddWithValue("$title", titleValue.GetString() ?? "新数据库"); title.Parameters.AddWithValue("$now", UtcNow()); title.Parameters.AddWithValue("$id", id); title.ExecuteNonQuery();
        }
        var fields = message.TryGetProperty("fields", out var fieldValue) ? fieldValue.Deserialize<List<DatabaseFieldRecord>>(_json) ?? [] : [];
        SaveDatabaseFields(connection, transaction, id, fields);
        RecordHistory(connection, transaction, documentId, historyBefore, "编辑数据库字段"); FinishDatabaseMutation(connection, transaction, documentId, message, mutationVersion); transaction.Commit();
    }

    private static void SaveDatabaseFields(SqliteConnection connection, SqliteTransaction transaction, string databaseId, List<DatabaseFieldRecord> fields)
    {
        using var remove = connection.CreateCommand(); remove.Transaction = transaction; remove.CommandText = "UPDATE data_fields SET deleted_at=$now WHERE database_id=$id"; remove.Parameters.AddWithValue("$id", databaseId); remove.Parameters.AddWithValue("$now", DateTime.UtcNow.ToString("O")); remove.ExecuteNonQuery();
        foreach (var field in fields)
        {
            var fieldId = field.Id;
            if (string.IsNullOrWhiteSpace(fieldId))
            {
                using var existing = connection.CreateCommand(); existing.Transaction = transaction;
                existing.CommandText = "SELECT id FROM data_fields WHERE database_id=$database AND field_key=$key";
                existing.Parameters.AddWithValue("$database", databaseId); existing.Parameters.AddWithValue("$key", field.Key);
                fieldId = existing.ExecuteScalar() as string ?? Guid.NewGuid().ToString("N");
            }
            using var command = connection.CreateCommand(); command.Transaction = transaction; command.CommandText = "INSERT INTO data_fields(id,database_id,field_key,title,type,formula,relation_database_id,relation_scope,rollup,rollup_field_key,position,created_at,updated_at) VALUES($id,$database,$key,$title,$type,$formula,$relationDatabase,$relationScope,$rollup,$rollupField,$position,$now,$now) ON CONFLICT(id) DO UPDATE SET field_key=excluded.field_key,title=excluded.title,type=excluded.type,formula=excluded.formula,relation_database_id=excluded.relation_database_id,relation_scope=excluded.relation_scope,rollup=excluded.rollup,rollup_field_key=excluded.rollup_field_key,position=excluded.position,updated_at=excluded.updated_at,deleted_at=NULL";
            command.Parameters.AddWithValue("$id", fieldId); command.Parameters.AddWithValue("$database", databaseId); command.Parameters.AddWithValue("$key", field.Key); command.Parameters.AddWithValue("$title", field.Title); command.Parameters.AddWithValue("$type", field.Type); command.Parameters.AddWithValue("$formula", (object?)field.Formula ?? DBNull.Value); command.Parameters.AddWithValue("$relationDatabase", (object?)field.RelationDatabaseId ?? DBNull.Value); command.Parameters.AddWithValue("$relationScope", (object?)field.RelationScope ?? DBNull.Value); command.Parameters.AddWithValue("$rollup", (object?)field.Rollup ?? DBNull.Value); command.Parameters.AddWithValue("$rollupField", (object?)field.RollupFieldKey ?? DBNull.Value); command.Parameters.AddWithValue("$position", field.Position); command.Parameters.AddWithValue("$now", DateTime.UtcNow.ToString("O")); command.ExecuteNonQuery();
        }
    }

    private void UpsertDatabaseRecord(string documentId, JsonElement message)
    {
        var databaseId = message.GetProperty("databaseId").GetString() ?? throw new InvalidOperationException("缺少数据库 ID");
        var record = message.GetProperty("record").Deserialize<DatabaseRecordRequest>(_json) ?? throw new InvalidOperationException("记录无效");
        using var connection = OpenConnection(); using var transaction = connection.BeginTransaction();
        var mutationVersion = BeginDatabaseMutation(connection, transaction, documentId, message, out var duplicate); if (duplicate) return;
        var historyBefore = CaptureHistory(connection, transaction, documentId, databaseId);
        var notebookId = DatabaseNotebookId(connection, documentId);
        using (var check = connection.CreateCommand()) { check.Transaction = transaction; check.CommandText = "SELECT COUNT(*) FROM data_sources WHERE id=$id AND notebook_id=$notebook AND deleted_at IS NULL"; check.Parameters.AddWithValue("$id", databaseId); check.Parameters.AddWithValue("$notebook", notebookId); if (Convert.ToInt32(check.ExecuteScalar()) != 1) throw new InvalidOperationException("数据库不属于当前笔记本。"); }
        using (var row = connection.CreateCommand()) { row.Transaction = transaction; row.CommandText = "INSERT INTO data_records(id,database_id,position,source_document_id,source_block_id,created_at,updated_at) VALUES($id,$database,$position,$sourceDocument,$sourceBlock,$now,$now) ON CONFLICT(id) DO UPDATE SET position=excluded.position,source_document_id=excluded.source_document_id,source_block_id=excluded.source_block_id,updated_at=excluded.updated_at,deleted_at=NULL"; row.Parameters.AddWithValue("$id", record.Id); row.Parameters.AddWithValue("$database", databaseId); row.Parameters.AddWithValue("$position", record.Position); row.Parameters.AddWithValue("$sourceDocument", (object?)record.SourceDocumentId ?? DBNull.Value); row.Parameters.AddWithValue("$sourceBlock", (object?)record.SourceBlockId ?? DBNull.Value); row.Parameters.AddWithValue("$now", UtcNow()); row.ExecuteNonQuery(); }
        foreach (var value in record.Values)
        {
            using var save = connection.CreateCommand(); save.Transaction = transaction; save.CommandText = "INSERT INTO data_values(record_id,field_id,value_json,updated_at) SELECT $record,f.id,$value,$now FROM data_fields f WHERE f.database_id=$database AND f.field_key=$key AND f.deleted_at IS NULL ON CONFLICT(record_id,field_id) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at"; save.Parameters.AddWithValue("$record", record.Id); save.Parameters.AddWithValue("$database", databaseId); save.Parameters.AddWithValue("$key", value.Key); save.Parameters.AddWithValue("$value", value.Value.GetRawText()); save.Parameters.AddWithValue("$now", UtcNow()); save.ExecuteNonQuery();
        }
        RecordHistory(connection, transaction, documentId, historyBefore, "编辑数据库记录"); FinishDatabaseMutation(connection, transaction, documentId, message, mutationVersion); transaction.Commit();
    }

    private void DeleteDatabaseRecord(string documentId, JsonElement message)
    {
        var databaseId = message.GetProperty("databaseId").GetString() ?? ""; var recordId = message.GetProperty("record").GetProperty("id").GetString() ?? "";
        using var connection = OpenConnection(); using var transaction = connection.BeginTransaction(); var mutationVersion = BeginDatabaseMutation(connection, transaction, documentId, message, out var duplicate); if (duplicate) return; var historyBefore = CaptureHistory(connection, transaction, documentId, databaseId);
        using var command = connection.CreateCommand(); command.Transaction = transaction; command.CommandText = "UPDATE data_records SET deleted_at=$now WHERE id=$record AND database_id=$database AND database_id IN (SELECT id FROM data_sources WHERE notebook_id=(SELECT workspace_id FROM documents WHERE id=$document) AND deleted_at IS NULL)"; command.Parameters.AddWithValue("$now", UtcNow()); command.Parameters.AddWithValue("$record", recordId); command.Parameters.AddWithValue("$database", databaseId); command.Parameters.AddWithValue("$document", documentId); command.ExecuteNonQuery();
        RecordHistory(connection, transaction, documentId, historyBefore, "删除数据库记录"); FinishDatabaseMutation(connection, transaction, documentId, message, mutationVersion); transaction.Commit();
    }

    private static List<StyleSheetRecord> ReadStyles(SqliteConnection connection, string scope, string scopeId)
    {
        using var command = connection.CreateCommand(); command.CommandText = "SELECT id,title,description,css,enabled,position,scope_type FROM styles WHERE scope_type=$scope AND scope_id=$scopeId AND deleted_at IS NULL ORDER BY position, created_at";
        command.Parameters.AddWithValue("$scope", scope); command.Parameters.AddWithValue("$scopeId", scopeId);
        using var reader = command.ExecuteReader(); var result = new List<StyleSheetRecord>();
        while (reader.Read()) result.Add(new StyleSheetRecord { Id = reader.GetString(0), Title = reader.GetString(1), Description = reader.GetString(2), Css = reader.GetString(3), Enabled = reader.GetInt32(4) != 0, Position = reader.GetString(5), Scope = reader.GetString(6) switch { "system" => "system", "workspace" => "notebook", _ => "document" } });
        return result;
    }

    private void CreateReferenceAtomic(string documentId, string hostBlockId, string targetDocumentId, string? targetBlockId)
    {
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        var historyBefore = CaptureHistory(connection, transaction, documentId);
        using var check = connection.CreateCommand();
        check.Transaction = transaction;
        check.CommandText = "SELECT COUNT(*) FROM blocks WHERE id=$id AND document_id=$doc AND deleted_at IS NULL AND scope_type='canonical'";
        check.Parameters.AddWithValue("$id", hostBlockId);
        check.Parameters.AddWithValue("$doc", documentId);
        if (Convert.ToInt32(check.ExecuteScalar()) != 1) throw new InvalidOperationException("请先保存引用所在块。");
        using var target = connection.CreateCommand();
        target.Transaction = transaction;
        target.CommandText = "SELECT title FROM documents WHERE id=$id AND deleted_at IS NULL";
        target.Parameters.AddWithValue("$id", targetDocumentId);
        if (target.ExecuteScalar() is not string title) throw new InvalidOperationException("目标文档已不存在。");
        if (targetBlockId is not null)
        {
            check.Parameters["$id"].Value = targetBlockId;
            check.Parameters["$doc"].Value = targetDocumentId;
            if (Convert.ToInt32(check.ExecuteScalar()) != 1) throw new InvalidOperationException("目标块已不存在。");
        }
        if (hostBlockId == targetBlockId || (documentId == targetDocumentId && targetBlockId is null))
            throw new InvalidOperationException("不能在文档内嵌入整个文档自身。");
        using var insert = connection.CreateCommand();
        insert.Transaction = transaction;
        insert.CommandText = """
            INSERT INTO reference_instances(id,host_document_id,host_block_id,target_document_id,target_block_id,mode,created_at,updated_at)
            VALUES ($id,$doc,$host,$target,$block,'inline',$now,$now)
            ON CONFLICT(host_block_id) DO UPDATE SET target_document_id=excluded.target_document_id,
              target_block_id=excluded.target_block_id,deleted_at=NULL,updated_at=excluded.updated_at;
            UPDATE blocks SET type='reference', revision=revision+1, updated_at=$now WHERE id=$host;
            """;
        insert.Parameters.AddWithValue("$id", Guid.NewGuid().ToString("N"));
        insert.Parameters.AddWithValue("$doc", documentId);
        insert.Parameters.AddWithValue("$host", hostBlockId);
        insert.Parameters.AddWithValue("$target", targetDocumentId);
        insert.Parameters.AddWithValue("$block", (object?)targetBlockId ?? DBNull.Value);
        insert.Parameters.AddWithValue("$now", UtcNow());
        insert.ExecuteNonQuery();
        RecordHistory(connection, transaction, documentId, historyBefore, "新增引用");
        transaction.Commit();
    }

    private void DetachReference(string documentId, string referenceId)
    {
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        var historyBefore = CaptureHistory(connection, transaction, documentId);
        using var query = connection.CreateCommand();
        query.Transaction = transaction;
        query.CommandText = "SELECT ri.host_block_id, ri.target_document_id, ri.target_block_id, COALESCE(d.title, '已删除文档') FROM reference_instances ri LEFT JOIN documents d ON d.id=ri.target_document_id WHERE ri.id=$id";
        query.Parameters.AddWithValue("$id", referenceId);
        string host, target, title; string? block;
        using (var reader = query.ExecuteReader())
        {
            if (!reader.Read()) throw new InvalidOperationException("引用不存在。");
            host = reader.GetString(0); target = reader.GetString(1); block = reader.IsDBNull(2) ? null : reader.GetString(2); title = reader.GetString(3);
        }
        var text = "[[" + title + (block is null ? "" : "#^" + block) + "]]";
        var content = JsonSerializer.Serialize(new { text, html = "<span data-target-id=\"" + target + "\"" +
            (block is null ? "" : " data-target-block-id=\"" + block + "\"") + ">" + System.Net.WebUtility.HtmlEncode(text) + "</span>",
            links = new[] { new { targetDocumentId = target, targetBlockId = block, targetText = text, alias = (string?)null, start = 0, end = text.Length } } });
        using var update = connection.CreateCommand();
        update.Transaction = transaction;
        update.CommandText = "UPDATE blocks SET type='paragraph',content_json=$content,revision=revision+1 WHERE id=$host; UPDATE reference_instances SET deleted_at=$now WHERE id=$id";
        update.Parameters.AddWithValue("$content", content); update.Parameters.AddWithValue("$host", host);
        update.Parameters.AddWithValue("$id", referenceId); update.Parameters.AddWithValue("$now", UtcNow());
        update.ExecuteNonQuery();
        RebuildBlockLinks(connection, transaction, documentId, host, JsonSerializer.Deserialize<JsonElement>(content));
        RecordHistory(connection, transaction, documentId, historyBefore, "删除引用");
        transaction.Commit();
    }
}
