using System.Runtime.InteropServices;

namespace WorkEncourager;

internal static partial class NativeMethods
{
    public const int WM_NCLBUTTONDOWN = 0x00A1;
    public const int HTCAPTION = 2;
    public const int CS_DROPSHADOW = 0x00020000;

    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWCP_ROUND = 2;
    private const nint HWND_TOPMOST = -1;
    private const nint HWND_NOTOPMOST = -2;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint GW_HWNDNEXT = 2;
    private const int GWL_STYLE = -16;
    private const int GWL_EXSTYLE = -20;
    private const int DWMWA_CLOAKED = 14;

    public const long WS_CAPTION = 0x00C00000;
    public const long WS_EX_TOPMOST = 0x00000008;
    public const long WS_EX_TRANSPARENT = 0x00000020;
    public const long WS_EX_TOOLWINDOW = 0x00000080;
    public const long WS_EX_NOACTIVATE = 0x08000000;

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left, Top, Right, Bottom;
    }

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool ReleaseCapture();

    [LibraryImport("user32.dll", EntryPoint = "SendMessageW")]
    public static partial nint SendMessage(nint hWnd, int msg, nint wParam, nint lParam);

    [LibraryImport("dwmapi.dll")]
    private static partial int DwmSetWindowAttribute(nint hwnd, int attribute, ref int value, int size);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool SetWindowPos(nint hWnd, nint hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

    [LibraryImport("user32.dll", EntryPoint = "GetTopWindow")]
    private static partial nint GetTopWindowCore(nint hWnd);

    [LibraryImport("user32.dll")]
    private static partial nint GetWindow(nint hWnd, uint command);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool IsWindowVisible(nint hWnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool IsIconic(nint hWnd);

    [LibraryImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static partial nint GetWindowLongPtr(nint hWnd, int index);

    [LibraryImport("user32.dll", EntryPoint = "GetWindowRect")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetWindowRectCore(nint hWnd, out NativeRect rect);

    [LibraryImport("user32.dll", EntryPoint = "GetClassNameW")]
    private static unsafe partial int GetClassName(nint hWnd, char* name, int maxCount);

    [LibraryImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static partial int DwmGetWindowAttributeInt(nint hwnd, int attribute, out int value, int size);

    public static nint GetTopWindow() => GetTopWindowCore(0);

    public static nint GetNextWindow(nint hWnd) => GetWindow(hWnd, GW_HWNDNEXT);

    public static long GetStyle(nint hWnd) => GetWindowLongPtr(hWnd, GWL_STYLE);

    public static long GetExStyle(nint hWnd) => GetWindowLongPtr(hWnd, GWL_EXSTYLE);

    public static Rectangle GetBounds(nint hWnd) =>
        GetWindowRectCore(hWnd, out var r) ? Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom) : Rectangle.Empty;

    /// <summary>被系统隐藏但仍标记为可见的窗口，比如其他虚拟桌面上的窗口和后台的商店应用。</summary>
    public static bool IsCloaked(nint hWnd) =>
        DwmGetWindowAttributeInt(hWnd, DWMWA_CLOAKED, out var cloaked, sizeof(int)) == 0 && cloaked != 0;

    public static unsafe string ClassNameOf(nint hWnd)
    {
        const int capacity = 64;
        var buffer = stackalloc char[capacity];
        var length = GetClassName(hWnd, buffer, capacity);
        return length > 0 ? new string(buffer, 0, length) : "";
    }

    /// <summary>切换置顶但不激活窗口。Form.TopMost 的实现会激活窗口，抢走用户正在打字的焦点。</summary>
    public static void SetTopMost(nint hwnd, bool topMost)
    {
        SetWindowPos(hwnd, topMost ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    /// <summary>无边框窗口默认是直角，这里请系统按 Win11 风格画圆角；旧系统不支持时忽略。</summary>
    public static void UseRoundedCorners(nint hwnd)
    {
        var preference = DWMWCP_ROUND;
        _ = DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref preference, sizeof(int));
    }
}
