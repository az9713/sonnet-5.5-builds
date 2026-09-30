using System.Globalization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Deskworlds;

/// <summary>One monitor's worth of world: a borderless form on the desktop layer holding a WebView2.</summary>
internal sealed class Wallpaper : Form
{
    public const string SceneHost = "deskworlds.local";

    // Installed before any page script runs. start.js reports readiness through the WebKit
    // message handler the macOS build used; this maps it onto WebView2. The pointer is
    // never delivered by the OS (the window sits under the icons), so the host reads the
    // global cursor and hands it to the page as a pointer move.
    private const string Shim = """
        window.webkit = { messageHandlers: { ready: { postMessage: () => chrome.webview.postMessage('ready') } } };
        window.scenePointerCount = 0;
        window.scenePointer = (x, y) => {
          const canvas = document.querySelector('#scene');
          window.scenePointerCount++;
          if (canvas) canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
        };
        window.scenePointerOut = () => {
          const canvas = document.querySelector('#scene');
          if (canvas) canvas.dispatchEvent(new PointerEvent('pointerleave'));
        };
        const report = (text) => chrome.webview.postMessage('report:' + String(text));
        for (const level of ['error', 'warn']) {
          const original = console[level];
          console[level] = (...parts) => {
            report(parts.map((part) => part && part.stack ? part.stack : part).join(' '));
            original.apply(console, parts);
          };
        }
        addEventListener('error', (event) => report(`${event.message} at ${event.filename}:${event.lineno}`));
        addEventListener('unhandledrejection', (event) => report(event.reason));
        """;

    private readonly WebView2 _view = new();
    private readonly Rectangle _monitor;
    private readonly World _world;
    private readonly bool _windowed;
    private bool _loaded, _inside, _battery;
    private int _rate;

    public Rectangle Monitor => _monitor;

    public Wallpaper(Screen screen, World world, bool windowed)
    {
        _monitor = screen.Bounds;
        _world = world;
        _windowed = windowed;

        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        BackColor = world.Background();
        // Created on the target monitor so it takes that monitor's DPI.
        Bounds = windowed
            ? new Rectangle(_monitor.X + 80, _monitor.Y + 80, _monitor.Width * 2 / 3, _monitor.Height * 2 / 3)
            : _monitor;
        Text = "Deskworlds";

        _view.Dock = DockStyle.Fill;
        _view.DefaultBackgroundColor = world.Background();
        _view.AllowExternalDrop = false;
        Controls.Add(_view);
    }

    // The desktop never activates this window, and it must not steal the cursor's clicks.
    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= (int)(Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE);
            return cp;
        }
    }

    public async Task StartAsync(CoreWebView2Environment environment, string sceneRoot)
    {
        Show();
        if (!_windowed && !DesktopHost.Attach(this, _monitor))
        {
            Log.Write("could not find the desktop window to sit behind; running as a plain window at the bottom");
            Native.SetWindowPos(Handle, Native.HWND_BOTTOM, _monitor.X, _monitor.Y, _monitor.Width, _monitor.Height,
                Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW);
        }

        CoreWebView2ControllerOptions? options = null;
        try
        {
            // The page holds no state worth keeping between runs and should leave no traces.
            options = environment.CreateCoreWebView2ControllerOptions();
            options.IsInPrivateModeEnabled = true;
        }
        catch { options = null; }

        if (options is not null) await _view.EnsureCoreWebView2Async(environment, options);
        else await _view.EnsureCoreWebView2Async(environment);

        var web = _view.CoreWebView2;
        web.Settings.AreDefaultContextMenusEnabled = false;
        web.Settings.AreDevToolsEnabled = Environment.GetEnvironmentVariable("DESKWORLDS_DEVTOOLS") == "1";
        web.Settings.IsStatusBarEnabled = false;
        web.Settings.IsZoomControlEnabled = false;
        web.Settings.IsPinchZoomEnabled = false;
        web.Settings.IsSwipeNavigationEnabled = false;
        web.Settings.AreBrowserAcceleratorKeysEnabled = false;
        web.Settings.IsGeneralAutofillEnabled = false;
        web.Settings.IsPasswordAutosaveEnabled = false;

        // The scenes are served exactly as a web server would, so their module imports resolve.
        web.SetVirtualHostNameToFolderMapping(SceneHost, sceneRoot, CoreWebView2HostResourceAccessKind.Allow);
        web.WebMessageReceived += OnMessage;
        web.NavigationCompleted += (_, e) =>
        {
            if (!e.IsSuccess) Log.Write($"the scene did not load: {e.WebErrorStatus}");
        };
        web.ProcessFailed += (_, e) => Log.Write($"web process failed: {e.ProcessFailedKind}; reloading");
        web.ProcessFailed += (_, _) => BeginInvoke(() => { _loaded = false; web.Reload(); });
        await web.AddScriptToExecuteOnDocumentCreatedAsync(Shim);

        // Native: full display resolution on mains power, the Balanced profile on battery.
        web.Navigate($"https://{SceneHost}{_world.Page()}?quality=native");
    }

    private void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        var text = e.TryGetWebMessageAsString();
        if (text == "ready")
        {
            // The scene has installed its callbacks; anything sent earlier would be lost.
            _loaded = true;
            Send();
        }
        else if (text.StartsWith("report:", StringComparison.Ordinal))
            Log.Write($"page ({_world.Title()}): {text[7..]}");
    }

    /// <summary>Called by the controller after Explorer restarts, when the desktop window is new.</summary>
    public void Reattach()
    {
        if (_windowed || !IsHandleCreated) return;
        if (!DesktopHost.Attach(this, _monitor)) Log.Write("could not re-attach to the desktop");
    }

    /// <summary>Send only state changes; the ready message resends once.</summary>
    public bool SetRate(int wanted)
    {
        if (wanted == _rate) return false;
        _rate = wanted;
        if (_rate == 0 && _inside)
        {
            Run("scenePointerOut()");
            _inside = false;
        }
        Log.Write($"{_world.Title()} {_monitor.Width}x{_monitor.Height}: {_rate} fps");
        Send();
        return true;
    }

    public void SetPower(bool onBattery)
    {
        if (_battery == onBattery) return;
        _battery = onBattery;
        Send();
    }

    private void Send()
    {
        if (!_loaded) return;
        Run($"typeof scenePower === 'function' && scenePower({(_battery ? "true" : "false")});" +
            $"typeof sceneRate === 'function' && sceneRate({_rate});");
    }

    /// <summary>Nothing is sent while the scene is stopped, where the food would only pile up unseen.</summary>
    public void Feed()
    {
        if (_loaded && _rate > 0) Run("typeof sceneFeed === 'function' && sceneFeed()");
    }

    /// <summary>A cursor position in this monitor's CSS pixels, or null when the cursor is elsewhere.</summary>
    public void SetPointer(Point? physical)
    {
        if (!_loaded || _rate <= 0) return;
        if (physical is null)
        {
            if (_inside) Run("scenePointerOut()");
            _inside = false;
            return;
        }
        _inside = true;
        var scale = DeviceDpi / 96.0;
        var x = (physical.Value.X - _monitor.X) / scale;
        var y = (physical.Value.Y - _monitor.Y) / scale;
        Run(string.Create(CultureInfo.InvariantCulture, $"scenePointer({x:0.0},{y:0.0})"));
    }

    private void Run(string script)
    {
        var web = _view.CoreWebView2;
        if (web is null) return;
        try { _ = web.ExecuteScriptAsync(script); }
        catch (Exception e) { Log.Write($"script failed: {e.Message}"); }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _view.Dispose();
        base.Dispose(disposing);
    }
}
