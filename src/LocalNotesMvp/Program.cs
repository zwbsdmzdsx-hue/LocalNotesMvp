using Avalonia;
using Avalonia.WebView.Desktop;
using System.Text.Json;

namespace LocalNotesMvp;

internal static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        if (args.Contains("--acceptance-test"))
            Environment.SetEnvironmentVariable("LOCAL_NOTES_MVP_DB", Path.Combine(Path.GetTempPath(), $"local-notes-acceptance-{Guid.NewGuid():N}.db"));
        if (args.Contains("--diagnostics"))
        {
            var store = new NoteStore();
            store.Load();
            Console.WriteLine(JsonSerializer.Serialize(store.GetTableCounts()));
            return;
        }
        if (args.Contains("--self-test"))
        {
            Console.WriteLine(StorageSelfTest.Run());
            return;
        }
        // Avoid black native-child surfaces on systems where WebView2 GPU composition conflicts with Avalonia.
        Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--disable-gpu --remote-debugging-port=9222");
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    public static AppBuilder BuildAvaloniaApp() => AppBuilder.Configure<App>()
        .UsePlatformDetect()
        .LogToTrace()
        .UseDesktopWebView();
}
