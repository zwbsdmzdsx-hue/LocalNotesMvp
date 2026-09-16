using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace LocalNotesMvp;

public sealed partial class NoteStore
{
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
            SELECT d.id, d.title, COALESCE(w.name, ''),
              COALESCE((SELECT group_concat(b.name, ' / ') FROM document_bookmarks db
              JOIN bookmarks b ON b.id=db.bookmark_id AND b.workspace_id=d.workspace_id
              WHERE db.document_id=d.id AND b.deleted_at IS NULL), ''), d.updated_at
            FROM documents d LEFT JOIN workspaces w ON w.id=d.workspace_id
            WHERE d.deleted_at IS NULL ORDER BY d.updated_at DESC
            """;
        var documents = new List<(string Id, string Title, string Path, string Updated)>();
        using (var reader = command.ExecuteReader())
            while (reader.Read()) documents.Add((reader.GetString(0), reader.GetString(1),
                reader.GetString(2) + " / " + reader.GetString(3), reader.GetString(4)));
        return documents.Select(d => (object)new { id = d.Id, title = d.Title, path = d.Path,
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
            default: throw new InvalidOperationException("未知操作：" + operation);
        }
        RefreshNotes();
        return GetEditorState(documentId);
    }

    private void CreateReferenceAtomic(string documentId, string hostBlockId, string targetDocumentId, string? targetBlockId)
    {
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
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
        transaction.Commit();
    }

    private void DetachReference(string documentId, string referenceId)
    {
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
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
        transaction.Commit();
    }
}
