'use strict';
/* The on-TV sdb relay (TV-Store#52): a TCP proxy from a LAN port to the TV's own sdbd over loopback.
 * This proves it against a fake sdbd: a real sdb session survives the hop byte for byte, the allow list
 * refuses an off-list client, and stop() tears down live sessions (not just the listener). ES5, so it
 * runs on the TV's Node 4.4 as well. */
var net = require('net');
var fake = require('./fake-sdbd.js');
var sdb = require('../tizen-app/service/sdb.js');
var relayMod = require('../tizen-app/service/relay.js');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
var WD = setTimeout(function () { fail('watchdog timeout (8s)'); }, 8000);

// normList: a comma string or an array becomes a clean list; junk becomes [].
(function () {
    var a = relayMod.normList('1.2.3.4, 5.6.7.8 ,');
    if (a.length !== 2 || a[0] !== '1.2.3.4' || a[1] !== '5.6.7.8') fail('normList string: got ' + JSON.stringify(a));
    if (relayMod.normList(null).length !== 0 || relayMod.normList(42).length !== 0) fail('normList junk should be empty');
})();

var SDB = 26193;
fake.start(SDB, {
    shell: function (cmd) { return cmd.indexOf('vd_appinstall') >= 0 ? 'appInstall return : [0]\n' : 'unknown\n'; }
}, function (h) {

    // 1) A real sdb session forwarded through the relay reaches the fake sdbd and comes back intact.
    var relay = new relayMod.Relay({ sdbPort: SDB, log: function () {} });
    relay.start(0, function (err, port) {
        if (err) return done(err);
        var c = new sdb.SdbClient('127.0.0.1', port);
        c.connect(function (err) {
            if (err) return done(err);
            c.shell('0 vd_appinstall A2SProbe01 /home/owner/share/tmp/sdk_tools/x.wgt', function (err, out) {
                c.end();
                if (err) return done(err);
                if (out.indexOf('appInstall return : [0]') < 0) return done(new Error('relayed reply wrong: ' + JSON.stringify(out)));
                relay.stop();
                step2();
            });
        });
    });

    // 2) With an allow list that does not include the caller, the relay refuses the connection.
    function step2() {
        var relay2 = new relayMod.Relay({ sdbPort: SDB, allow: ['9.9.9.9'], log: function () {} });
        relay2.start(0, function (err, port) {
            if (err) return done(err);
            var c = new sdb.SdbClient('127.0.0.1', port);
            c.connect(function (err) {
                c.end();
                relay2.stop();
                if (!err) return done(new Error('allow list did not refuse an off-list client'));
                step3();
            });
        });
    }

    // 3) stop() destroys a live session, not just the listener: an open client socket gets closed.
    function step3() {
        var relay3 = new relayMod.Relay({ sdbPort: SDB, log: function () {} });
        relay3.start(0, function (err, port) {
            if (err) return done(err);
            var sock = net.connect(port, '127.0.0.1', function () {
                // Give the relay a tick to register the session, then stop it.
                setTimeout(function () {
                    if (relay3.status().sessions < 1) return done(new Error('relay did not register the live session'));
                    var closed = false;
                    sock.on('close', function () { closed = true; });
                    relay3.stop();
                    setTimeout(function () {
                        if (!closed) return done(new Error('stop() left the live session open'));
                        if (relay3.status().listening) return done(new Error('stop() left the listener up'));
                        done(null);
                    }, 100);
                }, 50);
            });
            sock.on('error', function () {});
        });
    }

    function done(err) {
        clearTimeout(WD);
        try { h.server.close(); } catch (e) {}
        if (err) { console.error('FAIL:', err.message); process.exit(1); }
        console.log('PASS');
        console.log('  forwarded a real sdb session through the relay');
        console.log('  allow list refused an off-list client');
        console.log('  stop() tore down the live session and the listener');
        process.exit(0);
    }
});
