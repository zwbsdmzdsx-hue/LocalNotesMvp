using System.Text.Json;
using Avalonia.Controls;
using AvaloniaWebView;
using WebViewCore.Events;

namespace LocalNotesMvp;

public partial class StickyWindow : Window
{
    private readonly NoteStore _store;
    private readonly Note _note;

    public StickyWindow() : this(new NoteStore(), new Note { IsSticky = true })
    {
    }

    public StickyWindow(NoteStore store, Note note)
    {
        _store = store; _note = note;
        InitializeComponent();
        EditorView.WebMessageReceived += OnMessage;
        EditorView.NavigationCompleted += OnNavigationCompleted;
        EditorView.HtmlContent = EditorPage.Load();
    }

    private async void OnNavigationCompleted(object? sender, WebViewUrlLoadedEventArg e)
    {
        var payload = JsonSerializer.Serialize(new { type = "load-note", note = _note });
        await EditorView.ExecuteScriptAsync($"window.dispatchEvent(new MessageEvent('message', {{ data: {JsonSerializer.Serialize(payload)} }}));");
    }

    private void OnMessage(object? sender, WebViewMessageReceivedEventArgs e)
    {
        using var doc = JsonDocument.Parse(e.Message);
        if (doc.RootElement.GetProperty("type").GetString() != "save-note") return;
        _note.Title = doc.RootElement.GetProperty("title").GetString() ?? "新便签";
        _note.ContentJson = doc.RootElement.GetProperty("content").GetRawText();
        _note.UpdatedAt = DateTime.UtcNow;
        _store.Save();
    }
}
