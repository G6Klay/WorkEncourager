using System.Runtime.CompilerServices;

namespace WorkEncourager;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        // 要先于任何用到 WebView2 类型的方法，所以真正的启动逻辑放在单独的方法里。
        EmbeddedDependencies.InstallResolver();
        Run();
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Run()
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

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            EmbeddedDependencies.PrepareLoader(paths.DataDir);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            MessageBox.Show($"无法写入数据目录，程序不能启动：\n{e.Message}", "上班鼓励器", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        Application.Run(new MainForm(paths, showSignal));
    }
}
