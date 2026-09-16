using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace LocalNotesMvp;

public sealed partial class NoteStore : INoteRepository
{
    private static readonly Regex WikiLinkRegex = new(@"\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]+)?\]\]", RegexOptions.Compiled);
    private readonly string _databasePath;
    private readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web);
    private List<Note> _notes = [];

    public IReadOnlyList<Note> Notes => _notes;
    public string DatabasePath => _databasePath;

    public NoteStore(string? databasePath = null) => _databasePath = databasePath ?? Environment.GetEnvironmentVariable("LOCAL_NOTES_MVP_DB") ?? Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalNotesMvp", "notes.db");

    public void Load()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_databasePath)!);
        InitializeDatabase();
        MigrateLegacyNotes();
        ImportLegacyJsonIfNeeded();
        EnsureWorkspaceStructure();
        RefreshNotes();
        if (_notes.Count == 0) CreateWelcomeDocument();
        EnsureWorkspaceStructure();
        RefreshNotes();
    }

    public IReadOnlyList<Workspace> GetWorkspaces()
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT id, name, root_path, updated_at FROM workspaces ORDER BY updated_at DESC";
        using var reader = command.ExecuteReader();
        var result = new List<Workspace>();
        while (reader.Read()) result.Add(new Workspace
        {
            Id = reader.GetString(0), Name = reader.GetString(1), RootPath = reader.IsDBNull(2) ? null : reader.GetString(2),
            UpdatedAt = DateTime.Parse(reader.GetString(3), null, System.Globalization.DateTimeStyles.RoundtripKind)
        });
        return result;
    }

    public IReadOnlyList<Bookmark> GetBookmarks(string workspaceId)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT id, workspace_id, name, color, position FROM bookmarks WHERE workspace_id=$workspaceId AND deleted_at IS NULL ORDER BY position";
        command.Parameters.AddWithValue("$workspaceId", workspaceId);
        using var reader = command.ExecuteReader();
        var result = new List<Bookmark>();
        while (reader.Read()) result.Add(new Bookmark
        {
            Id = reader.GetString(0), WorkspaceId = reader.GetString(1), Name = reader.GetString(2), Color = reader.GetString(3), Position = reader.GetString(4)
        });
        return result;
    }

    public IReadOnlyList<WorkspacePreview> GetWorkspacePreviews()
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT w.id, w.name, w.root_path, w.updated_at,
                   (SELECT COUNT(*) FROM bookmarks b WHERE b.workspace_id=w.id AND b.deleted_at IS NULL),
                   (SELECT COUNT(*) FROM documents d WHERE d.workspace_id=w.id AND d.deleted_at IS NULL)
            FROM workspaces w ORDER BY w.updated_at DESC
            """;
        using var reader = command.ExecuteReader();
        var result = new List<WorkspacePreview>();
        while (reader.Read()) result.Add(new WorkspacePreview
        {
            Workspace = new Workspace
            {
                Id = reader.GetString(0), Name = reader.GetString(1), RootPath = reader.IsDBNull(2) ? null : reader.GetString(2),
                UpdatedAt = DateTime.Parse(reader.GetString(3), null, System.Globalization.DateTimeStyles.RoundtripKind)
            },
            BookmarkCount = reader.GetInt32(4), DocumentCount = reader.GetInt32(5)
        });
        return result;
    }

    public IReadOnlyList<Note> GetDocuments(string workspaceId, string bookmarkId)
    {
        return _notes.Where(note => note.WorkspaceId == workspaceId && HasBookmark(note.Id, bookmarkId)).ToList();
    }

    public Workspace CreateWorkspace(string name)
    {
        var workspace = new Workspace { Name = string.IsNullOrWhiteSpace(name) ? "新工作区" : name.Trim() };
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        InsertWorkspace(connection, transaction, workspace);
        InsertBookmark(connection, transaction, new Bookmark { WorkspaceId = workspace.Id, Name = "未分类", Color = "#3B82F6" });
        transaction.Commit();
        return workspace;
    }

    public void RenameWorkspace(string workspaceId, string name)
    {
        var normalizedName = string.IsNullOrWhiteSpace(name) ? "未命名工作区" : name.Trim();
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE workspaces SET name=$name, updated_at=$now WHERE id=$id";
        command.Parameters.AddWithValue("$name", normalizedName);
        command.Parameters.AddWithValue("$now", UtcNow());
        command.Parameters.AddWithValue("$id", workspaceId);
        command.ExecuteNonQuery();
    }

    public Bookmark CreateBookmark(string workspaceId, string name, string color)
    {
        var bookmark = new Bookmark { WorkspaceId = workspaceId, Name = string.IsNullOrWhiteSpace(name) ? "新书签" : name.Trim(), Color = NormalizeColor(color) };
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        var position = GetNextBookmarkPosition(connection, transaction, workspaceId);
        bookmark.Position = position;
        InsertBookmark(connection, transaction, bookmark);
        transaction.Commit();
        return bookmark;
    }

    public void UpdateBookmark(Bookmark bookmark)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE bookmarks SET name=$name, color=$color, updated_at=$now WHERE id=$id AND deleted_at IS NULL";
        command.Parameters.AddWithValue("$name", string.IsNullOrWhiteSpace(bookmark.Name) ? "未命名书签" : bookmark.Name.Trim());
        command.Parameters.AddWithValue("$color", NormalizeColor(bookmark.Color));
        command.Parameters.AddWithValue("$now", UtcNow());
        command.Parameters.AddWithValue("$id", bookmark.Id);
        command.ExecuteNonQuery();
    }

    private void ImportLegacyJsonIfNeeded()
    {
        using var connection = OpenConnection();
        using var count = connection.CreateCommand();
        count.CommandText = "SELECT COUNT(*) FROM documents";
        if (Convert.ToInt32(count.ExecuteScalar()) > 0) return;
        var path = Path.Combine(Path.GetDirectoryName(_databasePath)!, "notes.json");
        if (!File.Exists(path)) return;
        using var source = JsonDocument.Parse(File.ReadAllText(path));
        using var transaction = connection.BeginTransaction();
        foreach (var item in source.RootElement.EnumerateArray())
        {
            var note = new Note
            {
                Id = item.TryGetProperty("id", out var id) ? id.GetString() ?? Guid.NewGuid().ToString("N") : Guid.NewGuid().ToString("N"),
                Title = item.TryGetProperty("title", out var title) && !string.IsNullOrWhiteSpace(title.GetString()) ? title.GetString()! : "未命名笔记",
                IsSticky = item.TryGetProperty("isSticky", out var sticky) && sticky.GetBoolean(),
                UpdatedAt = item.TryGetProperty("updatedAt", out var updated) && DateTime.TryParse(updated.GetString(), out var date) ? date : DateTime.UtcNow
            };
            InsertDocument(connection, transaction, note);
            var content = item.TryGetProperty("contentJson", out var contentElement) ? contentElement.GetString() : null;
            var imported = false;
            if (!string.IsNullOrWhiteSpace(content))
            {
                try
                {
                    foreach (var block in JsonDocument.Parse(content).RootElement.EnumerateArray())
                    {
                        var type = block.TryGetProperty("type", out var typeElement) ? typeElement.GetString() ?? "paragraph" : "paragraph";
                        var text = block.TryGetProperty("text", out var textElement) ? textElement.GetString() ?? "" : "";
                        InsertBlock(connection, transaction, note.Id, NewBlock(type, text));
                        imported = true;
                    }
                }
                catch (JsonException) { }
            }
            if (!imported) InsertBlock(connection, transaction, note.Id, NewBlock("paragraph", ""));
        }
        transaction.Commit();
    }

    public Note Create(bool sticky = false, string? workspaceId = null, string? bookmarkId = null)
    {
        var note = new Note { Title = sticky ? "新便签" : "新笔记", IsSticky = sticky };
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        workspaceId ??= GetDefaultWorkspaceId(connection, transaction);
        bookmarkId ??= GetDefaultBookmarkId(connection, transaction, workspaceId);
        note.WorkspaceId = workspaceId;
        InsertDocument(connection, transaction, note);
        LinkDocumentBookmark(connection, transaction, note.Id, bookmarkId);
        InsertBlock(connection, transaction, note.Id, NewBlock("paragraph", ""));
        transaction.Commit();
        RefreshNotes();
        return _notes.First(x => x.Id == note.Id);
    }

    public void AssignDocumentToBookmark(string documentId, string bookmarkId)
    {
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        using (var workspace = connection.CreateCommand())
        {
            workspace.Transaction = transaction;
            workspace.CommandText = "UPDATE documents SET workspace_id=(SELECT workspace_id FROM bookmarks WHERE id=$bookmarkId) WHERE id=$documentId";
            workspace.Parameters.AddWithValue("$bookmarkId", bookmarkId);
            workspace.Parameters.AddWithValue("$documentId", documentId);
            workspace.ExecuteNonQuery();
        }
        LinkDocumentBookmark(connection, transaction, documentId, bookmarkId);
        transaction.Commit();
        RefreshNotes();
    }

    public Note? Find(string id) => _notes.FirstOrDefault(x => x.Id == id);

    public IReadOnlyDictionary<string, long> GetTableCounts()
    {
        using var connection = OpenConnection();
        var counts = new Dictionary<string, long>();
        foreach (var table in new[] { "workspaces", "bookmarks", "document_bookmarks", "documents", "blocks", "links", "reference_instances", "block_overrides", "instance_tree_operations", "views", "placements", "edges" })
        {
            using var command = connection.CreateCommand();
            command.CommandText = $"SELECT COUNT(*) FROM {table}";
            counts[table] = Convert.ToInt64(command.ExecuteScalar());
        }
        return counts;
    }

    public object GetEditorState(string documentId)
    {
        var note = Find(documentId) ?? throw new InvalidOperationException("Document not found.");
        using var connection = OpenConnection();
        return new
        {
            note,
            blocks = ReadBlocks(connection, documentId),
            documents = ReadLinkCatalog(connection),
            backlinks = ReadBacklinks(connection, documentId),
            overrideNotices = ReadOverrideNotices(connection, documentId),
            references = ReadReferenceInstances(connection, documentId)
        };
    }

    private bool HasBookmark(string documentId, string bookmarkId)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT EXISTS(SELECT 1 FROM document_bookmarks WHERE document_id=$documentId AND bookmark_id=$bookmarkId)";
        command.Parameters.AddWithValue("$documentId", documentId);
        command.Parameters.AddWithValue("$bookmarkId", bookmarkId);
        return Convert.ToInt32(command.ExecuteScalar()) == 1;
    }

    private void EnsureWorkspaceStructure()
    {
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        var workspaceId = GetDefaultWorkspaceId(connection, transaction);
        var bookmarkId = GetDefaultBookmarkId(connection, transaction, workspaceId);
        using var assign = connection.CreateCommand();
        assign.Transaction = transaction;
        assign.CommandText = "UPDATE documents SET workspace_id=$workspaceId WHERE workspace_id IS NULL";
        assign.Parameters.AddWithValue("$workspaceId", workspaceId);
        assign.ExecuteNonQuery();
        using var links = connection.CreateCommand();
        links.Transaction = transaction;
        links.CommandText = "INSERT OR IGNORE INTO document_bookmarks (document_id, bookmark_id, created_at) SELECT id, $bookmarkId, $now FROM documents WHERE deleted_at IS NULL";
        links.Parameters.AddWithValue("$bookmarkId", bookmarkId);
        links.Parameters.AddWithValue("$now", UtcNow());
        links.ExecuteNonQuery();
        transaction.Commit();
    }

    public void SaveDocument(string documentId, SaveDocumentRequest request)
    {
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        SaveDocumentCore(connection, transaction, documentId, request, null);
        transaction.Commit();
        RefreshNotes();
    }

    public long SaveTransaction(SaveTransactionRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.DocumentId) || string.IsNullOrWhiteSpace(request.MutationId))
            throw new InvalidOperationException("A save transaction requires a document ID and mutation ID.");

        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        long currentVersion;
        using (var current = connection.CreateCommand())
        {
            current.Transaction = transaction;
            current.CommandText = "SELECT client_version FROM documents WHERE id=$id AND deleted_at IS NULL";
            current.Parameters.AddWithValue("$id", request.DocumentId);
            currentVersion = Convert.ToInt64(current.ExecuteScalar() ?? throw new InvalidOperationException("Document no longer exists."));
        }

        using (var duplicate = connection.CreateCommand())
        {
            duplicate.Transaction = transaction;
            duplicate.CommandText = "SELECT client_version FROM save_transactions WHERE document_id=$documentId AND mutation_id=$mutationId";
            duplicate.Parameters.AddWithValue("$documentId", request.DocumentId);
            duplicate.Parameters.AddWithValue("$mutationId", request.MutationId);
            var previous = duplicate.ExecuteScalar();
            if (previous is not null && previous is not DBNull)
            {
                transaction.Commit();
                return Convert.ToInt64(previous);
            }
        }

        if (request.ClientVersion <= currentVersion)
            throw new InvalidOperationException($"Stale save rejected. Expected a version newer than {currentVersion}, received {request.ClientVersion}.");

        var persistedVersion = currentVersion + 1;

        SaveDocumentCore(connection, transaction, request.DocumentId, new SaveDocumentRequest
        {
            Title = request.Title,
            Blocks = request.Blocks
        }, persistedVersion);

        using (var record = connection.CreateCommand())
        {
            record.Transaction = transaction;
            record.CommandText = "INSERT INTO save_transactions (document_id, mutation_id, client_version, created_at) VALUES ($documentId, $mutationId, $version, $now)";
            record.Parameters.AddWithValue("$documentId", request.DocumentId);
            record.Parameters.AddWithValue("$mutationId", request.MutationId);
            record.Parameters.AddWithValue("$version", persistedVersion);
            record.Parameters.AddWithValue("$now", UtcNow());
            record.ExecuteNonQuery();
        }
        transaction.Commit();
        RefreshNotes();
        return persistedVersion;
    }

    private void SaveDocumentCore(SqliteConnection connection, SqliteTransaction transaction, string documentId, SaveDocumentRequest request, long? clientVersion)
    {
        using (var update = connection.CreateCommand())
        {
            update.Transaction = transaction;
            update.CommandText = clientVersion.HasValue
                ? "UPDATE documents SET title=$title, updated_at=$now, client_version=$clientVersion WHERE id=$id"
                : "UPDATE documents SET title=$title, updated_at=$now WHERE id=$id";
            update.Parameters.AddWithValue("$title", string.IsNullOrWhiteSpace(request.Title) ? "未命名笔记" : request.Title.Trim());
            update.Parameters.AddWithValue("$now", UtcNow());
            update.Parameters.AddWithValue("$id", documentId);
            if (clientVersion.HasValue) update.Parameters.AddWithValue("$clientVersion", clientVersion.Value);
            if (update.ExecuteNonQuery() == 0) throw new InvalidOperationException("Document no longer exists.");
        }

        var incomingIds = request.Blocks.Select(x => x.Id).ToHashSet();
        foreach (var block in request.Blocks) UpsertBlock(connection, transaction, documentId, block);
        SoftDeleteMissingBlocks(connection, transaction, documentId, incomingIds);
        RebuildLinks(connection, transaction, documentId, request.Blocks);
    }

    public void CreateReference(string hostDocumentId, string hostBlockId, string targetDocumentId, string? targetBlockId = null)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO reference_instances
                (id, host_document_id, host_block_id, target_document_id, target_block_id, mode, update_policy, conflict_policy, created_at, updated_at)
            VALUES ($id, $hostDocumentId, $hostBlockId, $targetDocumentId, $targetBlockId, 'live', 'inherit', 'notify', $now, $now)
            ON CONFLICT(host_block_id) DO UPDATE SET target_document_id=excluded.target_document_id, target_block_id=excluded.target_block_id, updated_at=excluded.updated_at;
            """;
        command.Parameters.AddWithValue("$id", Guid.NewGuid().ToString("N"));
        command.Parameters.AddWithValue("$hostDocumentId", hostDocumentId);
        command.Parameters.AddWithValue("$hostBlockId", hostBlockId);
        command.Parameters.AddWithValue("$targetDocumentId", targetDocumentId);
        command.Parameters.AddWithValue("$targetBlockId", (object?)targetBlockId ?? DBNull.Value);
        command.Parameters.AddWithValue("$now", UtcNow());
        command.ExecuteNonQuery();
    }

    public void SetReferenceMode(SetReferenceModeRequest request)
    {
        var mode = request.Mode is "inline" or "collapsed" or "sidebar" or "link" ? request.Mode : "inline";
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE reference_instances SET mode=$mode, updated_at=$now WHERE id=$id AND deleted_at IS NULL";
        command.Parameters.AddWithValue("$mode", mode);
        command.Parameters.AddWithValue("$now", UtcNow());
        command.Parameters.AddWithValue("$id", request.ReferenceInstanceId);
        if (command.ExecuteNonQuery() == 0) throw new InvalidOperationException("Reference instance no longer exists.");
    }

    public void RemoveReference(string referenceInstanceId)
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "UPDATE reference_instances SET deleted_at=$now, updated_at=$now WHERE id=$id AND deleted_at IS NULL";
        command.Parameters.AddWithValue("$now", UtcNow());
        command.Parameters.AddWithValue("$id", referenceInstanceId);
        command.ExecuteNonQuery();
    }

    public void ResetReference(string referenceInstanceId)
    {
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        foreach (var sql in new[]
        {
            "DELETE FROM block_overrides WHERE reference_instance_id=$id",
            "UPDATE instance_tree_operations SET status='deleted', updated_at=$now WHERE reference_instance_id=$id AND status='active'",
            "UPDATE blocks SET deleted_at=$now WHERE scope_type='reference_instance' AND scope_id=$id AND deleted_at IS NULL"
        })
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = sql;
            command.Parameters.AddWithValue("$id", referenceInstanceId);
            command.Parameters.AddWithValue("$now", UtcNow());
            command.ExecuteNonQuery();
        }
        transaction.Commit();
    }

    public void SaveOverride(SaveOverrideRequest request)
    {
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        int revision;
        string baseContent;
        using (var source = connection.CreateCommand())
        {
            source.Transaction = transaction;
            source.CommandText = "SELECT revision, content_json FROM blocks WHERE id=$id AND deleted_at IS NULL";
            source.Parameters.AddWithValue("$id", request.TargetBlockId);
            using var reader = source.ExecuteReader();
            if (!reader.Read()) throw new InvalidOperationException("Referenced block no longer exists.");
            revision = reader.GetInt32(0);
            baseContent = reader.GetString(1);
        }

        var patch = JsonSerializer.Serialize(new { content = request.Content, properties = request.Properties }, _json);
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO block_overrides
                (id, reference_instance_id, target_block_id, override_type, patch_json, base_revision, base_content_json, status, created_at, updated_at)
            VALUES ($id, $referenceId, $targetBlockId, 'content_style', $patch, $revision, $baseContent, 'active', $now, $now)
            ON CONFLICT(reference_instance_id, target_block_id) DO UPDATE SET
                patch_json=excluded.patch_json, status='active', updated_at=excluded.updated_at;
            """;
        command.Parameters.AddWithValue("$id", Guid.NewGuid().ToString("N"));
        command.Parameters.AddWithValue("$referenceId", request.ReferenceInstanceId);
        command.Parameters.AddWithValue("$targetBlockId", request.TargetBlockId);
        command.Parameters.AddWithValue("$patch", patch);
        command.Parameters.AddWithValue("$revision", revision);
        command.Parameters.AddWithValue("$baseContent", baseContent);
        command.Parameters.AddWithValue("$now", UtcNow());
        command.ExecuteNonQuery();
        transaction.Commit();
    }

    public void HideReferencedBlock(string referenceInstanceId, string targetBlockId)
    {
        using var connection = OpenConnection();
        int revision;
        string? parentId;
        string position;
        using (var source = connection.CreateCommand())
        {
            source.CommandText = "SELECT revision, parent_id, position FROM blocks WHERE id=$id AND scope_type='canonical' AND deleted_at IS NULL";
            source.Parameters.AddWithValue("$id", targetBlockId);
            using var reader = source.ExecuteReader();
            if (!reader.Read()) throw new InvalidOperationException("Referenced block no longer exists.");
            revision = reader.GetInt32(0);
            parentId = reader.IsDBNull(1) ? null : reader.GetString(1);
            position = reader.GetString(2);
        }
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO instance_tree_operations
                (id, reference_instance_id, operation, target_block_id, base_parent_id, base_position,
                 base_revision, properties_json, status, created_at, updated_at)
            VALUES ($id, $referenceId, 'hide', $targetBlockId, $parentId, $position,
                    $revision, '{}', 'active', $now, $now)
            ON CONFLICT(reference_instance_id, operation, target_block_id)
            DO UPDATE SET status='active', updated_at=excluded.updated_at;
            """;
        command.Parameters.AddWithValue("$id", Guid.NewGuid().ToString("N"));
        command.Parameters.AddWithValue("$referenceId", referenceInstanceId);
        command.Parameters.AddWithValue("$targetBlockId", targetBlockId);
        command.Parameters.AddWithValue("$parentId", (object?)parentId ?? DBNull.Value);
        command.Parameters.AddWithValue("$position", position);
        command.Parameters.AddWithValue("$revision", revision);
        command.Parameters.AddWithValue("$now", UtcNow());
        command.ExecuteNonQuery();
    }

    public void SaveInstanceBlock(SaveInstanceBlockRequest request)
    {
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        string hostDocumentId;
        using (var instance = connection.CreateCommand())
        {
            instance.Transaction = transaction;
            instance.CommandText = "SELECT host_document_id FROM reference_instances WHERE id=$id AND deleted_at IS NULL";
            instance.Parameters.AddWithValue("$id", request.ReferenceInstanceId);
            hostDocumentId = instance.ExecuteScalar() as string ?? throw new InvalidOperationException("Reference instance no longer exists.");
        }

        var block = request.Block;
        var content = block.Content.ValueKind == JsonValueKind.Undefined ? "{}" : block.Content.GetRawText();
        var properties = block.Properties.ValueKind == JsonValueKind.Undefined ? "{}" : block.Properties.GetRawText();
        using (var save = connection.CreateCommand())
        {
            save.Transaction = transaction;
            save.CommandText = """
                INSERT INTO blocks
                    (id, document_id, parent_id, position, type, content_json, properties_json,
                     revision, scope_type, scope_id, created_at, updated_at)
                VALUES ($id, $documentId, $parentId, $position, $type, $content, $properties,
                        1, 'reference_instance', $referenceId, $now, $now)
                ON CONFLICT(id) DO UPDATE SET
                    parent_id=excluded.parent_id, position=excluded.position, type=excluded.type,
                    content_json=excluded.content_json, properties_json=excluded.properties_json,
                    revision=CASE WHEN blocks.parent_id IS NOT excluded.parent_id OR blocks.position<>excluded.position OR
                        blocks.type<>excluded.type OR blocks.content_json<>excluded.content_json OR
                        blocks.properties_json<>excluded.properties_json THEN blocks.revision+1 ELSE blocks.revision END,
                    updated_at=excluded.updated_at, deleted_at=NULL
                WHERE blocks.scope_type='reference_instance' AND blocks.scope_id=excluded.scope_id;
                """;
            save.Parameters.AddWithValue("$id", block.Id);
            save.Parameters.AddWithValue("$documentId", hostDocumentId);
            save.Parameters.AddWithValue("$parentId", (object?)block.ParentId ?? DBNull.Value);
            save.Parameters.AddWithValue("$position", block.Position);
            save.Parameters.AddWithValue("$type", block.Type);
            save.Parameters.AddWithValue("$content", content);
            save.Parameters.AddWithValue("$properties", properties);
            save.Parameters.AddWithValue("$referenceId", request.ReferenceInstanceId);
            save.Parameters.AddWithValue("$now", UtcNow());
            if (save.ExecuteNonQuery() == 0) throw new InvalidOperationException("Instance block belongs to another reference.");
        }

        using (var operation = connection.CreateCommand())
        {
            operation.Transaction = transaction;
            operation.CommandText = """
                INSERT INTO instance_tree_operations
                    (id, reference_instance_id, operation, instance_block_id, parent_block_id, position,
                     properties_json, status, created_at, updated_at)
                VALUES ($id, $referenceId, 'insert', $blockId, $parentId, $position, '{}', 'active', $now, $now)
                ON CONFLICT DO UPDATE SET parent_block_id=excluded.parent_block_id,
                    position=excluded.position, status='active', updated_at=excluded.updated_at;
                """;
            operation.Parameters.AddWithValue("$id", Guid.NewGuid().ToString("N"));
            operation.Parameters.AddWithValue("$referenceId", request.ReferenceInstanceId);
            operation.Parameters.AddWithValue("$blockId", block.Id);
            operation.Parameters.AddWithValue("$parentId", (object?)block.ParentId ?? DBNull.Value);
            operation.Parameters.AddWithValue("$position", block.Position);
            operation.Parameters.AddWithValue("$now", UtcNow());
            operation.ExecuteNonQuery();
        }
        transaction.Commit();
    }

    public void MoveReferencedBlock(MoveReferencedBlockRequest request)
    {
        using var connection = OpenConnection();
        int revision;
        string? baseParentId;
        string basePosition;
        using (var source = connection.CreateCommand())
        {
            source.CommandText = "SELECT revision, parent_id, position FROM blocks WHERE id=$id AND scope_type='canonical' AND deleted_at IS NULL";
            source.Parameters.AddWithValue("$id", request.TargetBlockId);
            using var reader = source.ExecuteReader();
            if (!reader.Read()) throw new InvalidOperationException("Referenced block no longer exists.");
            revision = reader.GetInt32(0);
            baseParentId = reader.IsDBNull(1) ? null : reader.GetString(1);
            basePosition = reader.GetString(2);
        }
        using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO instance_tree_operations
                (id, reference_instance_id, operation, target_block_id, parent_block_id, position,
                 base_parent_id, base_position, base_revision, properties_json, status, created_at, updated_at)
            VALUES ($id, $referenceId, 'move', $targetBlockId, $parentId, $position,
                    $baseParentId, $basePosition, $revision, '{}', 'active', $now, $now)
            ON CONFLICT(reference_instance_id, operation, target_block_id) DO UPDATE SET
                parent_block_id=excluded.parent_block_id, position=excluded.position,
                status='active', updated_at=excluded.updated_at;
            """;
        command.Parameters.AddWithValue("$id", Guid.NewGuid().ToString("N"));
        command.Parameters.AddWithValue("$referenceId", request.ReferenceInstanceId);
        command.Parameters.AddWithValue("$targetBlockId", request.TargetBlockId);
        command.Parameters.AddWithValue("$parentId", (object?)request.ParentBlockId ?? DBNull.Value);
        command.Parameters.AddWithValue("$position", request.Position);
        command.Parameters.AddWithValue("$baseParentId", (object?)baseParentId ?? DBNull.Value);
        command.Parameters.AddWithValue("$basePosition", basePosition);
        command.Parameters.AddWithValue("$revision", revision);
        command.Parameters.AddWithValue("$now", UtcNow());
        command.ExecuteNonQuery();
    }

    public void DeleteInstanceBlock(string referenceInstanceId, string blockId)
    {
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        using (var block = connection.CreateCommand())
        {
            block.Transaction = transaction;
            block.CommandText = "UPDATE blocks SET deleted_at=$now, revision=revision+1 WHERE id=$id AND scope_type='reference_instance' AND scope_id=$referenceId";
            block.Parameters.AddWithValue("$now", UtcNow());
            block.Parameters.AddWithValue("$id", blockId);
            block.Parameters.AddWithValue("$referenceId", referenceInstanceId);
            if (block.ExecuteNonQuery() == 0) throw new InvalidOperationException("Instance block no longer exists.");
        }
        using (var operation = connection.CreateCommand())
        {
            operation.Transaction = transaction;
            operation.CommandText = "UPDATE instance_tree_operations SET status='deleted', updated_at=$now WHERE reference_instance_id=$referenceId AND instance_block_id=$blockId";
            operation.Parameters.AddWithValue("$now", UtcNow());
            operation.Parameters.AddWithValue("$referenceId", referenceInstanceId);
            operation.Parameters.AddWithValue("$blockId", blockId);
            operation.ExecuteNonQuery();
        }
        transaction.Commit();
    }

    public void ResetOverride(string referenceInstanceId, string targetBlockId)
    {
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        foreach (var sql in new[]
        {
            "DELETE FROM block_overrides WHERE reference_instance_id=$referenceId AND target_block_id=$targetBlockId",
            "DELETE FROM instance_tree_operations WHERE reference_instance_id=$referenceId AND target_block_id=$targetBlockId"
        })
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = sql;
            command.Parameters.AddWithValue("$referenceId", referenceInstanceId);
            command.Parameters.AddWithValue("$targetBlockId", targetBlockId);
            command.ExecuteNonQuery();
        }
        transaction.Commit();
    }

    private void InitializeDatabase()
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, is_sticky INTEGER NOT NULL DEFAULT 0,
                default_view TEXT NOT NULL DEFAULT 'document', schema_version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
                client_version INTEGER NOT NULL DEFAULT 0, workspace_id TEXT
            );
            CREATE TABLE IF NOT EXISTS workspaces (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, deleted_at TEXT
            );
            CREATE TABLE IF NOT EXISTS bookmarks (
                id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#3B82F6', position TEXT NOT NULL DEFAULT '00001000',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
            );
            CREATE INDEX IF NOT EXISTS ix_bookmarks_workspace ON bookmarks(workspace_id, position);
            CREATE TABLE IF NOT EXISTS document_bookmarks (
                document_id TEXT NOT NULL, bookmark_id TEXT NOT NULL, created_at TEXT NOT NULL,
                PRIMARY KEY(document_id, bookmark_id), FOREIGN KEY(document_id) REFERENCES documents(id),
                FOREIGN KEY(bookmark_id) REFERENCES bookmarks(id)
            );
            CREATE INDEX IF NOT EXISTS ix_document_bookmarks_bookmark ON document_bookmarks(bookmark_id);
            CREATE TABLE IF NOT EXISTS save_transactions (
                document_id TEXT NOT NULL, mutation_id TEXT NOT NULL, client_version INTEGER NOT NULL,
                created_at TEXT NOT NULL, PRIMARY KEY(document_id, mutation_id),
                UNIQUE(document_id, client_version)
            );
            CREATE TABLE IF NOT EXISTS blocks (
                id TEXT PRIMARY KEY, document_id TEXT NOT NULL, parent_id TEXT, position TEXT NOT NULL,
                type TEXT NOT NULL, content_json TEXT NOT NULL DEFAULT '{}', properties_json TEXT NOT NULL DEFAULT '{}',
                revision INTEGER NOT NULL DEFAULT 1, scope_type TEXT NOT NULL DEFAULT 'canonical', scope_id TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
                FOREIGN KEY(document_id) REFERENCES documents(id), FOREIGN KEY(parent_id) REFERENCES blocks(id),
                CHECK(parent_id IS NULL OR parent_id <> id)
            );
            CREATE INDEX IF NOT EXISTS ix_blocks_tree ON blocks(document_id, parent_id, position);
            CREATE TABLE IF NOT EXISTS links (
                id TEXT PRIMARY KEY, source_document_id TEXT NOT NULL, source_block_id TEXT,
                target_document_id TEXT, target_block_id TEXT, target_text TEXT, link_type TEXT NOT NULL DEFAULT 'reference',
                start_offset INTEGER, end_offset INTEGER, alias TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_links_source ON links(source_document_id, source_block_id);
            CREATE INDEX IF NOT EXISTS ix_links_target ON links(target_document_id, target_block_id);
            CREATE TABLE IF NOT EXISTS reference_instances (
                id TEXT PRIMARY KEY, host_document_id TEXT NOT NULL, host_block_id TEXT NOT NULL UNIQUE,
                target_document_id TEXT, target_block_id TEXT, mode TEXT NOT NULL DEFAULT 'live',
                update_policy TEXT NOT NULL DEFAULT 'inherit', conflict_policy TEXT NOT NULL DEFAULT 'notify',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
            );
            CREATE TABLE IF NOT EXISTS block_overrides (
                id TEXT PRIMARY KEY, reference_instance_id TEXT NOT NULL, target_block_id TEXT NOT NULL,
                override_type TEXT NOT NULL, patch_json TEXT NOT NULL, base_revision INTEGER NOT NULL,
                base_content_json TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, resolved_at TEXT,
                UNIQUE(reference_instance_id, target_block_id)
            );
            CREATE INDEX IF NOT EXISTS ix_overrides_target ON block_overrides(target_block_id);
            CREATE TABLE IF NOT EXISTS instance_tree_operations (
                id TEXT PRIMARY KEY, reference_instance_id TEXT NOT NULL, operation TEXT NOT NULL,
                target_block_id TEXT, instance_block_id TEXT, parent_block_id TEXT, position TEXT,
                base_parent_id TEXT, base_position TEXT, base_revision INTEGER, properties_json TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                UNIQUE(reference_instance_id, operation, target_block_id)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS ux_tree_insert_instance
                ON instance_tree_operations(reference_instance_id, instance_block_id) WHERE operation='insert';
            CREATE TABLE IF NOT EXISTS views (
                id TEXT PRIMARY KEY, document_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
                settings_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS placements (
                id TEXT PRIMARY KEY, view_id TEXT NOT NULL, block_id TEXT NOT NULL, x REAL NOT NULL DEFAULT 0,
                y REAL NOT NULL DEFAULT 0, width REAL, height REAL, rotation REAL NOT NULL DEFAULT 0,
                z_index TEXT NOT NULL, style_json TEXT NOT NULL DEFAULT '{}', UNIQUE(view_id, block_id)
            );
            CREATE TABLE IF NOT EXISTS edges (
                id TEXT PRIMARY KEY, document_id TEXT NOT NULL, view_id TEXT, from_block_id TEXT NOT NULL,
                to_block_id TEXT NOT NULL, type TEXT NOT NULL, label TEXT, properties_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            """;
        command.ExecuteNonQuery();
        EnsureClientVersionColumn(connection);
        EnsureWorkspaceIdColumn(connection);
    }

    private static void EnsureClientVersionColumn(SqliteConnection connection)
    {
        using var check = connection.CreateCommand();
        check.CommandText = "PRAGMA table_info(documents)";
        using var reader = check.ExecuteReader();
        while (reader.Read()) if (reader.GetString(1).Equals("client_version", StringComparison.OrdinalIgnoreCase)) return;
        reader.Close();
        using var alter = connection.CreateCommand();
        alter.CommandText = "ALTER TABLE documents ADD COLUMN client_version INTEGER NOT NULL DEFAULT 0";
        alter.ExecuteNonQuery();
    }

    private static void EnsureWorkspaceIdColumn(SqliteConnection connection)
    {
        using var check = connection.CreateCommand();
        check.CommandText = "PRAGMA table_info(documents)";
        using var reader = check.ExecuteReader();
        while (reader.Read()) if (reader.GetString(1).Equals("workspace_id", StringComparison.OrdinalIgnoreCase)) return;
        reader.Close();
        using var alter = connection.CreateCommand();
        alter.CommandText = "ALTER TABLE documents ADD COLUMN workspace_id TEXT";
        alter.ExecuteNonQuery();
    }

    private void MigrateLegacyNotes()
    {
        using var connection = OpenConnection();
        using var count = connection.CreateCommand();
        count.CommandText = "SELECT COUNT(*) FROM documents";
        if (Convert.ToInt32(count.ExecuteScalar()) > 0 || !TableExists(connection, "notes")) return;

        var legacy = new List<(Note Note, string Json)>();
        using (var read = connection.CreateCommand())
        {
            read.CommandText = "SELECT id, title, content_json, is_sticky, updated_at FROM notes ORDER BY updated_at";
            using var reader = read.ExecuteReader();
            while (reader.Read()) legacy.Add((new Note
            {
                Id = reader.GetString(0), Title = reader.GetString(1), IsSticky = reader.GetInt64(3) == 1,
                UpdatedAt = DateTime.Parse(reader.GetString(4), null, System.Globalization.DateTimeStyles.RoundtripKind)
            }, reader.GetString(2)));
        }

        using var transaction = connection.BeginTransaction();
        foreach (var item in legacy)
        {
            InsertDocument(connection, transaction, item.Note);
            var position = 1000;
            try
            {
                using var content = JsonDocument.Parse(item.Json);
                foreach (var oldBlock in content.RootElement.EnumerateArray())
                {
                    var type = oldBlock.TryGetProperty("type", out var t) ? t.GetString() ?? "paragraph" : "paragraph";
                    var text = oldBlock.TryGetProperty("text", out var value) ? value.GetString() ?? "" : "";
                    var block = NewBlock(type, text);
                    var isChecked = oldBlock.TryGetProperty("checked", out var check) && check.ValueKind is JsonValueKind.True or JsonValueKind.False && check.GetBoolean();
                    block.Content = JsonSerializer.SerializeToElement(new { text, html = WebUtility.HtmlEncode(text), @checked = isChecked }, _json);
                    block.Position = position.ToString("D8");
                    InsertBlock(connection, transaction, item.Note.Id, block);
                    position += 1000;
                }
            }
            catch (JsonException) { InsertBlock(connection, transaction, item.Note.Id, NewBlock("paragraph", "")); }
        }
        transaction.Commit();
    }

    private void CreateWelcomeDocument()
    {
        var note = new Note { Title = "欢迎使用本地笔记" };
        using var connection = OpenConnection();
        using var transaction = connection.BeginTransaction();
        InsertDocument(connection, transaction, note);
        InsertBlock(connection, transaction, note.Id, NewBlock("paragraph", "这是一个本地优先的块编辑器。点击这里开始记录。"));
        transaction.Commit();
    }

    private void UpsertBlock(SqliteConnection connection, SqliteTransaction transaction, string documentId, BlockRecord block)
    {
        var content = block.Content.ValueKind == JsonValueKind.Undefined ? "{}" : block.Content.GetRawText();
        var properties = block.Properties.ValueKind == JsonValueKind.Undefined ? "{}" : block.Properties.GetRawText();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO blocks (id, document_id, parent_id, position, type, content_json, properties_json, revision, created_at, updated_at)
            VALUES ($id, $documentId, $parentId, $position, $type, $content, $properties, 1, $now, $now)
            ON CONFLICT(id) DO UPDATE SET
                parent_id=excluded.parent_id, position=excluded.position, type=excluded.type,
                content_json=excluded.content_json, properties_json=excluded.properties_json,
                revision=CASE WHEN blocks.parent_id IS NOT excluded.parent_id OR blocks.position<>excluded.position OR
                    blocks.type<>excluded.type OR blocks.content_json<>excluded.content_json OR blocks.properties_json<>excluded.properties_json
                    THEN blocks.revision+1 ELSE blocks.revision END,
                updated_at=CASE WHEN blocks.parent_id IS NOT excluded.parent_id OR blocks.position<>excluded.position OR
                    blocks.type<>excluded.type OR blocks.content_json<>excluded.content_json OR blocks.properties_json<>excluded.properties_json
                    THEN excluded.updated_at ELSE blocks.updated_at END, deleted_at=NULL;
            """;
        command.Parameters.AddWithValue("$id", block.Id);
        command.Parameters.AddWithValue("$documentId", documentId);
        command.Parameters.AddWithValue("$parentId", (object?)block.ParentId ?? DBNull.Value);
        command.Parameters.AddWithValue("$position", block.Position);
        command.Parameters.AddWithValue("$type", block.Type);
        command.Parameters.AddWithValue("$content", content);
        command.Parameters.AddWithValue("$properties", properties);
        command.Parameters.AddWithValue("$now", UtcNow());
        command.ExecuteNonQuery();
    }

    private static void SoftDeleteMissingBlocks(SqliteConnection connection, SqliteTransaction transaction, string documentId, HashSet<string> incomingIds)
    {
        var removed = new List<string>();
        using (var existing = connection.CreateCommand())
        {
            existing.Transaction = transaction;
            existing.CommandText = "SELECT id FROM blocks WHERE document_id=$documentId AND deleted_at IS NULL AND scope_type='canonical'";
            existing.Parameters.AddWithValue("$documentId", documentId);
            using var reader = existing.ExecuteReader();
            while (reader.Read()) if (!incomingIds.Contains(reader.GetString(0))) removed.Add(reader.GetString(0));
        }
        foreach (var id in removed)
        {
            using var remove = connection.CreateCommand();
            remove.Transaction = transaction;
            remove.CommandText = "UPDATE blocks SET deleted_at=$now, revision=revision+1 WHERE id=$id";
            remove.Parameters.AddWithValue("$now", UtcNow());
            remove.Parameters.AddWithValue("$id", id);
            remove.ExecuteNonQuery();
        }
    }

    private void RebuildLinks(SqliteConnection connection, SqliteTransaction transaction, string documentId, IEnumerable<BlockRecord> blocks)
    {
        foreach (var block in blocks)
            RebuildBlockLinks(connection, transaction, documentId, block.Id, block.Content);
    }

    private void RebuildLegacyLinks(SqliteConnection connection, SqliteTransaction transaction, string documentId, IEnumerable<BlockRecord> blocks)
    {
        using (var clear = connection.CreateCommand())
        {
            clear.Transaction = transaction;
            clear.CommandText = "DELETE FROM links WHERE source_document_id=$documentId";
            clear.Parameters.AddWithValue("$documentId", documentId);
            clear.ExecuteNonQuery();
        }
        var titles = _notes
            .Where(note => !string.IsNullOrWhiteSpace(note.Title))
            .GroupBy(note => note.Title.Trim(), StringComparer.OrdinalIgnoreCase)
            .Where(group => group.Count() == 1)
            .ToDictionary(group => group.Key, group => group.First().Id, StringComparer.OrdinalIgnoreCase);
        foreach (var block in blocks)
        {
            if (block.Content.ValueKind != JsonValueKind.Object || !block.Content.TryGetProperty("text", out var textElement)) continue;
            var text = textElement.GetString() ?? "";
            foreach (Match match in WikiLinkRegex.Matches(text))
            {
                var targetText = match.Groups[1].Value.Trim();
                titles.TryGetValue(targetText, out var targetDocumentId);
                using var insert = connection.CreateCommand();
                insert.Transaction = transaction;
                insert.CommandText = """
                    INSERT INTO links (id, source_document_id, source_block_id, target_document_id, target_text, link_type, start_offset, end_offset, created_at, updated_at)
                    VALUES ($id, $sourceDocumentId, $sourceBlockId, $targetDocumentId, $targetText, 'reference', $start, $end, $now, $now)
                    """;
                insert.Parameters.AddWithValue("$id", Guid.NewGuid().ToString("N"));
                insert.Parameters.AddWithValue("$sourceDocumentId", documentId);
                insert.Parameters.AddWithValue("$sourceBlockId", block.Id);
                insert.Parameters.AddWithValue("$targetDocumentId", (object?)targetDocumentId ?? DBNull.Value);
                insert.Parameters.AddWithValue("$targetText", targetText);
                insert.Parameters.AddWithValue("$start", match.Index);
                insert.Parameters.AddWithValue("$end", match.Index + match.Length);
                insert.Parameters.AddWithValue("$now", UtcNow());
                insert.ExecuteNonQuery();
            }
        }
    }

    private List<object> ReadBlocks(SqliteConnection connection, string documentId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT id, parent_id, position, type, content_json, properties_json, revision FROM blocks WHERE document_id=$id AND deleted_at IS NULL AND scope_type='canonical' ORDER BY position";
        command.Parameters.AddWithValue("$id", documentId);
        using var reader = command.ExecuteReader();
        var blocks = new List<object>();
        while (reader.Read()) blocks.Add(BlockPayload(reader));
        return blocks;
    }

    private static List<object> ReadBacklinks(SqliteConnection connection, string documentId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT l.source_document_id, d.title, l.source_block_id, json_extract(b.content_json, '$.text')
            FROM links l JOIN documents d ON d.id=l.source_document_id LEFT JOIN blocks b ON b.id=l.source_block_id
            WHERE l.target_document_id=$id ORDER BY l.updated_at DESC
            """;
        command.Parameters.AddWithValue("$id", documentId);
        using var reader = command.ExecuteReader();
        var rows = new List<object>();
        while (reader.Read()) rows.Add(new { sourceDocumentId = reader.GetString(0), sourceTitle = reader.GetString(1), sourceBlockId = reader.IsDBNull(2) ? null : reader.GetString(2), excerpt = reader.IsDBNull(3) ? "" : reader.GetString(3) });
        return rows;
    }

    private static List<object> ReadOverrideNotices(SqliteConnection connection, string documentId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT bo.reference_instance_id, bo.target_block_id, bo.base_revision, b.revision,
                   host.title, ri.host_document_id, ri.host_block_id, json_extract(b.content_json, '$.text')
            FROM block_overrides bo JOIN blocks b ON b.id=bo.target_block_id
            JOIN reference_instances ri ON ri.id=bo.reference_instance_id JOIN documents host ON host.id=ri.host_document_id
            WHERE b.document_id=$id AND bo.status='active' ORDER BY bo.updated_at DESC
            """;
        command.Parameters.AddWithValue("$id", documentId);
        using var reader = command.ExecuteReader();
        var rows = new List<object>();
        while (reader.Read()) rows.Add(new
        {
            referenceInstanceId = reader.GetString(0), targetBlockId = reader.GetString(1),
            baseRevision = reader.GetInt32(2), sourceRevision = reader.GetInt32(3),
            sourceUpdated = reader.GetInt32(2) != reader.GetInt32(3), hostTitle = reader.GetString(4),
            hostDocumentId = reader.GetString(5), hostBlockId = reader.GetString(6), excerpt = reader.IsDBNull(7) ? "" : reader.GetString(7),
            kind = "content_style"
        });
        reader.Close();

        using var structure = connection.CreateCommand();
        structure.CommandText = """
            SELECT ito.reference_instance_id, COALESCE(ito.target_block_id, ito.instance_block_id),
                   ito.base_revision, COALESCE(source.revision, local.revision, 0), host.title,
                   ri.host_document_id, ri.host_block_id,
                   COALESCE(json_extract(source.content_json, '$.text'), json_extract(local.content_json, '$.text'), ''),
                   ito.operation
            FROM instance_tree_operations ito
            JOIN reference_instances ri ON ri.id=ito.reference_instance_id
            JOIN documents host ON host.id=ri.host_document_id
            LEFT JOIN blocks source ON source.id=ito.target_block_id
            LEFT JOIN blocks local ON local.id=ito.instance_block_id
            WHERE ri.target_document_id=$id AND ito.status='active'
            ORDER BY ito.updated_at DESC
            """;
        structure.Parameters.AddWithValue("$id", documentId);
        using var structureReader = structure.ExecuteReader();
        while (structureReader.Read()) rows.Add(new
        {
            referenceInstanceId = structureReader.GetString(0), targetBlockId = structureReader.IsDBNull(1) ? "" : structureReader.GetString(1),
            baseRevision = structureReader.IsDBNull(2) ? 0 : structureReader.GetInt32(2), sourceRevision = structureReader.GetInt32(3),
            sourceUpdated = !structureReader.IsDBNull(2) && structureReader.GetInt32(2) != structureReader.GetInt32(3),
            hostTitle = structureReader.GetString(4), hostDocumentId = structureReader.GetString(5),
            hostBlockId = structureReader.GetString(6), excerpt = structureReader.GetString(7), kind = structureReader.GetString(8)
        });
        return rows;
    }

    private List<object> ReadReferenceInstances(SqliteConnection connection, string hostDocumentId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT ri.id, ri.host_block_id, ri.target_document_id, d.title, ri.mode, ri.target_block_id, CASE WHEN d.id IS NULL OR (ri.target_block_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.id=ri.target_block_id AND b.deleted_at IS NULL)) THEN 1 ELSE 0 END FROM reference_instances ri LEFT JOIN documents d ON d.id=ri.target_document_id AND d.deleted_at IS NULL JOIN blocks host ON host.id=ri.host_block_id AND host.deleted_at IS NULL WHERE ri.host_document_id=$id AND ri.deleted_at IS NULL";
        command.Parameters.AddWithValue("$id", hostDocumentId);
        var instances = new List<(string Id, string HostBlockId, string TargetDocumentId, string Title, string Mode, string? TargetBlockId, bool Broken)>();
        using (var reader = command.ExecuteReader()) while (reader.Read()) instances.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.IsDBNull(3) ? "已删除文档" : reader.GetString(3), reader.GetString(4), reader.IsDBNull(5) ? null : reader.GetString(5), reader.GetInt32(6) == 1));

        var result = new List<object>();
        foreach (var instance in instances)
        {
            var sourceBlocks = ReadReferenceBlocks(connection, instance.TargetDocumentId, instance.Id, instance.TargetBlockId);
            using var overrideCommand = connection.CreateCommand();
            overrideCommand.CommandText = "SELECT target_block_id, patch_json, base_revision FROM block_overrides WHERE reference_instance_id=$id AND status='active'";
            overrideCommand.Parameters.AddWithValue("$id", instance.Id);
            var overrides = new List<object>();
            using (var reader = overrideCommand.ExecuteReader()) while (reader.Read()) overrides.Add(new { targetBlockId = reader.GetString(0), patch = JsonDocument.Parse(reader.GetString(1)).RootElement.Clone(), baseRevision = reader.GetInt32(2) });

            using var hiddenCommand = connection.CreateCommand();
            hiddenCommand.CommandText = "SELECT target_block_id FROM instance_tree_operations WHERE reference_instance_id=$id AND operation='hide' AND status='active'";
            hiddenCommand.Parameters.AddWithValue("$id", instance.Id);
            var hidden = new List<string>();
            using (var reader = hiddenCommand.ExecuteReader()) while (reader.Read()) hidden.Add(reader.GetString(0));
            result.Add(new { id = instance.Id, hostBlockId = instance.HostBlockId, targetDocumentId = instance.TargetDocumentId, targetBlockId = instance.TargetBlockId, targetTitle = instance.Title, mode = instance.Mode == "live" ? "inline" : instance.Mode, broken = instance.Broken, blocks = sourceBlocks, overrides, hiddenBlockIds = hidden });
        }
        return result;
    }

    private static List<object> ReadReferenceBlocks(SqliteConnection connection, string targetDocumentId, string referenceInstanceId, string? targetBlockId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            WITH RECURSIVE target_tree(id) AS (
                SELECT $targetBlockId
                WHERE $targetBlockId IS NOT NULL
                UNION
                SELECT b.id FROM blocks b JOIN target_tree t ON b.parent_id=t.id
                WHERE b.document_id=$documentId AND b.scope_type='canonical' AND b.deleted_at IS NULL
            )
            SELECT b.id, CASE WHEN move.id IS NOT NULL THEN move.parent_block_id ELSE b.parent_id END,
                   COALESCE(move.position, b.position),
                   b.type, b.content_json, b.properties_json, b.revision, b.scope_type
            FROM blocks b
            LEFT JOIN instance_tree_operations move ON move.reference_instance_id=$referenceId
                AND move.operation='move' AND move.target_block_id=b.id AND move.status='active'
            WHERE b.document_id=$documentId AND b.scope_type='canonical' AND b.deleted_at IS NULL
              AND ($targetBlockId IS NULL OR b.id IN (SELECT id FROM target_tree))
            UNION ALL
            SELECT b.id, b.parent_id, b.position, b.type, b.content_json, b.properties_json,
                   b.revision, b.scope_type
            FROM blocks b
            WHERE b.scope_type='reference_instance' AND b.scope_id=$referenceId AND b.deleted_at IS NULL
            ORDER BY 3
            """;
        command.Parameters.AddWithValue("$documentId", targetDocumentId);
        command.Parameters.AddWithValue("$referenceId", referenceInstanceId);
        command.Parameters.AddWithValue("$targetBlockId", (object?)targetBlockId ?? DBNull.Value);
        using var reader = command.ExecuteReader();
        var blocks = new List<object>();
        while (reader.Read()) blocks.Add(new
        {
            id = reader.GetString(0), parentId = reader.IsDBNull(1) ? null : reader.GetString(1), position = reader.GetString(2),
            type = reader.GetString(3), content = JsonDocument.Parse(reader.GetString(4)).RootElement.Clone(),
            properties = JsonDocument.Parse(reader.GetString(5)).RootElement.Clone(), revision = reader.GetInt32(6),
            scopeType = reader.GetString(7)
        });
        return blocks;
    }

    private static object BlockPayload(SqliteDataReader reader) => new
    {
        id = reader.GetString(0), parentId = reader.IsDBNull(1) ? null : reader.GetString(1), position = reader.GetString(2),
        type = reader.GetString(3), content = JsonDocument.Parse(reader.GetString(4)).RootElement.Clone(),
        properties = JsonDocument.Parse(reader.GetString(5)).RootElement.Clone(), revision = reader.GetInt32(6)
    };

    private List<Note> ReadDocuments()
    {
        using var connection = OpenConnection();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT id, title, is_sticky, updated_at, client_version, workspace_id FROM documents WHERE deleted_at IS NULL ORDER BY updated_at DESC";
        using var reader = command.ExecuteReader();
        var notes = new List<Note>();
        while (reader.Read()) notes.Add(new Note { Id = reader.GetString(0), Title = reader.GetString(1), IsSticky = reader.GetInt64(2) == 1, UpdatedAt = DateTime.Parse(reader.GetString(3), null, System.Globalization.DateTimeStyles.RoundtripKind), ClientVersion = reader.GetInt64(4), WorkspaceId = reader.IsDBNull(5) ? null : reader.GetString(5) });
        return notes;
    }

    private void RefreshNotes() => _notes = ReadDocuments();

    private static BlockRecord NewBlock(string type, string text) => new()
    {
        Type = type,
        Content = JsonSerializer.SerializeToElement(new { text, html = WebUtility.HtmlEncode(text), @checked = false }),
        Properties = JsonSerializer.SerializeToElement(new { })
    };

    private static void InsertDocument(SqliteConnection connection, SqliteTransaction transaction, Note note)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "INSERT INTO documents (id,title,is_sticky,workspace_id,created_at,updated_at) VALUES ($id,$title,$sticky,$workspaceId,$now,$updatedAt)";
        command.Parameters.AddWithValue("$id", note.Id);
        command.Parameters.AddWithValue("$title", note.Title);
        command.Parameters.AddWithValue("$sticky", note.IsSticky ? 1 : 0);
        command.Parameters.AddWithValue("$workspaceId", (object?)note.WorkspaceId ?? DBNull.Value);
        command.Parameters.AddWithValue("$now", UtcNow());
        command.Parameters.AddWithValue("$updatedAt", note.UpdatedAt.ToUniversalTime().ToString("O"));
        command.ExecuteNonQuery();
    }

    private static void InsertBlock(SqliteConnection connection, SqliteTransaction transaction, string documentId, BlockRecord block)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "INSERT INTO blocks (id,document_id,parent_id,position,type,content_json,properties_json,created_at,updated_at) VALUES ($id,$documentId,$parentId,$position,$type,$content,$properties,$now,$now)";
        command.Parameters.AddWithValue("$id", block.Id);
        command.Parameters.AddWithValue("$documentId", documentId);
        command.Parameters.AddWithValue("$parentId", (object?)block.ParentId ?? DBNull.Value);
        command.Parameters.AddWithValue("$position", block.Position);
        command.Parameters.AddWithValue("$type", block.Type);
        command.Parameters.AddWithValue("$content", block.Content.GetRawText());
        command.Parameters.AddWithValue("$properties", block.Properties.GetRawText());
        command.Parameters.AddWithValue("$now", UtcNow());
        command.ExecuteNonQuery();
    }

    private static bool TableExists(SqliteConnection connection, string table)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=$name)";
        command.Parameters.AddWithValue("$name", table);
        return Convert.ToInt32(command.ExecuteScalar()) == 1;
    }

    private static string GetDefaultWorkspaceId(SqliteConnection connection, SqliteTransaction transaction)
    {
        using var find = connection.CreateCommand();
        find.Transaction = transaction;
        find.CommandText = "SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1";
        var existing = find.ExecuteScalar() as string;
        if (!string.IsNullOrWhiteSpace(existing)) return existing;
        var workspace = new Workspace { Name = "默认工作区" };
        InsertWorkspace(connection, transaction, workspace);
        return workspace.Id;
    }

    private static string GetDefaultBookmarkId(SqliteConnection connection, SqliteTransaction transaction, string workspaceId)
    {
        using var find = connection.CreateCommand();
        find.Transaction = transaction;
        find.CommandText = "SELECT id FROM bookmarks WHERE workspace_id=$workspaceId AND deleted_at IS NULL ORDER BY position LIMIT 1";
        find.Parameters.AddWithValue("$workspaceId", workspaceId);
        var existing = find.ExecuteScalar() as string;
        if (!string.IsNullOrWhiteSpace(existing)) return existing;
        var bookmark = new Bookmark { WorkspaceId = workspaceId, Name = "未分类", Color = "#3B82F6" };
        InsertBookmark(connection, transaction, bookmark);
        return bookmark.Id;
    }

    private static string GetNextBookmarkPosition(SqliteConnection connection, SqliteTransaction transaction, string workspaceId)
    {
        using var find = connection.CreateCommand();
        find.Transaction = transaction;
        find.CommandText = "SELECT COALESCE(MAX(CAST(position AS INTEGER)), 0) + 1000 FROM bookmarks WHERE workspace_id=$workspaceId";
        find.Parameters.AddWithValue("$workspaceId", workspaceId);
        return Convert.ToInt64(find.ExecuteScalar()).ToString("D8");
    }

    private static void InsertWorkspace(SqliteConnection connection, SqliteTransaction transaction, Workspace workspace)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "INSERT INTO workspaces (id,name,root_path,created_at,updated_at) VALUES ($id,$name,$rootPath,$now,$now)";
        command.Parameters.AddWithValue("$id", workspace.Id);
        command.Parameters.AddWithValue("$name", workspace.Name);
        command.Parameters.AddWithValue("$rootPath", (object?)workspace.RootPath ?? DBNull.Value);
        command.Parameters.AddWithValue("$now", UtcNow());
        command.ExecuteNonQuery();
    }

    private static void InsertBookmark(SqliteConnection connection, SqliteTransaction transaction, Bookmark bookmark)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "INSERT INTO bookmarks (id,workspace_id,name,color,position,created_at,updated_at) VALUES ($id,$workspaceId,$name,$color,$position,$now,$now)";
        command.Parameters.AddWithValue("$id", bookmark.Id);
        command.Parameters.AddWithValue("$workspaceId", bookmark.WorkspaceId);
        command.Parameters.AddWithValue("$name", bookmark.Name);
        command.Parameters.AddWithValue("$color", NormalizeColor(bookmark.Color));
        command.Parameters.AddWithValue("$position", bookmark.Position);
        command.Parameters.AddWithValue("$now", UtcNow());
        command.ExecuteNonQuery();
    }

    private static void LinkDocumentBookmark(SqliteConnection connection, SqliteTransaction transaction, string documentId, string bookmarkId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "INSERT OR IGNORE INTO document_bookmarks (document_id,bookmark_id,created_at) VALUES ($documentId,$bookmarkId,$now)";
        command.Parameters.AddWithValue("$documentId", documentId);
        command.Parameters.AddWithValue("$bookmarkId", bookmarkId);
        command.Parameters.AddWithValue("$now", UtcNow());
        command.ExecuteNonQuery();
    }

    private static string NormalizeColor(string? color) => !string.IsNullOrWhiteSpace(color) && Regex.IsMatch(color, "^#[0-9a-fA-F]{6}$") ? color : "#3B82F6";

    private SqliteConnection OpenConnection()
    {
        var connection = new SqliteConnection($"Data Source={_databasePath}");
        try
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;";
            command.ExecuteNonQuery();
            return connection;
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }

    private static string UtcNow() => DateTime.UtcNow.ToString("O");
}
