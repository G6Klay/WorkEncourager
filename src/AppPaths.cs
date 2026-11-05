namespace WorkEncourager;

internal sealed record AppPaths(string DataDir, string WebViewDir, string InstanceSuffix)
{
    /// <summary>测试时用环境变量指向独立目录，不碰正式数据，也能和正式程序同时运行。</summary>
    private const string OverrideVariable = "WORK_ENCOURAGER_DATA_DIR";

    public static AppPaths Resolve()
    {
        var overrideDir = Environment.GetEnvironmentVariable(OverrideVariable);
        var isOverride = !string.IsNullOrWhiteSpace(overrideDir);
        var dataDir = isOverride
            ? overrideDir!
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WorkEncourager");
        Directory.CreateDirectory(dataDir);
        return new AppPaths(dataDir, Path.Combine(dataDir, "WebView2"), isOverride ? ".test" : "");
    }
}
