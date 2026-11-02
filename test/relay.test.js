'use strict';
/* The on-TV sdb relay (TV-Store#52): a TCP proxy from a LAN port to the TV's own sdbd over loopback.
 * This proves it against a fake sdbd: a real sdb session survives the hop byte for byte, the allow list
 * refuses an off-list client and changes live, stop() tears down live sessions (not just the listener)
 * and leaves nothing bound even when it runs before the bind completed, a slow reader still gets every
 * byte sdbd sent before closing, the session cap and the idle timeout hold. And every way a relayed
 * connection can fail is told apart and recorded with a reason (TV-Store#58): nothing listening on
 * sdbd, sdbd dropping the connection without a byte back, sdbd never answering, the allow list, the
 * cap; while a served session, a probe, an idle close and stop() are not failures. ES5, so it runs on
 * the TV's Node 4.4 as well. */
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
                var st = relay.status();
                if (st.served !== 1 || st.failures !== 0 || st.lastFailure) return done(new Error('a served session must count as served, not failed: ' + JSON.stringify(st)));
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
                var f = relay2.status().lastFailure;
                if (!f || f.code !== 'NOT_ALLOWED' || f.client !== '127.0.0.1' || !f.at) return done(new Error('an allow-list refusal must be recorded as NOT_ALLOWED: ' + JSON.stringify(f)));
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
                        if (relay3.status().failures !== 0) return done(new Error('stop() dropping a session is not a failure: ' + JSON.stringify(relay3.status().lastFailure)));
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
                        if (!relay6.status().lastFailure || relay6.status().lastFailure.code !== 'BUSY') return done(new Error('a refusal at the cap must be recorded as BUSY: ' + JSON.stringify(relay6.status().lastFailure)));
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
                if (relay7.status().failures !== 0) return done(new Error('an idle close is not a failure: ' + JSON.stringify(relay7.status().lastFailure)));
                relay7.stop();
                step8();
            }, 500);
        });
    }

    // 8) Nothing listens where sdbd should be: the client is dropped and the failure reads SDBD_DOWN.
    //    A port that was just listening and closed is free and refuses connections.
    function step8() {
        var gone = net.createServer();
        gone.listen(0, '127.0.0.1', function () {
            var deadPort = gone.address().port;
            gone.close(function () {
                var relay8 = new relayMod.Relay({ sdbPort: deadPort, log: quiet });
                relay8.start(0, function (err, port) {
                    if (err) return done(err);
                    var c = new sdb.SdbClient('127.0.0.1', port);
                    c.connect(function (err) {
                        c.end();
                        if (!err) return done(new Error('a dead sdbd port must fail the client'));
                        setTimeout(function () {
                            var st = relay8.status();
                            relay8.stop();
                            if (st.failures !== 1 || !st.lastFailure || st.lastFailure.code !== 'SDBD_DOWN') return done(new Error('nothing listening on sdbd must read SDBD_DOWN: ' + JSON.stringify(st)));
                            if (st.lastFailure.reason.indexOf('Developer Mode') < 0 || st.lastFailure.reason.indexOf('ECONNREFUSED') < 0) return done(new Error('the SDBD_DOWN reason must say what to do and carry the error: ' + st.lastFailure.reason));
                            step9();
                        }, 50);
                    });
                });
            });
        });
    }

    // 9) sdbd takes the connection and closes it on the first bytes without answering (what the real
    //    one does when the peer address is not its Host PC IP): SDBD_DROPPED, with the client's address.
    function step9() {
        fake.start(0, { hostPcIp: '10.9.9.9', shell: function () { return 'ok\n'; } }, function (h2) {
            var relay9 = new relayMod.Relay({ sdbPort: h2.server.address().port, log: quiet });
            relay9.start(0, function (err, port) {
                if (err) return done(err);
                var c = new sdb.SdbClient('127.0.0.1', port);
                c.connect(function (err) {
                    c.end();
                    if (!err) return done(new Error('a dropped connection must fail the client'));
                    setTimeout(function () {
                        var st = relay9.status();
                        relay9.stop(); h2.server.close();
                        if (h2.drops !== 1) return done(new Error('the fake sdbd should have dropped exactly one connection: ' + h2.drops));
                        if (st.failures !== 1 || !st.lastFailure || st.lastFailure.code !== 'SDBD_DROPPED' || st.lastFailure.client !== '127.0.0.1') return done(new Error('sdbd closing without a byte back must read SDBD_DROPPED: ' + JSON.stringify(st)));
                        if (st.lastFailure.reason.indexOf('Host PC IP') < 0) return done(new Error('the SDBD_DROPPED reason must name Host PC IP: ' + st.lastFailure.reason));
                        if (st.served !== 0) return done(new Error('a dropped session must not count as served'));
                        step10();
                    }, 50);
                });
            });
        });
    }

    // 10) sdbd takes the connection and never answers; the client speaks, waits, gives up: SDBD_SILENT.
    //     A probe that connects and leaves without a word is neither a failure nor served.
    function step10() {
        var mute = net.createServer(function (s) { s.on('error', function () {}); });
        mute.listen(0, '127.0.0.1', function () {
            var relay10 = new relayMod.Relay({ sdbPort: mute.address().port, log: quiet });
            relay10.start(0, function (err, port) {
                if (err) return done(err);
                var probe = net.connect(port, '127.0.0.1', function () { setTimeout(function () { probe.destroy(); }, 30); });
                probe.on('error', function () {});
                probe.on('close', function () {
                    setTimeout(function () {
                        if (relay10.status().failures !== 0 || relay10.status().served !== 0) return done(new Error('a silent probe is neither a failure nor served: ' + JSON.stringify(relay10.status())));
                        var talker = net.connect(port, '127.0.0.1', function () { talker.write('CNXN....'); setTimeout(function () { talker.destroy(); }, 120); });
                        talker.on('error', function () {});
                        talker.on('close', function () {
                            setTimeout(function () {
                                var st = relay10.status();
                                relay10.stop(); mute.close();
                                if (st.failures !== 1 || !st.lastFailure || st.lastFailure.code !== 'SDBD_SILENT') return done(new Error('a client that spoke and gave up without a byte back must read SDBD_SILENT: ' + JSON.stringify(st)));
                                done(null);
                            }, 50);
                        });
                    }, 50);
                });
            });
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
        console.log('  served, allow-list, cap, stop() and idle outcomes recorded right; sdbd down, dropping and silent read SDBD_DOWN, SDBD_DROPPED, SDBD_SILENT');
        process.exit(0);
    }
});
