namespace LocalNotesMvp;

internal static class EditorPage
{
    public static string Load()
    {
        var root = Path.Combine(AppContext.BaseDirectory, "web");
        var html = File.ReadAllText(Path.Combine(root, "index.html"));
        var css = File.ReadAllText(Path.Combine(root, "style.css"));
        var js = File.ReadAllText(Path.Combine(root, "main.js"));
        return html
            .Replace("<link rel=\"stylesheet\" href=\"style.css\">", $"<style>{css}</style>", StringComparison.Ordinal)
            .Replace("<script type=\"module\" src=\"main.js\"></script>", $"<script>{js}</script>", StringComparison.Ordinal);
    }
}
