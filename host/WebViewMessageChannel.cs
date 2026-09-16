using System.Text.Json;

namespace LocalNotesMvp;

public static class WebViewMessageChannel
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static JsonDocument Parse(string rawMessage)
    {
        var document = JsonDocument.Parse(rawMessage);
        if (document.RootElement.ValueKind != JsonValueKind.String) return document;
        var nested = document.RootElement.GetString();
        document.Dispose();
        if (string.IsNullOrWhiteSpace(nested)) throw new JsonException("Empty WebView message.");
        return JsonDocument.Parse(nested);
    }

    public static string Serialize(object message) => JsonSerializer.Serialize(message, Json);
}
