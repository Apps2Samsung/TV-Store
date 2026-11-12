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
 * Any LAN client that reaches this port can push and install, so the relay is on by default only
 * where nothing else reaches sdbd (Host PC IP at 127.0.0.1, index.js decides), and an optional allow
 * list pins it to specific client IPs. Every relayed connection costs sdbd a
 * connection too, so there is a cap on live sessions and an idle timeout, or a client that connects
 * and never speaks could hold sdbd's slots until the TV's own install path fails. ES5, so it runs on
 * the TV's Node 4.4 too.
 *
 * The sdb protocol has no way to tell the client why its connection died, so a client only ever sees
 * "connection reset" (TV-Store#58). The relay therefore works out what happened to each session (sdbd
 * not listening, sdbd took the connection and closed it without a byte back, sdbd never answered, the
 * allow list, the cap) and keeps the last failure with a reason in words: the log gets it, status()
 * carries it to the TV's Settings screen and to GET /relay for Apps2Samsung.
 */
'use strict';
var net = require('net');

var MAX_SESSIONS = 16;
var IDLE_MS = 30 * 60 * 1000;   // sdb's transport connection sits silent between commands; be generous

// The failure codes status().lastFailure.code can carry, with what each means for the person reading it.
var CODES = {
    SDBD_DOWN: 'nothing listens on the TV\'s sdbd: Developer Mode is off, or the TV needs a restart',
    SDBD_DROPPED: 'the TV\'s sdbd took the connection and closed it without answering: Developer Mode\'s Host PC IP is not 127.0.0.1, or the TV was not restarted after setting it',
    SDBD_BUSY: 'the TV\'s sdbd took the connection and closed it without answering while another connection is open: the TV takes one developer connection at a time',
    SDBD_SILENT: 'the TV\'s sdbd never answered and the client gave up: Developer Mode\'s Host PC IP is not 127.0.0.1, the TV was not restarted after setting it, or sdbd is busy with another connection',
    SDBD_ERROR: 'the connection to the TV\'s sdbd failed',
    NOT_ALLOWED: 'the client is not on the relay\'s allow list',
    BUSY: 'too many sessions are open through the relay already'
};

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
    this.onClient = typeof opts.onClient === 'function' ? opts.onClient : null;   // (ip, allowed) for every connection, before anything else
    this._server = null;
    this._sessions = [];       // { client, upstream, closed } for every live relayed connection
    this._listening = false;
    this._port = null;
    this._error = null;
    this._served = 0;          // sessions in this run that got at least one byte back from sdbd
    this._failures = 0;        // sessions in this run that failed, see CODES
    this._lastFailure = null;  // { at, client, code, reason } of the latest one
}

// One session went wrong: count it, keep it as the last failure, and log it. A session is recorded
// once at most, whichever of the socket events gets there first.
Relay.prototype._fail = function (session, code, detail) {
    if (session && session.outcome) return;
    // sdbd takes one client at a time (#73) and drops the next one the way it drops a wrong Host PC
    // IP. With another session talking to sdbd through this relay, or TV-Store's own install on it
    // (inUse), the drop is that, and saying Host PC IP would send the user to the wrong setting.
    if (code === 'SDBD_DROPPED') {
        var others = this._sessions.filter(function (s) { return s !== session && s.up > 0 && s.ip; }).map(function (s) { return s.ip; });
        var own = this.inUse ? this.inUse() : '';
        if (others.length || own) {
            code = 'SDBD_BUSY';
            var who = others.filter(function (ip, i) { return others.indexOf(ip) === i; }).join(', ');
            detail = (who ? who + ' is connected through the relay' + (own ? ', and ' + own : '') : own)
                + '; ' + (who ? 'close Apps2Samsung there, or wait: an idle connection is closed after ' + Math.round(this.idleMs / 60000) + ' min' : 'try again when it is done');
        }
    }
    if (session) session.outcome = code;
    var client = session && session.ip ? session.ip : '';
    var reason = CODES[code] + (detail ? ' (' + detail + ')' : '');
    this._failures++;
    this._lastFailure = { at: new Date().toISOString(), client: client, code: code, reason: reason };
    this.log('relay: ' + (client || 'a client') + ' failed: ' + reason);
};

Relay.prototype._serve = function (session) {
    if (session.outcome) return;
    session.outcome = 'served';
    this._served++;
};

Relay.prototype._forget = function (session) {
    var i = this._sessions.indexOf(session);
    if (i >= 0) this._sessions.splice(i, 1);
};

// Tear down one relayed connection at once and forget it: for an error, a timeout, or stop(). The
// outcome, when given, says this end was the relay's own doing, so the close events that follow do not
// read it as sdbd dropping the client.
Relay.prototype._drop = function (session, outcome) {
    if (outcome && !session.outcome) session.outcome = outcome;
    try { session.client.destroy(); } catch (e) {}
    try { session.upstream.destroy(); } catch (e) {}
    this._forget(session);
};

Relay.prototype.setAllow = function (allow) { this.allow = normList(allow); };

Relay.prototype._accept = function (client) {
    var self = this;
    var ip = peerIp(client);
    var allowed = !self.allow.length || self.allow.indexOf(ip) >= 0;
    if (self.onClient) { try { self.onClient(ip, allowed); } catch (e) {} }
    if (!allowed) {
        self._fail({ ip: ip }, 'NOT_ALLOWED');
        try { client.destroy(); } catch (e) {}
        return;
    }
    if (self._sessions.length >= self.maxSessions) {
        self._fail({ ip: ip }, 'BUSY', self._sessions.length + ' open');
        try { client.destroy(); } catch (e) {}
        return;
    }
    var upstream = net.connect(self.sdbPort, self.sdbHost);
    // up and down count the bytes each way; connected says the TCP connect to sdbd completed; outcome is
    // set once, 'served' or a failure code. Together they tell what happened when a side goes away.
    var session = { client: client, upstream: upstream, closed: 0, ip: ip, up: 0, down: 0, connected: false, outcome: null, since: Date.now() };
    self._sessions.push(session);
    upstream.on('connect', function () { session.connected = true; });
    client.on('data', function (d) { session.down += d.length; });
    upstream.on('data', function (d) { session.up += d.length; if (!session.outcome) self._serve(session); });
    client.pipe(upstream);
    upstream.pipe(client);
    // When one side closes cleanly the other is ended, not destroyed: pipe() may still hold bytes
    // queued for it (sdbd's last reply to a client that reads slowly), and end() writes those out
    // where destroy() would throw them away. The session is gone once both sides have closed.
    function closed(other) {
        if (++session.closed >= 2) return self._forget(session);
        try { other.end(); } catch (e) {}
    }
    function upstreamFailed(e) {
        var code = e && e.code ? e.code : (e && e.message) || 'error';
        if (!session.connected) return self._fail(session, code === 'ECONNREFUSED' ? 'SDBD_DOWN' : 'SDBD_ERROR', code + ' connecting to ' + self.sdbHost + ':' + self.sdbPort);
        if (!session.up) return self._fail(session, 'SDBD_DROPPED', code);
        self._fail(session, 'SDBD_ERROR', code + ' after ' + session.up + ' bytes from sdbd');
    }
    client.on('error', function () { self._drop(session, 'client-error'); });
    upstream.on('error', function (e) { upstreamFailed(e); self._drop(session); });
    client.on('close', function () {
        // The client went first without a byte back although it had spoken (sent CNXN and waited): sdbd
        // sat on the connection until the client's own timeout. A probe that connects and leaves without
        // a word (Apps2Samsung checks the port that way) is neither served nor failed.
        if (!session.closed && !session.up && session.down && session.connected) self._fail(session, 'SDBD_SILENT', Math.round((Date.now() - session.since) / 1000) + ' s');
        closed(upstream);
    });
    upstream.on('close', function () {
        // sdbd went first without a byte back: it accepted the TCP connection and closed it, which is
        // what it does when the peer address is not its Host PC IP.
        if (!session.closed && !session.up && session.connected) self._fail(session, 'SDBD_DROPPED', 'closed after ' + Math.round(Date.now() - session.since) + ' ms');
        closed(client);
    });
    // Every byte either way passes the client socket, so one timer sees the session's whole activity.
    if (self.idleMs > 0) client.setTimeout(self.idleMs, function () {
        self.log('relay: closed ' + (ip || 'a client') + ' after ' + Math.round(self.idleMs / 60000) + ' min idle');
        self._drop(session, 'idle');
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
    for (var i = 0; i < live.length; i++) this._drop(live[i], 'stopped');
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
    return { listening: this._listening, port: this._port, sessions: this._sessions.length, allow: this.allow.slice(), error: this._error,
             served: this._served, failures: this._failures, lastFailure: this._lastFailure };
};

module.exports = { Relay: Relay, normList: normList, peerIp: peerIp, CODES: CODES };
