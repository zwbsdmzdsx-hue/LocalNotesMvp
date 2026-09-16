using System.Text.Json;

namespace LocalNotesMvp;

public sealed class StickyWindowHostAdapter
{
    private readonly EditorHostController _controller;

    public StickyWindowHostAdapter(INoteRepository repository)
    {
        _controller = new EditorHostController(repository);
    }

    public Task<HostResponse> HandleAsync(HostRequest request) => _controller.HandleAsync(request);
}
