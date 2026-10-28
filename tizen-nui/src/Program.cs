using System;
using System.Text;
using System.Threading;
using Tizen.Applications;
using Tizen.NUI;
using Tizen.NUI.BaseComponents;

namespace TVStore
{
    internal sealed class App : NUIApplication
    {
        private Window _window;
        private TextLabel _status;
        private WebView _web;
        private volatile string _probeReport = "(probe running)";
        private volatile string _pageReport = "(page has not reported)";

        private static void Main(string[] args)
        {
            // First, before anything that can fail: on a set with no shell the socket is the
            // only way to read what happened.
            Server.Start();
            new App().Run(args);
        }

        protected override void OnCreate()
        {
            base.OnCreate();
            Log.Init(SafeDataDir());
            Log.Add("TV-Store NUI starting, .NET " + Environment.Version + ", this TV " + Server.OwnIp());
            Server.Handler = Handle;

            _window = GetDefaultWindow();
            _window.BackgroundColor = new Color(0.039f, 0.043f, 0.055f, 1f);
            _window.KeyEvent += OnKey;

            _status = new TextLabel("TV-Store NUI probe")
            {
                Position = new Position(60, 40),
                Size = new Size(1800, 760),
                PointSize = 13,
                TextColor = Color.White,
                MultiLine = true,
            };
            _window.Add(_status);

            try
            {
                _web = new WebView
                {
                    Position = new Position(60, 820),
                    Size = new Size(1800, 220),
                };
                _web.EnableJavaScript = true;
                _window.Add(_web);
                string page = Current.DirectoryInfo.Resource + "probe.html";
                Log.Add("web view: loading " + page);
                _web.LoadUrl("file://" + page);
            }
            catch (Exception e)
            {
                Log.Add("web view failed: " + e);
            }

            new Thread(() =>
            {
                _probeReport = Probe.Run();
                RunOnMain(Refresh);
            }) { IsBackground = true }.Start();
            Refresh();
        }

        private static string SafeDataDir()
        {
            try { return Current.DirectoryInfo.Data; } catch { return null; }
        }

        private void Refresh()
        {
            string ip = Server.OwnIp() ?? "(no network)";
            string verdict = Probe.Passed == null ? "Testing... (about 30 seconds)"
                : Probe.Passed == true ? "RESULT: WORKS. This TV can run TV-Store as an app. Thank you!"
                : "RESULT: DOES NOT WORK. Please check the Host PC IP below, restart the TV and try again; if it still fails, send a photo of this screen.";
            _status.Text = "TV-Store for Tizen 9/10: test build (it installs nothing)\n\n" + verdict + "\n\n" +
                           "This TV: " + ip + ". Developer Mode's Host PC IP must be " + ip + " (then restart the TV).\n" +
                           "Log for a bug report: http://" + ip + ":" + Server.Port + "/log.txt   Back closes this app.\n\n" +
                           "Details:\n" + _probeReport + "\npage: " + _pageReport;
        }

        private static void RunOnMain(Action a)
        {
            // Back onto the main loop; DALi objects may only be touched there.
            CoreApplication.Post(a);
        }

        private Server.Response Handle(Server.Request req)
        {
            if (req.Path == "/log.txt") return Server.Response.Text(200, Log.Text());
            if (!Server.FromThisTv(req.Peer)) return Server.Response.Text(403, "only this TV may use TV-Store");
            if (req.Path == "/ping")
                return Json("{\"ok\":true,\"service\":\"tv-store\",\"runtime\":\"nui\",\"ownIp\":\"" + Server.OwnIp() + "\"}");
            if (req.Path == "/probe") return Server.Response.Text(200, _probeReport + "\npage: " + _pageReport + "\n");
            if (req.Path == "/page-report" && req.Method == "POST")
            {
                _pageReport = Encoding.UTF8.GetString(req.Body);
                Log.Add("page: " + _pageReport);
                RunOnMain(Refresh);
                return Json("{\"ok\":true}");
            }
            return null;
        }

        private static Server.Response Json(string json) =>
            new Server.Response { Body = Encoding.UTF8.GetBytes(json) };

        private void OnKey(object sender, Window.KeyEventArgs e)
        {
            if (e.Key.State == Key.StateType.Down && (e.Key.KeyPressedName == "XF86Back" || e.Key.KeyPressedName == "Escape"))
                Exit();
        }
    }
}
