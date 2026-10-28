using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace TVStore
{
    /// <summary>
    /// The log, on disk with the previous run's next to it, readable at /log.txt — the same
    /// file pair the Node service keeps (tvstore.log, tvstore.prev.log).
    /// </summary>
    internal static class Log
    {
        private static readonly object Gate = new object();
        private static readonly List<string> Lines = new List<string>();
        private static string _file, _prev;

        public static void Init(string dataDir)
        {
            if (string.IsNullOrEmpty(dataDir)) return;
            lock (Gate)
            {
                _file = Path.Combine(dataDir, "tvstore.log");
                _prev = Path.Combine(dataDir, "tvstore.prev.log");
                try { if (File.Exists(_file)) File.Move(_file, _prev, true); } catch { }
                try { File.AppendAllText(_file, string.Join("\n", Lines) + (Lines.Count > 0 ? "\n" : "")); } catch { }
            }
        }

        public static void Add(string message)
        {
            string line = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") + " " + message;
            lock (Gate)
            {
                Lines.Add(line);
                if (Lines.Count > 300) Lines.RemoveAt(0);
                if (_file == null) return;
                try { if (new FileInfo(_file).Length > 512 * 1024) File.Move(_file, _prev, true); } catch { }
                try { File.AppendAllText(_file, line + "\n"); } catch { }
            }
        }

        public static string[] Recent()
        {
            lock (Gate) return Lines.ToArray();
        }

        public static string Text()
        {
            var sb = new StringBuilder();
            lock (Gate)
            {
                try { sb.Append("--- previous run ---\n").Append(File.ReadAllText(_prev)).Append('\n'); } catch { }
                try { sb.Append("--- this run ---\n").Append(File.ReadAllText(_file)); }
                catch { sb.Append("--- this run (memory) ---\n").Append(string.Join("\n", Lines)).Append('\n'); }
            }
            return sb.ToString();
        }
    }
}
