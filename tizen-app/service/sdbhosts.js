/* The addresses to try the TV's own sdbd on, in order (#26, #52). sdbd accepts a connection only on
 * the address Developer Mode's Host PC IP names, and that is either the TV's own LAN IP or 127.0.0.1
 * (a rooted TV is pinned at 127.0.0.1, where no PC can reach SDB), so TV-Store tries both and uses
 * whichever completes the handshake. Order: the address that worked last in this run (so repeat
 * installs skip the dead one), then the TV's own LAN IPv4, then loopback. Deduped; loopback is always
 * present, so there is something to try even when the LAN IP is unknown.
 *
 * sdbd takes one client at a time, and another app on the TV may hold it for good: Vetro keeps one
 * connection to sdbd open and shares it through an sdb tunnel on 127.0.0.1:26201 (#90), so with
 * Vetro running every direct connection is dropped. targets() puts that tunnel last, after the direct
 * addresses, when a tunnel port is given: on loopback, then on the TV's own LAN IP. The TV keeps one
 * app out of another app's port on loopback (an S95F on Tizen 9 answers EHOSTUNREACH, #90), so the
 * LAN IP is the way into Vetro's tunnel from TV-Store; Vetro lets that address in only with its
 * "Allow SDB from the local network" switch on. Pure, ES5, Node 4: test/sdbhosts.test.js. */
'use strict';
var LOOPBACK = '127.0.0.1';
function order(ownIp, remembered) {
    var out = [];
    [remembered, ownIp, LOOPBACK].forEach(function (h) { if (h && out.indexOf(h) < 0) out.push(h); });
    return out;
}
// [{ host, port, tunnel }]: order()'s addresses on sdbPort, then 127.0.0.1:tunnelPort when tunnelPort
// is set (0 leaves it out: TV-Store's own relay is on that port, and it is only a way to the same
// sdbd). remembered is the target that worked last; a remembered tunnel that is no longer offered is
// dropped, so a later relay on that port is not taken for another app's tunnel.
function targets(ownIp, remembered, sdbPort, tunnelPort) {
    var out = [];
    function add(host, port, tunnel) {
        if (!host || !port) return;
        for (var i = 0; i < out.length; i++) if (out[i].host === host && out[i].port === port) return;
        out.push({ host: host, port: port, tunnel: !!tunnel });
    }
    if (remembered && (!remembered.tunnel || remembered.port === tunnelPort)) add(remembered.host, remembered.port, remembered.tunnel);
    order(ownIp, null).forEach(function (h) { add(h, sdbPort, false); });
    if (tunnelPort) { add(LOOPBACK, tunnelPort, true); add(ownIp, tunnelPort, true); }
    return out;
}
// The TV turning a connection away before anything listening sees it: what one app gets on another
// app's port (#90). Not ECONNREFUSED, which is a port nobody listens on.
var KEPT_OUT = /^(EHOSTUNREACH|ENETUNREACH|EACCES|EPERM)$/;
// How the tunnel attempts went, from connectSdb's [{ host, code, frame, tunnel }]: null when no
// tunnel was tried or the TV did not keep TV-Store out of one on loopback (then nothing says another
// app holds sdbd), else { lanBlocked } (the TV kept it out on its own LAN IP as well, so Vetro's
// switch cannot help) or { lanBlocked: false } (the LAN IP got through to the app, or was not tried).
function heldByApp(seen) {
    var tun = (seen || []).filter(function (s) { return s.tunnel; });
    var lo = tun.filter(function (s) { return s.host === LOOPBACK; })[0];
    if (!lo || !KEPT_OUT.test(lo.code || '')) return null;
    var lan = tun.filter(function (s) { return s.host !== LOOPBACK; })[0];
    return { lanBlocked: !!lan && KEPT_OUT.test(lan.code || '') };
}
module.exports = { order: order, targets: targets, heldByApp: heldByApp, LOOPBACK: LOOPBACK };
