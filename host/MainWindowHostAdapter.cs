using System.Text.Json;

namespace LocalNotesMvp;

public sealed class MainWindowHostAdapter
{
    private readonly EditorHostController _controller;

    public MainWindowHostAdapter(
        INoteRepository repository,
        Func<string, string?, Task> openDocument,
        Func<bool, Task> navigate)
    {
        _controller = new EditorHostController(repository, openDocument, navigate);
    }

    public Task<HostResponse> HandleAsync(HostRequest request) => _controller.HandleAsync(request);
}
