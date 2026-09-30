using Deskworlds;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        // One wallpaper at a time; a second launch just does nothing.
        using var single = new Mutex(true, @"Local\Deskworlds.SingleInstance", out var first);
        if (!first) return 0;

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.ThreadException += (_, e) => Log.Write($"unhandled: {e.Exception}");

        var root = FindSceneRoot();
        if (root is null)
        {
            MessageBox.Show("Deskworlds cannot find its scenes folder next to the program.", "Deskworlds",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        // --window      show a normal window instead of drawing behind the desktop icons
        // --world NAME  riverscape, reefscape, bettascape or plasmascape, for this run only
        var windowed = args.Contains("--window");
        World? forced = null;
        var at = Array.IndexOf(args, "--world");
        if (at >= 0 && at + 1 < args.Length && Enum.TryParse<World>(args[at + 1], true, out var w)) forced = w;

        Application.Run(new Controller(root, forced, windowed));
        return 0;
    }

    /// <summary>The bundled copy next to the exe, or, running from a source checkout, the project itself.</summary>
    private static string? FindSceneRoot()
    {
        var env = Environment.GetEnvironmentVariable("DESKWORLDS_SCENE_ROOT");
        if (env is not null && File.Exists(Path.Combine(env, "scenes", "riverscape", "wallpaper.html"))) return env;
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            foreach (var candidate in new[] { Path.Combine(dir.FullName, "scene"), dir.FullName })
                if (File.Exists(Path.Combine(candidate, "scenes", "riverscape", "wallpaper.html"))) return candidate;
        }
        return null;
    }
}
