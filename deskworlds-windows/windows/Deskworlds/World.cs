using System.Text.Json;
using System.Text.Json.Serialization;

namespace Deskworlds;

/// <summary>The scenes the app can show, each a directory under scenes/ with a wallpaper.html.</summary>
internal enum World { Riverscape, Reefscape, Bettascape, Plasmascape, Slimescape, Pelagicscape, Aurorascape, Cosmoscape }

internal static class Worlds
{
    public static string Folder(this World w) => w.ToString().ToLowerInvariant();

    public static string Title(this World w) => w switch
    {
        World.Riverscape => "Riverbed",
        World.Reefscape => "Coral reef",
        World.Bettascape => "Betta",
        World.Plasmascape => "Plasma globe",
        World.Slimescape => "Slime mould",
        World.Pelagicscape => "Pelagic",
        World.Aurorascape => "Aurora fjord",
        _ => "Cosmic web",
    };

    /// <summary>Only worlds with something to eat have anything to feed.</summary>
    public static bool CanFeed(this World w) => w is World.Riverscape or World.Reefscape or World.Bettascape or World.Slimescape;

    public static string Page(this World w) => $"/scenes/{w.Folder()}/wallpaper.html";

    /// <summary>What shows before the page has drawn anything, matched to each scene's own dark.</summary>
    public static Color Background(this World w) => w switch
    {
        World.Riverscape => Color.FromArgb(8, 14, 12),
        World.Reefscape => Color.FromArgb(11, 24, 37),
        World.Pelagicscape => Color.FromArgb(0, 3, 8),
        World.Cosmoscape => Color.FromArgb(1, 2, 5),
        _ => Color.Black,
    };
}

/// <summary>The world and pause choices, which outlive a restart.</summary>
internal sealed class Settings
{
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public World World { get; set; } = World.Riverscape;

    /// <summary>Null until somebody has decided; that is what lets a machine that asks for
    /// less motion start still without overruling anyone who has since chosen otherwise.</summary>
    public bool? Paused { get; set; }

    public static string Directory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Deskworlds");

    private static string FilePath => Path.Combine(Directory, "settings.json");

    public static Settings Load()
    {
        try { return JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath)) ?? new(); }
        catch { return new(); }
    }

    public void Save()
    {
        try
        {
            System.IO.Directory.CreateDirectory(Directory);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this));
        }
        catch (Exception e) { Log.Write($"could not save settings: {e.Message}"); }
    }
}

internal static class Log
{
    private static readonly object Gate = new();
    private static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Deskworlds", "deskworlds.log");

    public static void Write(string line)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
                // A log that only ever grows is a leak; start over when it gets large.
                var info = new FileInfo(FilePath);
                if (info.Exists && info.Length > 512 * 1024) info.Delete();
                File.AppendAllText(FilePath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {line}{Environment.NewLine}");
            }
        }
        catch { /* logging must never take the wallpaper down */ }
    }
}
