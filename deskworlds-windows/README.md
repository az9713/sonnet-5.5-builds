# Deskworlds for Windows

A Windows port of [chaseleantj/deskworlds](https://github.com/chaseleantj/deskworlds) (MIT). The four live 3D worlds (Riverbed, Coral reef, Betta, Plasma globe) are the upstream Three.js scenes, unchanged. What is new is a Windows host that draws them as a desktop wallpaper, in place of the upstream macOS Swift agent. The original README is kept as `README.upstream.md`.

## Run in a browser (no install)

Needs Node.js 20 or newer and a browser with WebGL2 (Edge, Chrome, Firefox).

```bat
windows\run-browser.cmd
```

or `npm start` and open <http://127.0.0.1:8080>. Opening `index.html` directly will not work; the scenes are ES modules and need HTTP.

## Install as the desktop wallpaper

Needs Windows 10 1809 or newer (Windows 11 recommended), the .NET 8 SDK (`winget install Microsoft.DotNet.SDK.8`) and the Edge WebView2 Runtime (already present on Windows 11 and current Windows 10). Then, from the project folder:

```bat
npm run wallpaper
```

or `powershell -ExecutionPolicy Bypass -File windows\install.ps1`. It publishes the host for your CPU (x64 or ARM64), installs it to `%LOCALAPPDATA%\Programs\Deskworlds`, adds a sign-in entry and starts it. Add `-NoAutostart` to skip the sign-in entry.

Prebuilt: every push runs the `deskworlds-windows` GitHub Actions workflow, which uploads a self-contained `Deskworlds-win-x64` artifact. Unzip it anywhere and run `Deskworlds.exe`; it needs no .NET install, only WebView2.

Remove it with `npm run unwallpaper`. Your desktop picture is never changed.

## Use it

Click the Deskworlds icon in the taskbar tray (under `^` if hidden):

- **World** switches every monitor between the four scenes and is remembered.
- **Feed** drops food on every monitor (Riverbed, Coral reef, Betta). Desktop clicks do not feed; use the menu.
- **Pause / Resume** is remembered across restarts. If Windows "Show animations" is off, it starts paused until you choose Resume.
- **Start with Windows** toggles the sign-in entry.
- **Quit** closes it.

Icons, right-click menus and dragging on the desktop keep working: the scene sits behind the icons and never takes mouse input. The host reads the global cursor position and passes it to the page so the creatures still react.

Frame rate follows the same policy as the macOS build:

| Desktop state | Frame rate |
| --- | --- |
| Clearly visible, on mains power | Up to 60 fps, native resolution |
| Clearly visible, on battery | Up to 30 fps, Balanced profile |
| Mostly covered by windows | Up to 20 fps |
| Almost entirely covered | Stopped |
| Battery Saver, locked or disconnected session, sleep, display off | Stopped |

Each monitor gets its own world and its own WebView2, so more monitors cost more power. Nothing leaves your machine: the scenes are served from a local virtual host, the browser profile is InPrivate, and there is no telemetry.

## How the port works

| macOS (upstream) | Windows |
| --- | --- |
| `NSWindow` at `desktopWindow` level | Borderless form parented to Explorer's `WorkerW`/`Progman` (`0x052C` trick, both the pre-24H2 and 24H2 layouts) |
| `WKWebView` + `deskworlds://` scheme handler | WebView2 + `SetVirtualHostNameToFolderMapping("deskworlds.local", ...)` |
| `webkit.messageHandlers.ready` | Shim mapping it onto `chrome.webview.postMessage` (scene code is untouched) |
| `NSEvent.mouseLocation` polled | `GetCursorPos` polled, converted to CSS pixels via the monitor's DPI |
| `CGWindowListCopyWindowInfo` coverage | `EnumWindows` + DWM extended frame bounds, cloaked/tool windows ignored |
| IOKit battery, Low Power Mode | `GetSystemPowerStatus` (AC line, Battery Saver) |
| Screen sleep/lock notifications | `PBT_POWERSETTINGCHANGE` display state, `SessionSwitch`, `PowerModeChanged` |
| Menu bar item | Tray `NotifyIcon` |
| `launchctl` login item | `HKCU\...\Run` entry |

Also fixed for Windows: `npm run check` used a POSIX shell loop (now `tools/check.mjs`), the installer scripts were `sh`, and `tools/bake-live-rock.py` read UTF-8 with the locale codepage.

Debug options: `Deskworlds.exe --window` shows a normal window instead of attaching to the desktop, `--world plasmascape` forces a scene for that run, and `DESKWORLDS_DEVTOOLS=1` enables F12. The log is `%LOCALAPPDATA%\Deskworlds\deskworlds.log`.

## Status

Verified on Linux: the scene syntax check and the full scene test suite pass, and the host C# compiles against the WinForms and WebView2 reference assemblies. **Not yet run on a Windows machine**: desktop attachment, DPI handling on mixed-DPI monitors, and GPU performance are untested until someone runs the CI artifact. The undocumented `WorkerW` mechanism has broken between Windows builds before; if the scene appears as a normal window or not at all, check the log and open an issue with your Windows build number.

Rebuilding the reef's baked meshes (`tools/bake-*.py`) needs Python with numpy, scipy, scikit-image and Pillow, and is only needed if you change the reef layout; the outputs are committed.
