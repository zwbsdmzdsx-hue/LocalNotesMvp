using System.Text.Json;

namespace LocalNotesMvp;

public sealed class EditorHostController
{
    private readonly INoteRepository _repository;
    private readonly Func<string, string?, Task>? _openDocument;
    private readonly Func<bool, Task>? _navigate;
    private readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = true };

    public EditorHostController(
        INoteRepository repository,
        Func<string, string?, Task>? openDocument = null,
        Func<bool, Task>? navigate = null)
    {
        _repository = repository;
        _openDocument = openDocument;
        _navigate = navigate;
    }

    public async Task<HostResponse> HandleAsync(HostRequest request)
    {
        try
        {
            if (request.ProtocolVersion != HostProtocol.Version)
                throw new HostRequestException("unsupported_protocol", $"不支持的协议版本：{request.ProtocolVersion}");
            if (string.IsNullOrWhiteSpace(request.RequestId) || string.IsNullOrWhiteSpace(request.Kind))
                throw new HostRequestException("invalid_request", "请求缺少 requestId 或 kind。");

            object? payload = request.Kind switch
            {
                "ready" => null,
                "loadDocument" or "reloadDocument" => LoadDocument(request),
                "saveDocument" => SaveDocument(request),
                "executeCommand" => ExecuteCommand(request),
                "openDocument" => await OpenDocumentAsync(request),
                "navigateBack" => await NavigateAsync(false),
                "navigateForward" => await NavigateAsync(true),
                "showNotification" => null,
                _ => throw new HostRequestException("unknown_kind", $"未知宿主能力：{request.Kind}")
            };
            return new HostResponse { RequestId = request.RequestId, Kind = request.Kind, Ok = true, Payload = payload };
        }
        catch (HostRequestException exception)
        {
            return Failure(request, exception.Code, exception.Message);
        }
        catch (Exception exception)
        {
            return Failure(request, "host_error", exception.Message);
        }
    }

    private object LoadDocument(HostRequest request)
    {
        var documentId = GetDocumentId(request);
        return new { state = _repository.GetEditorState(documentId) };
    }

    private object SaveDocument(HostRequest request)
    {
        var payload = request.Payload.Deserialize<HostSaveDocumentPayload>(_json)
            ?? throw new HostRequestException("invalid_payload", "saveDocument payload 无效。");
        if (string.IsNullOrWhiteSpace(payload.DocumentId)) payload.DocumentId = GetDocumentId(request);
        if (payload.DocumentId != GetDocumentId(request))
            throw new HostRequestException("document_mismatch", "保存文档与请求归属不一致。");
        var version = _repository.SaveTransaction(new SaveTransactionRequest
        {
            DocumentId = payload.DocumentId,
            MutationId = payload.MutationId,
            ClientVersion = payload.ClientVersion,
            Title = payload.Title,
            Blocks = payload.Blocks
        });
        return new { documentId = payload.DocumentId, mutationId = payload.MutationId, clientVersion = version };
    }

    private object ExecuteCommand(HostRequest request)
    {
        var documentId = GetDocumentId(request);
        return new { state = _repository.ExecuteEditorCommand(documentId, request.Payload) };
    }

    private async Task<object?> OpenDocumentAsync(HostRequest request)
    {
        var payload = request.Payload.Deserialize<OpenDocumentPayload>(_json)
            ?? throw new HostRequestException("invalid_payload", "openDocument payload 无效。");
        if (_openDocument is not null) await _openDocument(payload.DocumentId, payload.BlockId);
        return null;
    }

    private async Task<object?> NavigateAsync(bool forward)
    {
        if (_navigate is not null) await _navigate(forward);
        return null;
    }

    private string GetDocumentId(HostRequest request) =>
        request.SourceDocumentId ?? throw new HostRequestException("missing_document", "请求缺少 sourceDocumentId。");

    private static HostResponse Failure(HostRequest request, string code, string message) => new()
    {
        RequestId = request.RequestId,
        Kind = request.Kind,
        Ok = false,
        Error = new HostProtocolError { Code = code, Message = message }
    };

    private sealed class HostRequestException(string code, string message) : Exception(message)
    {
        public string Code { get; } = code;
    }
}
