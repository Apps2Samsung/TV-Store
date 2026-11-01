'use strict';
/* The on-TV sdb relay (TV-Store#52): a TCP proxy from a LAN port to the TV's own sdbd over loopback.
 * This proves it against a fake sdbd: a real sdb session survives the hop byte for byte, the allow list
 * refuses an off-list client and changes live, stop() tears down live sessions (not just the listener)
 * and leaves nothing bound even when it runs before the bind completed, a slow reader still gets every
 * byte sdbd sent before closing, the session cap and the idle timeout hold. ES5, so it runs on the TV's
 * Node 4.4 as well. */
var net = require('net');
var fake = require('./fake-sdbd.js');
var sdb = require('../tizen-app/service/sdb.js');
var relayMod = require('../tizen-app/service/relay.js');
var Buf = require('../tizen-app/service/compat.js');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
var WD = setTimeout(function () { fail('watchdog timeout (20s)'); }, 20000);

// normList: a comma string or an array becomes a clean list; junk becomes [].
(function () {
    var a = relayMod.normList('1.2.3.4, 5.6.7.8 ,');
    if (a.length !== 2 || a[0] !== '1.2.3.4' || a[1] !== '5.6.7.8') fail('normList string: got ' + JSON.stringify(a));
    if (relayMod.normList(null).length !== 0 || relayMod.normList(42).length !== 0) fail('normList junk should be empty');
    if (relayMod.peerIp({ remoteAddress: '::ffff:10.0.0.5' }) !== '10.0.0.5') fail('peerIp must strip the v4-mapped prefix');
    if (relayMod.peerIp({}) !== '' || relayMod.peerIp(null) !== '') fail('peerIp without an address is empty');
})();

var SDB = 26193, FIXED = 26194;
var quiet = function () {};
fake.start(SDB, {
    shell: function (cmd) { return cmd.indexOf('vd_appinstall') >= 0 ? 'appInstall return : [0]\n' : 'unknown\n'; }
}, function (h) {

    // 1) A real sdb session forwarded through the relay reaches the fake sdbd and comes back intact.
    var relay = new relayMod.Relay({ sdbPort: SDB, log: quiet });
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

    // 2) With an allow list that does not include the caller, the relay refuses the connection; once
    //    setAllow() admits it (no restart), the same relay lets it through.
    function step2() {
        var relay2 = new relayMod.Relay({ sdbPort: SDB, allow: ['9.9.9.9'], log: quiet });
        relay2.start(0, function (err, port) {
            if (err) return done(err);
            var c = new sdb.SdbClient('127.0.0.1', port);
            c.connect(function (err) {
                c.end();
                if (!err) return done(new Error('allow list did not refuse an off-list client'));
                relay2.setAllow('9.9.9.9, 127.0.0.1');
                var c2 = new sdb.SdbClient('127.0.0.1', port);
                c2.connect(function (err) {
                    c2.end();
                    relay2.stop();
                    if (err) return done(new Error('setAllow() did not admit the client live: ' + err.message));
                    step3();
                });
            });
        });
    }

    // 3) stop() destroys a live session, not just the listener: an open client socket gets closed.
    function step3() {
        var relay3 = new relayMod.Relay({ sdbPort: SDB, log: quiet });
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
                        step4();
                    }, 100);
                }, 50);
            });
            sock.on('error', function () {});
        });
    }

    // 4) stop() right after start(), while the bind is still pending, leaves nothing bound: the port
    //    refuses a connection afterwards and the same port can be started again.
    function step4() {
        var relay4 = new relayMod.Relay({ sdbPort: SDB, log: quiet });
        var cbErr = 'none';
        relay4.start(FIXED, function (err) { cbErr = err ? err.message : null; });
        relay4.stop();
        setTimeout(function () {
            if (relay4.status().listening) return done(new Error('stop() before the bind completed still shows listening'));
            var probe = net.connect(FIXED, '127.0.0.1');
            probe.on('connect', function () { probe.destroy(); done(new Error('stop() before the bind completed left the port open')); });
            probe.on('error', function () {
                if (cbErr === 'none') return done(new Error('start() callback never ran after an early stop()'));
                var again = new relayMod.Relay({ sdbPort: SDB, log: quiet });
                again.start(FIXED, function (err, port) {
                    if (err) return done(new Error('the port was not free after an early stop(): ' + err.message));
                    again.stop();
                    step5();
                });
            });
        }, 150);
    }

    // 5) A slow reader gets every byte: the upstream sends 2 MB and closes at once; the relay must
    //    end the client (flushing what pipe() still holds), not destroy it.
    function step5() {
        var SIZE = 2 * 1024 * 1024, big = Buf.alloc(SIZE); big.fill(0x41);
        var up = net.createServer(function (s) { s.on('error', function () {}); s.end(big); });
        up.listen(0, '127.0.0.1', function () {
            var relay5 = new relayMod.Relay({ sdbPort: up.address().port, log: quiet });
            relay5.start(0, function (err, port) {
                if (err) return done(err);
                var got = 0, c = net.connect(port, '127.0.0.1');
                c.on('data', function (d) { got += d.length; c.pause(); setTimeout(function () { c.resume(); }, 5); });
                c.on('error', function (e) { done(new Error('slow reader got an error instead of the whole stream: ' + e.message)); });
                c.on('end', function () {
                    setTimeout(function () {
                        if (got !== SIZE) return done(new Error('slow reader got ' + got + ' of ' + SIZE + ' bytes'));
                        if (relay5.status().sessions !== 0) return done(new Error('a finished session was not forgotten: ' + relay5.status().sessions));
                        relay5.stop(); up.close();
                        step6();
                    }, 50);
                });
            });
        });
    }

    // 6) The session cap: with room for one, a second client is refused while the first is open.
    function step6() {
        var relay6 = new relayMod.Relay({ sdbPort: SDB, maxSessions: 1, log: quiet });
        relay6.start(0, function (err, port) {
            if (err) return done(err);
            var first = net.connect(port, '127.0.0.1', function () {
                setTimeout(function () {
                    var second = net.connect(port, '127.0.0.1'), refused = false;
                    second.on('close', function () { refused = true; });
                    second.on('error', function () {});
                    setTimeout(function () {
                        if (!refused) return done(new Error('the session cap let a second client through'));
                        if (relay6.status().sessions !== 1) return done(new Error('sessions after the cap: ' + relay6.status().sessions));
                        first.destroy(); relay6.stop();
                        step7();
                    }, 100);
                }, 50);
            });
            first.on('error', function () {});
        });
    }

    // 7) The idle timeout: a client that connects and never speaks is closed, and the session forgotten.
    function step7() {
        var relay7 = new relayMod.Relay({ sdbPort: SDB, idleMs: 150, log: quiet });
        relay7.start(0, function (err, port) {
            if (err) return done(err);
            var closed = false, sock = net.connect(port, '127.0.0.1');
            sock.on('close', function () { closed = true; });
            sock.on('error', function () {});
            setTimeout(function () {
                if (!closed) return done(new Error('an idle session was not closed'));
                if (relay7.status().sessions !== 0) return done(new Error('an idle session was closed but not forgotten'));
                relay7.stop();
                done(null);
            }, 500);
        });
    }

    function done(err) {
        clearTimeout(WD);
        try { h.server.close(); } catch (e) {}
        if (err) { console.error('FAIL:', err.message); process.exit(1); }
        console.log('PASS');
        console.log('  forwarded a real sdb session through the relay');
        console.log('  allow list refused an off-list client, and admitted it after a live setAllow()');
        console.log('  stop() tore down the live session and the listener');
        console.log('  stop() before the bind completed left nothing bound');
        console.log('  a slow reader got every byte before the close');
        console.log('  the session cap refused a client over the limit');
        console.log('  an idle session was closed and forgotten');
        process.exit(0);
    }
});
