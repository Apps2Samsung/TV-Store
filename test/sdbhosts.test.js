/* sdbhosts.order picks the addresses to try the TV's own sdbd on (#52): the one that worked last,
 * then the TV's LAN IP, then loopback, deduped, loopback always present. */
'use strict';
var sdbhosts = require('../tizen-app/service/sdbhosts.js');
function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
var o = function (ip, r) { return sdbhosts.order(ip, r).join(); };

// No memory yet: the LAN IP first, then loopback.
if (o('192.168.2.22', null) !== '192.168.2.22,127.0.0.1') fail('LAN then loopback: ' + o('192.168.2.22', null));
// The remembered address goes first; when it is loopback, loopback leads.
if (o('192.168.2.22', '127.0.0.1') !== '127.0.0.1,192.168.2.22') fail('remembered loopback first: ' + o('192.168.2.22', '127.0.0.1'));
// Remembered == LAN: one entry, not two.
if (o('192.168.2.22', '192.168.2.22') !== '192.168.2.22,127.0.0.1') fail('dedup remembered==LAN: ' + o('192.168.2.22', '192.168.2.22'));
// The LAN IP is unknown (a rooted TV, or a set that would not say): loopback alone, never empty.
if (o(null, null) !== '127.0.0.1' || o('', null) !== '127.0.0.1') fail('null LAN -> loopback only: ' + o(null, null));
// A remembered LAN IP survives a moment when ownIp cannot be read.
if (o(null, '192.168.2.22') !== '192.168.2.22,127.0.0.1') fail('remembered survives null LAN: ' + o(null, '192.168.2.22'));
// Everything loopback: one entry.
if (o('127.0.0.1', '127.0.0.1') !== '127.0.0.1') fail('all loopback -> one: ' + o('127.0.0.1', '127.0.0.1'));
if (sdbhosts.LOOPBACK !== '127.0.0.1') fail('LOOPBACK constant');

// targets (#90): the same addresses on sdbd's port, then another app's sdb tunnel on loopback.
var t = function (ip, r, tun) { return sdbhosts.targets(ip, r, 26101, tun).map(function (x) { return x.host + ':' + x.port + (x.tunnel ? '*' : ''); }).join(); };
if (t('192.168.2.22', null, 26201) !== '192.168.2.22:26101,127.0.0.1:26101,127.0.0.1:26201*,192.168.2.22:26201*') fail('direct first, the tunnel last, on loopback then the LAN IP: ' + t('192.168.2.22', null, 26201));
// No tunnel port (TV-Store's own relay has it): the direct addresses only.
if (t('192.168.2.22', null, 0) !== '192.168.2.22:26101,127.0.0.1:26101') fail('no tunnel port -> direct only: ' + t('192.168.2.22', null, 0));
// A remembered tunnel leads, and is not listed twice.
var tun = { host: '127.0.0.1', port: 26201, tunnel: true };
if (t('192.168.2.22', tun, 26201) !== '127.0.0.1:26201*,192.168.2.22:26101,127.0.0.1:26101,192.168.2.22:26201*') fail('remembered tunnel first: ' + t('192.168.2.22', tun, 26201));
// A remembered tunnel that is no longer offered (the relay took the port) is dropped.
if (t('192.168.2.22', tun, 0) !== '192.168.2.22:26101,127.0.0.1:26101') fail('stale tunnel dropped: ' + t('192.168.2.22', tun, 0));
// A remembered direct address leads as before.
if (t('192.168.2.22', { host: '127.0.0.1', port: 26101, tunnel: false }, 26201) !== '127.0.0.1:26101,192.168.2.22:26101,127.0.0.1:26201*,192.168.2.22:26201*') fail('remembered loopback first: ' + t('192.168.2.22', { host: '127.0.0.1', port: 26101 }, 26201));
// LAN IP unknown: loopback, then the tunnel.
if (t(null, null, 26201) !== '127.0.0.1:26101,127.0.0.1:26201*') fail('null LAN: ' + t(null, null, 26201));
// A remembered tunnel on the LAN IP leads, and is not listed twice.
var lanTun = { host: '192.168.2.22', port: 26201, tunnel: true };
if (t('192.168.2.22', lanTun, 26201) !== '192.168.2.22:26201*,192.168.2.22:26101,127.0.0.1:26101,127.0.0.1:26201*') fail('remembered LAN tunnel first: ' + t('192.168.2.22', lanTun, 26201));

// heldByApp (#90): the TV keeping TV-Store out of the tunnel's port on loopback is what says another
// app holds sdbd; the LAN IP attempt says whether Vetro's switch can help.
var h = sdbhosts.heldByApp;
function at(host, code, tunnel) { return { host: host, code: code, frame: null, tunnel: tunnel !== false }; }
var direct = [at('192.168.1.181', 'SDB_CLOSED', false), at('127.0.0.1', 'SDB_CLOSED', false)];
if (h(direct) !== null) fail('no tunnel tried -> null');
if (h(direct.concat([at('127.0.0.1', 'ECONNREFUSED')])) !== null) fail('nobody on the tunnel port -> null');
if (h(direct.concat([at('127.0.0.1', 'ECONNRESET')])) !== null) fail('a tunnel that let us in and dropped -> null (HOST_PC_IP stands)');
var r = h(direct.concat([at('127.0.0.1', 'EHOSTUNREACH'), at('192.168.1.181', 'SDB_CLOSED')]));
if (!r || r.lanBlocked) fail('kept out on loopback, Vetro dropped the LAN IP -> held, switch can help: ' + JSON.stringify(r));
r = h(direct.concat([at('127.0.0.1', 'EHOSTUNREACH'), at('192.168.1.181', 'EHOSTUNREACH')]));
if (!r || !r.lanBlocked) fail('kept out on both -> held, LAN blocked: ' + JSON.stringify(r));
r = h(direct.concat([at('127.0.0.1', 'EHOSTUNREACH')]));
if (!r || r.lanBlocked) fail('kept out on loopback, LAN IP unknown -> held: ' + JSON.stringify(r));
if (h(null) !== null) fail('no attempts -> null');
console.log('PASS: sdb host order: remembered first, then the TV’s LAN IP, then loopback; deduped; loopback always present; another app’s sdb tunnel last, on loopback then the LAN IP; the TV keeping TV-Store out of it on loopback says another app holds sdbd (#90)');
