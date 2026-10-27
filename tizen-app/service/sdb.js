/* Minimal SDB client for the TV-Store service (#844).
 *
 * Speaks the Samsung sdbd wire protocol (the ADB-derived transport) to sdbd on the TV, over a plain
 * TCP socket the Node service is allowed to open. Ported from TizenSdb.Core (SdbTcpDevice): the CNXN
 * handshake, the OPEN/OKAY/WRTE/CLSE stream multiplexing, the shell: service, and the sync: push.
 *
 * On the sets this targets the probe (#844 phase 0) showed sdbd replies CNXN with NO auth once
 * Developer Mode's Host PC IP is the TV's own address, so this client does not implement the RSA
 * AUTH exchange: if a set ever answers AUTH, connect() rejects with a clear message rather than
 * pretending. Everything here is byte-for-byte what tizen-sdb sends, so a package it pushes and
 * installs is handled exactly as the desktop/phone/CLI would.
 */
'use strict';
var Buf = require('./compat.js');
var net = require('net');

var CMD = { CNXN: 0x4E584E43, AUTH: 0x48545541, OPEN: 0x4E45504F, OKAY: 0x59414B4F, WRTE: 0x45545257, CLSE: 0x45534C43 };
var NAME = {}; Object.keys(CMD).forEach(function (k) { NAME[CMD[k]] = k; });
var CLIENT_VERSION = 0x01000000;
var MAXDATA = 256 * 1024;

function sum32(buf) { var s = 0; for (var i = 0; i < buf.length; i++) s = (s + buf[i]) >>> 0; return s; }

function frame(command, arg0, arg1, payload) {
    payload = payload || Buf.alloc(0);
    var h = Buf.alloc(24);
    h.writeUInt32LE(command >>> 0, 0);
    h.writeUInt32LE(arg0 >>> 0, 4);
    h.writeUInt32LE(arg1 >>> 0, 8);
    h.writeUInt32LE(payload.length >>> 0, 12);
    h.writeUInt32LE(sum32(payload) >>> 0, 16);
    h.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
    return Buffer.concat([h, payload]);
}

// A framed reader: accumulates bytes and emits {command,arg0,arg1,payload} frames.
function Demux(onFrame) {
    var buf = Buf.alloc(0);
    this.push = function (chunk) {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 24) {
            var len = buf.readUInt32LE(12);
            if (buf.length < 24 + len) break;
            var command = buf.readUInt32LE(0), arg0 = buf.readUInt32LE(4), arg1 = buf.readUInt32LE(8);
            var payload = buf.slice(24, 24 + len);
            buf = buf.slice(24 + len);
            onFrame({ command: command, arg0: arg0, arg1: arg1, payload: payload });
        }
    };
}

function SdbClient(host, port) {
    this.host = host;
    this.port = port || 26101;
    this._sock = null;
    this._nextLocalId = 1;
    this._channels = {};        // localId -> channel state
    this._connected = false;
}

SdbClient.prototype.connect = function (cb) {
    var self = this;
    var done = false;
    function finish(err) { if (done) return; done = true; cb(err); }
    var sock = net.connect(this.port, this.host, function () {
        sock.write(frame(CMD.CNXN, CLIENT_VERSION, MAXDATA, Buf.from('host::sdb-net-client')));
    });
    this._sock = sock;
    sock.setTimeout(15000);
    this._demux = new Demux(function (f) { self._onFrame(f, finish); });
    sock.on('data', function (d) { self._demux.push(d); });
    sock.on('timeout', function () { finish(new Error('sdb connect timed out')); });
    sock.on('error', function (e) { finish(new Error('sdb socket error: ' + ((e && e.code) || e.message))); self._failAll(e); });
    sock.on('close', function () { self._connected = false; self._failAll(new Error('connection closed')); });
};

SdbClient.prototype._onFrame = function (f, connectCb) {
    var self = this;
    if (!this._connected) {
        if (f.command === CMD.CNXN) { this._connected = true; if (connectCb) connectCb(null); return; }
        if (f.command === CMD.AUTH) { if (connectCb) connectCb(new Error('sdbd requires key auth on this set; set Developer Mode Host PC IP to the TV’s own IP')); try { this._sock.destroy(); } catch (e) {} return; }
        return;
    }
    var ch = this._channels[f.arg1];   // arg1 = our local id on inbound frames
    if (f.command === CMD.OKAY) { if (ch) { ch.remoteId = f.arg0; if (ch.onReady) { var r = ch.onReady; ch.onReady = null; r(); } else if (ch.pendingWrite) { var w = ch.pendingWrite; ch.pendingWrite = null; w(); } } return; }
    if (f.command === CMD.WRTE) { if (ch) { self._send(CMD.OKAY, ch.localId, ch.remoteId); if (ch.onData) ch.onData(f.payload); } return; }
    if (f.command === CMD.CLSE) { if (ch) { if (ch.onClose) ch.onClose(); delete self._channels[ch.localId]; } return; }
};

SdbClient.prototype._send = function (command, arg0, arg1, payload) { this._sock.write(frame(command, arg0, arg1, payload)); };
SdbClient.prototype._failAll = function (err) { var self = this; Object.keys(this._channels).forEach(function (id) { var ch = self._channels[id]; if (ch.onClose) ch.onClose(err); }); this._channels = {}; };

// Open a stream for a service string ("shell:...\0", "sync:\0"). cb(err, channel).
SdbClient.prototype.open = function (service, handlers, cb) {
    var localId = this._nextLocalId++;
    var ch = { localId: localId, remoteId: 0, onData: handlers.onData, onClose: handlers.onClose, onReady: null };
    this._channels[localId] = ch;
    ch.onReady = function () { cb(null, ch); };
    this._send(CMD.OPEN, localId, 0, Buf.from(service, 'binary'));
};

// Write a chunk to a channel and wait for the device OKAY before the next write.
SdbClient.prototype.write = function (ch, payload, cb) {
    ch.pendingWrite = cb;
    this._send(CMD.WRTE, ch.localId, ch.remoteId, payload);
};

SdbClient.prototype.close = function (ch) { try { this._send(CMD.CLSE, ch.localId, ch.remoteId); } catch (e) {} delete this._channels[ch.localId]; };
SdbClient.prototype.end = function () { try { this._sock.destroy(); } catch (e) {} };

// shell:<command> — collect all output, then callback.
SdbClient.prototype.shell = function (command, cb) {
    var out = [], finished = false;
    function fin(err) { if (finished) return; finished = true; cb(err, Buffer.concat(out).toString('utf8')); }
    this.open('shell:' + command + '\u0000', {
        onData: function (d) { out.push(d); },
        onClose: function (err) { fin(err || null); },
    }, function (err) { if (err) fin(err); });
};

// sync: push to a remote path (mode 0644). Mirrors tizen-sdb PushAsync. data is a Buffer or
// { size, read(offset, length) -> Buffer }, so a package can go straight from a file.
SdbClient.prototype.push = function (remotePath, data, cb) {
    var self = this;
    var reply = Buf.alloc(0), finished = false, chRef = null;
    function finish(err) { if (finished) return; finished = true; if (chRef) { try { self.close(chRef); } catch (e) {} } cb(err || null); }
    function onSync(d) {
        reply = Buffer.concat([reply, d]);
        if (reply.length >= 8) {
            var id = reply.slice(0, 4).toString('ascii');
            if (id === 'OKAY') return finish(null);
            if (id === 'FAIL') { var n = reply.readUInt32LE(4); return finish(new Error('sync FAIL: ' + reply.slice(8, 8 + n).toString('utf8'))); }
        }
    }
    this.open('sync:\u0000', { onData: function (d) { onSync(d); }, onClose: function (err) { if (err) finish(err); } }, function (err, ch) {
        if (err) return cb(err);
        chRef = ch;
        // SEND "<path>,<mode>"
        var target = remotePath + ',' + 0x81a4;   // 0100644
        syncPacket('SEND', Buf.from(target), function () { sendData(0); });
        var size = Buffer.isBuffer(data) ? data.length : data.size;
        function sendData(off) {
            if (off >= size) return doneCmd();
            var end = Math.min(off + 64 * 1024, size), chunk;        // 64 KiB sync chunks
            try { chunk = Buffer.isBuffer(data) ? data.slice(off, end) : data.read(off, end - off); } catch (e) { return finish(e); }
            syncPacket('DATA', chunk, function () { sendData(end); });
        }
        function doneCmd() {
            var mtime = Buf.alloc(4); mtime.writeUInt32LE(Math.floor(Date.now() / 1000) >>> 0, 0);
            syncPacket('DONE', mtime, function () { /* wait for OKAY via onSync */ });
        }
        function syncPacket(cmd4, payload, after) {
            var h = Buf.alloc(8); h.write(cmd4, 0, 'ascii'); h.writeUInt32LE(payload.length >>> 0, 4);
            self.write(ch, Buffer.concat([h, payload]), after);
        }
    });
};

module.exports = { SdbClient: SdbClient, frame: frame, CMD: CMD, NAME: NAME, Demux: Demux, sum32: sum32 };
