using System.Reflection;
using System.Security.Cryptography;
using Microsoft.Web.WebView2.Core;

namespace WorkEncourager;

/// <summary>
/// 让程序只有一个 exe：WebView2 的托管 DLL 从内嵌资源直接加载到内存；
/// 原生的 WebView2Loader.dll 必须是磁盘上的文件，启动时释放到数据目录。
/// </summary>
internal static class EmbeddedDependencies
{
    private const string LoaderFile = "WebView2Loader.dll";

    /// <summary>必须在第一次用到 WebView2 类型之前调用。</summary>
    public static void InstallResolver()
    {
        AppDomain.CurrentDomain.AssemblyResolve += (_, args) =>
        {
            var name = new AssemblyName(args.Name).Name;
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream($"deps/{name}.dll");
            return stream is null ? null : Assembly.Load(ReadAll(stream));
        };
    }

    public static void PrepareLoader(string dataDir)
    {
        var resource = $"loader/{LoaderArchitecture()}/{LoaderFile}";
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource)
            ?? throw new InvalidOperationException($"缺少内嵌文件 {resource}");
        var bytes = ReadAll(stream);

        // 目录名带内容哈希：升级后不会和旧版本冲突，也不用覆盖可能正在使用的文件。
        var folder = Path.Combine(dataDir, "runtime", Hash(bytes));
        var path = Path.Combine(folder, LoaderFile);
        Directory.CreateDirectory(folder);
        // 每次启动都比对内容，文件被改动或损坏时用内嵌的版本恢复。
        if (!File.Exists(path) || !bytes.SequenceEqual(File.ReadAllBytes(path)))
            File.WriteAllBytes(path, bytes);

        CoreWebView2Environment.SetLoaderDllFolderPath(folder);
    }

    /// <summary>这个环境变量反映当前进程的架构，模拟运行时也是准确的。</summary>
    private static string LoaderArchitecture() =>
        Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE")?.ToUpperInvariant() switch
        {
            "X86" => "x86",
            "ARM64" => "arm64",
            _ => "x64",
        };

    private static byte[] ReadAll(Stream stream)
    {
        using var buffer = new MemoryStream();
        stream.CopyTo(buffer);
        return buffer.ToArray();
    }

    private static string Hash(byte[] bytes)
    {
        using var sha = SHA256.Create();
        return BitConverter.ToString(sha.ComputeHash(bytes), 0, 8).Replace("-", "");
    }
}
