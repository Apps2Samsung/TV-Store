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
console.log('PASS: sdb host order: remembered first, then the TV’s LAN IP, then loopback; deduped; loopback always present');
