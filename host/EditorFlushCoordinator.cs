using System.Text.Json;

namespace LocalNotesMvp;

/// <summary>Correlates flush replies and shares an in-progress drain between navigation and close.</summary>
public sealed class EditorFlushCoordinator
{
    private sealed record Pending(string Id, TaskCompletionSource<bool> Completion);
    private Pending? _pending;
    private readonly TimeSpan _timeout;

    public EditorFlushCoordinator(TimeSpan? timeout = null) => _timeout = timeout ?? TimeSpan.FromSeconds(10);

    public Task<bool> FlushAsync(Func<string, Task> send)
    {
        if (_pending is not null) return _pending.Completion.Task;
        var pending = new Pending(Guid.NewGuid().ToString("N"),
            new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously));
        _pending = pending;
        _ = RunAsync(pending, send);
        return pending.Completion.Task;
    }

    private async Task RunAsync(Pending pending, Func<string, Task> send)
    {
        try
        {
            // Bound both script dispatch and the subsequent ACK wait.
            await send(pending.Id).WaitAsync(_timeout);
            await pending.Completion.Task.WaitAsync(_timeout);
        }
        catch { pending.Completion.TrySetResult(false); }
        finally { if (ReferenceEquals(_pending, pending)) _pending = null; }
    }

    public bool TryHandle(JsonElement message)
    {
        if (!message.TryGetProperty("type", out var type)) return false;
        var kind = type.GetString();
        if (kind is not ("editor-flush-complete" or "editor-flush-failed")) return false;
        if (message.TryGetProperty("requestId", out var id) && id.ValueKind == JsonValueKind.String && id.GetString() == _pending?.Id)
        {
            var pending = _pending!;
            _pending = null;
            pending.Completion.TrySetResult(kind == "editor-flush-complete");
        }
        return true;
    }
}
