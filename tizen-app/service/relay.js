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
 * and an optional allow list pins it to specific client IPs. ES5, so it runs on the TV's Node 4.4 too.
 */
'use strict';
var net = require('net');

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

function Relay(opts) {
    opts = opts || {};
    this.bindHost = opts.bindHost || '0.0.0.0';
    this.sdbHost = opts.sdbHost || '127.0.0.1';
    this.sdbPort = opts.sdbPort || 26101;
    this.allow = normList(opts.allow);
    this.log = typeof opts.log === 'function' ? opts.log : function () {};
    this._server = null;
    this._sessions = [];       // { client, upstream } for every live relayed connection
    this._listening = false;
    this._port = null;
    this._error = null;
}

// Tear down one relayed connection and forget it. Destroying either end is enough; both are called
// on close so the pair never lingers half open.
Relay.prototype._drop = function (session) {
    try { session.client.destroy(); } catch (e) {}
    try { session.upstream.destroy(); } catch (e) {}
    var i = this._sessions.indexOf(session);
    if (i >= 0) this._sessions.splice(i, 1);
};

Relay.prototype.setAllow = function (allow) { this.allow = normList(allow); };

Relay.prototype.start = function (port, cb) {
    var self = this;
    if (self._server) { if (cb) cb(null, self._port); return self; }
    self._error = null;
    var server = net.createServer(function (client) {
        var ip = client.remoteAddress ? String(client.remoteAddress).replace(/^::ffff:/, '') : '';
        if (self.allow.length && self.allow.indexOf(ip) < 0) {
            self.log('relay: refused ' + (ip || 'a client') + ' (not in the allow list)');
            try { client.destroy(); } catch (e) {}
            return;
        }
        var upstream = net.connect(self.sdbPort, self.sdbHost);
        var session = { client: client, upstream: upstream };
        self._sessions.push(session);
        client.pipe(upstream);
        upstream.pipe(client);
        client.on('error', function () { self._drop(session); });
        upstream.on('error', function (e) { self.log('relay: upstream ' + self.sdbHost + ':' + self.sdbPort + ' error: ' + e.message); self._drop(session); });
        client.on('close', function () { self._drop(session); });
        upstream.on('close', function () { self._drop(session); });
    });
    self._server = server;
    server.on('error', function (e) {
        self._listening = false;
        self._error = e.message;
        self._server = null;
        self.log('relay: cannot listen on ' + self.bindHost + ':' + port + ': ' + e.message);
        if (cb) { var f = cb; cb = null; f(e); }
    });
    server.listen(port, self.bindHost, function () {
        self._listening = true;
        self._port = server.address().port;
        self.log('relay: listening on ' + self.bindHost + ':' + self._port + ' -> ' + self.sdbHost + ':' + self.sdbPort + ', ' + (self.allow.length ? 'allow ' + self.allow.join(', ') : 'any LAN client'));
        if (cb) { var g = cb; cb = null; g(null, self._port); }
    });
    return self;
};

// Destroy every live session first, then the listener. server.close() alone keeps accepted sockets
// open, so listening:false would not mean every session is gone (the gap TV-Store#52 calls out).
Relay.prototype.stop = function () {
    var live = this._sessions.slice();
    for (var i = 0; i < live.length; i++) this._drop(live[i]);
    this._sessions = [];
    if (this._server) { try { this._server.close(); } catch (e) {} this._server = null; }
    this._listening = false;
    this._port = null;
};

Relay.prototype.status = function () {
    return { listening: this._listening, port: this._port, sessions: this._sessions.length, allow: this.allow.slice(), error: this._error };
};

module.exports = { Relay: Relay, normList: normList };
