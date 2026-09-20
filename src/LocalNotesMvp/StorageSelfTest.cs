using System.Text.Json;

namespace LocalNotesMvp;

internal static class StorageSelfTest
{
    public static string Run()
    {
        var path = Path.Combine(Path.GetTempPath(), $"local-notes-{Guid.NewGuid():N}.db");
        var store = new NoteStore(path);
        store.Load();
        var source = store.Notes[0];
        var target = store.Create();
        var sourceBlockId = FirstBlockId(store, source.Id);
        var targetBlockId = FirstBlockId(store, target.Id);
        var emptyProperties = JsonSerializer.SerializeToElement(new { });

        store.SaveDocument(source.Id, new SaveDocumentRequest
        {
            Title = source.Title,
            Blocks =
            [
                new BlockRecord
                {
                    Id = sourceBlockId,
                    Position = "00001000",
                    Type = "paragraph",
                    Content = JsonSerializer.SerializeToElement(new { text = $"关联 [[{target.Title}]]", html = $"关联 [[{target.Title}]]" }),
                    Properties = JsonSerializer.SerializeToElement(new { background = "rgb(255, 242, 168)", textColor = "rgb(23, 92, 211)" })
                }
            ]
        });
        store.CreateReference(source.Id, sourceBlockId, target.Id);
        var referenceId = ReferenceId(store, source.Id);
        store.SetReferenceMode(new SetReferenceModeRequest { ReferenceInstanceId = referenceId, Mode = "collapsed" });
        store.SaveOverride(new SaveOverrideRequest
        {
            ReferenceInstanceId = referenceId,
            TargetBlockId = targetBlockId,
            Content = JsonSerializer.SerializeToElement(new { text = "实例专属内容", html = "<b>实例专属内容</b>" }),
            Properties = JsonSerializer.SerializeToElement(new { background = "#fff2a8" })
        });
        store.SaveInstanceBlock(new SaveInstanceBlockRequest
        {
            ReferenceInstanceId = referenceId,
            Block = new BlockRecord
            {
                ParentId = targetBlockId,
                Position = "00002000",
                Content = JsonSerializer.SerializeToElement(new { text = "引用中新增的子块", html = "引用中新增的子块" }),
                Properties = emptyProperties
            }
        });
        store.MoveReferencedBlock(new MoveReferencedBlockRequest
        {
            ReferenceInstanceId = referenceId,
            TargetBlockId = targetBlockId,
            Position = "00003000"
        });
        store.HideReferencedBlock(referenceId, targetBlockId);

        var counts = store.GetTableCounts();
        var expected = new Dictionary<string, long>
        {
            ["documents"] = 2, ["blocks"] = 3, ["links"] = 1,
            ["reference_instances"] = 1, ["block_overrides"] = 1, ["instance_tree_operations"] = 3
        };
        foreach (var item in expected)
            if (counts[item.Key] != item.Value) throw new InvalidOperationException($"{item.Key}: expected {item.Value}, got {counts[item.Key]}");

        var duplicateTitleNote = store.Create();
        store.SaveDocument(duplicateTitleNote.Id, new SaveDocumentRequest
        {
            Title = target.Title,
            Blocks = [new BlockRecord
            {
                Id = FirstBlockId(store, duplicateTitleNote.Id), Position = "00001000", Type = "paragraph",
                Content = JsonSerializer.SerializeToElement(new { text = "同名文档", html = "同名文档" }), Properties = emptyProperties
            }]
        });

        var reloadedStore = new NoteStore(path);
        reloadedStore.Load();
        using var sourceState = JsonDocument.Parse(JsonSerializer.Serialize(reloadedStore.GetEditorState(source.Id)));
        var savedProperties = sourceState.RootElement.GetProperty("blocks")[0].GetProperty("properties");
        if (savedProperties.GetProperty("background").GetString() != "rgb(255, 242, 168)" ||
            savedProperties.GetProperty("textColor").GetString() != "rgb(23, 92, 211)")
            throw new InvalidOperationException("Block style properties did not survive a store reload.");
        var sourceText = sourceState.RootElement.GetProperty("blocks")[0].GetProperty("content").GetProperty("text").GetString();
        if (sourceText != $"关联 [[{target.Title}]]")
            throw new InvalidOperationException("Source document text did not survive a store reload.");
        using var targetDocumentState = JsonDocument.Parse(JsonSerializer.Serialize(reloadedStore.GetEditorState(target.Id)));
        var targetText = targetDocumentState.RootElement.GetProperty("blocks")[0].GetProperty("content").GetProperty("text").GetString();
        if (!string.IsNullOrEmpty(targetText))
            throw new InvalidOperationException("Separate document content was unexpectedly overwritten.");
        var referenceBlocks = sourceState.RootElement.GetProperty("references")[0].GetProperty("blocks");
        if (referenceBlocks.GetArrayLength() != 2)
            throw new InvalidOperationException($"Expected a canonical and an instance block, got {referenceBlocks.GetArrayLength()}.");
        if (sourceState.RootElement.GetProperty("references")[0].GetProperty("mode").GetString() != "collapsed")
            throw new InvalidOperationException("Reference display mode did not survive a store reload.");

        using var targetState = JsonDocument.Parse(JsonSerializer.Serialize(reloadedStore.GetEditorState(target.Id)));
        var notices = targetState.RootElement.GetProperty("overrideNotices");
        if (notices.GetArrayLength() != 4)
            throw new InvalidOperationException($"Expected four override notices, got {notices.GetArrayLength()}.");

        var transactionBlock = new BlockRecord
        {
            Id = sourceBlockId,
            Position = "00001000",
            Type = "paragraph",
            Content = JsonSerializer.SerializeToElement(new { text = "事务版本 1", html = "事务版本 1" }),
            Properties = emptyProperties
        };
        var firstTransaction = new SaveTransactionRequest
        {
            DocumentId = source.Id, MutationId = "self-test-mutation-1", ClientVersion = reloadedStore.Find(source.Id)!.ClientVersion + 1,
            Title = source.Title, Blocks = [transactionBlock]
        };
        var firstVersion = reloadedStore.SaveTransaction(firstTransaction);
        if (reloadedStore.SaveTransaction(firstTransaction) != firstVersion)
            throw new InvalidOperationException("Duplicate transaction was not idempotent.");
        transactionBlock.Content = JsonSerializer.SerializeToElement(new { text = "事务版本 2", html = "事务版本 2" });
        var secondVersion = reloadedStore.SaveTransaction(new SaveTransactionRequest
        {
            DocumentId = source.Id, MutationId = "self-test-mutation-2", ClientVersion = firstVersion + 1,
            Title = source.Title, Blocks = [transactionBlock]
        });
        if (secondVersion != firstVersion + 1) throw new InvalidOperationException("Transaction version did not advance.");
        var jumpedVersion = reloadedStore.SaveTransaction(new SaveTransactionRequest
        {
            DocumentId = source.Id, MutationId = "self-test-jumped-client-version", ClientVersion = 99,
            Title = source.Title, Blocks = [transactionBlock]
        });
        if (jumpedVersion != secondVersion + 1) throw new InvalidOperationException("A coalesced client version was not normalized.");
        var staleRejected = false;
        try
        {
            reloadedStore.SaveTransaction(new SaveTransactionRequest
            {
                DocumentId = source.Id, MutationId = "self-test-stale", ClientVersion = firstVersion,
                Title = source.Title, Blocks = [transactionBlock]
            });
        }
        catch (InvalidOperationException) { staleRejected = true; }
        if (!staleRejected) throw new InvalidOperationException("Stale transaction was accepted.");
        foreach (var mode in new[] { "inline", "collapsed", "link", "sidebar", "collapsed" })
        {
            reloadedStore.SetReferenceMode(new SetReferenceModeRequest { ReferenceInstanceId = referenceId, Mode = mode });
            var reopened = new NoteStore(path);
            reopened.Load();
            using var persisted = JsonDocument.Parse(JsonSerializer.Serialize(reopened.GetEditorState(source.Id)));
            if (persisted.RootElement.GetProperty("references")[0].GetProperty("mode").GetString() != mode)
                throw new InvalidOperationException($"Reference mode {mode} was not persisted after reopening SQLite.");
        }
        var embeddedNote = reloadedStore.Create();
        var ownerId = FirstBlockId(reloadedStore, embeddedNote.Id);
        var embeddedId = Guid.NewGuid().ToString("N");
        var anchorHtml = $"Before <span data-reference-host-id=\"{embeddedId}\"></span> After";
        reloadedStore.SaveDocument(embeddedNote.Id, new SaveDocumentRequest
        {
            Title = "Embedded reference persistence",
            Blocks = [
                new BlockRecord { Id = ownerId, Position = "00001000", Content = JsonSerializer.SerializeToElement(new { text = "Before  After", html = anchorHtml }), Properties = emptyProperties },
                new BlockRecord { Id = embeddedId, ParentId = ownerId, Position = "00002000", Type = "reference", Content = JsonSerializer.SerializeToElement(new { text = "", html = "" }), Properties = emptyProperties }
            ]
        });
        reloadedStore.CreateReference(embeddedNote.Id, embeddedId, target.Id, targetBlockId);
        var embeddedReferenceId = ReferenceId(reloadedStore, embeddedNote.Id);
        reloadedStore.SetReferenceMode(new SetReferenceModeRequest { ReferenceInstanceId = embeddedReferenceId, Mode = "collapsed" });
        var finalStore = new NoteStore(path);
        finalStore.Load();
        using var embeddedState = JsonDocument.Parse(JsonSerializer.Serialize(finalStore.GetEditorState(embeddedNote.Id)));
        var persistedBlocks = embeddedState.RootElement.GetProperty("blocks");
        if (persistedBlocks[0].GetProperty("content").GetProperty("html").GetString() != anchorHtml ||
            persistedBlocks[1].GetProperty("parentId").GetString() != ownerId ||
            embeddedState.RootElement.GetProperty("references")[0].GetProperty("mode").GetString() != "collapsed")
            throw new InvalidOperationException("Embedded reference placement or disclosure state was lost after SQLite reopen.");

        var databaseId = "self-test-database";
        var fieldId = "self-test-field";
        var databaseVersion = finalStore.Find(source.Id)!.ClientVersion + 1;
        var databaseMessage = JsonSerializer.SerializeToElement(new
        {
            operation = "create-database", databaseId, mutationId = "self-test-database-create", clientVersion = databaseVersion,
            database = new { id = databaseId, title = "自测表" },
            fields = new[] { new { id = fieldId, databaseId, key = "name", title = "名称", type = "text", position = "00001000" } }
        });
        finalStore.ExecuteEditorCommand(source.Id, databaseMessage);
        var recordMessage = JsonSerializer.SerializeToElement(new
        {
            operation = "upsert-database-record", databaseId, mutationId = "self-test-database-record", clientVersion = finalStore.Find(source.Id)!.ClientVersion + 1,
            record = new { id = "self-test-record", databaseId, position = "00001000", values = new Dictionary<string, object?> { ["name"] = "第一条" } }
        });
        finalStore.ExecuteEditorCommand(source.Id, recordMessage);
        var recordVersion = finalStore.Find(source.Id)!.ClientVersion;
        finalStore.ExecuteEditorCommand(source.Id, recordMessage);
        if (finalStore.Find(source.Id)!.ClientVersion != recordVersion) throw new InvalidOperationException("Duplicate database mutation was not idempotent.");
        using var databaseState = JsonDocument.Parse(JsonSerializer.Serialize(finalStore.GetEditorState(source.Id)));
        if (databaseState.RootElement.GetProperty("databaseRecords").GetProperty(databaseId).GetArrayLength() != 1)
            throw new InvalidOperationException("Database record did not persist.");
        var versionBeforeUndo = finalStore.Find(source.Id)!.ClientVersion;
        finalStore.ExecuteEditorCommand(source.Id, JsonSerializer.SerializeToElement(new { operation = "history-undo", expectedVersion = versionBeforeUndo }));
        using var undoneState = JsonDocument.Parse(JsonSerializer.Serialize(finalStore.GetEditorState(source.Id)));
        if (undoneState.RootElement.GetProperty("databaseRecords").GetProperty(databaseId).GetArrayLength() != 0)
            throw new InvalidOperationException("Database record undo did not restore the previous snapshot.");
        var versionBeforeRedo = finalStore.Find(source.Id)!.ClientVersion;
        finalStore.ExecuteEditorCommand(source.Id, JsonSerializer.SerializeToElement(new { operation = "history-redo", expectedVersion = versionBeforeRedo }));
        using var redoneState = JsonDocument.Parse(JsonSerializer.Serialize(finalStore.GetEditorState(source.Id)));
        if (redoneState.RootElement.GetProperty("databaseRecords").GetProperty(databaseId).GetArrayLength() != 1)
            throw new InvalidOperationException("Database record redo did not restore the record.");
        return JsonSerializer.Serialize(new { passed = true, counts });
    }

    private static string FirstBlockId(NoteStore store, string documentId)
    {
        using var state = JsonDocument.Parse(JsonSerializer.Serialize(store.GetEditorState(documentId)));
        return state.RootElement.GetProperty("blocks")[0].GetProperty("id").GetString()!;
    }

    private static string ReferenceId(NoteStore store, string documentId)
    {
        using var state = JsonDocument.Parse(JsonSerializer.Serialize(store.GetEditorState(documentId)));
        return state.RootElement.GetProperty("references")[0].GetProperty("id").GetString()!;
    }
}
