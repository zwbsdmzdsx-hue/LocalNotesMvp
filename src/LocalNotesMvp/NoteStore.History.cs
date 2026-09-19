using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace LocalNotesMvp;

public sealed partial class NoteStore
{
    // Only owned rows are stored. Referenced source content is never a history payload.
    private static readonly Dictionary<string, string> HistoryScopes = new()
    {
        ["blocks"] = "document_id=$doc AND deleted_at IS NULL",
        ["reference_instances"] = "host_document_id=$doc AND deleted_at IS NULL",
        ["block_overrides"] = "reference_instance_id IN (SELECT id FROM reference_instances WHERE host_document_id=$doc AND deleted_at IS NULL) AND status='active'",
        ["instance_tree_operations"] = "reference_instance_id IN (SELECT id FROM reference_instances WHERE host_document_id=$doc AND deleted_at IS NULL) AND status='active'",
        ["links"] = "source_document_id=$doc"
    };
    private sealed class HistorySnapshot
    {
        public string Title { get; set; } = "";
        public Dictionary<string, List<Dictionary<string, JsonElement>>> Tables { get; set; } = new();
    }
    private sealed class HistoryVersion
    {
        public string Id { get; set; } = Guid.NewGuid().ToString("N");
        public long Timestamp { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        public string Label { get; set; } = "开始编辑";
        public string Kind { get; set; } = "initial";
        public string? Group { get; set; }
        public HistorySnapshot Snapshot { get; set; } = new();
    }
    private sealed class HistoryLog
    {
        public List<HistoryVersion> Entries { get; set; } = [];
        public List<string> Stack { get; set; } = [];
        public int Cursor { get; set; } = -1;
    }

    private HistorySnapshot CaptureHistory(SqliteConnection connection, SqliteTransaction transaction, string documentId)
    {
        using var title = connection.CreateCommand(); title.Transaction = transaction;
        title.CommandText = "SELECT title FROM documents WHERE id=$doc AND deleted_at IS NULL";
        title.Parameters.AddWithValue("$doc", documentId);
        var snapshot = new HistorySnapshot { Title = title.ExecuteScalar() as string ?? throw new InvalidOperationException("文档已不存在。") };
        foreach (var (table, scope) in HistoryScopes)
        {
            using var query = connection.CreateCommand(); query.Transaction = transaction;
            query.CommandText = $"SELECT * FROM {table} WHERE {scope} ORDER BY id";
            query.Parameters.AddWithValue("$doc", documentId);
            using var reader = query.ExecuteReader();
            var rows = new List<Dictionary<string, JsonElement>>();
            while (reader.Read())
            {
                var row = new Dictionary<string, JsonElement>();
                for (var i = 0; i < reader.FieldCount; i++) row[reader.GetName(i)] = JsonSerializer.SerializeToElement(reader.IsDBNull(i) ? null : reader.GetValue(i));
                rows.Add(row);
            }
            snapshot.Tables[table] = rows;
        }
        return snapshot;
    }

    private static string HistorySignature(HistorySnapshot snapshot) => JsonSerializer.Serialize(new
    {
        snapshot.Title,
        tables = snapshot.Tables.Where(pair => pair.Key != "links").Select(pair => new {
            pair.Key, rows = pair.Value.Select(row => row.Where(field => field.Key is not ("revision" or "created_at" or "updated_at" or "deleted_at" or "resolved_at")))
        })
    });

    private HistoryLog ReadHistory(SqliteConnection connection, SqliteTransaction? transaction, string documentId)
    {
        using var query = connection.CreateCommand(); query.Transaction = transaction;
        query.CommandText = "SELECT data_json FROM document_history WHERE document_id=$doc";
        query.Parameters.AddWithValue("$doc", documentId);
        return query.ExecuteScalar() is string json ? JsonSerializer.Deserialize<HistoryLog>(json, _json)! : new();
    }

    private void WriteHistory(SqliteConnection connection, SqliteTransaction transaction, string documentId, HistoryLog log)
    {
        while (log.Entries.Count > 80)
        {
            var removed = log.Entries[0].Id; log.Entries.RemoveAt(0);
            var index = log.Stack.IndexOf(removed);
            if (index >= 0) { log.Stack.RemoveAt(index); if (log.Cursor >= index) log.Cursor--; }
        }
        using var command = connection.CreateCommand(); command.Transaction = transaction;
        command.CommandText = "INSERT INTO document_history(document_id,data_json) VALUES($doc,$json) ON CONFLICT(document_id) DO UPDATE SET data_json=excluded.data_json";
        command.Parameters.AddWithValue("$doc", documentId); command.Parameters.AddWithValue("$json", JsonSerializer.Serialize(log, _json));
        command.ExecuteNonQuery();
    }

    private static void AppendHistory(HistoryLog log, HistoryVersion entry)
    {
        log.Stack.RemoveRange(log.Cursor + 1, log.Stack.Count - log.Cursor - 1);
        log.Entries.Add(entry); log.Stack.Add(entry.Id); log.Cursor = log.Stack.Count - 1;
    }

    private void RecordHistory(SqliteConnection connection, SqliteTransaction transaction, string documentId,
        HistorySnapshot before, string label, string? group = null)
    {
        var after = CaptureHistory(connection, transaction, documentId);
        if (HistorySignature(before) == HistorySignature(after)) return;
        var log = ReadHistory(connection, transaction, documentId);
        var current = log.Cursor >= 0 ? log.Entries.Find(e => e.Id == log.Stack[log.Cursor]) : null;
        if (current is null || HistorySignature(current.Snapshot) != HistorySignature(before))
        {
            AppendHistory(log, new() { Snapshot = before });
            current = log.Entries[^1];
        }
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (group is not null && current.Kind == "edit" && current.Group == group && log.Cursor == log.Stack.Count - 1 && now - current.Timestamp <= 900)
        { current.Snapshot = after; current.Timestamp = now; }
        else AppendHistory(log, new() { Snapshot = after, Label = label, Kind = group is null ? "command" : "edit", Group = group });
        WriteHistory(connection, transaction, documentId, log);
    }

    private string HistoryOwner(SqliteConnection connection, SqliteTransaction transaction, string referenceId)
    {
        using var command = connection.CreateCommand(); command.Transaction = transaction;
        command.CommandText = "SELECT host_document_id FROM reference_instances WHERE id=$id";
        command.Parameters.AddWithValue("$id", referenceId);
        return command.ExecuteScalar() as string ?? throw new InvalidOperationException("引用不存在。");
    }

    public object GetDocumentHistory(string documentId)
    {
        using var connection = OpenConnection();
        var log = ReadHistory(connection, null, documentId);
        return new {
            documentId, currentId = log.Cursor >= 0 ? log.Stack[log.Cursor] : "",
            canUndo = log.Cursor > 0, canRedo = log.Cursor >= 0 && log.Cursor < log.Stack.Count - 1,
            entries = log.Entries.Select(e => new { id = e.Id, timestamp = e.Timestamp, label = e.Label, kind = e.Kind, title = e.Snapshot.Title,
                preview = string.Join("\n", e.Snapshot.Tables["blocks"].Where(b => b["scope_type"].GetString() == "canonical")
                    .OrderBy(b => b["position"].GetString()).Select(b => {
                        var content = JsonSerializer.Deserialize<JsonElement>(b["content_json"].GetString()!);
                        return content.TryGetProperty("text", out var text) ? text.GetString() : "";
                    })).TruncateHistoryPreview() })
        };
    }

    private void MoveHistory(string documentId, string operation, JsonElement message)
    {
        using var connection = OpenConnection(); using var transaction = connection.BeginTransaction();
        using var version = connection.CreateCommand(); version.Transaction = transaction;
        version.CommandText = "SELECT client_version FROM documents WHERE id=$doc AND deleted_at IS NULL"; version.Parameters.AddWithValue("$doc", documentId);
        var currentVersion = Convert.ToInt64(version.ExecuteScalar());
        if (!message.TryGetProperty("expectedVersion", out var expected) || expected.GetInt64() != currentVersion)
            throw new InvalidOperationException("文档已更新，请重新载入后再恢复历史。");
        var log = ReadHistory(connection, transaction, documentId);
        var target = operation == "history-undo" ? log.Cursor - 1 : log.Cursor + 1;
        HistoryVersion? entry;
        if (operation == "history-restore") entry = log.Entries.Find(e => e.Id == message.GetProperty("entryId").GetString());
        else entry = target >= 0 && target < log.Stack.Count ? log.Entries.Find(e => e.Id == log.Stack[target]) : null;
        if (entry is null) throw new InvalidOperationException("没有可恢复的历史版本。");
        var current = log.Cursor >= 0 ? log.Entries.Find(e => e.Id == log.Stack[log.Cursor]) : null;
        if (current is null || HistorySignature(current.Snapshot) != HistorySignature(CaptureHistory(connection, transaction, documentId)))
            throw new InvalidOperationException("文档已在其他位置更新，请重新编辑后再撤销。");
        RestoreHistoryRows(connection, transaction, documentId, entry.Snapshot, currentVersion + 1);
        if (operation == "history-restore") AppendHistory(log, new() { Label = "恢复历史版本", Kind = "restore", Snapshot = CaptureHistory(connection, transaction, documentId) });
        else { log.Cursor = target; entry.Group = null; }
        WriteHistory(connection, transaction, documentId, log);
        transaction.Commit(); RefreshNotes();
    }

    private void RestoreHistoryRows(SqliteConnection connection, SqliteTransaction transaction, string documentId, HistorySnapshot snapshot, long version)
    {
        // Retain IDs and tombstones; only revive rows owned by this document. Defer parent FKs until all blocks are restored.
        using var clear = connection.CreateCommand(); clear.Transaction = transaction;
        clear.CommandText = "PRAGMA defer_foreign_keys=ON; UPDATE blocks SET deleted_at=$now WHERE document_id=$doc; UPDATE reference_instances SET deleted_at=$now WHERE host_document_id=$doc; DELETE FROM block_overrides WHERE reference_instance_id IN (SELECT id FROM reference_instances WHERE host_document_id=$doc); DELETE FROM instance_tree_operations WHERE reference_instance_id IN (SELECT id FROM reference_instances WHERE host_document_id=$doc); DELETE FROM links WHERE source_document_id=$doc; UPDATE documents SET title=$title,client_version=$version,updated_at=$now WHERE id=$doc";
        clear.Parameters.AddWithValue("$doc", documentId); clear.Parameters.AddWithValue("$now", UtcNow());
        clear.Parameters.AddWithValue("$title", snapshot.Title); clear.Parameters.AddWithValue("$version", version); clear.ExecuteNonQuery();
        foreach (var table in HistoryScopes.Keys)
        foreach (var row in snapshot.Tables[table])
        {
            using var insert = connection.CreateCommand(); insert.Transaction = transaction;
            var columns = row.Keys.ToArray();
            var updates = columns.Where(c => c is not ("id" or "created_at" or "revision")).Select(c => $"{c}=excluded.{c}").ToList();
            if (table == "blocks") updates.Add("revision=blocks.revision+1");
            insert.CommandText = $"INSERT INTO {table}({string.Join(',', columns)}) VALUES({string.Join(',', columns.Select((_, i) => "$p" + i))}) ON CONFLICT(id) DO UPDATE SET {string.Join(',', updates)}";
            for (var i = 0; i < columns.Length; i++)
            {
                var value = row[columns[i]];
                object data = value.ValueKind == JsonValueKind.Null ? DBNull.Value : value.ValueKind == JsonValueKind.Number ? value.GetInt64() : value.GetString()!;
                if (columns[i] == "updated_at") data = UtcNow();
                insert.Parameters.AddWithValue("$p" + i, data);
            }
            insert.ExecuteNonQuery();
        }
    }
}

internal static class HistoryPreviewExtensions
{
    internal static string TruncateHistoryPreview(this string value) => value.Length > 12000 ? value[..12000] + "\n…" : value;
}
