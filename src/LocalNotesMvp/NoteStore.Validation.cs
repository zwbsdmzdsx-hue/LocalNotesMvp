using Microsoft.Data.Sqlite;
using System.Text.Json;

namespace LocalNotesMvp;

public sealed partial class NoteStore
{
    // A save is a complete canonical snapshot. Validate inside its transaction,
    // before changing any rows, including ownership of soft-deleted block IDs.
    private static void ValidateDocumentSnapshot(SqliteConnection connection, SqliteTransaction transaction,
        string documentId, List<BlockRecord> blocks)
    {
        if (blocks is null) throw new InvalidOperationException("Blocks must be an array.");
        var incoming = new Dictionary<string, BlockRecord>(StringComparer.Ordinal);
        foreach (var block in blocks)
        {
            if (block is null || string.IsNullOrWhiteSpace(block.Id) || !incoming.TryAdd(block.Id, block))
                throw new InvalidOperationException("Block IDs must be nonempty and unique.");
            if (block.Content.ValueKind != JsonValueKind.Object ||
                block.Properties.ValueKind is not (JsonValueKind.Object or JsonValueKind.Undefined))
                throw new InvalidOperationException("Block content and properties must be objects.");
            using var query = connection.CreateCommand();
            query.Transaction = transaction;
            query.CommandText = "SELECT document_id, scope_type FROM blocks WHERE id=$id";
            query.Parameters.AddWithValue("$id", block.Id);
            using var row = query.ExecuteReader();
            if (row.Read() && (row.GetString(0) != documentId || row.GetString(1) != "canonical"))
                throw new InvalidOperationException("Block belongs to another document or reference instance.");
        }
        foreach (var block in blocks)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal) { block.Id };
            var parent = block.ParentId;
            while (parent is not null)
            {
                if (!incoming.TryGetValue(parent, out var ancestor))
                    throw new InvalidOperationException("Parent block must belong to the same document snapshot.");
                if (!seen.Add(parent)) throw new InvalidOperationException("Block tree contains a cycle.");
                parent = ancestor.ParentId;
            }
        }
    }
}
