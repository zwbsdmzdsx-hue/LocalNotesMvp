using System.Text.Json;
using Avalonia.Controls;
using Avalonia.Interactivity;
using AvaloniaWebView;
using WebViewCore.Events;

namespace LocalNotesMvp;

public partial class MainWindow : Window
{
    private readonly NoteStore _store = new();
    private Note? _current;

    public MainWindow()
    {
        InitializeComponent();
        _store.Load();
        NotesList.ItemsSource = _store.Notes;
        NotesList.SelectedIndex = 0;
        EditorView.WebMessageReceived += OnWebMessageReceived;
        EditorView.NavigationCompleted += OnNavigationCompleted;
        EditorView.HtmlContent = EditorPage.Load();
    }

    private void NoteSelectionChanged(object? sender, SelectionChangedEventArgs e)
    {
        if (NotesList.SelectedItem is not Note note) return;
        _current = note;
        _ = SendNoteAsync(note);
    }

    private async Task SendNoteAsync(Note note)
    {
        var payload = JsonSerializer.Serialize(new { type = "load-note", note });
        await EditorView.ExecuteScriptAsync($"window.dispatchEvent(new MessageEvent('message', {{ data: {JsonSerializer.Serialize(payload)} }}));");
    }

    private async void OnNavigationCompleted(object? sender, WebViewUrlLoadedEventArg e)
    {
        if (_current is not null) await SendNoteAsync(_current);
    }

    private void OnWebMessageReceived(object? sender, WebViewMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.Message);
            if (doc.RootElement.GetProperty("type").GetString() != "save-note" || _current is null) return;
            _current.Title = doc.RootElement.GetProperty("title").GetString() ?? "未命名笔记";
            _current.ContentJson = doc.RootElement.GetProperty("content").GetRawText();
            _current.UpdatedAt = DateTime.UtcNow;
            _store.Save();
        }
        catch (JsonException) { }
    }

    private void NewNoteClick(object? sender, RoutedEventArgs e)
    {
        var note = _store.Create();
        NotesList.ItemsSource = null;
        NotesList.ItemsSource = _store.Notes;
        NotesList.SelectedItem = note;
    }

    private void OpenStickyClick(object? sender, RoutedEventArgs e)
    {
        var sticky = _store.Notes.FirstOrDefault(x => x.IsSticky) ?? _store.Create(true);
        var window = new StickyWindow(_store, sticky);
        window.Show(this);
    }
}
