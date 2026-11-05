namespace WorkEncourager;

/// <summary>判断小窗所在的屏幕上，是不是正有全屏程序在显示（PPT 放映、全屏视频、游戏）。</summary>
internal static class FullscreenDetector
{
    private const int MinWindowSize = 100;

    /// <summary>
    /// 从最上层往下看窗口。之所以不只看前台窗口：焦点可能在别的屏幕或者远程控制的小面板上，
    /// 这时全屏程序仍然显示着，小窗不该跳出来挡住它。
    /// </summary>
    public static bool IsActive(nint self)
    {
        var screen = Screen.FromHandle(self).Bounds;
        for (var h = NativeMethods.GetTopWindow(); h != 0; h = NativeMethods.GetNextWindow(h))
        {
            if (h == self || !NativeMethods.IsWindowVisible(h) || NativeMethods.IsIconic(h) || NativeMethods.IsCloaked(h)) continue;

            var ex = NativeMethods.GetExStyle(h);
            if ((ex & NativeMethods.WS_EX_TRANSPARENT) != 0) continue; // 鼠标穿透的覆盖层，比如显卡的叠加层

            // 很多程序带隐形的小窗口（阴影、消息窗），不算用户正在用的窗口。
            var rect = NativeMethods.GetBounds(h);
            if (rect.Width < MinWindowSize || rect.Height < MinWindowSize) continue;
            if (!screen.Contains(rect.Left + rect.Width / 2, rect.Top + rect.Height / 2)) continue;

            var cls = NativeMethods.ClassNameOf(h);
            if (cls is "Progman" or "WorkerW") return false; // 已经看到桌面了
            if (cls is "Shell_TrayWnd" or "Shell_SecondaryTrayWnd") continue;

            // 最大化的窗口四周会超出屏幕几个像素，任务栏自动隐藏时也能盖住整个屏幕，
            // 所以盖住之外还要求：大小正好等于屏幕，或者没有标题栏。
            var hasCaption = (NativeMethods.GetStyle(h) & NativeMethods.WS_CAPTION) == NativeMethods.WS_CAPTION;
            if (rect.Contains(screen) && (rect == screen || !hasCaption)) return true;

            // 上面压着一个普通窗口，说明用户正在用它，全屏程序（如果有）被挡住了。
            // 置顶的小挂件和工具窗口不算，继续往下看。
            if ((ex & (NativeMethods.WS_EX_TOPMOST | NativeMethods.WS_EX_TOOLWINDOW | NativeMethods.WS_EX_NOACTIVATE)) == 0) return false;
        }
        return false;
    }
}
