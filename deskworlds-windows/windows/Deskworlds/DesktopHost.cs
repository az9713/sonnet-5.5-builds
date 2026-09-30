using static Deskworlds.Native;

namespace Deskworlds;

/// <summary>
/// Finds the window that sits between the still wallpaper picture and the desktop icons,
/// so a scene parented to it is drawn under the icons and files stay clickable.
/// </summary>
internal static class DesktopHost
{
    public readonly record struct Slot(IntPtr Parent, IntPtr InsertAfter);

    public static Slot? Find()
    {
        var progman = FindWindow("Progman", null);
        if (progman == IntPtr.Zero) return null;

        // Ask Explorer to create the WorkerW that hosts the wallpaper picture.
        SendMessageTimeout(progman, WM_SPAWN_WORKER, UIntPtr.Zero, IntPtr.Zero, SMTO_NORMAL, 1000, out _);
        SendMessageTimeout(progman, WM_SPAWN_WORKER, new UIntPtr(0xD), new IntPtr(1), SMTO_NORMAL, 1000, out _);

        // Windows 11 24H2 and later keep the icon layer and the wallpaper layer as children
        // of Progman itself. Sit directly below the icons and above the wallpaper picture.
        var defView = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (defView != IntPtr.Zero) return new Slot(progman, defView);

        // Earlier builds: the icons live in one top-level WorkerW and the picture in the
        // WorkerW that follows it.
        var worker = IntPtr.Zero;
        EnumWindows((top, _) =>
        {
            if (FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null) == IntPtr.Zero) return true;
            worker = FindWindowEx(IntPtr.Zero, top, "WorkerW", null);
            return false;
        }, IntPtr.Zero);
        return worker != IntPtr.Zero ? new Slot(worker, HWND_BOTTOM) : null;
    }

    /// <summary>Parents a form to the desktop and gives it exactly the monitor's rectangle.</summary>
    public static bool Attach(Form form, Rectangle monitor)
    {
        var slot = Find();
        if (slot is null) return false;
        var handle = form.Handle;

        SetParent(handle, slot.Value.Parent);
        var style = GetWindowLong(handle, GWL_STYLE);
        SetWindowLong(handle, GWL_STYLE, (style & ~WS_POPUP & ~WS_CAPTION) | WS_CHILD | WS_VISIBLE);
        // Never take focus, never show on the taskbar or in Alt-Tab.
        var ex = GetWindowLong(handle, GWL_EXSTYLE);
        SetWindowLong(handle, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);

        // A child is positioned in its parent's client coordinates; the parent spans the
        // whole virtual desktop, whose origin is negative with a monitor left of the primary.
        var origin = new POINT { X = monitor.X, Y = monitor.Y };
        ScreenToClient(slot.Value.Parent, ref origin);
        return SetWindowPos(handle, slot.Value.InsertAfter, origin.X, origin.Y, monitor.Width, monitor.Height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED);
    }
}
