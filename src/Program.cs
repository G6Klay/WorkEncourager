namespace WorkEncourager;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        var paths = AppPaths.Resolve();

        // 只允许运行一份。再次打开时，通知已经在运行的那一份显示窗口。
        using var mutex = new Mutex(true, $@"Local\WorkEncourager.Instance{paths.InstanceSuffix}", out var isFirst);
        using var showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, $@"Local\WorkEncourager.Show{paths.InstanceSuffix}");
        if (!isFirst)
        {
            showSignal.Set();
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(paths, showSignal));
    }
}
