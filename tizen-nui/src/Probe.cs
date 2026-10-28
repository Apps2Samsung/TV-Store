using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;

namespace TVStore
{
    /// <summary>
    /// Phase 0 for this build: can a .NET app on this set reach its own sdbd, run a shell
    /// command and push a file? Tried on every address of the TV, loopback included; the
    /// answer is in the log and at /probe.
    /// </summary>
    internal static class Probe
    {
        private const string Staging = "/home/owner/share/tmp/sdk_tools";

        /// <summary>null while running; then whether one address got the whole way (CNXN, shell, push).</summary>
        public static bool? Passed { get; private set; }

        public static string Run()
        {
            bool passed = false;
            var sb = new StringBuilder();
            sb.Append(Listeners());
            foreach (IPAddress a in Server.OwnAddresses())
            {
                string host = a.ToString();
                sb.Append("== sdbd at ").Append(host).Append(":26101\n");
                var clock = System.Diagnostics.Stopwatch.StartNew();
                try
                {
                    using (SdbClient c = SdbClient.Connect(host, timeoutMs: 8000))
                    {
                        sb.Append("CNXN ok after ").Append(clock.ElapsedMilliseconds).Append(" ms: ").Append(c.Banner).Append('\n');
                        string apps = c.Shell("0 vd_applist");
                        sb.Append("shell 0 vd_applist: ").Append(apps.Length).Append(" bytes: ")
                          .Append(Flat(apps, 160)).Append('\n');
                        string remote = Staging + "/a2s-probe.txt";
                        c.Push(remote, new MemoryStream(Encoding.ASCII.GetBytes("TV-Store NUI probe\n")));
                        sb.Append("push to ").Append(remote).Append(": ok\n");
                        passed = true;
                    }
                }
                catch (Exception e)
                {
                    sb.Append("FAILED after ").Append(clock.ElapsedMilliseconds).Append(" ms: ").Append(e.GetType().Name).Append(": ").Append(e.Message).Append('\n');
                }
            }
            string report = sb.ToString();
            Passed = passed;
            Log.Add("probe: " + (passed ? "PASSED" : "FAILED"));
            foreach (string l in report.Split('\n').Where(l => l.Length > 0)) Log.Add("probe: " + l);
            return report;
        }

        // Who listens on which TCP port, from /proc/net/tcp: a set with no shell has no netstat.
        private static string Listeners()
        {
            var sb = new StringBuilder("listening (port uid inode):");
            try
            {
                foreach (string line in File.ReadAllLines("/proc/net/tcp").Skip(1))
                {
                    string[] f = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (f.Length < 10 || f[3] != "0A") continue;
                    string[] local = f[1].Split(':');
                    uint ip = Convert.ToUInt32(local[0], 16);
                    sb.Append(' ').Append(new IPAddress(ip)).Append(':').Append(Convert.ToInt32(local[1], 16))
                      .Append('/').Append(f[7]).Append('/').Append(f[9]);
                }
            }
            catch (Exception e)
            {
                sb.Append(" unreadable: ").Append(e.Message);
            }
            return sb.Append('\n').ToString();
        }

        private static string Flat(string s, int max)
        {
            s = string.Join(" ", s.Split(new[] { '\r', '\n', '\t', ' ' }, StringSplitOptions.RemoveEmptyEntries));
            return s.Length > max ? s.Substring(0, max) + "..." : s;
        }
    }
}
