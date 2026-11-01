/* The addresses to try the TV's own sdbd on, in order (#26, #52). sdbd accepts a connection only on
 * the address Developer Mode's Host PC IP names, and that is either the TV's own LAN IP or 127.0.0.1
 * (a rooted TV is pinned at 127.0.0.1, where no PC can reach SDB), so TV-Store tries both and uses
 * whichever completes the handshake. Order: the address that worked last in this run (so repeat
 * installs skip the dead one), then the TV's own LAN IPv4, then loopback. Deduped; loopback is always
 * present, so there is something to try even when the LAN IP is unknown. Pure, ES5, Node 4: test/sdbhosts.test.js. */
'use strict';
var LOOPBACK = '127.0.0.1';
function order(ownIp, remembered) {
    var out = [];
    [remembered, ownIp, LOOPBACK].forEach(function (h) { if (h && out.indexOf(h) < 0) out.push(h); });
    return out;
}
module.exports = { order: order, LOOPBACK: LOOPBACK };
