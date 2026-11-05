using System.Web.Script.Serialization;

namespace WorkEncourager;

/// <summary>.NET Framework 自带的 JSON 读写，不用多带一个 DLL。</summary>
internal static class Json
{
    private static JavaScriptSerializer Create() => new() { MaxJsonLength = int.MaxValue };

    public static string Serialize(object value) => Create().Serialize(value);

    /// <summary>解析 JSON 对象。内容不合法时抛 ArgumentException 或 InvalidOperationException。</summary>
    public static Dictionary<string, object?> ParseObject(string json) =>
        Create().DeserializeObject(json) as Dictionary<string, object?>
        ?? throw new InvalidOperationException("JSON 不是对象");

    /// <summary>只检查是不是合法 JSON。</summary>
    public static bool IsValid(string json)
    {
        try
        {
            Create().DeserializeObject(json);
            return true;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException)
        {
            return false;
        }
    }
}
