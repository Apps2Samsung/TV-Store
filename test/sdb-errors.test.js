'use strict';
// The service tells the user what to change on the TV from how the sdb connection failed (#26):
// refused (Developer Mode off), or accepted and dropped before sdbd says anything (wrong Host PC IP).
// This checks the client reports those apart: the error code, and no first frame.
var net = require('net');
var sdb = require('../tizen-app/service/sdb.js');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
var WD = setTimeout(function () { fail('watchdog timeout (8s)'); }, 8000);

function attempt(port, cb) {
    var c = new sdb.SdbClient('127.0.0.1', port);
    c.connect(function (err) { c.end(); cb(err, c.firstFrame); });
}

// sdbd as a wrong Host PC IP meets it: reads CNXN, then hangs up without a reply.
function dropper(cb) {
    var srv = net.createServer(function (s) { s.once('data', function () { s.end(); }); })
        .listen(0, '127.0.0.1', function () { cb(srv, srv.address().port); });
}

// 1) nothing listening
var probe = net.createServer().listen(0, '127.0.0.1', function () {
    var freePort = probe.address().port;
    probe.close(function () {
        attempt(freePort, function (err, first) {
            if (!err || err.code !== 'ECONNREFUSED') fail('refused: want ECONNREFUSED, got ' + (err && err.code));
            if (first) fail('refused: want no first frame, got ' + first);
            // 2) accepted, then closed without a reply
            dropper(function (srv, port) {
                attempt(port, function (err, first) {
                    srv.close();
                    if (!err || !/^(SDB_CLOSED|ECONNRESET)$/.test(err.code)) fail('closed: want SDB_CLOSED, got ' + (err && err.code));
                    if (first) fail('closed: want no first frame, got ' + first);
                    clearTimeout(WD);
                    console.log('PASS: refused -> ECONNREFUSED, dropped -> ' + err.code + ', no first frame');
                    process.exit(0);
                });
            });
        });
    });
});
