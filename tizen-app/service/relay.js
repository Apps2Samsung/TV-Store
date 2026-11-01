/* On-TV sdb relay (TV-Store#52).
 *
 * A plain TCP proxy: it listens on the LAN and forwards every connection to the TV's own sdbd over
 * loopback. sdbd then sees the connection arrive from 127.0.0.1, so once Developer Mode's Host PC IP
 * is set to 127.0.0.1 one time, any machine on the LAN reaches sdbd through this port whatever its
 * own address is, and the user never re-enters the Host PC IP. It needs no root: it is an ordinary
 * socket the service is allowed to open, and it changes nothing sdbd authorizes. It only normalizes
 * the source address sdbd sees (the decompiled verify_peer_ip compares the peer IP against the stored
 * Host PC IP with an exact strcmp; see TV-Store#52).
 *
 * Any LAN client that reaches this port can push and install, so the relay is off until turned on,
 * and an optional allow list pins it to specific client IPs. Every relayed connection costs sdbd a
 * connection too, so there is a cap on live sessions and an idle timeout, or a client that connects
 * and never speaks could hold sdbd's slots until the TV's own install path fails. ES5, so it runs on
 * the TV's Node 4.4 too.
 */
'use strict';
var net = require('net');

var MAX_SESSIONS = 16;
var IDLE_MS = 30 * 60 * 1000;   // sdb's transport connection sits silent between commands; be generous

// A comma string or an array of IPs -> a clean array; anything else -> [].
function normList(allow) {
    if (!allow) return [];
    if (typeof allow === 'string') allow = allow.split(',');
    if (!Array.isArray(allow)) return [];
    var out = [];
    for (var i = 0; i < allow.length; i++) {
        var ip = String(allow[i]).trim();
        if (ip) out.push(ip);
    }
    return out;
}

// The peer's IPv4 as sdbd and the allow list spell it: Node reports a v4 peer on a dual-stack
// socket as ::ffff:a.b.c.d.
function peerIp(socket) {
    return socket && socket.remoteAddress ? String(socket.remoteAddress).replace(/^::ffff:/, '') : '';
}

function Relay(opts) {
    opts = opts || {};
    this.bindHost = opts.bindHost || '0.0.0.0';
    this.sdbHost = opts.sdbHost || '127.0.0.1';
    this.sdbPort = opts.sdbPort || 26101;
    this.allow = normList(opts.allow);
    this.maxSessions = opts.maxSessions > 0 ? opts.maxSessions : MAX_SESSIONS;
    this.idleMs = opts.idleMs !== undefined ? opts.idleMs : IDLE_MS;   // 0 turns the idle timeout off
    this.log = typeof opts.log === 'function' ? opts.log : function () {};
    this._server = null;
    this._sessions = [];       // { client, upstream, closed } for every live relayed connection
    this._listening = false;
    this._port = null;
    this._error = null;
}

Relay.prototype._forget = function (session) {
    var i = this._sessions.indexOf(session);
    if (i >= 0) this._sessions.splice(i, 1);
};

// Tear down one relayed connection at once and forget it: for an error, a timeout, or stop().
Relay.prototype._drop = function (session) {
    try { session.client.destroy(); } catch (e) {}
    try { session.upstream.destroy(); } catch (e) {}
    this._forget(session);
};

Relay.prototype.setAllow = function (allow) { this.allow = normList(allow); };

Relay.prototype._accept = function (client) {
    var self = this;
    var ip = peerIp(client);
    if (self.allow.length && self.allow.indexOf(ip) < 0) {
        self.log('relay: refused ' + (ip || 'a client') + ' (not in the allow list)');
        try { client.destroy(); } catch (e) {}
        return;
    }
    if (self._sessions.length >= self.maxSessions) {
        self.log('relay: refused ' + (ip || 'a client') + ' (' + self._sessions.length + ' sessions open already)');
        try { client.destroy(); } catch (e) {}
        return;
    }
    var upstream = net.connect(self.sdbPort, self.sdbHost);
    var session = { client: client, upstream: upstream, closed: 0 };
    self._sessions.push(session);
    client.pipe(upstream);
    upstream.pipe(client);
    // When one side closes cleanly the other is ended, not destroyed: pipe() may still hold bytes
    // queued for it (sdbd's last reply to a client that reads slowly), and end() writes those out
    // where destroy() would throw them away. The session is gone once both sides have closed.
    function closed(other) {
        if (++session.closed >= 2) return self._forget(session);
        try { other.end(); } catch (e) {}
    }
    client.on('error', function () { self._drop(session); });
    upstream.on('error', function (e) { self.log('relay: upstream ' + self.sdbHost + ':' + self.sdbPort + ' error: ' + e.message); self._drop(session); });
    client.on('close', function () { closed(upstream); });
    upstream.on('close', function () { closed(client); });
    // Every byte either way passes the client socket, so one timer sees the session's whole activity.
    if (self.idleMs > 0) client.setTimeout(self.idleMs, function () {
        self.log('relay: closed ' + (ip || 'a client') + ' after ' + Math.round(self.idleMs / 60000) + ' min idle');
        self._drop(session);
    });
};

Relay.prototype.start = function (port, cb) {
    var self = this;
    if (self._server) { if (cb) cb(null, self._port); return self; }
    self._error = null;
    var server = net.createServer(function (client) { self._accept(client); });
    self._server = server;
    function once(err, p) { if (cb) { var f = cb; cb = null; f(err, p); } }
    // stop() before the bind completed: Node 20 then drops the pending listen without a word, Node 4
    // completes it (the 'listening' callback below closes the socket again), so the caller is told here.
    server.a2sAbort = function () { once(new Error('stopped before it was listening')); };
    server.on('error', function (e) {
        // Before listening: the bind failed. After: an accept-time error (EMFILE, say) that leaves the
        // socket bound, so close it rather than just forget it, or stop() could never reach it.
        try { server.close(); } catch (x) {}
        if (self._server === server) { self._server = null; self._listening = false; self._port = null; self._error = e.message; }
        self.log('relay: cannot listen on ' + self.bindHost + ':' + port + ': ' + e.message);
        once(e);
    });
    server.listen(port, self.bindHost, function () {
        if (self._server !== server) {
            // stop() ran while the bind was still pending (a tick on Node 4): close() was a no-op
            // then, so close the bound socket now.
            try { server.close(); } catch (x) {}
            return;
        }
        self._listening = true;
        self._port = server.address().port;
        self.log('relay: listening on ' + self.bindHost + ':' + self._port + ' -> ' + self.sdbHost + ':' + self.sdbPort + ', ' + (self.allow.length ? 'allow ' + self.allow.join(', ') : 'any LAN client'));
        once(null, self._port);
    });
    return self;
};

// Destroy every live session first, then the listener. server.close() alone keeps accepted sockets
// open, so listening:false would not mean every session is gone (the gap TV-Store#52 calls out).
Relay.prototype.stop = function () {
    var live = this._sessions.slice();
    for (var i = 0; i < live.length; i++) this._drop(live[i]);
    this._sessions = [];
    var server = this._server, wasListening = this._listening;
    this._server = null;
    this._listening = false;
    if (server) {
        try { server.close(); } catch (e) {}
        if (!wasListening && server.a2sAbort) server.a2sAbort();
    }
    this._port = null;
};

Relay.prototype.status = function () {
    return { listening: this._listening, port: this._port, sessions: this._sessions.length, allow: this.allow.slice(), error: this._error };
};

module.exports = { Relay: Relay, normList: normList, peerIp: peerIp };
