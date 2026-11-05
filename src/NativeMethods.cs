using System.Runtime.InteropServices;
using System.Text;

namespace WorkEncourager;

internal static class NativeMethods
{
    public const int WM_NCLBUTTONDOWN = 0x00A1;
    public const int WM_DPICHANGED = 0x02E0;
    public const int HTCAPTION = 2;
    public const int CS_DROPSHADOW = 0x00020000;

    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWCP_ROUND = 2;
    private const int HWND_TOPMOST = -1;
    private const int HWND_NOTOPMOST = -2;
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
    public struct NativeRect
    {
        public int Left, Top, Right, Bottom;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ReleaseCapture();

    [DllImport("user32.dll", EntryPoint = "SendMessageW")]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int DwmGetWindowAttributeInt(IntPtr hwnd, int attribute, out int value, int size);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll", EntryPoint = "GetTopWindow")]
    private static extern IntPtr GetTopWindowCore(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint command);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hWnd);

    // 样式只用低 32 位。GetWindowLongPtrW 在 32 位系统上不存在，所以用这个两边都有的版本。
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern int GetWindowLong(IntPtr hWnd, int index);

    [DllImport("user32.dll", EntryPoint = "GetWindowRect")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRectCore(IntPtr hWnd, out NativeRect rect);

    [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int maxCount);

    [DllImport("user32.dll", EntryPoint = "GetDpiForWindow")]
    private static extern uint GetDpiForWindowCore(IntPtr hWnd);

    public static IntPtr GetTopWindow() => GetTopWindowCore(IntPtr.Zero);

    public static IntPtr GetNextWindow(IntPtr hWnd) => GetWindow(hWnd, GW_HWNDNEXT);

    public static long GetStyle(IntPtr hWnd) => (uint)GetWindowLong(hWnd, GWL_STYLE);

    public static long GetExStyle(IntPtr hWnd) => (uint)GetWindowLong(hWnd, GWL_EXSTYLE);

    public static Rectangle GetBounds(IntPtr hWnd) =>
        GetWindowRectCore(hWnd, out var r) ? Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom) : Rectangle.Empty;

    /// <summary>被系统隐藏但仍标记为可见的窗口，比如其他虚拟桌面上的窗口和后台的商店应用。</summary>
    public static bool IsCloaked(IntPtr hWnd) =>
        DwmGetWindowAttributeInt(hWnd, DWMWA_CLOAKED, out var cloaked, sizeof(int)) == 0 && cloaked != 0;

    public static string ClassNameOf(IntPtr hWnd)
    {
        var buffer = new StringBuilder(64);
        return GetClassName(hWnd, buffer, buffer.Capacity) > 0 ? buffer.ToString() : "";
    }

    /// <summary>窗口当前的 DPI。旧系统没有这个 API 时按 100% 缩放处理。</summary>
    public static int DpiOf(IntPtr hWnd)
    {
        try
        {
            var dpi = (int)GetDpiForWindowCore(hWnd);
            return dpi > 0 ? dpi : 96;
        }
        catch (EntryPointNotFoundException)
        {
            return 96;
        }
    }

    /// <summary>切换置顶但不激活窗口。Form.TopMost 的实现会激活窗口，抢走用户正在打字的焦点。</summary>
    public static void SetTopMost(IntPtr hwnd, bool topMost)
    {
        SetWindowPos(hwnd, new IntPtr(topMost ? HWND_TOPMOST : HWND_NOTOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    /// <summary>无边框窗口默认是直角，这里请系统按 Win11 风格画圆角；旧系统不支持时忽略。</summary>
    public static void UseRoundedCorners(IntPtr hwnd)
    {
        var preference = DWMWCP_ROUND;
        _ = DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref preference, sizeof(int));
    }
}
