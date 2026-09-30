using System.Reflection;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace Deskworlds;

/// <summary>Owns one wallpaper per monitor, the tray icon, and every reason to draw less or stop.</summary>
internal sealed class Controller : ApplicationContext
{
    private static readonly HashSet<string> IgnoredClasses = new(StringComparer.OrdinalIgnoreCase)
    {
        "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow",
        "XamlExplorerHostIslandWindow", "TopLevelWindowForOverflowXamlIsland",
    };
    private static readonly Point Nowhere = new(int.MinValue, int.MinValue);

    private readonly Settings _settings = Settings.Load();
    private readonly string _sceneRoot;
    private readonly bool _windowed;
    private readonly List<Wallpaper> _screens = new();
    private readonly NotifyIcon _tray;
    private readonly ToolStripMenuItem _state = new() { Enabled = false };
    private readonly ToolStripMenuItem _pause = new();
    private readonly ToolStripMenuItem _feed = new("Feed");
    private readonly ToolStripMenuItem _autostart = new("Start with Windows");
    private readonly Dictionary<World, ToolStripMenuItem> _worldItems = new();
    private readonly PowerWindow _power;
    private readonly System.Windows.Forms.Timer _pointerTimer = new();
    private readonly System.Windows.Forms.Timer _exposureTimer = new() { Interval = 1000 };
    private CoreWebView2Environment? _environment;
    private Rectangle[] _layout = Array.Empty<Rectangle>();
    private World _world;
    private bool _awake = true, _displayOn = true, _stopped, _building;
    private int _applied, _pointerRate;
    private Point _lastPoint = Nowhere;

    public Controller(string sceneRoot, World? forced, bool windowed)
    {
        _sceneRoot = sceneRoot;
        _windowed = windowed;
        _world = forced ?? _settings.World;
        // Reduce Motion decides how the wallpaper starts and never more than that.
        _stopped = _settings.Paused ?? Native.ReduceMotion();

        _tray = new NotifyIcon
        {
            Icon = LoadIcon(),
            Text = $"Deskworlds · {_world.Title()}",
            Visible = true,
            ContextMenuStrip = BuildMenu(),
        };
        _tray.MouseClick += (_, e) =>
        {
            // NotifyIcon opens its menu on right click only; a left click should too.
            if (e.Button != MouseButtons.Left) return;
            typeof(NotifyIcon).GetMethod("ShowContextMenu", BindingFlags.Instance | BindingFlags.NonPublic)
                ?.Invoke(_tray, null);
        };

        _power = new PowerWindow(
            displayOn => { _displayOn = displayOn; ApplyRate(); },
            () => OnUi(ReattachAll));
        _pointerTimer.Tick += (_, _) => TrackPointer();
        _exposureTimer.Tick += (_, _) => ApplyRate();

        SystemEvents.DisplaySettingsChanged += (_, _) => OnUi(ScreensChanged);
        SystemEvents.PowerModeChanged += (_, e) =>
        {
            if (e.Mode == PowerModes.Suspend) OnUi(() => { _awake = false; ApplyRate(); });
            else if (e.Mode == PowerModes.Resume) OnUi(() => { _awake = true; ApplyRate(); });
            else if (e.Mode == PowerModes.StatusChange) OnUi(ApplyRate);
        };
        SystemEvents.SessionSwitch += (_, e) =>
        {
            switch (e.Reason)
            {
                case SessionSwitchReason.SessionLock:
                case SessionSwitchReason.ConsoleDisconnect:
                case SessionSwitchReason.RemoteDisconnect:
                    OnUi(() => { _awake = false; ApplyRate(); });
                    break;
                case SessionSwitchReason.SessionUnlock:
                case SessionSwitchReason.ConsoleConnect:
                case SessionSwitchReason.RemoteConnect:
                case SessionSwitchReason.SessionLogon:
                    OnUi(() => { _awake = true; ApplyRate(); });
                    break;
            }
        };
        SystemEvents.UserPreferenceChanged += (_, e) =>
        {
            if (e.Category != UserPreferenceCategory.Accessibility || _settings.Paused is not null) return;
            OnUi(() => { _stopped = Native.ReduceMotion(); ApplyRate(); });
        };

        _ui.Post(_ => _ = BuildAsync(), null);
    }

    private bool Still => _stopped || LowPower || !_awake || !_displayOn;
    private bool LowPower => Power().SystemStatusFlag == 1; // Battery saver.
    private bool OnBattery => Power().ACLineStatus == 0;

    private static Native.SYSTEM_POWER_STATUS Power() =>
        Native.GetSystemPowerStatus(out var status) ? status : new() { ACLineStatus = 255 };

    // Posts to the UI thread once the message loop runs, which is after this constructor.
    private readonly SynchronizationContext _ui = new WindowsFormsSynchronizationContext();
    private void OnUi(Action action) => _ui.Post(_ => action(), null);

    // MARK: - Building the screens

    private async Task BuildAsync()
    {
        if (_building) return;
        _building = true;
        try
        {
            foreach (var screen in _screens) screen.Dispose();
            _screens.Clear();
            _layout = Screen.AllScreens.Select(s => s.Bounds).ToArray();

            _environment ??= await CoreWebView2Environment.CreateAsync(
                null,
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Deskworlds", "WebView2"),
                new CoreWebView2EnvironmentOptions
                {
                    // Chromium stops drawing a window it thinks is covered, and a window
                    // behind the desktop icons always looks covered. The host works out
                    // what is really visible instead.
                    AdditionalBrowserArguments =
                        "--disable-features=CalculateNativeWinOcclusion " +
                        "--disable-backgrounding-occluded-windows --disable-renderer-backgrounding " +
                        "--disable-background-timer-throttling",
                });

            foreach (var screen in Screen.AllScreens)
            {
                var wallpaper = new Wallpaper(screen, _world, _windowed);
                _screens.Add(wallpaper);
                await wallpaper.StartAsync(_environment, _sceneRoot);
            }
            ApplyRate();
        }
        catch (WebView2RuntimeNotFoundException)
        {
            Fail("The Microsoft Edge WebView2 Runtime is not installed.\n\n" +
                 "Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and start Deskworlds again.");
        }
        catch (Exception e)
        {
            Log.Write($"build failed: {e}");
            Fail($"Deskworlds could not start its scene.\n\n{e.Message}\n\nDetails are in %LOCALAPPDATA%\\Deskworlds\\deskworlds.log");
        }
        finally { _building = false; }
    }

    private void Fail(string message)
    {
        MessageBox.Show(message, "Deskworlds", MessageBoxButtons.OK, MessageBoxIcon.Error);
        ExitThread();
    }

    private void ScreensChanged()
    {
        // Putting a full-screen window on a monitor is itself a display change, so the
        // arrangement is compared before anything is rebuilt.
        if (Screen.AllScreens.Select(s => s.Bounds).SequenceEqual(_layout)) return;
        _ = BuildAsync();
    }

    private void ReattachAll()
    {
        // Explorer restarted, so the window the scenes hung from is gone.
        Task.Delay(1500).ContinueWith(_ => OnUi(() => { foreach (var s in _screens) s.Reattach(); }));
    }

    // MARK: - Frame rate policy

    /// <summary>
    /// Full speed while the wallpaper is in plain sight, a slow beat when windows leave only
    /// part of it showing, and nothing behind a full screen of work or a dark display.
    /// </summary>
    private void ApplyRate()
    {
        var battery = OnBattery;
        var full = battery ? 30 : 60;
        var still = Still;
        var blockers = still ? new List<Native.RECT>() : WindowBlockers();
        _applied = 0;
        var changed = false;
        for (var i = 0; i < _screens.Count; i++)
        {
            var showing = Exposure(_screens[i].Monitor, blockers);
            var rate = still || showing < 0.15 ? 0 : showing < 0.4 ? 20 : full;
            _screens[i].SetPower(battery);
            if (_screens[i].SetRate(rate)) changed = true;
            _applied = Math.Max(_applied, rate);
        }
        if (changed) _lastPoint = Nowhere;
        UpdateTimers(pollExposure: !still);
    }

    private void UpdateTimers(bool pollExposure)
    {
        // Pointer sampling need not outrun the animation, nor wake a stopped wallpaper.
        var wanted = Math.Min(30, _applied);
        if (wanted != _pointerRate)
        {
            _pointerRate = wanted;
            _pointerTimer.Stop();
            if (wanted > 0)
            {
                _pointerTimer.Interval = Math.Max(1, 1000 / wanted);
                _pointerTimer.Start();
            }
        }
        // Keep this low-frequency check going while merely covered so uncovering resumes.
        if (pollExposure && !_exposureTimer.Enabled) _exposureTimer.Start();
        else if (!pollExposure && _exposureTimer.Enabled) _exposureTimer.Stop();
    }

    /// <summary>Ordinary application windows, in physical pixels, that could cover the desktop.</summary>
    private static List<Native.RECT> WindowBlockers()
    {
        var list = new List<Native.RECT>();
        var me = (uint)Environment.ProcessId;
        Native.EnumWindows((hWnd, _) =>
        {
            if (!Native.IsWindowVisible(hWnd) || Native.IsIconic(hWnd)) return true;
            Native.GetWindowThreadProcessId(hWnd, out var pid);
            if (pid == me) return true;
            // Windows on other virtual desktops and suspended UWP windows are "cloaked".
            if (Native.DwmGetWindowAttribute(hWnd, Native.DWMWA_CLOAKED, out int cloaked, sizeof(int)) == 0 && cloaked != 0)
                return true;
            var ex = Native.GetWindowLong(hWnd, Native.GWL_EXSTYLE);
            if ((ex & (Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE)) != 0) return true;
            if (!Native.HasTitle(hWnd) || IgnoredClasses.Contains(Native.ClassName(hWnd))) return true;
            if (Native.DwmGetWindowAttribute(hWnd, Native.DWMWA_EXTENDED_FRAME_BOUNDS, out Native.RECT rect,
                    Marshal.SizeOf<Native.RECT>()) != 0 && !Native.GetWindowRect(hWnd, out rect))
                return true;
            if (rect.Width > 50 && rect.Height > 50) list.Add(rect);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    /// <summary>How much of a monitor windows leave uncovered, from none (0) to all of it (1).</summary>
    private static double Exposure(Rectangle monitor, List<Native.RECT> blockers)
    {
        if (blockers.Count == 0) return 1;
        const int columns = 16, rows = 10;
        var free = 0;
        for (var c = 0; c < columns; c++)
        for (var r = 0; r < rows; r++)
        {
            var x = monitor.X + (int)(monitor.Width * (c + 0.5) / columns);
            var y = monitor.Y + (int)(monitor.Height * (r + 0.5) / rows);
            if (!blockers.Any(b => x >= b.Left && x < b.Right && y >= b.Top && y < b.Bottom)) free++;
        }
        return free / (double)(columns * rows);
    }

    /// <summary>The cursor belongs to Explorer, so its position is read rather than captured.</summary>
    private void TrackPointer()
    {
        if (!Native.GetCursorPos(out var p)) return;
        var point = new Point(p.X, p.Y);
        if (Math.Abs(point.X - _lastPoint.X) < 1 && Math.Abs(point.Y - _lastPoint.Y) < 1) return;
        _lastPoint = point;
        foreach (var screen in _screens)
            screen.SetPointer(screen.Monitor.Contains(point) ? point : null);
    }

    // MARK: - The tray menu

    private ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();
        var worlds = new ToolStripMenuItem("World");
        foreach (var world in Enum.GetValues<World>())
        {
            var item = new ToolStripMenuItem(world.Title()) { Tag = world };
            item.Click += (_, _) => SelectWorld(world);
            worlds.DropDownItems.Add(item);
            _worldItems[world] = item;
        }
        _feed.Click += (_, _) => { foreach (var s in _screens) s.Feed(); };
        _pause.Click += (_, _) =>
        {
            _stopped = !_stopped;
            _settings.Paused = _stopped;
            _settings.Save();
            ApplyRate();
        };
        _autostart.Click += (_, _) => Autostart.Set(!Autostart.Enabled);
        var quit = new ToolStripMenuItem("Quit");
        quit.Click += (_, _) => ExitThread();

        menu.Items.AddRange(new ToolStripItem[]
        {
            _state, new ToolStripSeparator(), worlds, new ToolStripSeparator(),
            _feed, _pause, _autostart, new ToolStripSeparator(), quit,
        });
        // The items say for themselves when they are available.
        menu.Opening += (_, _) => RefreshMenu();
        return menu;
    }

    /// <summary>Says what the wallpaper is doing, and why, whenever the menu is opened.</summary>
    private void RefreshMenu()
    {
        foreach (var (world, item) in _worldItems) item.Checked = world == _world;
        _state.Text = LowPower ? "Still, for Battery Saver"
            : _stopped ? (Native.ReduceMotion() && _settings.Paused is null ? "Paused, for Reduced animations" : "Paused")
            : !_awake || !_displayOn ? "Still, the screen is off or locked"
            : _applied == 0 ? "Resting behind your windows"
            : $"Running at {_applied} frames a second";
        _pause.Text = _stopped ? "Resume" : "Pause";
        // Nothing will draw under Battery Saver, so the item would be a false promise.
        _pause.Enabled = !LowPower;
        _feed.Enabled = _applied > 0 && _world.CanFeed();
        _autostart.Checked = Autostart.Enabled;
    }

    private void SelectWorld(World chosen)
    {
        if (chosen == _world) return;
        _world = chosen;
        _settings.World = chosen;
        _settings.Save();
        _tray.Text = $"Deskworlds · {chosen.Title()}";
        _ = BuildAsync();
    }

    private static Icon LoadIcon()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("deskworlds.ico");
        return stream is null ? SystemIcons.Application : new Icon(stream);
    }

    protected override void ExitThreadCore()
    {
        _pointerTimer.Stop();
        _exposureTimer.Stop();
        _tray.Visible = false;
        _tray.Dispose();
        foreach (var screen in _screens) screen.Dispose();
        _power.DestroyHandle();
        base.ExitThreadCore();
    }
}

/// <summary>Start with Windows, as a per-user Run entry.</summary>
internal static class Autostart
{
    private const string Key = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string Name = "Deskworlds";

    public static bool Enabled
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(Key);
            return key?.GetValue(Name) is string;
        }
    }

    public static void Set(bool on)
    {
        using var key = Registry.CurrentUser.CreateSubKey(Key);
        if (on) key.SetValue(Name, $"\"{Environment.ProcessPath}\"");
        else key.DeleteValue(Name, throwOnMissingValue: false);
    }
}

/// <summary>A hidden window that hears about the display turning off and Explorer restarting.</summary>
internal sealed class PowerWindow : NativeWindow
{
    private const int WM_POWERBROADCAST = 0x218;
    private const int PBT_POWERSETTINGCHANGE = 0x8013;
    private static readonly Guid ConsoleDisplayState = new("6fe69556-704a-47a0-8f24-c28d936fda47");

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr RegisterPowerSettingNotification(IntPtr hRecipient, ref Guid setting, int flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint RegisterWindowMessage(string name);

    private readonly Action<bool> _displayChanged;
    private readonly Action _explorerRestarted;
    private readonly uint _taskbarCreated = RegisterWindowMessage("TaskbarCreated");

    public PowerWindow(Action<bool> displayChanged, Action explorerRestarted)
    {
        _displayChanged = displayChanged;
        _explorerRestarted = explorerRestarted;
        CreateHandle(new CreateParams { Caption = "DeskworldsMessages", Parent = new IntPtr(-3) /* HWND_MESSAGE */ });
        var guid = ConsoleDisplayState;
        RegisterPowerSettingNotification(Handle, ref guid, 0 /* DEVICE_NOTIFY_WINDOW_HANDLE */);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_POWERBROADCAST && m.WParam.ToInt32() == PBT_POWERSETTINGCHANGE)
        {
            // POWERBROADCAST_SETTING: a GUID, a length, then the data. 0 off, 1 on, 2 dimmed.
            if (Marshal.PtrToStructure<Guid>(m.LParam) == ConsoleDisplayState)
                _displayChanged(Marshal.ReadInt32(m.LParam, 20) != 0);
        }
        else if (_taskbarCreated != 0 && m.Msg == _taskbarCreated) _explorerRestarted();
        base.WndProc(ref m);
    }
}
