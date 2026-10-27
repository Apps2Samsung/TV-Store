/* A fake sdbd that speaks enough of the protocol to prove the client: CNXN (no auth), OPEN/OKAY/WRTE/
 * CLSE multiplexing, shell: (echoes a canned reply per command), and sync: SEND/DATA/DONE (reassembles
 * the pushed file and remembers it). Used by the local test; nothing here runs on a TV. */
'use strict';
var Buf = require('../tizen-app/service/compat.js');
var net = require('net');
var CMD = { CNXN:0x4E584E43, AUTH:0x48545541, OPEN:0x4E45504F, OKAY:0x59414B4F, WRTE:0x45545257, CLSE:0x45534C43 };
function sum32(b){var s=0;for(var i=0;i<b.length;i++)s=(s+b[i])>>>0;return s;}
function frame(c,a0,a1,p){p=p||Buf.alloc(0);var h=Buf.alloc(24);h.writeUInt32LE(c>>>0,0);h.writeUInt32LE(a0>>>0,4);h.writeUInt32LE(a1>>>0,8);h.writeUInt32LE(p.length>>>0,12);h.writeUInt32LE(sum32(p)>>>0,16);h.writeUInt32LE((c^0xffffffff)>>>0,20);return Buffer.concat([h,p]);}

function start(port, opts, onReady) {
    opts = opts || {};
    var received = {};   // remotePath -> Buffer (what the client pushed)
    var srv = net.createServer(function (sock) {
        var connected = false, buf = Buf.alloc(0), nextRemote = 1000;
        var chans = {};  // remoteId -> {clientId, service, syncBuf, syncState}
        function send(c,a0,a1,p){ sock.write(frame(c,a0,a1,p)); }
        sock.on('data', function (d) {
            buf = Buffer.concat([buf, d]);
            while (buf.length >= 24) {
                var len = buf.readUInt32LE(12); if (buf.length < 24+len) break;
                var f = { command: buf.readUInt32LE(0), arg0: buf.readUInt32LE(4), arg1: buf.readUInt32LE(8), payload: buf.slice(24,24+len) };
                buf = buf.slice(24+len); handle(f);
            }
        });
        function handle(f) {
            if (f.command === CMD.CNXN) {
                if (opts.requireAuth) { send(CMD.AUTH, 1, 0, Buf.from('token')); return; }
                connected = true; send(CMD.CNXN, 0x01000000, 256*1024, Buf.from('device::fake')); return;
            }
            if (f.command === CMD.OPEN) {
                var clientId = f.arg0, service = f.payload.toString('binary').replace(/\u0000$/, '');
                var remoteId = nextRemote++;
                chans[remoteId] = { clientId: clientId, remoteId: remoteId, service: service, syncBuf: Buf.alloc(0), file: null };
                send(CMD.OKAY, remoteId, clientId);
                if (service.indexOf('shell:') === 0) {
                    var cmd = service.slice(6);
                    var reply = (opts.shell && opts.shell(cmd)) || ('ok: ' + cmd + '\n');
                    send(CMD.WRTE, remoteId, clientId, Buf.from(reply));
                    // client will OKAY; then we close
                    chans[remoteId].closeAfterOkay = true;
                }
                return;
            }
            // Inbound frames address the destination (us) in arg1; arg0 is the sender's (client) id.
            var ch = chans[f.arg1];
            if (f.command === CMD.OKAY) {
                if (ch && ch.closeAfterOkay) { send(CMD.CLSE, ch.remoteId, ch.clientId); delete chans[ch.remoteId]; }
                return;
            }
            if (f.command === CMD.WRTE) {
                if (!ch) return;
                send(CMD.OKAY, ch.remoteId, ch.clientId);
                if (ch.service.indexOf('sync:') === 0) handleSync(ch, ch.remoteId, f.payload);
                return;
            }
            if (f.command === CMD.CLSE) { if (ch) { send(CMD.CLSE, ch.remoteId, ch.clientId); delete chans[ch.remoteId]; } return; }
        }
        function handleSync(ch, remoteId, payload) {
            ch.syncBuf = Buffer.concat([ch.syncBuf, payload]);
            while (ch.syncBuf.length >= 8) {
                var id = ch.syncBuf.slice(0,4).toString('ascii'); var n = ch.syncBuf.readUInt32LE(4);
                if (ch.syncBuf.length < 8+n) break;
                var body = ch.syncBuf.slice(8,8+n); ch.syncBuf = ch.syncBuf.slice(8+n);
                if (id === 'SEND') { var s = body.toString('utf8'); ch.path = s.slice(0, s.lastIndexOf(',')); ch.file = Buf.alloc(0); }
                else if (id === 'DATA') { ch.file = Buffer.concat([ch.file, body]); }
                else if (id === 'DONE') { received[ch.path] = ch.file; var ok = Buf.alloc(8); ok.write('OKAY',0,'ascii'); ok.writeUInt32LE(0,4); send(CMD.WRTE, remoteId, ch.clientId, ok); }
            }
        }
    });
    srv.listen(port, '127.0.0.1', function () { onReady({ server: srv, received: received }); });
}
module.exports = { start: start };
