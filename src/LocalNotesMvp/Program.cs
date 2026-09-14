using Avalonia;
using Avalonia.WebView.Desktop;

namespace LocalNotesMvp;

internal static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        // Avoid black native-child surfaces on systems where WebView2 GPU composition conflicts with Avalonia.
        Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--disable-gpu --disable-gpu-compositing");
        BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
    }

    public static AppBuilder BuildAvaloniaApp() => AppBuilder.Configure<App>()
        .UsePlatformDetect()
        .LogToTrace()
        .UseDesktopWebView();
}
