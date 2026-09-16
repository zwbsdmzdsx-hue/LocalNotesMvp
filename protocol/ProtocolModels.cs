using System.Text.Json;

namespace LocalNotesMvp;

public static class HostProtocol
{
    public const int Version = 1;
}

public sealed class HostRequest
{
    public int ProtocolVersion { get; set; }
    public string RequestId { get; set; } = "";
    public string Kind { get; set; } = "";
    public string? SourceDocumentId { get; set; }
    public JsonElement Payload { get; set; }
}

public sealed class HostResponse
{
    public int ProtocolVersion { get; set; } = HostProtocol.Version;
    public string RequestId { get; set; } = "";
    public string Kind { get; set; } = "";
    public bool Ok { get; set; }
    public object? Payload { get; set; }
    public HostProtocolError? Error { get; set; }
}

public sealed class HostProtocolError
{
    public string Code { get; set; } = "host_error";
    public string Message { get; set; } = "宿主操作失败。";
}

public sealed class HostSaveDocumentPayload
{
    public string DocumentId { get; set; } = "";
    public string MutationId { get; set; } = "";
    public long ClientVersion { get; set; }
    public string Title { get; set; } = "未命名笔记";
    public List<BlockRecord> Blocks { get; set; } = [];
}

public sealed class OpenDocumentPayload
{
    public string DocumentId { get; set; } = "";
    public string? BlockId { get; set; }
}
