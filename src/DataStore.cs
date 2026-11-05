using System.Text;

namespace WorkEncourager;

/// <summary>窗口钉在哪个点上：Point 是固定不动的那个角，Right/Bottom 说明它是右边还是下边的角。</summary>
internal readonly record struct WindowAnchor(Point Point, bool Right, bool Bottom);

/// <summary>把界面层给的 JSON 存到本地。先写临时文件再替换，断电也不会留下写了一半的存档。</summary>
internal sealed class DataStore
{
    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false);

    private readonly string _dataFile;
    private readonly string _backupFile;
    private readonly string _tempFile;
    private readonly string _placementFile;

    public DataStore(string dataDir)
    {
        _dataFile = Path.Combine(dataDir, "data.json");
        _backupFile = Path.Combine(dataDir, "data.json.bak");
        _tempFile = Path.Combine(dataDir, "data.json.tmp");
        _placementFile = Path.Combine(dataDir, "window.json");
    }

    public string? Load()
    {
        var main = ReadValidJson(_dataFile);
        if (main is not null) return main;

        if (File.Exists(_dataFile))
        {
            // 存档损坏时留一份原文件，方便手动抢救，不直接覆盖。
            var keep = $"{_dataFile}.corrupt-{DateTime.Now:yyyyMMddHHmmss}";
            try { File.Move(_dataFile, keep); } catch (IOException) { }
        }
        return ReadValidJson(_backupFile);
    }

    public void Save(string json)
    {
        File.WriteAllText(_tempFile, json, Utf8);
        if (File.Exists(_dataFile))
            File.Replace(_tempFile, _dataFile, _backupFile, ignoreMetadataErrors: true);
        else
            File.Move(_tempFile, _dataFile);
    }

    public WindowAnchor? LoadPlacement()
    {
        try
        {
            if (!File.Exists(_placementFile)) return null;
            var root = Json.ParseObject(File.ReadAllText(_placementFile, Utf8));
            return new WindowAnchor(new Point(Convert.ToInt32(root["x"]), Convert.ToInt32(root["y"])),
                (bool)root["right"]!, (bool)root["bottom"]!);
        }
        catch (Exception e) when (e is IOException or ArgumentException or KeyNotFoundException or InvalidOperationException or InvalidCastException or FormatException or NullReferenceException)
        {
            return null;
        }
    }

    public void SavePlacement(WindowAnchor a)
    {
        try
        {
            File.WriteAllText(_placementFile, Json.Serialize(new { x = a.Point.X, y = a.Point.Y, right = a.Right, bottom = a.Bottom }), Utf8);
        }
        catch (IOException)
        {
            // 窗口位置只是便利信息，写失败不影响使用。
        }
    }

    private static string? ReadValidJson(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            var text = File.ReadAllText(path, Utf8);
            return Json.IsValid(text) ? text : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
