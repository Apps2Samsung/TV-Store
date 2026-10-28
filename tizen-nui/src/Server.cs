using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace TVStore
{
    /// <summary>
    /// The HTTP API the page drives, on port 8077 — what the Node service is in the .wgt, on a
    /// thread in this process instead. Plain HTTP/1.1, one request per connection.
    /// </summary>
    internal static class Server
    {
        public const int Port = 8077;

        public sealed class Request
        {
            public string Method, Path;
            public byte[] Body;
            public IPAddress Peer;
        }

        public sealed class Response
        {
            public int Status = 200;
            public string ContentType = "application/json";
            public byte[] Body = Array.Empty<byte>();

            public static Response Text(int status, string text, string type = "text/plain; charset=utf-8") =>
                new Response { Status = status, ContentType = type, Body = Encoding.UTF8.GetBytes(text) };
        }

        /// <summary>Answers a request; null for 404. Runs on the request's own thread.</summary>
        public static Func<Request, Response> Handler;

        private static Thread _thread;

        public static void Start()
        {
            if (_thread != null) return;
            _thread = new Thread(Loop) { IsBackground = true, Name = "http" };
            _thread.Start();
        }

        private static void Loop()
        {
            try
            {
                var listener = new TcpListener(IPAddress.Any, Port);
                listener.Start();
                Log.Add("listening on :" + Port);
                while (true)
                {
                    TcpClient client = listener.AcceptTcpClient();
                    new Thread(() => Serve(client)) { IsBackground = true }.Start();
                }
            }
            catch (Exception e)
            {
                Log.Add("server stopped: " + e.GetType().Name + ": " + e.Message);
            }
        }

        private static void Serve(TcpClient client)
        {
            using (client)
            {
                try
                {
                    client.ReceiveTimeout = 30000;
                    NetworkStream s = client.GetStream();
                    Request req = ReadRequest(s);
                    if (req == null) return;
                    req.Peer = ((IPEndPoint)client.Client.RemoteEndPoint).Address;
                    Response res;
                    if (req.Method == "OPTIONS") res = Response.Text(204, "");
                    else
                    {
                        try { res = Handler?.Invoke(req) ?? Response.Text(404, "not found"); }
                        catch (Exception e) { Log.Add("request " + req.Path + " failed: " + e); res = Response.Text(500, e.Message); }
                    }
                    Write(s, res);
                }
                catch (Exception e)
                {
                    Log.Add("connection: " + e.GetType().Name + ": " + e.Message);
                }
            }
        }

        private static Request ReadRequest(Stream s)
        {
            var head = new MemoryStream();
            int b;
            uint last4 = 0;
            while (last4 != 0x0D0A0D0A)
            {
                if ((b = s.ReadByte()) < 0 || head.Length > 64 * 1024) return null;
                head.WriteByte((byte)b);
                last4 = (last4 << 8) | (uint)b;
            }
            string[] lines = Encoding.ASCII.GetString(head.ToArray()).Split("\r\n");
            string[] first = lines[0].Split(' ');
            if (first.Length < 2) return null;
            int length = 0;
            foreach (string l in lines.Skip(1))
            {
                int c = l.IndexOf(':');
                if (c > 0 && l.Substring(0, c).Trim().Equals("Content-Length", StringComparison.OrdinalIgnoreCase))
                    int.TryParse(l.Substring(c + 1).Trim(), out length);
            }
            if (length < 0 || length > 1024 * 1024) return null;
            var body = new byte[length];
            int got = 0;
            while (got < length)
            {
                int r = s.Read(body, got, length - got);
                if (r <= 0) return null;
                got += r;
            }
            string path = first[1];
            int q = path.IndexOf('?');
            return new Request { Method = first[0], Path = q >= 0 ? path.Substring(0, q) : path, Body = body };
        }

        private static void Write(Stream s, Response res)
        {
            string head = "HTTP/1.1 " + res.Status + " " + Reason(res.Status) + "\r\n" +
                          "Content-Type: " + res.ContentType + "\r\n" +
                          "Content-Length: " + res.Body.Length + "\r\n" +
                          "Access-Control-Allow-Origin: *\r\n" +
                          "Access-Control-Allow-Headers: *\r\n" +
                          "Connection: close\r\n\r\n";
            byte[] h = Encoding.ASCII.GetBytes(head);
            s.Write(h, 0, h.Length);
            s.Write(res.Body, 0, res.Body.Length);
            s.Flush();
        }

        private static string Reason(int status) =>
            status switch { 200 => "OK", 204 => "No Content", 400 => "Bad Request", 403 => "Forbidden", 404 => "Not Found", 502 => "Bad Gateway", _ => "Error" };

        /// <summary>This TV's IPv4 addresses, loopback first: the only peers allowed past /log.txt.</summary>
        public static List<IPAddress> OwnAddresses()
        {
            var all = new List<IPAddress> { IPAddress.Loopback };
            try
            {
                foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces())
                    foreach (UnicastIPAddressInformation a in ni.GetIPProperties().UnicastAddresses)
                        if (a.Address.AddressFamily == AddressFamily.InterNetwork && !all.Contains(a.Address)) all.Add(a.Address);
            }
            catch (Exception e)
            {
                Log.Add("interfaces: " + e.Message);
            }
            return all;
        }

        /// <summary>The TV's LAN address: what sdbd accepts a connection on.</summary>
        public static string OwnIp() =>
            OwnAddresses().FirstOrDefault(a => !IPAddress.IsLoopback(a))?.ToString();

        public static bool FromThisTv(IPAddress peer)
        {
            if (peer.IsIPv4MappedToIPv6) peer = peer.MapToIPv4();
            return IPAddress.IsLoopback(peer) || OwnAddresses().Contains(peer);
        }
    }
}
