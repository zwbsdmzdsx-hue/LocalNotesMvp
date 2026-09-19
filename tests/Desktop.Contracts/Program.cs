using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using Avalonia.WebView.Desktop;
using AvaloniaWebView;
using LocalNotesMvp;

// Separate executable: the shipping windows and WebView are exercised unchanged.
internal static class Program
{
    private const string Marker = "sticky-contract-saved";

    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Length != 2 || args[0] is not ("write" or "read"))
            throw new ArgumentException("Usage: Desktop.Contracts <write|read> <temporary database path>");
        var database = Path.GetFullPath(args[1]);
        if (!database.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Desktop contracts require a database under the temporary directory.");
        Environment.SetEnvironmentVariable("LOCAL_NOTES_MVP_DB", database);
        Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--disable-gpu");
        return AppBuilder.Configure<App>().UsePlatformDetect().UseDesktopWebView()
            .AfterSetup(builder => Dispatcher.UIThread.Post(async () =>
            {
                var desktop = (IClassicDesktopStyleApplicationLifetime)builder.Instance!.ApplicationLifetime!;
                desktop.ShutdownMode = ShutdownMode.OnExplicitShutdown;
                var code = 0;
                try { await RunAsync(desktop.MainWindow!, database, args[0] == "read").WaitAsync(TimeSpan.FromSeconds(45)); }
                catch (Exception error) { Console.Error.WriteLine(error); code = 1; }
                finally { desktop.Shutdown(code); }
            })).StartWithClassicDesktopLifetime([]);
    }

    private static async Task UntilAsync(Func<Task<bool>> condition, string message)
    {
        for (var i = 0; i < 120; i++)
        {
            if (await condition()) return;
            await Task.Delay(50);
        }
        throw new Exception(message);
    }

    private static async Task<bool> EvaluateAsync(WebView view, string expression) =>
        (await view.ExecuteScriptAsync(expression)) == "true";

    private static async Task RunAsync(Window main, string database, bool readOnly)
    {
        var mainView = main.FindControl<WebView>("EditorView")!;
        await UntilAsync(() => EvaluateAsync(mainView, "!!document.querySelector('[data-own-block] .block-text')"), "Main editor did not load");
        if (!readOnly) await ExerciseHistoryAsync(mainView, "main-history-current");
        var store = new NoteStore(database); store.Load();
        var note = readOnly ? store.Notes.Single(n => n.IsSticky) : store.Create(true);
        var sticky = new StickyWindow(store, note);
        var closed = new TaskCompletionSource();
        sticky.Closed += (_, _) => closed.TrySetResult();
        sticky.Show(main);
        var view = sticky.FindControl<WebView>("EditorView")!;
        await UntilAsync(() => EvaluateAsync(view, "!!document.querySelector('[data-own-block] .block-text')"), "Sticky editor did not load");
        if (readOnly)
        {
            if (!await EvaluateAsync(view, $"document.querySelector('[data-own-block] .block-text').textContent === {JsonSerializer.Serialize(Marker)}"))
                throw new Exception("Second EXE process did not restore the saved sticky text");
            await CheckRestartHistoryAsync(view);
            sticky.Close();
            await closed.Task.WaitAsync(TimeSpan.FromSeconds(12));
            Console.WriteLine("PASS second EXE process restored sticky content");
            return;
        }

        // Hold the save before it reaches C#, then request native close. This models
        // a save still in flight and subsequently rejected by the host.
        await view.ExecuteScriptAsync("""
            window.contractSend = window.chrome.webview.postMessage.bind(window.chrome.webview);
            window.chrome.webview.postMessage = raw => {
              const message = JSON.parse(raw);
              if (message.type === 'save-transaction') window.contractPending = message;
              else window.contractSend(raw);
            };
            const edit = document.querySelector('[data-own-block] .block-text');
            edit.focus(); edit.textContent = 'recoverable sticky draft';
            edit.dispatchEvent(new Event('input', { bubbles: true }));
            """);
        await UntilAsync(() => EvaluateAsync(view, "!!window.contractPending"), "Input did not produce a save request");
        sticky.Close();
        await Task.Delay(100);
        if (!sticky.IsVisible || closed.Task.IsCompleted) throw new Exception("Sticky closed before save ACK");
        await view.ExecuteScriptAsync("""
            window.dispatchEvent(new MessageEvent('message', { data: {
              type: 'save-nack', mutationId: window.contractPending.mutationId, error: 'contract rejection'
            }}));
            """);
        await UntilAsync(() => EvaluateAsync(view, "document.querySelector('#status').textContent.includes('contract rejection')"), "Save rejection was not displayed");
        await Task.Delay(100);
        if (!sticky.IsVisible || closed.Task.IsCompleted) throw new Exception("Sticky closed after save NACK");
        if (!await EvaluateAsync(view, "document.querySelector('[data-own-block] .block-text').textContent === 'recoverable sticky draft'"))
            throw new Exception("NACK discarded editable draft");

        await view.ExecuteScriptAsync($$"""
            window.chrome.webview.postMessage = window.contractSend;
            const retry = document.querySelector('[data-own-block] .block-text');
            retry.textContent = {{JsonSerializer.Serialize(Marker)}};
            retry.dispatchEvent(new Event('input', { bubbles: true }));
            """);
        await UntilAsync(() => EvaluateAsync(view, "document.querySelector('#status').textContent.includes('已保存')"), "Retry did not receive save ACK");
        await ExerciseHistoryAsync(view, Marker);
        sticky.Close();
        await closed.Task.WaitAsync(TimeSpan.FromSeconds(12));
        var state = JsonSerializer.SerializeToElement(store.GetEditorState(note.Id));
        if (state.GetProperty("blocks")[0].GetProperty("content").GetProperty("text").GetString() != Marker)
            throw new Exception("Sticky ACK did not correspond to persisted text");
        Console.WriteLine("PASS real sticky WebView: pending close, NACK, retained draft, retry, ACK, close and SQLite read");
    }
    private static async Task SetTextAsync(WebView view, string text)
    {
        await view.ExecuteScriptAsync($$"""
            (() => { const edit = document.querySelector('[data-own-block] .block-text');
              edit.focus(); edit.textContent = {{JsonSerializer.Serialize(text)}};
              edit.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' })); })();
            """);
        try { await UntilAsync(() => EvaluateAsync(view, "document.querySelector('#status').textContent.includes('已保存')"), "History edit did not save"); }
        catch { Console.Error.WriteLine(await view.ExecuteScriptAsync("JSON.stringify({ status: document.querySelector('#status').textContent, text: document.querySelector('[data-own-block] .block-text').textContent })")); throw; }
    }
    private static async Task HasTextAsync(WebView view, string text) => await UntilAsync(() => EvaluateAsync(view,
        $"document.querySelector('[data-own-block] .block-text').textContent === {JsonSerializer.Serialize(text)}"), "History text mismatch: " + text);
    private static async Task ShortcutAsync(WebView view, string key) => await view.ExecuteScriptAsync(
        $"(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', {{ key: {JsonSerializer.Serialize(key)}, ctrlKey: true, bubbles: true }}));");
    private static async Task ExerciseHistoryAsync(WebView view, string finalText)
    {
        await SetTextAsync(view, "history-first");
        await SetTextAsync(view, "history-second");
        await ShortcutAsync(view, "z"); await HasTextAsync(view, "history-first");
        await ShortcutAsync(view, "y"); await HasTextAsync(view, "history-second");
        await ShortcutAsync(view, "z"); await HasTextAsync(view, "history-first");
        await SetTextAsync(view, finalText);
        if (!await EvaluateAsync(view, "document.querySelector('#redo').disabled")) throw new Exception("Redo branch was not cleared");
        await view.ExecuteScriptAsync("document.querySelector('#history').click(); document.querySelectorAll('#history-panel .history-entry')[1].click();");
        await HasTextAsync(view, finalText);
        if (!await EvaluateAsync(view, "document.querySelector('#history-panel pre').textContent.includes('history-second')")) throw new Exception("Archived branch missing from history preview");
        await view.ExecuteScriptAsync("document.querySelector('#history-panel .history-preview button').click();");
        await HasTextAsync(view, "history-second");
        await ShortcutAsync(view, "z"); await HasTextAsync(view, finalText);
        // Hold history ACK, request native flush, then reject: the current text is retained.
        await view.ExecuteScriptAsync("""
            window.historySend = window.chrome.webview.postMessage.bind(window.chrome.webview);
            window.chrome.webview.postMessage = raw => {
              const msg = JSON.parse(raw);
              if (msg.type === 'editor-command' && msg.operation.startsWith('history-')) window.heldHistory = msg;
              else { if (msg.type.startsWith('editor-flush-')) window.historyFlushReply = msg; window.historySend(raw); }
            };
            document.querySelector('#undo').click();
            """);
        await UntilAsync(() => EvaluateAsync(view, "!!window.heldHistory"), "History request not sent");
        await view.ExecuteScriptAsync("window.localNotesFlush('history-drain');");
        await Task.Delay(100);
        if (await EvaluateAsync(view, "!!window.historyFlushReply")) throw new Exception("Flush did not wait for history ACK");
        await view.ExecuteScriptAsync("""
            window.dispatchEvent(new MessageEvent('message', { data: { type: 'command-nack', requestId: window.heldHistory.requestId, documentId: window.heldHistory.sourceDocumentId, error: 'history rejected' } }));
            """);
        await UntilAsync(() => EvaluateAsync(view, "document.querySelector('#status').textContent.includes('history rejected')"), "History NACK missing");
        await HasTextAsync(view, finalText);
        await view.ExecuteScriptAsync("window.chrome.webview.postMessage = window.historySend;");
        await ShortcutAsync(view, "z"); await HasTextAsync(view, "history-first");
        await ShortcutAsync(view, "y"); await HasTextAsync(view, finalText);
        Console.WriteLine("PASS real WebView history: keyboard undo/redo, branches, preview, restore, delayed ACK and NACK retry");
    }
    private static async Task CheckRestartHistoryAsync(WebView view)
    {
        await view.ExecuteScriptAsync("document.querySelector('#history').click();");
        if (!await EvaluateAsync(view, "document.querySelectorAll('#history-panel .history-entry').length >= 4")) throw new Exception("History missing after process restart");
        await ShortcutAsync(view, "z"); await HasTextAsync(view, "history-first");
        await ShortcutAsync(view, "y"); await HasTextAsync(view, Marker);
        Console.WriteLine("PASS second EXE process restored history and performed undo/redo");
    }

}
