using System.Reflection;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace WorkEncourager;

/// <summary>无边框小窗外壳：负责窗口、托盘、通知和读写文件，界面和业务都在 web 目录里。</summary>
internal sealed class MainForm : Form
{
    private const string Origin = "https://work-encourager.invalid/";
    private const int ScreenMargin = 16;

    private readonly DataStore _store;
    private readonly AppPaths _paths;
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly NotifyIcon _tray;
    private readonly ToolStripMenuItem _showItem = new("隐藏窗口");
    private readonly ToolStripMenuItem _pinItem = new("窗口置顶");
    private readonly RegisteredWaitHandle _showWait;
    private readonly System.Windows.Forms.Timer _fullscreenTimer = new() { Interval = 1000 };

    private bool _revealed;
    private bool _exiting;
    private bool? _pinned;

    // 窗口是否显示由这三个状态决定：用户藏到了托盘、正在给全屏程序让位、
    // 让位期间用户又手动打开了（这次全屏结束前不再自动隐藏）。
    private bool _userHidden;
    private bool _yielding;
    private bool _yieldOverride;
    private bool _yieldEnabled = true;
    private WindowAnchor _anchor;
    private Size _cssSize = new(324, 280);

    public MainForm(AppPaths paths, EventWaitHandle showSignal)
    {
        _paths = paths;
        _store = new DataStore(paths.DataDir);

        Text = "上班鼓励器";
        Icon = LoadIcon(32);
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        BackColor = Color.FromArgb(23, 25, 29);
        Controls.Add(_web);

        _tray = BuildTray();
        _showWait = ThreadPool.RegisterWaitForSingleObject(showSignal, (_, _) =>
        {
            if (IsHandleCreated) BeginInvoke(ShowByUser);
        }, null, Timeout.Infinite, executeOnlyOnce: false);
        _fullscreenTimer.Tick += (_, _) => CheckFullscreen();

        // 第一次显示推迟到页面就绪，避免闪白。这里先创建句柄，WebView2 才能初始化。
        CreateHandle();
        NativeMethods.UseRoundedCorners(Handle);
        PlaceInitially();
        SystemEvents.DisplaySettingsChanged += OnDisplaySettingsChanged;
        DpiChanged += (_, _) =>
        {
            UpdateAnchor();
            ApplySize(_cssSize);
        };
        ResizeEnd += (_, _) =>
        {
            UpdateAnchor();
            _store.SavePlacement(_anchor);
        };
        InitWebViewAsync();
    }

    /// <summary>显示时不抢焦点，开机自启时不会打断正在做的事。</summary>
    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ClassStyle |= NativeMethods.CS_DROPSHADOW;
            return cp;
        }
    }

    protected override void SetVisibleCore(bool value)
    {
        base.SetVisibleCore(value && _revealed);
        if (IsHandleCreated) _showItem.Text = value && _revealed ? "隐藏窗口" : "显示窗口";
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // Alt+F4 等同点关闭按钮：回到托盘。系统关机和真正退出时才结束。
        if (e.CloseReason == CloseReason.UserClosing && !_exiting)
        {
            e.Cancel = true;
            HideByUser();
            return;
        }
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
            _fullscreenTimer.Dispose();
            _showWait.Unregister(null);
            _tray.Visible = false;
            _tray.Dispose();
        }
        base.Dispose(disposing);
    }

    /* ---------- 托盘 ---------- */
    private NotifyIcon BuildTray()
    {
        _showItem.Click += (_, _) => ToggleVisible();
        _pinItem.Click += (_, _) => SendCommand("togglePin");

        var menu = new ContextMenuStrip();
        menu.Items.Add(_showItem);
        menu.Items.Add(_pinItem);
        menu.Items.Add("切换迷你模式", null, (_, _) => { ShowByUser(); SendCommand("toggleMini"); });
        menu.Items.Add("排班、心愿和记录", null, (_, _) => { ShowByUser(); SendCommand("openPanel"); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, (_, _) => ExitApp());

        var icon = new NotifyIcon
        {
            Icon = LoadIcon(SystemInformation.SmallIconSize.Width),
            Text = "上班鼓励器",
            ContextMenuStrip = menu,
            Visible = true,
        };
        icon.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left) ToggleVisible();
        };
        icon.BalloonTipClicked += (_, _) => ShowByUser();
        return icon;
    }

    private void ToggleVisible()
    {
        if (Visible) HideByUser();
        else ShowByUser();
    }

    private void HideByUser()
    {
        _userHidden = true;
        UpdateVisibility();
    }

    /// <summary>用户明确要看窗口。正在让位时也显示，并且这次全屏结束前不再自动隐藏。</summary>
    private void ShowByUser()
    {
        _userHidden = false;
        if (_yielding)
        {
            _yielding = false;
            _yieldOverride = true;
        }
        UpdateVisibility();
    }

    private void UpdateVisibility()
    {
        if (_userHidden || _yielding)
        {
            Hide();
            return;
        }
        _revealed = true;
        ClampToScreen();
        Show();
    }

    /// <summary>置顶时才需要让位：不置顶的窗口本来就会被全屏程序盖住。</summary>
    private void CheckFullscreen()
    {
        var fullscreen = _yieldEnabled && _pinned == true && FullscreenDetector.IsActive(Handle);
        if (!fullscreen)
        {
            _yieldOverride = false;
            if (_yielding)
            {
                _yielding = false;
                UpdateVisibility();
            }
            return;
        }
        if (!_yielding && !_yieldOverride)
        {
            _yielding = true;
            UpdateVisibility();
        }
    }

    private void ExitApp()
    {
        _exiting = true;
        Close();
    }

    private static Icon LoadIcon(int size)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.ico")
            ?? throw new InvalidOperationException("缺少内嵌图标 app.ico");
        return new Icon(stream, size, size);
    }

    /* ---------- 窗口位置 ---------- */
    private void PlaceInitially()
    {
        var area = Screen.PrimaryScreen?.WorkingArea ?? SystemInformation.WorkingArea;
        _anchor = _store.LoadPlacement()
            ?? new WindowAnchor(new Point(area.Right - ScreenMargin, area.Bottom - ScreenMargin), Right: true, Bottom: true);
        ApplySize(_cssSize);
    }

    /// <summary>
    /// 只在用户拖动窗口后才重新决定锚点：靠近哪个屏幕角就钉住哪个角。
    /// 平时改大小都围绕同一个点，放在右下角时展开面板往左上方长，收起后也能回到原位。
    /// </summary>
    private void UpdateAnchor()
    {
        var area = Screen.FromRectangle(Bounds).WorkingArea;
        var right = Bounds.Left + Bounds.Width / 2 >= area.Left + area.Width / 2;
        var bottom = Bounds.Top + Bounds.Height / 2 >= area.Top + area.Height / 2;
        _anchor = new WindowAnchor(new Point(right ? Bounds.Right : Bounds.Left, bottom ? Bounds.Bottom : Bounds.Top), right, bottom);
    }

    private void ApplySize(Size css)
    {
        _cssSize = css;
        var scale = DeviceDpi / 96d;
        var area = Screen.FromPoint(_anchor.Point).WorkingArea;
        var w = Math.Min((int)Math.Round(css.Width * scale), area.Width);
        var h = Math.Min((int)Math.Round(css.Height * scale), area.Height);
        var x = _anchor.Right ? _anchor.Point.X - w : _anchor.Point.X;
        var y = _anchor.Bottom ? _anchor.Point.Y - h : _anchor.Point.Y;
        Bounds = new Rectangle(x, y, w, h);
        ClampToScreen();
    }

    private void ClampToScreen()
    {
        var area = Screen.FromRectangle(Bounds).WorkingArea;
        var x = Math.Clamp(Bounds.X, area.Left, Math.Max(area.Left, area.Right - Bounds.Width));
        var y = Math.Clamp(Bounds.Y, area.Top, Math.Max(area.Top, area.Bottom - Bounds.Height));
        if (x != Bounds.X || y != Bounds.Y) Location = new Point(x, y);
    }

    private void OnDisplaySettingsChanged(object? sender, EventArgs e)
    {
        if (IsHandleCreated) BeginInvoke(ClampToScreen);
    }

    private void SetPinned(bool pinned)
    {
        if (_pinned == pinned) return;
        _pinned = pinned;
        _pinItem.Checked = pinned;
        NativeMethods.SetTopMost(Handle, pinned);
    }

    private void StartDrag()
    {
        NativeMethods.ReleaseCapture();
        NativeMethods.SendMessage(Handle, NativeMethods.WM_NCLBUTTONDOWN, NativeMethods.HTCAPTION, 0);
    }

    /* ---------- WebView2 ---------- */
    private async void InitWebViewAsync()
    {
        try
        {
            // 窗口藏到托盘后计时也不能被浏览器降频，否则下班提醒会迟到。
            var options = new CoreWebView2EnvironmentOptions(
                "--disable-background-timer-throttling --disable-renderer-backgrounding " +
                "--disable-backgrounding-occluded-windows --autoplay-policy=no-user-gesture-required");
            var env = await CoreWebView2Environment.CreateAsync(null, _paths.WebViewDir, options);
            await _web.EnsureCoreWebView2Async(env);

            var core = _web.CoreWebView2;
            ConfigureSecurity(core);

            core.AddWebResourceRequestedFilter($"{Origin}*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, e) => e.Response = ServeEmbedded(env, e.Request.Uri);
            core.WebMessageReceived += OnWebMessage;
            core.ProcessFailed += (_, e) =>
            {
                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited ||
                    e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                {
                    BeginInvoke(() => core.Reload());
                }
            };

            var boot = JsonSerializer.Serialize(new
            {
                data = _store.Load(),
                autostart = Autostart.IsEnabled(),
                version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3),
                dataDir = _paths.DataDir,
            });
            await core.AddScriptToExecuteOnDocumentCreatedAsync($"window.__HOST__={boot};");
            Autostart.RefreshPath();
            core.Navigate($"{Origin}index.html");
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(
                "这台电脑缺少 Microsoft Edge WebView2 Runtime，程序无法显示界面。\n请到微软官网安装后再打开。",
                "上班鼓励器", MessageBoxButtons.OK, MessageBoxIcon.Error);
            ExitApp();
        }
    }

    private void ConfigureSecurity(CoreWebView2 core)
    {
        var s = core.Settings;
        s.AreDevToolsEnabled = false;
        s.AreDefaultContextMenusEnabled = false;
        s.AreDefaultScriptDialogsEnabled = false;
        s.AreBrowserAcceleratorKeysEnabled = false;
        s.AreHostObjectsAllowed = false;
        s.IsZoomControlEnabled = false;
        s.IsPinchZoomEnabled = false;
        s.IsSwipeNavigationEnabled = false;
        s.IsStatusBarEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        s.IsPasswordAutosaveEnabled = false;

        // 这是一个纯本地程序：不跳转到外部网页、不开新窗口、不下载、不申请任何权限。
        core.NavigationStarting += (_, e) =>
        {
            if (!e.Uri.StartsWith(Origin, StringComparison.Ordinal)) e.Cancel = true;
        };
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.DownloadStarting += (_, e) => e.Cancel = true;
        core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
    }

    private static CoreWebView2WebResourceResponse ServeEmbedded(CoreWebView2Environment env, string uri)
    {
        var name = new Uri(uri).AbsolutePath.TrimStart('/');
        var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream($"web/{name}");
        if (stream is null)
            return env.CreateWebResourceResponse(null, 404, "Not Found", "");

        var type = Path.GetExtension(name) switch
        {
            ".html" => "text/html; charset=utf-8",
            ".js" => "text/javascript; charset=utf-8",
            ".css" => "text/css; charset=utf-8",
            _ => "application/octet-stream",
        };
        return env.CreateWebResourceResponse(stream, 200, "OK", $"Content-Type: {type}\r\nCache-Control: no-store");
    }

    private void SendCommand(string name)
    {
        _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "command", name }));
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!e.Source.StartsWith(Origin, StringComparison.Ordinal)) return;
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var msg = doc.RootElement;
            switch (msg.GetProperty("type").GetString())
            {
                case "ready":
                    CheckFullscreen();
                    UpdateVisibility();
                    _fullscreenTimer.Start();
                    break;
                case "save":
                    _store.Save(msg.GetProperty("data").GetString() ?? "");
                    break;
                case "window":
                    SetPinned(msg.GetProperty("topmost").GetBoolean());
                    _yieldEnabled = msg.GetProperty("yieldFullscreen").GetBoolean();
                    ApplySize(new Size(msg.GetProperty("width").GetInt32(), msg.GetProperty("height").GetInt32()));
                    break;
                case "drag":
                    StartDrag();
                    break;
                case "hide":
                    HideByUser();
                    break;
                case "quit":
                    ExitApp();
                    break;
                case "notify":
                    Notify(msg);
                    break;
                case "tooltip":
                    var text = msg.GetProperty("text").GetString() ?? "";
                    _tray.Text = text.Length > 127 ? text[..127] : text;
                    break;
                case "autostart":
                    SetAutostart(msg.GetProperty("enabled").GetBoolean());
                    break;
            }
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException or IOException or UnauthorizedAccessException)
        {
            // 单条消息处理失败（比如存档被占用）不能让程序崩溃。把失败写进托盘提示，方便发现。
            _tray.ShowBalloonTip(5000, "上班鼓励器", $"操作失败：{ex.Message}", ToolTipIcon.Warning);
        }
    }

    private void Notify(JsonElement msg)
    {
        var title = msg.GetProperty("title").GetString() ?? "上班鼓励器";
        var body = msg.GetProperty("body").GetString() ?? "";
        if (msg.TryGetProperty("popup", out var popup) && popup.GetBoolean())
        {
            // 下班提醒要把托盘里的窗口叫出来。正在全屏时不打扰，等全屏结束再显示。
            _userHidden = false;
            UpdateVisibility();
        }
        _tray.ShowBalloonTip(8000, title, body, ToolTipIcon.Info);
    }

    private void SetAutostart(bool enabled)
    {
        Autostart.Set(enabled);
        _web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "autostart", enabled = Autostart.IsEnabled() }));
    }
}
