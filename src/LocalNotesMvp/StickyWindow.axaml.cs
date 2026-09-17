using System.Text.Json;
using Avalonia.Controls;
using AvaloniaWebView;
using WebViewCore.Events;

namespace LocalNotesMvp;

public partial class StickyWindow : Window
{
    private readonly NoteStore _store;
    private readonly Note _note;
    private readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = true };
    private bool _closing;
    private bool _closePending;
    private bool _editorReady;
    private readonly EditorFlushCoordinator _flush = new();

    public StickyWindow() : this(new NoteStore(), new Note { IsSticky = true })
    {
    }

    public StickyWindow(NoteStore store, Note note)
    {
        _store = store; _note = note;
        InitializeComponent();
        Closing += StickyWindowClosing;
        EditorView.WebMessageReceived += OnMessage;
        EditorView.NavigationCompleted += OnNavigationCompleted;
        EditorView.HtmlContent = EditorPage.Load();
    }

    private async void StickyWindowClosing(object? sender, WindowClosingEventArgs e)
    {
        if (_closing) return;
        e.Cancel = true;
        if (_closePending) return;
        _closePending = true;
        try
        {
            if (_editorReady && !await _flush.FlushAsync(async requestId =>
                await EditorView.ExecuteScriptAsync($"window.localNotesFlush?.({JsonSerializer.Serialize(requestId)});"))) return;
            _closing = true;
            Close();
        }
        finally { _closePending = false; }
    }

    private async void OnNavigationCompleted(object? sender, WebViewUrlLoadedEventArg e)
    {
        _editorReady = true;
        var payload = JsonSerializer.Serialize(new { type = "load-state", state = _store.GetEditorState(_note.Id) }, _json);
        await EditorView.ExecuteScriptAsync($"window.dispatchEvent(new MessageEvent('message', {{ data: {JsonSerializer.Serialize(payload)} }}));");
    }

    private void OnMessage(object? sender, WebViewMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = ParseWebMessage(e.Message);
            if (_flush.TryHandle(doc.RootElement)) return;
            var type = doc.RootElement.GetProperty("type").GetString();
            if (type == "editor-command")
            {
                var requestId = doc.RootElement.GetProperty("requestId").GetString();
                try
                {
                    if (doc.RootElement.GetProperty("sourceDocumentId").GetString() != _note.Id) throw new InvalidOperationException("Document mismatch.");
                    var result = _store.ExecuteEditorCommand(_note.Id, doc.RootElement);
                    SendClientMessage(new { type = "command-ack", requestId, documentId = _note.Id, state = result });
                }
                catch (Exception error) { SendClientMessage(new { type = "command-nack", requestId, documentId = _note.Id, error = error.Message }); }
                return;
            }
            switch (type)
            {
                case "save-transaction":
                    var saveTransaction = doc.RootElement.Deserialize<SaveTransactionRequest>(_json);
                    if (saveTransaction is null || saveTransaction.DocumentId != _note.Id)
                        throw new InvalidOperationException("Save transaction document ID mismatch.");
                    var savedVersion = _store.SaveTransaction(saveTransaction);
                    SendClientMessage(new { type = "save-ack", documentId = _note.Id, mutationId = saveTransaction.MutationId, clientVersion = savedVersion });
                    break;
                case "reload-state":
                    OnNavigationCompleted(null, null!);
                    break;
                case "save-document":
                    var request = doc.RootElement.Deserialize<SaveDocumentRequest>(_json);
                    if (request is not null) _store.SaveDocument(_note.Id, request);
                    break;
                case "save-override":
                    var overrideRequest = doc.RootElement.Deserialize<SaveOverrideRequest>(_json);
                    if (overrideRequest is not null) _store.SaveOverride(overrideRequest);
                    break;
                case "save-instance-block":
                    var instanceBlockRequest = doc.RootElement.Deserialize<SaveInstanceBlockRequest>(_json);
                    if (instanceBlockRequest is not null) _store.SaveInstanceBlock(instanceBlockRequest);
                    break;
                case "move-reference-block":
                    var moveRequest = doc.RootElement.Deserialize<MoveReferencedBlockRequest>(_json);
                    if (moveRequest is not null) _store.MoveReferencedBlock(moveRequest);
                    break;
                case "delete-instance-block":
                    _store.DeleteInstanceBlock(doc.RootElement.GetProperty("referenceInstanceId").GetString()!, doc.RootElement.GetProperty("blockId").GetString()!);
                    OnNavigationCompleted(null, null!);
                    break;
                case "create-reference":
                    _store.CreateReference(_note.Id, doc.RootElement.GetProperty("hostBlockId").GetString()!, doc.RootElement.GetProperty("targetDocumentId").GetString()!, doc.RootElement.TryGetProperty("targetBlockId", out var targetBlockId) ? targetBlockId.GetString() : null);
                    OnNavigationCompleted(null, null!);
                    break;
                case "hide-reference-block":
                    _store.HideReferencedBlock(doc.RootElement.GetProperty("referenceInstanceId").GetString()!, doc.RootElement.GetProperty("targetBlockId").GetString()!);
                    OnNavigationCompleted(null, null!);
                    break;
                case "reset-override":
                    _store.ResetOverride(doc.RootElement.GetProperty("referenceInstanceId").GetString()!, doc.RootElement.GetProperty("targetBlockId").GetString()!);
                    OnNavigationCompleted(null, null!);
                    break;
            }
        }
        catch (Exception exception)
        {
            using var failedDoc = ParseWebMessage(e.Message);
            if (failedDoc.RootElement.TryGetProperty("type", out var failedType) && failedType.GetString() == "save-transaction" &&
                failedDoc.RootElement.TryGetProperty("mutationId", out var failedMutation))
            {
                SendClientMessage(new { type = "save-nack", mutationId = failedMutation.GetString(), error = exception.Message });
            }
            _ = EditorView.ExecuteScriptAsync($"window.localNotesError?.({JsonSerializer.Serialize(exception.Message)});");
        }
    }

    private void SendClientMessage(object message)
    {
        var payload = JsonSerializer.Serialize(JsonSerializer.Serialize(message));
        _ = EditorView.ExecuteScriptAsync($"window.dispatchEvent(new MessageEvent('message', {{ data: {payload} }}));");
    }

    private static JsonDocument ParseWebMessage(string message)
    {
        var document = JsonDocument.Parse(message);
        if (document.RootElement.ValueKind != JsonValueKind.String) return document;
        var nested = document.RootElement.GetString();
        document.Dispose();
        if (string.IsNullOrWhiteSpace(nested)) throw new JsonException("Empty WebView message.");
        return JsonDocument.Parse(nested);
    }
}
