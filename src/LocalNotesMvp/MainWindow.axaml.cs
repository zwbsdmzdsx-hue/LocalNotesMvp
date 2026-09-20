using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Input;
using Avalonia.Interactivity;
using AvaloniaWebView;
using WebViewCore.Events;

namespace LocalNotesMvp;

public partial class MainWindow : Window
{
    private readonly NoteStore _store = new(Environment.GetEnvironmentVariable("LOCAL_NOTES_MVP_DB"));
    private readonly MainWindowHostAdapter _hostAdapter;
    private readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = true };
    private Note? _current;
    private bool _suppressSelectionChanged;
    private bool _editorReady;
    private int _selectionVersion;
    private readonly EditorFlushCoordinator _flush = new();
    private bool _closePending;
    private readonly bool _acceptanceTest = Environment.GetCommandLineArgs().Contains("--acceptance-test");
    private bool _closing;
    private bool _acceptanceTriggered;
    private bool _acceptanceSaveAcknowledged;
    private string? _acceptanceDocumentId;
    private string? _acceptanceMarker;
    private Workspace? _workspace;
    private Bookmark? _bookmark;
    private string? _currentBlockId;
    private readonly List<Workspace> _openWorkspaces = [];
    private readonly List<NavigationEntry> _backHistory = [];
    private readonly List<NavigationEntry> _forwardHistory = [];
    private bool _navigationBusy;

    private sealed record NavigationEntry(string WorkspaceId, string? BookmarkId, string DocumentId, string? BlockId);

    public MainWindow()
    {
        InitializeComponent();
        _store.Load();
        _hostAdapter = new MainWindowHostAdapter(_store,
            async (documentId, blockId) =>
            {
                var target = _store.Find(documentId) ?? throw new InvalidOperationException("目标文档已不存在。");
                await OpenLinkedDocumentAsync(target, blockId);
            },
            async forward => { if (forward) await GoForwardAsync(); else await GoBackAsync(); });
        if (_acceptanceTest && _store.Notes.Count < 2) _store.Create();
        if (_acceptanceTest)
        {
            _acceptanceDocumentId = _store.Notes[0].Id;
            _acceptanceMarker = $"acceptance-{Guid.NewGuid():N}";
        }
        EditorView.WebMessageReceived += OnWebMessageReceived;
        EditorView.NavigationCompleted += OnNavigationCompleted;
        Closing += MainWindowClosing;
        AddHandler(KeyDownEvent, MainWindowKeyDown, RoutingStrategies.Tunnel);
        _suppressSelectionChanged = true;
        InitializeWorkspaceUi();
        NotesList.SelectedIndex = 0;
        _current = NotesList.SelectedItem as Note;
        _suppressSelectionChanged = false;
        EditorView.HtmlContent = EditorPage.Load();
    }

    private async void NoteSelectionChanged(object? sender, SelectionChangedEventArgs e)
    {
        if (_suppressSelectionChanged) return;
        if (NotesList.SelectedItem is not Note note) return;
        if (_current?.Id == note.Id) return;
        await NavigateToAsync(note, null, recordHistory: true, clearForward: true);
    }

    private async Task SendNoteAsync(Note note)
    {
        var payload = JsonSerializer.Serialize(new { type = "load-state", state = _store.GetEditorState(note.Id) }, _json);
        await EditorView.ExecuteScriptAsync($"window.dispatchEvent(new MessageEvent('message', {{ data: {JsonSerializer.Serialize(payload)} }}));");
    }

    private NavigationEntry? CurrentNavigationEntry()
        => _current is null || _workspace is null
            ? null
            : new NavigationEntry(_workspace.Id, _bookmark?.Id, _current.Id, _currentBlockId);

    private NavigationEntry? NavigationEntryFor(Note note, string? blockId)
    {
        var workspace = _openWorkspaces.FirstOrDefault(w => w.Id == note.WorkspaceId)
            ?? _store.GetWorkspaces().FirstOrDefault(w => w.Id == note.WorkspaceId);
        if (workspace is null) return null;
        var bookmark = _store.GetBookmarks(workspace.Id).FirstOrDefault(b =>
            _store.GetDocuments(workspace.Id, b.Id).Any(item => item.Id == note.Id));
        return new NavigationEntry(workspace.Id, bookmark?.Id, note.Id, blockId);
    }

    private void UpdateNavigationButtons()
    {
        BackButton.IsEnabled = _backHistory.Count > 0;
        ForwardButton.IsEnabled = _forwardHistory.Count > 0;
    }

    private async Task NavigateToAsync(Note note, string? blockId, bool recordHistory, bool clearForward, bool alreadyFlushed = false)
    {
        var version = ++_selectionVersion;
        if (!alreadyFlushed && !await FlushEditorAsync())
        {
            if (_current is not null) RefreshList(_current.Id);
            return;
        }
        if (version != _selectionVersion) return;
        var next = NavigationEntryFor(note, blockId);
        if (next is null) return;
        if (recordHistory)
        {
            var previous = CurrentNavigationEntry();
            if (previous is not null && !previous.Equals(next))
            {
                _backHistory.Add(previous);
                if (clearForward) _forwardHistory.Clear();
            }
        }
        _workspace = _openWorkspaces.FirstOrDefault(w => w.Id == next.WorkspaceId)
            ?? _store.GetWorkspaces().FirstOrDefault(w => w.Id == next.WorkspaceId);
        if (_workspace is null) return;
        if (_openWorkspaces.All(w => w.Id != _workspace.Id)) _openWorkspaces.Add(_workspace);
        _bookmark = next.BookmarkId is null ? null : _store.GetBookmarks(_workspace.Id).FirstOrDefault(b => b.Id == next.BookmarkId);
        _suppressSelectionChanged = true;
        try
        {
            RefreshWorkspaceUi(note.Id);
            _current = note;
            _currentBlockId = blockId;
        }
        finally { _suppressSelectionChanged = false; }
        await SendNoteAsync(note);
        if (blockId is not null) SendClientMessage(new { type = "focus-block", blockId });
        UpdateNavigationButtons();
    }

    private async Task NavigateToHistoryEntryAsync(NavigationEntry entry)
    {
        var note = _store.Find(entry.DocumentId);
        if (note is null) throw new InvalidOperationException("历史记录指向的文档已不存在。");
        await NavigateToAsync(note, entry.BlockId, recordHistory: false, clearForward: false, alreadyFlushed: true);
    }

    private async void BackClick(object? sender, RoutedEventArgs e) => await GoBackAsync();

    private async Task GoBackAsync()
    {
        if (_navigationBusy || _backHistory.Count == 0) return;
        _navigationBusy = true;
        try
        {
            if (!await FlushEditorAsync()) return;
            var target = _backHistory[^1];
            if (_store.Find(target.DocumentId) is null) { _backHistory.RemoveAt(_backHistory.Count - 1); UpdateNavigationButtons(); return; }
            _backHistory.RemoveAt(_backHistory.Count - 1);
            var current = CurrentNavigationEntry();
            if (current is not null) _forwardHistory.Add(current);
            await NavigateToHistoryEntryAsync(target);
            UpdateNavigationButtons();
        }
        finally { _navigationBusy = false; }
    }

    private async void ForwardClick(object? sender, RoutedEventArgs e) => await GoForwardAsync();

    private async Task GoForwardAsync()
    {
        if (_navigationBusy || _forwardHistory.Count == 0) return;
        _navigationBusy = true;
        try
        {
            if (!await FlushEditorAsync()) return;
            var target = _forwardHistory[^1];
            if (_store.Find(target.DocumentId) is null) { _forwardHistory.RemoveAt(_forwardHistory.Count - 1); UpdateNavigationButtons(); return; }
            _forwardHistory.RemoveAt(_forwardHistory.Count - 1);
            var current = CurrentNavigationEntry();
            if (current is not null) _backHistory.Add(current);
            await NavigateToHistoryEntryAsync(target);
            UpdateNavigationButtons();
        }
        finally { _navigationBusy = false; }
    }

    private void MainWindowKeyDown(object? sender, KeyEventArgs e)
    {
        if ((e.KeyModifiers & KeyModifiers.Alt) != KeyModifiers.Alt) return;
        if (e.Key == Key.Left)
        {
            e.Handled = true;
            BackClick(sender, new RoutedEventArgs());
        }
        else if (e.Key == Key.Right)
        {
            e.Handled = true;
            ForwardClick(sender, new RoutedEventArgs());
        }
    }

    private async void OnNavigationCompleted(object? sender, WebViewUrlLoadedEventArg e)
    {
        _editorReady = true;
        if (_current is not null) await SendNoteAsync(_current);
        if (_acceptanceTest && !_acceptanceTriggered)
        {
            _acceptanceTriggered = true;
            _ = AcceptanceWatchdogAsync();
            await EditorView.ExecuteScriptAsync($"window.localNotesRunAcceptanceEdit?.({JsonSerializer.Serialize(_acceptanceMarker)});");
        }
    }

    private async Task<bool> FlushEditorAsync()
    {
        if (!_editorReady) return true;
        return await _flush.FlushAsync(async requestId =>
            await EditorView.ExecuteScriptAsync($"window.localNotesFlush?.({JsonSerializer.Serialize(requestId)});"));
    }

    private async void MainWindowClosing(object? sender, WindowClosingEventArgs e)
    {
        if (_closing) return;
        e.Cancel = true;
        if (_closePending) return;
        _closePending = true;
        try
        {
            if (!await FlushEditorAsync()) return;
            _closing = true;
            Close();
        }
        finally { _closePending = false; }
    }

    private void OnWebMessageReceived(object? sender, WebViewMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = ParseWebMessage(e.Message);
            if (_flush.TryHandle(doc.RootElement)) return;
            if (doc.RootElement.TryGetProperty("protocolVersion", out var protocolVersion) && protocolVersion.GetInt32() == HostProtocol.Version)
            {
                var request = doc.RootElement.Deserialize<HostRequest>(_json)
                    ?? throw new InvalidOperationException("协议请求为空。");
                _ = HandleProtocolRequestAsync(request);
                return;
            }
            var type = doc.RootElement.GetProperty("type").GetString();
            if (type == "editor-command")
            {
                var requestId = doc.RootElement.GetProperty("requestId").GetString();
                var owner = doc.RootElement.GetProperty("sourceDocumentId").GetString()!;
                try
                {
                    var result = _store.ExecuteEditorCommand(owner, doc.RootElement);
                    if (result is EditorCommandResult command)
                        SendClientMessage(new { type = "command-ack", requestId, documentId = owner, state = command.State, result = command.Result, content = command.Content, mimeType = command.MimeType, fileName = command.FileName });
                    else SendClientMessage(new { type = "command-ack", requestId, documentId = owner, state = result });
                }
                catch (Exception error) { SendClientMessage(new { type = "command-nack", requestId, documentId = owner, error = error.Message }); }
                return;
            }
            if (type == "navigate-back")
            {
                _ = GoBackAsync();
                return;
            }
            if (type == "navigate-forward")
            {
                _ = GoForwardAsync();
                return;
            }
            if (_current is null) return;
            var sourceDocumentId = doc.RootElement.TryGetProperty("sourceDocumentId", out var sourceIdElement)
                ? sourceIdElement.GetString() ?? _current.Id
                : _current.Id;
            switch (type)
            {
                case "save-transaction":
                    var saveTransaction = doc.RootElement.Deserialize<SaveTransactionRequest>(_json);
                    if (saveTransaction is null || saveTransaction.DocumentId != sourceDocumentId)
                        throw new InvalidOperationException("Save transaction document ID mismatch.");
                    var savedVersion = _store.SaveTransaction(saveTransaction);
                    SendClientMessage(new { type = "save-ack", documentId = sourceDocumentId, mutationId = saveTransaction.MutationId, clientVersion = savedVersion, history = _store.GetDocumentHistory(sourceDocumentId) });
                    if (_acceptanceTest && !_acceptanceSaveAcknowledged && saveTransaction.DocumentId == _acceptanceDocumentId)
                    {
                        _acceptanceSaveAcknowledged = true;
                        _ = CompleteAcceptanceAsync();
                    }
                    break;
                case "reload-state":
                    if (_current.Id == sourceDocumentId) _ = SendNoteAsync(_current);
                    break;
                case "save-document":
                    var request = doc.RootElement.Deserialize<SaveDocumentRequest>(_json);
                    if (request is null) return;
                    if (_store.Find(sourceDocumentId) is null) throw new InvalidOperationException("Document no longer exists.");
                    _store.SaveDocument(sourceDocumentId, request);
                    _ = EditorView.ExecuteScriptAsync($"window.localNotesSaved?.({JsonSerializer.Serialize(sourceDocumentId)});");
                    break;
                case "create-reference":
                    _store.CreateReference(sourceDocumentId,
                        doc.RootElement.GetProperty("hostBlockId").GetString()!,
                        doc.RootElement.GetProperty("targetDocumentId").GetString()!,
                        doc.RootElement.TryGetProperty("targetBlockId", out var targetBlockId) ? targetBlockId.GetString() : null);
                    if (_current.Id == sourceDocumentId) _ = SendNoteAsync(_current);
                    break;
                case "set-reference-mode":
                    var modeRequest = doc.RootElement.Deserialize<SetReferenceModeRequest>(_json);
                    if (modeRequest is not null) _store.SetReferenceMode(modeRequest);
                    if (_current.Id == sourceDocumentId) _ = SendNoteAsync(_current);
                    break;
                case "remove-reference":
                    _store.RemoveReference(doc.RootElement.GetProperty("referenceInstanceId").GetString()!);
                    if (_current.Id == sourceDocumentId) _ = SendNoteAsync(_current);
                    break;
                case "reset-reference":
                    _store.ResetReference(doc.RootElement.GetProperty("referenceInstanceId").GetString()!);
                    if (_current.Id == sourceDocumentId) _ = SendNoteAsync(_current);
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
                    _store.DeleteInstanceBlock(
                        doc.RootElement.GetProperty("referenceInstanceId").GetString()!,
                        doc.RootElement.GetProperty("blockId").GetString()!);
                    if (_current.Id == sourceDocumentId) _ = SendNoteAsync(_current);
                    break;
                case "hide-reference-block":
                    _store.HideReferencedBlock(
                        doc.RootElement.GetProperty("referenceInstanceId").GetString()!,
                        doc.RootElement.GetProperty("targetBlockId").GetString()!);
                    if (_current.Id == sourceDocumentId) _ = SendNoteAsync(_current);
                    break;
                case "reset-override":
                    _store.ResetOverride(
                        doc.RootElement.GetProperty("referenceInstanceId").GetString()!,
                        doc.RootElement.GetProperty("targetBlockId").GetString()!);
                    if (_current.Id == sourceDocumentId) _ = SendNoteAsync(_current);
                    break;
                case "open-document":
                    var target = _store.Find(doc.RootElement.GetProperty("documentId").GetString()!);
                    if (target is not null) _ = OpenLinkedDocumentAsync(target,
                        doc.RootElement.TryGetProperty("blockId", out var linkBlock) ? linkBlock.GetString() : null);
                    break;
            }
        }
        catch (Exception exception)
        {
            try
            {
                using var failedDoc = ParseWebMessage(e.Message);
                if (failedDoc.RootElement.TryGetProperty("type", out var failedType) && failedType.GetString() == "save-transaction" &&
                    failedDoc.RootElement.TryGetProperty("mutationId", out var failedMutation))
                {
                    SendClientMessage(new { type = "save-nack", mutationId = failedMutation.GetString(), error = exception.Message });
                }
            }
            catch (JsonException)
            {
            }
            _ = EditorView.ExecuteScriptAsync($"window.localNotesError?.({JsonSerializer.Serialize(exception.Message)});");
        }
    }

    private async Task HandleProtocolRequestAsync(HostRequest request)
    {
        var response = await _hostAdapter.HandleAsync(request);
        SendProtocolMessage(response);
        if (response.Ok && (request.Kind is "openDocument" or "navigateBack" or "navigateForward") && _current is not null)
            SendProtocolMessage(new { protocolVersion = HostProtocol.Version, kind = "documentLoaded", payload = new { state = _store.GetEditorState(_current.Id) } });
    }

    private void SendProtocolMessage(object message)
    {
        var json = WebViewMessageChannel.Serialize(message);
        _ = EditorView.ExecuteScriptAsync($"window.localNotesHostReceive?.({json});");
    }

    private async Task OpenLinkedDocumentAsync(Note note, string? blockId)
    {
        await NavigateToAsync(note, blockId, recordHistory: true, clearForward: true);
    }

    private void RefreshList(string selectedId)
    {
        _suppressSelectionChanged = true;
        try
        {
            NotesList.ItemsSource = null;
            NotesList.ItemsSource = CurrentDocuments();
            _current = _store.Find(selectedId);
            NotesList.SelectedItem = _current;
        }
        finally { _suppressSelectionChanged = false; }
    }

    private async Task AcceptanceWatchdogAsync()
    {
        await Task.Delay(TimeSpan.FromSeconds(8));
        if (!_acceptanceSaveAcknowledged) FinishAcceptance(false, "真实 WebView input 未产生 save ACK。");
    }

    private async Task CompleteAcceptanceAsync()
    {
        try
        {
            await Task.Delay(300);
            if (_acceptanceDocumentId is null || _acceptanceMarker is null) throw new InvalidOperationException("验收状态未初始化。");
            var other = _store.Notes.FirstOrDefault(note => note.Id != _acceptanceDocumentId);
            if (other is null) throw new InvalidOperationException("验收数据库没有第二篇文档。");
            var visibleOther = NotesList.Items.OfType<Note>().FirstOrDefault(note => note.Id == other.Id);
            if (visibleOther is null) throw new InvalidOperationException("验收列表没有第二篇可见文档。");
            NotesList.SelectedItem = visibleOther;
            await WaitForCurrentAsync(other.Id);
            var visibleOriginal = NotesList.Items.OfType<Note>().FirstOrDefault(note => note.Id == _acceptanceDocumentId);
            if (visibleOriginal is null) throw new InvalidOperationException("切换后验收列表没有原文档。");
            NotesList.SelectedItem = visibleOriginal;
            await WaitForCurrentAsync(_acceptanceDocumentId);

            var reloaded = new NoteStore(_store.DatabasePath);
            reloaded.Load();
            var stateJson = JsonSerializer.Serialize(reloaded.GetEditorState(_acceptanceDocumentId), _json);
            if (!stateJson.Contains(_acceptanceMarker, StringComparison.Ordinal))
                throw new InvalidOperationException("切换文档并重新读取 SQLite 后，正文标记不存在。");
            FinishAcceptance(true, "真实 WebView input -> ACK -> SQLite -> 切换文档 -> 重载验收通过。");
        }
        catch (Exception exception)
        {
            FinishAcceptance(false, exception.Message);
        }
    }

    private async Task WaitForCurrentAsync(string documentId)
    {
        for (var attempt = 0; attempt < 100; attempt++)
        {
            if (_current?.Id == documentId) return;
            await Task.Delay(50);
        }
        throw new InvalidOperationException($"切换文档未完成：{documentId}");
    }

    private void FinishAcceptance(bool passed, string message)
    {
        Environment.ExitCode = passed ? 0 : 1;
        try
        {
            var resultPath = Path.Combine(Path.GetTempPath(), "local-notes-acceptance-result.json");
            File.WriteAllText(resultPath, JsonSerializer.Serialize(new { passed, message, databasePath = _store.DatabasePath }));
        }
        catch
        {
        }
        if (Application.Current?.ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
            desktop.Shutdown(passed ? 0 : 1);
        else
            Close();
    }

    private void SendClientMessage(object message)
    {
        var payload = JsonSerializer.Serialize(JsonSerializer.Serialize(message, _json));
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

    private async void NewNoteClick(object? sender, RoutedEventArgs e)
    {
        if (!await FlushEditorAsync()) return;
        var note = _store.Create(false, _workspace?.Id, _bookmark?.Id);
        if (_workspace is null || _bookmark is null) InitializeWorkspaceUi();
        RefreshList(note.Id);
        _currentBlockId = null;
        if (_current is not null) await SendNoteAsync(_current);
    }

    private void OpenStickyClick(object? sender, RoutedEventArgs e)
    {
        var sticky = _store.Notes.FirstOrDefault(x => x.IsSticky) ?? _store.Create(true);
        var window = new StickyWindow(_store, sticky);
        window.Show(this);
    }

    private IReadOnlyList<Note> CurrentDocuments() => _workspace is null || _bookmark is null
        ? []
        : _store.GetDocuments(_workspace.Id, _bookmark.Id);

    private void InitializeWorkspaceUi()
    {
        _workspace = _store.GetWorkspaces().FirstOrDefault();
        _openWorkspaces.Clear();
        if (_workspace is not null) _openWorkspaces.Add(_workspace);
        _bookmark = _workspace is null ? null : _store.GetBookmarks(_workspace.Id).FirstOrDefault();
        RefreshWorkspaceUi();
    }

    private void RefreshWorkspaceUi(string? selectedDocumentId = null)
    {
        WorkspaceLabel.Text = _workspace?.Name ?? "未打开工作区";
        BookmarkLabel.Text = _bookmark?.Name ?? "选择书签";
        RefreshWorkspaceTabs();
        BookmarksBar.Children.Clear();
        BookmarksBar.Children.Add(new TextBlock { Text = "书签", FontSize = 11, Foreground = Avalonia.Media.Brushes.Gray, HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Center });
        if (_workspace is not null)
        {
            foreach (var bookmark in _store.GetBookmarks(_workspace.Id))
            {
                var button = new Button
                {
                    Content = bookmark.ShortName,
                    Tag = bookmark,
                    Height = 42,
                    Padding = new Avalonia.Thickness(0),
                    Background = Avalonia.Media.Brush.Parse(bookmark.Color),
                    Foreground = Avalonia.Media.Brushes.White,
                    HorizontalContentAlignment = Avalonia.Layout.HorizontalAlignment.Center
                };
                ToolTip.SetTip(button, bookmark.Name);
                button.Click += BookmarkClick;
                BookmarksBar.Children.Add(button);
            }
        }
        var add = new Button { Content = "+", Height = 42, FontSize = 22, Padding = new Avalonia.Thickness(0), Background = Avalonia.Media.Brushes.White };
        add.Click += NewBookmarkClick;
        BookmarksBar.Children.Add(add);
        NotesList.ItemsSource = CurrentDocuments();
        if (selectedDocumentId is not null) NotesList.SelectedItem = CurrentDocuments().FirstOrDefault(note => note.Id == selectedDocumentId);
    }

    private void RefreshWorkspaceTabs()
    {
        WorkspaceTabs.Children.Clear();
        foreach (var workspace in _openWorkspaces.ToList())
        {
            var tab = new Button
            {
                Content = workspace.Name,
                Tag = workspace,
                Padding = new Avalonia.Thickness(12, 6),
                MinWidth = 78,
                Background = _workspace?.Id == workspace.Id
                    ? Avalonia.Media.Brush.Parse("#E8EEF9")
                    : Avalonia.Media.Brushes.White,
                Foreground = Avalonia.Media.Brush.Parse("#172B4D")
            };
            ToolTip.SetTip(tab, "左键切换，右键重命名或关闭");
            tab.Click += WorkspaceTabClick;
            tab.PointerPressed += WorkspaceTabPointerPressed;
            WorkspaceTabs.Children.Add(tab);
        }
        var add = new Button { Content = "+", Padding = new Avalonia.Thickness(10, 6), Background = Avalonia.Media.Brushes.White };
        add.Click += CreateWorkspaceClick;
        WorkspaceTabs.Children.Add(add);
    }

    private async void WorkspaceTabClick(object? sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: Workspace workspace } || _workspace?.Id == workspace.Id) return;
        if (!await FlushEditorAsync()) return;
        _workspace = workspace;
        _bookmark = _store.GetBookmarks(workspace.Id).FirstOrDefault();
        _current = null;
        _currentBlockId = null;
        RefreshWorkspaceUi();
        NotesList.SelectedIndex = 0;
        _current = NotesList.SelectedItem as Note;
        if (_current is not null) await SendNoteAsync(_current);
    }

    private async void WorkspaceTabPointerPressed(object? sender, Avalonia.Input.PointerPressedEventArgs e)
    {
        if (!e.Handled && e.GetCurrentPoint(null).Properties.PointerUpdateKind == Avalonia.Input.PointerUpdateKind.RightButtonPressed &&
            sender is Button { Tag: Workspace workspace })
        {
            e.Handled = true;
            var action = await ShowWorkspaceContextMenuAsync(workspace);
            if (action == "rename")
            {
                var name = await ShowTextPromptAsync("重命名工作区", "工作区名称", workspace.Name);
                if (!string.IsNullOrWhiteSpace(name))
                {
                    _store.RenameWorkspace(workspace.Id, name);
                    workspace.Name = name.Trim();
                    RefreshWorkspaceUi();
                }
            }
            else if (action == "close")
            {
                _openWorkspaces.RemoveAll(x => x.Id == workspace.Id);
                if (_workspace?.Id == workspace.Id)
                {
                    _workspace = _openWorkspaces.LastOrDefault();
                    _bookmark = _workspace is null ? null : _store.GetBookmarks(_workspace.Id).FirstOrDefault();
                    _current = null;
                    _currentBlockId = null;
                }
                RefreshWorkspaceUi();
                NotesList.SelectedIndex = 0;
                _current = NotesList.SelectedItem as Note;
                if (_current is not null) await SendNoteAsync(_current);
            }
        }
    }

    private async Task<string?> ShowWorkspaceContextMenuAsync(Workspace workspace)
    {
        var rename = new Button { Content = "重命名" };
        var close = new Button { Content = "关闭标签页" };
        var dialog = new Window { Title = workspace.Name, Width = 220, Height = 145, WindowStartupLocation = WindowStartupLocation.CenterOwner };
        rename.Click += (_, _) => dialog.Close("rename");
        close.Click += (_, _) => dialog.Close("close");
        dialog.Content = new StackPanel { Spacing = 8, Margin = new Avalonia.Thickness(16), Children = { rename, close } };
        return await dialog.ShowDialog<string?>(this);
    }

    private async void BookmarkClick(object? sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: Bookmark bookmark }) return;
        if (_bookmark?.Id == bookmark.Id) return;
        if (!await FlushEditorAsync()) return;
        _bookmark = bookmark;
        _current = null;
        _currentBlockId = null;
        RefreshWorkspaceUi();
        NotesList.SelectedIndex = 0;
        _current = NotesList.SelectedItem as Note;
        if (_current is not null) await SendNoteAsync(_current);
    }

    private async void OpenWorkspaceClick(object? sender, RoutedEventArgs e)
    {
        if (!await FlushEditorAsync()) return;
        var choices = _store.GetWorkspacePreviews();
        var selected = await ShowWorkspacePickerAsync(choices);
        if (selected is null) return;
        if (_openWorkspaces.All(x => x.Id != selected.Id)) _openWorkspaces.Add(selected);
        _workspace = selected;
        _bookmark = _store.GetBookmarks(selected.Id).FirstOrDefault();
        _current = null;
        _currentBlockId = null;
        RefreshWorkspaceUi();
        NotesList.SelectedIndex = 0;
        _current = NotesList.SelectedItem as Note;
        if (_current is not null) await SendNoteAsync(_current);
    }

    private async void CreateWorkspaceClick(object? sender, RoutedEventArgs e)
    {
        if (!await FlushEditorAsync()) return;
        var name = await ShowTextPromptAsync("创建工作区", "工作区名称", "新工作区");
        if (string.IsNullOrWhiteSpace(name)) return;
        _workspace = _store.CreateWorkspace(name.Trim());
        _openWorkspaces.Add(_workspace);
        _bookmark = _store.GetBookmarks(_workspace.Id).FirstOrDefault();
        _current = null;
        _currentBlockId = null;
        RefreshWorkspaceUi();
    }

    private async void CloseWorkspaceClick(object? sender, RoutedEventArgs e)
    {
        if (!await FlushEditorAsync()) return;
        _workspace = null;
        _bookmark = null;
        _openWorkspaces.Clear();
        _current = null;
        _currentBlockId = null;
        RefreshWorkspaceUi();
        await EditorView.ExecuteScriptAsync("window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'load-state', state: { note: { id: '', title: '', clientVersion: 0 }, blocks: [], documents: [], backlinks: [], overrideNotices: [], references: [] } }) }));");
    }

    private async void NewBookmarkClick(object? sender, RoutedEventArgs e)
    {
        if (_workspace is null) return;
        var name = await ShowTextPromptAsync("新建书签", "书签名称", "新书签");
        if (string.IsNullOrWhiteSpace(name)) return;
        _bookmark = _store.CreateBookmark(_workspace.Id, name.Trim(), BookmarkColors[_store.GetBookmarks(_workspace.Id).Count % BookmarkColors.Length]);
        RefreshWorkspaceUi();
    }

    private static readonly string[] BookmarkColors = ["#3B82F6", "#7C3AED", "#DB2777", "#EA580C", "#16A34A", "#0891B2", "#CA8A04"];

    private async Task<Workspace?> ShowWorkspacePickerAsync(IReadOnlyList<WorkspacePreview> choices)
    {
        var list = new ListBox { ItemsSource = choices, Width = 360, Height = 260, Margin = new Avalonia.Thickness(18) };
        var open = new Button { Content = "打开", IsDefault = true, MinWidth = 90 };
        var cancel = new Button { Content = "取消", IsCancel = true, MinWidth = 90 };
        var dialog = new Window { Title = "打开工作区", Width = 430, Height = 380, WindowStartupLocation = WindowStartupLocation.CenterOwner };
        open.Click += (_, _) => dialog.Close((list.SelectedItem as WorkspacePreview)?.Workspace);
        cancel.Click += (_, _) => dialog.Close(null);
        var buttons = new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Right, Spacing = 8, Margin = new Avalonia.Thickness(18, 0, 18, 18) };
        buttons.Children.Add(cancel); buttons.Children.Add(open);
        var content = new StackPanel { Spacing = 8 };
        content.Children.Add(new TextBlock { Text = "选择一个工作区", Margin = new Avalonia.Thickness(18, 18, 18, 0), FontSize = 16 });
        content.Children.Add(list); content.Children.Add(buttons);
        dialog.Content = content;
        return await dialog.ShowDialog<Workspace?>(this);
    }

    private async Task<string?> ShowTextPromptAsync(string title, string label, string initial)
    {
        var input = new TextBox { Text = initial, MinWidth = 280 };
        var ok = new Button { Content = "确定", IsDefault = true, MinWidth = 80 };
        var cancel = new Button { Content = "取消", IsCancel = true, MinWidth = 80 };
        var dialog = new Window { Title = title, Width = 380, Height = 180, WindowStartupLocation = WindowStartupLocation.CenterOwner };
        ok.Click += (_, _) => dialog.Close(input.Text);
        cancel.Click += (_, _) => dialog.Close(null);
        var buttons = new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Right, Spacing = 8 };
        buttons.Children.Add(cancel); buttons.Children.Add(ok);
        var content = new StackPanel { Spacing = 12, Margin = new Avalonia.Thickness(22) };
        content.Children.Add(new TextBlock { Text = label }); content.Children.Add(input); content.Children.Add(buttons);
        dialog.Content = content;
        return await dialog.ShowDialog<string?>(this);
    }
}
