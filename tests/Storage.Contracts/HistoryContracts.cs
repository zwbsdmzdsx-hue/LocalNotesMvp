using System.Text.Json;
using LocalNotesMvp;

internal static class HistoryContracts
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
    private static JsonElement Json(object o) => JsonSerializer.SerializeToElement(o, Options);
    private static void Check(bool condition, string message) { if (!condition) throw new Exception("History: " + message); }
    public static void Run()
    {
        var path = Path.Combine(Path.GetTempPath(), $"local-notes-history-{Guid.NewGuid():N}.db");
        var store = new NoteStore(path); store.Load();
        var note = store.Create(); var source = store.Create();
        JsonElement State() => Json(store.GetEditorState(note.Id));
        JsonElement History() => Json(store.GetDocumentHistory(note.Id));
        long Version() => State().GetProperty("note").GetProperty("clientVersion").GetInt64();
        BlockRecord Block(string id, string text) => new() { Id = id, Content = Json(new { text, html = text }), Properties = Json(new { }) };
        void Save(string text, string group) => store.SaveTransaction(new() { DocumentId = note.Id, MutationId = Guid.NewGuid().ToString(), ClientVersion = Version() + 1, HistoryGroup = group, Title = text, Blocks = [Block("history-body", text)] });
        void Move(string operation, string? entryId = null) => store.ExecuteEditorCommand(note.Id, Json(new { operation, entryId, expectedVersion = Version() }));
        string Text() => State().GetProperty("blocks")[0].GetProperty("content").GetProperty("text").GetString()!;
        Save("one", "burst-1"); Save("one typed", "burst-1");
        Check(History().GetProperty("entries").GetArrayLength() == 2, "typing should coalesce with initial state retained");
        Save("two", "burst-2");
        var secondId = History().GetProperty("currentId").GetString();
        var version = Version(); Move("history-undo");
        Check(Text() == "one typed" && Version() == version + 1, "undo must commit a new version");
        Move("history-redo"); Check(Text() == "two", "redo");
        Move("history-undo"); Save("branch", "burst-1");
        Check(!History().GetProperty("canRedo").GetBoolean(), "editing after undo clears redo");
        Check(History().GetProperty("entries").EnumerateArray().Any(e => e.GetProperty("id").GetString() == secondId), "abandoned version is retained");
        Move("history-restore", secondId); Check(Text() == "two", "restore archived version");
        Move("history-undo"); Check(Text() == "branch", "restore is undoable");
        var before = State().GetRawText();
        try { store.ExecuteEditorCommand(note.Id, Json(new { operation = "history-restore", entryId = secondId, expectedVersion = 0 })); throw new Exception("stale restore accepted"); }
        catch (InvalidOperationException) { }
        Check(State().GetRawText() == before, "stale history request changed state");
        try { store.ExecuteEditorCommand(source.Id, Json(new { operation = "history-restore", entryId = secondId, expectedVersion = 0 })); throw new Exception("foreign history accepted"); }
        catch (InvalidOperationException) { }
        var receipt = new SaveTransactionRequest { DocumentId = note.Id, MutationId = "history-idempotent", ClientVersion = Version() + 1, Title = "idempotent", Blocks = [Block("history-body", "receipt")] };
        var ack = store.SaveTransaction(receipt); var historyBefore = History().GetRawText();
        Check(store.SaveTransaction(receipt) == ack && History().GetRawText() == historyBefore, "duplicate must not create history");

        store.SaveDocument(source.Id, new() { Title = "Source", Blocks = [Block("history-source", "original source")] });
        store.CreateReference(note.Id, "history-body", source.Id, "history-source");
        var reference = State().GetProperty("references")[0].GetProperty("id").GetString()!;
        store.SaveOverride(new() { ReferenceInstanceId = reference, TargetBlockId = "history-source", Content = Json(new { text = "local override", html = "local override" }), Properties = Json(new { }) });
        store.SaveInstanceBlock(new() { ReferenceInstanceId = reference, Block = Block("history-instance", "local addition") });
        store.MoveReferencedBlock(new() { ReferenceInstanceId = reference, TargetBlockId = "history-source", Position = "99999000" });
        var full = History().GetProperty("currentId").GetString();
        store.ResetReference(reference);
        // Recreate an override with a different internal row ID, then restore the older row.
        store.SaveOverride(new() { ReferenceInstanceId = reference, TargetBlockId = "history-source", Content = Json(new { text = "replacement", html = "replacement" }), Properties = Json(new { }) });
        store.SaveDocument(source.Id, new() { Title = "Source", Blocks = [Block("history-source", "latest source")] });
        Move("history-restore", full);
        var restored = State().GetProperty("references")[0];
        Check(restored.GetProperty("overrides")[0].GetProperty("patch").GetProperty("content").GetProperty("text").GetString() == "local override", "override restored");
        Check(restored.GetProperty("blocks").EnumerateArray().Any(b => b.GetProperty("id").GetString() == "history-instance"), "instance addition restored");
        Check(restored.GetProperty("blocks").EnumerateArray().Single(b => b.GetProperty("id").GetString() == "history-source").GetProperty("position").GetString() == "99999000", "instance move restored");
        Check(Json(store.GetEditorState(source.Id)).GetProperty("blocks")[0].GetProperty("content").GetProperty("text").GetString() == "latest source", "source content must never be restored");
        store.ResetOverride(reference, "history-source");
        Check(State().GetProperty("references")[0].GetProperty("blocks").EnumerateArray().Single(b => b.GetProperty("id").GetString() == "history-source").GetProperty("content").GetProperty("text").GetString() == "latest source", "inheritance reads latest source");
        var reopened = new NoteStore(path); reopened.Load();
        Check(Json(reopened.GetDocumentHistory(note.Id)).GetRawText() == History().GetRawText(), "history survives reopen");
        // Bound storage while retaining the active path.
        for (var i = 0; i < 85; i++) Save("bounded " + i, Guid.NewGuid().ToString());
        Check(History().GetProperty("entries").GetArrayLength() == 80, "history retention cap");
        Move("history-undo"); Check(Text() == "bounded 83", "undo after pruning");

        var tree = store.Create();
        store.SaveDocument(tree.Id, new() { Title = "Tree", Blocks = [
            new() { Id = "tree-root-a", Position = "00001000", Content = Json(new { text = "A", html = "A" }), Properties = Json(new { }) },
            new() { Id = "tree-child-a", ParentId = "tree-root-a", Position = "00001000", Content = Json(new { text = "A1", html = "A1" }), Properties = Json(new { }) },
            new() { Id = "tree-child-b", ParentId = "tree-root-a", Position = "00002000", Content = Json(new { text = "A2", html = "A2" }), Properties = Json(new { }) },
            new() { Id = "tree-root-b", Position = "00001500", Content = Json(new { text = "B", html = "B" }), Properties = Json(new { }) }
        ] });
        var orderedIds = Json(store.GetEditorState(tree.Id)).GetProperty("blocks").EnumerateArray().Select(block => block.GetProperty("id").GetString()).ToArray();
        Check(orderedIds.SequenceEqual(new[] { "tree-root-a", "tree-child-a", "tree-child-b", "tree-root-b" }), "tree order must not interleave roots and children");

        var cascadeSource = store.Create();
        store.SaveDocument(cascadeSource.Id, new() { Title = "Cascade source", Blocks = [Block("cascade-source", "source")] });
        store.SaveDocument(tree.Id, new() { Title = "Tree", Blocks = [Block("cascade-host", "host")] });
        store.CreateReference(tree.Id, "cascade-host", cascadeSource.Id, "cascade-source");
        Check(Json(store.GetEditorState(tree.Id)).GetProperty("references").GetArrayLength() == 1, "reference setup");
        store.SaveTransaction(new() { DocumentId = tree.Id, MutationId = "delete-reference-host", ClientVersion = 1,
            HistoryGroup = "delete-reference-host", Title = "Tree", Blocks = [] });
        Check(Json(store.GetEditorState(tree.Id)).GetProperty("references").GetArrayLength() == 0, "deleting host block must delete reference relation");
        store.ExecuteEditorCommand(tree.Id, Json(new { operation = "history-undo", expectedVersion = 1 }));
        Check(Json(store.GetEditorState(tree.Id)).GetProperty("references").GetArrayLength() == 1, "undo must restore host block and reference relation");
        Console.WriteLine("PASS transactional history: grouping, branches, restore, ownership, monotonic versions, references, reopen and retention");
    }
}
