using System.Text.Json;
using LocalNotesMvp;

static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);
static JsonElement State(NoteStore store, string id) => Json(store.GetEditorState(id));
static BlockRecord Block(string id, string text) => new() { Id = id, Content = Json(new { text, html = text }), Properties = Json(new { }) };

Console.WriteLine("Existing storage self-test: " + StorageSelfTest.Run());
var path = Path.Combine(Path.GetTempPath(), $"local-notes-contract-{Guid.NewGuid():N}.db");
var store = new NoteStore(path);
store.Load();
var a = store.Notes[0];
var b = store.Create();
store.SaveDocument(a.Id, new() { Title = "Alpha", Blocks = [Block("a1", "initial")] });
store.SaveDocument(b.Id, new() { Title = "Beta", Blocks = [Block("b1", "protected")] });
using var cases = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "save-cases.json")));
foreach (var test in cases.RootElement.EnumerateArray())
{
    var text = test.TryGetProperty("text", out var textValue) ? textValue.GetString()! : "invalid";
    List<BlockRecord>? blocks = [Block("a1", text)];
    if (test.TryGetProperty("blocks", out var input))
        blocks = input.ValueKind == JsonValueKind.Null ? null : input.EnumerateArray().Select(item => {
            var block = Block(item.GetProperty("id").GetString()!, text);
            if (item.TryGetProperty("parentId", out var parent)) block.ParentId = parent.GetString();
            if (item.TryGetProperty("content", out var content)) block.Content = content.Clone();
            if (item.TryGetProperty("properties", out var properties)) block.Properties = properties.Clone();
            if (item.TryGetProperty("omitContent", out _)) block.Content = default;
            if (item.TryGetProperty("omitProperties", out _)) block.Properties = default;
            return block;
        }).ToList();
    var before = State(store, a.Id).GetRawText();
    long? ack = null;
    try { ack = store.SaveTransaction(new() {
        DocumentId = a.Id, MutationId = test.GetProperty("mutationId").GetString()!,
        ClientVersion = test.GetProperty("version").GetInt64(), Title = "Alpha", Blocks = blocks!
    }); } catch (InvalidOperationException) { }
    var name = test.GetProperty("name").GetString();
    Check(ack.HasValue == test.GetProperty("ok").GetBoolean(), name + ": wrong acceptance");
    if (ack.HasValue) Check(ack == test.GetProperty("ack").GetInt64(), name + ": wrong ACK");
    else Check(State(store, a.Id).GetRawText() == before, name + ": rejection changed state");
    var reopened = new NoteStore(path); reopened.Load();
    Check(State(reopened, a.Id).GetProperty("blocks")[0].GetProperty("content").GetProperty("text").GetString() == test.GetProperty("expectedText").GetString(), name + ": incorrect persisted text");
    Check(State(reopened, b.Id).GetProperty("blocks")[0].GetProperty("content").GetProperty("text").GetString() == "protected", name + ": corrupted another document");
    Console.WriteLine("PASS " + name);
}

var markdownNote = store.Create();
const string markdownSource = "# Markdown 标题\n\n**粗体** 与 [[Beta]]\n\n![[#^reference-host]]";
store.SaveDocument(markdownNote.Id, new() { Title = "Markdown", Blocks = [new() {
    Id = "markdown-body", Content = Json(new { text = "Markdown 标题 粗体 与 Beta", html = "<h1>Markdown 标题</h1>", markdown = markdownSource }), Properties = Json(new { })
}] });
var markdownReopened = new NoteStore(path); markdownReopened.Load();
var persistedMarkdown = State(markdownReopened, markdownNote.Id).GetProperty("blocks")[0].GetProperty("content").GetProperty("markdown").GetString();
Check(persistedMarkdown == markdownSource, "Markdown source did not survive SQLite reopen");
Console.WriteLine("PASS Markdown content JSON survives SQLite reopen");

// Ownership is retained after soft deletion and cannot be bypassed through the legacy save path.
store.SaveDocument(b.Id, new() { Title = "Beta", Blocks = [] });
try { store.SaveDocument(a.Id, new() { Blocks = [Block("b1", "resurrect foreign")] }); throw new Exception("Foreign deleted block accepted"); }
catch (InvalidOperationException) { }
store.SaveDocument(b.Id, new() { Title = "Beta", Blocks = [Block("b1", "protected")] });
store.CreateReference(a.Id, "a2", b.Id, "b1");
var referenceId = State(store, a.Id).GetProperty("references")[0].GetProperty("id").GetString()!;
store.SaveInstanceBlock(new() { ReferenceInstanceId = referenceId, Block = Block("local-instance", "local") });
try { store.SaveDocument(a.Id, new() { Blocks = [Block("local-instance", "canonical")] }); throw new Exception("Instance block accepted as canonical"); }
catch (InvalidOperationException) { }
var controller = new EditorHostController(store);
var mismatch = await controller.HandleAsync(new() { ProtocolVersion = 1, RequestId = "mismatch", Kind = "saveDocument", SourceDocumentId = a.Id,
    Payload = Json(new { documentId = b.Id, mutationId = "wrong-owner", clientVersion = 99, title = "corrupt", blocks = Array.Empty<object>() }) });
Check(!mismatch.Ok && mismatch.Error?.Code == "document_mismatch", "Controller accepted mismatched owner");

// Flush correlation, concurrent close/navigation, NACK, timeout, and retry without a WebView.
var flush = new EditorFlushCoordinator(TimeSpan.FromMilliseconds(80));
string? requestId = null;
var first = flush.FlushAsync(id => { requestId = id; return Task.CompletedTask; });
var same = flush.FlushAsync(_ => throw new Exception("Second dispatch"));
Check(ReferenceEquals(first, same), "Concurrent drains must share a task");
flush.TryHandle(Json(new { type = "editor-flush-complete", requestId = "stale" }));
Check(!first.IsCompleted, "Stale ACK completed drain");
flush.TryHandle(Json(new { type = "editor-flush-failed", requestId }));
Check(!await first, "NACK allowed close");
var retry = flush.FlushAsync(id => { requestId = id; return Task.CompletedTask; });
flush.TryHandle(Json(new { type = "editor-flush-complete", requestId }));
Check(await retry, "Retry did not complete");
Check(!await flush.FlushAsync(_ => Task.CompletedTask), "Timeout allowed close");
Console.WriteLine("PASS ownership, protocol and flush coordinator contracts");
Console.WriteLine("Database: " + path);
HistoryContracts.Run();
