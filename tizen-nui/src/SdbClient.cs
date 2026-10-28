using System;
using System.IO;
using System.Net.Sockets;
using System.Text;

namespace TVStore
{
    /// <summary>
    /// Minimal SDB client: a port of tizen-app/service/sdb.js (itself from TizenSdb.Core's
    /// SdbTcpDevice) — the CNXN handshake, OPEN/OKAY/WRTE/CLSE, shell: and the sync: push.
    /// Used one stream at a time, so it reads frames synchronously as each step needs them.
    /// Like the JS client it does not do the RSA AUTH exchange: sdbd answers CNXN without auth
    /// once Developer Mode's Host PC IP is the TV's own address, and an AUTH is reported as such.
    /// </summary>
    internal sealed class SdbClient : IDisposable
    {
        private const uint CNXN = 0x4E584E43, AUTH = 0x48545541, OPEN = 0x4E45504F, OKAY = 0x59414B4F, WRTE = 0x45545257, CLSE = 0x45534C43;
        private const uint ClientVersion = 0x01000000, MaxData = 256 * 1024;

        private readonly TcpClient _tcp;
        private readonly NetworkStream _stream;
        private uint _nextLocalId = 1;

        /// <summary>What sdbd said about itself in its CNXN ("device::..."), for the log.</summary>
        public string Banner { get; private set; }

        private struct Frame
        {
            public uint Command, Arg0, Arg1;
            public byte[] Payload;
        }

        private SdbClient(TcpClient tcp)
        {
            _tcp = tcp;
            _stream = tcp.GetStream();
        }

        public static SdbClient Connect(string host, int port = 26101, int timeoutMs = 15000)
        {
            var tcp = new TcpClient();
            try
            {
                if (!tcp.ConnectAsync(host, port).Wait(timeoutMs)) throw new IOException("sdb connect to " + host + ":" + port + " timed out");
                tcp.ReceiveTimeout = timeoutMs;
                tcp.SendTimeout = timeoutMs;
                var c = new SdbClient(tcp);
                c.Send(CNXN, ClientVersion, MaxData, Encoding.ASCII.GetBytes("host::sdb-net-client"));
                while (true)
                {
                    Frame f;
                    try { f = c.Read(); }
                    catch (IOException e) { throw new IOException("sdbd closed the connection after CNXN (" + e.Message + ")", e); }
                    if (f.Command == CNXN) { c.Banner = Encoding.UTF8.GetString(f.Payload).TrimEnd('\0'); return c; }
                    if (f.Command == AUTH) throw new IOException("sdbd requires key auth on this set; set Developer Mode Host PC IP to the TV's own IP");
                }
            }
            catch (AggregateException e)
            {
                tcp.Dispose();
                throw new IOException("sdb socket error: " + e.InnerException.Message, e.InnerException);
            }
            catch
            {
                tcp.Dispose();
                throw;
            }
        }

        /// <summary>shell:command — every byte of output until sdbd closes the stream.</summary>
        public string Shell(string command)
        {
            uint local = _nextLocalId++, remote = Open("shell:" + command + "\0", local);
            var output = new MemoryStream();
            while (true)
            {
                Frame f = Read();
                if (f.Arg1 != local) continue;
                if (f.Command == WRTE) { output.Write(f.Payload, 0, f.Payload.Length); Send(OKAY, local, remote, null); }
                else if (f.Command == CLSE) { Send(CLSE, local, remote, null); break; }
            }
            return Encoding.UTF8.GetString(output.ToArray());
        }

        /// <summary>sync: push of a stream to remotePath, mode 0644. Mirrors tizen-sdb PushAsync.</summary>
        public void Push(string remotePath, Stream data)
        {
            uint local = _nextLocalId++, remote = Open("sync:\0", local);
            try
            {
                SyncPacket(local, remote, "SEND", Encoding.UTF8.GetBytes(remotePath + "," + 0x81a4));
                var chunk = new byte[64 * 1024];
                int n;
                while ((n = data.Read(chunk, 0, chunk.Length)) > 0)
                {
                    var part = new byte[n];
                    Buffer.BlockCopy(chunk, 0, part, 0, n);
                    SyncPacket(local, remote, "DATA", part);
                }
                SyncPacket(local, remote, "DONE", BitConverter.GetBytes((uint)DateTimeOffset.UtcNow.ToUnixTimeSeconds()));

                var reply = new MemoryStream();
                while (true)
                {
                    Frame f = Read();
                    if (f.Arg1 != local) continue;
                    if (f.Command == CLSE) throw new IOException("sync closed before it answered");
                    if (f.Command != WRTE) continue;
                    Send(OKAY, local, remote, null);
                    reply.Write(f.Payload, 0, f.Payload.Length);
                    if (reply.Length < 8) continue;
                    byte[] r = reply.ToArray();
                    string id = Encoding.ASCII.GetString(r, 0, 4);
                    if (id == "OKAY") return;
                    if (id == "FAIL")
                    {
                        int len = (int)BitConverter.ToUInt32(r, 4);
                        if (r.Length < 8 + len) continue;
                        throw new IOException("sync FAIL: " + Encoding.UTF8.GetString(r, 8, len));
                    }
                    throw new IOException("sync answered " + id);
                }
            }
            finally
            {
                try { Send(CLSE, local, remote, null); } catch { }
            }
        }

        private uint Open(string service, uint local)
        {
            Send(OPEN, local, 0, Encoding.ASCII.GetBytes(service));
            while (true)
            {
                Frame f = Read();
                if (f.Arg1 != local) continue;
                if (f.Command == OKAY) return f.Arg0;
                if (f.Command == CLSE) throw new IOException("sdbd refused " + service.TrimEnd('\0'));
            }
        }

        // One sync packet in one WRTE, then the device's OKAY before the next.
        private void SyncPacket(uint local, uint remote, string id, byte[] payload)
        {
            var p = new byte[8 + payload.Length];
            Encoding.ASCII.GetBytes(id, 0, 4, p, 0);
            BitConverter.GetBytes((uint)payload.Length).CopyTo(p, 4);
            Buffer.BlockCopy(payload, 0, p, 8, payload.Length);
            Send(WRTE, local, remote, p);
            while (true)
            {
                Frame f = Read();
                if (f.Arg1 != local) continue;
                if (f.Command == OKAY) return;
                if (f.Command == CLSE) throw new IOException("sync closed during " + id);
                if (f.Command == WRTE)
                {
                    // Only a FAIL arrives before DONE.
                    Send(OKAY, local, remote, null);
                    string text = f.Payload.Length > 8 ? Encoding.UTF8.GetString(f.Payload, 8, f.Payload.Length - 8) : "";
                    throw new IOException("sync FAIL during " + id + ": " + text);
                }
            }
        }

        private void Send(uint command, uint arg0, uint arg1, byte[] payload)
        {
            payload = payload ?? Array.Empty<byte>();
            uint sum = 0;
            foreach (byte b in payload) sum += b;
            var h = new byte[24];
            BitConverter.GetBytes(command).CopyTo(h, 0);
            BitConverter.GetBytes(arg0).CopyTo(h, 4);
            BitConverter.GetBytes(arg1).CopyTo(h, 8);
            BitConverter.GetBytes((uint)payload.Length).CopyTo(h, 12);
            BitConverter.GetBytes(sum).CopyTo(h, 16);
            BitConverter.GetBytes(command ^ 0xffffffff).CopyTo(h, 20);
            _stream.Write(h, 0, 24);
            if (payload.Length > 0) _stream.Write(payload, 0, payload.Length);
        }

        private Frame Read()
        {
            byte[] h = ReadExactly(24);
            return new Frame
            {
                Command = BitConverter.ToUInt32(h, 0),
                Arg0 = BitConverter.ToUInt32(h, 4),
                Arg1 = BitConverter.ToUInt32(h, 8),
                Payload = ReadExactly((int)BitConverter.ToUInt32(h, 12)),
            };
        }

        private byte[] ReadExactly(int n)
        {
            var b = new byte[n];
            int got = 0;
            while (got < n)
            {
                int r = _stream.Read(b, got, n - got);
                if (r <= 0) throw new IOException("connection closed");
                got += r;
            }
            return b;
        }

        public void Dispose()
        {
            _tcp.Dispose();
        }
    }
}
