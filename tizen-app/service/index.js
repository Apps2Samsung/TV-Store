/* TV-Store background service (#844): the control plane the on-screen UI drives over loopback HTTP,
 * and the install pipeline (download -> sign -> push -> vd_appinstall) over the sdb client.
 *
 * Opening a raw socket to sdbd and running a real HTTP server on loopback are both proven on retail
 * (the tessel SMB proxy, and the #844 phase-0 probe). The sdb transport here is proven end to end
 * against a fake sdbd (test/run.js). The one not-yet-ready step is signer.sign (see signer.js).
 */
'use strict';
var http = require('http');
var https = require('https');
var os = require('os');
var url = require('url');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var sdb = require('./sdb.js');
var relayMod = require('./relay.js');
var signer = require('./signer.js');
var zip = require('./zip.js');
var catalogTrust = require('./catalog.js');
var CATALOG_KEY = require('./catalog-key.js');
var manifest = require('./manifest.js');
var refusals = require('./refusal.js');
var certs = require('./certs.js');
var sdbhosts = require('./sdbhosts.js');
var wascmd = require('./wascmd.js');
var iconsMod = require('./icons.js');
var selfupdate = require('./selfupdate.js');
var repos = require('./repos.js');
var pkgid = require('./pkgid.js');

var PORT = 8077;
// sdbd's port; a test points the service at a fake sdbd (test/install.test.js).
function validPort(n) { return typeof n === 'number' && isFinite(n) && n === Math.floor(n) && n >= 1 && n <= 65535; }
function parsePort(v, dflt) { var n = parseInt(v, 10); return validPort(n) ? n : dflt; }
var SDB_PORT = parsePort(process.env.A2S_SDB_PORT, 26101);
// The on-TV sdb relay listens here (TV-Store#52). Default 26201; env override for a test.
var RELAY_PORT_DEFAULT = 26201;
// Why a port will not do for the relay, or null when it will. A bad port used to be saved and then
// fail to bind on every boot with nothing but a log line, so Settings refuses it up front instead.
function relayPortProblem(n) {
    if (!validPort(n) || n < 1024) return 'the relay port must be a number from 1024 to 65535';
    if (n === PORT) return 'port ' + n + ' is TV-Store\'s own';
    if (n === SDB_PORT) return 'port ' + n + ' is sdbd\'s own';
    return null;
}
function parseRelayPort(v, dflt) { var n = parseInt(v, 10); return relayPortProblem(n) ? dflt : n; }
var RELAY_PORT = parseRelayPort(process.env.A2S_RELAY_PORT, RELAY_PORT_DEFAULT);
// Another app's sdb tunnel on loopback (#90): Vetro holds sdbd's one connection and shares it on
// 127.0.0.1:26201 (the port TV-Store's relay defaults to as well). Env override for a test.
var TUNNEL_PORT = parsePort(process.env.A2S_TUNNEL_PORT, 26201);
// Signed by the Apps2Samsung catalog workflow; see catalog.js for why the content is checked
// instead of the connection.
var CATALOG_URL = process.env.A2S_CATALOG_URL || 'https://apps2samsung.com/catalog/resolved.json.signed';
// A test signs its own catalog: A2S_CATALOG_KEY names a PEM file with the key that verifies it.
var CATALOG_KEY_PEM = CATALOG_KEY;
if (process.env.A2S_CATALOG_KEY) { try { CATALOG_KEY_PEM = fs.readFileSync(process.env.A2S_CATALOG_KEY, 'utf8'); } catch (e) {} }
// A test points host names at its own server, the way curl --resolve does: "host=127.0.0.1:port,...".
// The independent repositories may not use an IP address or localhost (repos.js), so a test needs this.
var RESOLVE = {};
String(process.env.A2S_RESOLVE || '').split(',').forEach(function (p) { var m = /^([^=]+)=([^:]+):(\d+)$/.exec(p.trim()); if (m) RESOLVE[m[1].toLowerCase()] = { host: m[2], port: parseInt(m[3], 10) }; });
var STAGING = '/home/owner/share/tmp/sdk_tools';   // where sdbd accepts a pushed .wgt
// How a signed package reaches the TV's installer (#57): see the installer block below the log.
var LOGS = [];
var CERT_NAME = '.a2s-tvstore-certs.json';
// Where the handed-over certificate is kept, best first: the package's private data folder
// (what the page's tizen.filesystem calls wgt-private), which survives a reboot and an upgrade.
// The service runs from /opt/usr/apps/<pkg>/res/wgt/service, read-only, and $HOME (/home/owner)
// is not writable for it (both seen on a 2019 Tizen 5.0 set, #881); the data folder lives under
// apps_rw instead. /tmp is the last resort: it survives an app restart, not a reboot, and is
// where 0.3.3 ended up, so a certificate found there is moved up.
// The package id, from where the service runs (/opt/usr/apps/<pkg>/res/wgt/service). A runtime
// that gives the script no __dirname gets the id TV-Store ships with.
var PKG = typeof __dirname === 'string' ? path.basename(path.resolve(__dirname, '../../..')) : 'A2STVStore';
var CERT_DIRS = ['/opt/usr/home/owner/apps_rw/' + PKG + '/data', '/home/owner/apps_rw/' + PKG + '/data', process.env.HOME, '/tmp']
    .filter(function (d) { return !!d; });
var CERT_FILE = null, CERT_ERROR = null;
var CERTS = null;
var CATALOG = null;        // { catalog, payload, index, at } once a signed catalog verified
// Where the service keeps files: the first of the folders it may write. The log and the packages
// being installed live here, not in /tmp, which is RAM on many sets.
var DATA_DIRS = ['/opt/usr/home/owner/apps_rw/' + PKG + '/data', '/home/owner/apps_rw/' + PKG + '/data', os.tmpdir ? os.tmpdir() : '/tmp', '/tmp'];
var DATA_DIR = null;
for (var di = 0; di < DATA_DIRS.length && !DATA_DIR; di++) {
    try { var probe = path.join(DATA_DIRS[di], '.a2s-write-test'); fs.writeFileSync(probe, ''); fs.unlinkSync(probe); DATA_DIR = DATA_DIRS[di]; } catch (e) {}
}
// The log, on disk so it survives the service going down (the Tizen 6 report: the service vanished
// mid-install and the in-memory log with it). The previous run's log is kept next to it. Anyone on
// the LAN can read both at http://<TV IP>:8077/log.txt; they hold no keys.
var LOG_FILE = DATA_DIR ? path.join(DATA_DIR, 'tvstore.log') : null, LOG_PREV = LOG_FILE ? LOG_FILE.replace(/\.log$/, '.prev.log') : null;
if (LOG_FILE) { try { fs.renameSync(LOG_FILE, LOG_PREV); } catch (e) {} }
function log(m) {
    var l = new Date().toISOString() + ' ' + m; LOGS.push(l); if (LOGS.length > 300) LOGS.shift(); try { console.log(l); } catch (e) {}
    if (!LOG_FILE) return;
    try { if (fs.statSync(LOG_FILE).size > 512 * 1024) fs.renameSync(LOG_FILE, LOG_PREV); } catch (e) {}
    try { fs.appendFileSync(LOG_FILE, l + '\n'); } catch (e) {}
}
// Verbose logging (#31): off by default so the log a user sends stays readable; the page turns it
// on from Settings when a problem needs more. Kept in a file next to the log so it survives a restart.
// Verbose lines start with "verbose" and never contain " install:", which the page reads as progress.
// Never log key material: the /cert body is not logged, only that it arrived.
var VERBOSE_FILE = DATA_DIR ? path.join(DATA_DIR, '.a2s-verbose') : null;
var VERBOSE = false;
try { VERBOSE = !!(VERBOSE_FILE && fs.existsSync(VERBOSE_FILE)); } catch (e) {}
function logv(m) { if (VERBOSE) log('verbose ' + m); }
function setVerbose(on) {
    on = !!on;
    if (on === VERBOSE) return;
    VERBOSE = on;
    try { if (on) fs.writeFileSync(VERBOSE_FILE, ''); else fs.unlinkSync(VERBOSE_FILE); } catch (e) {}
    log('verbose logging ' + (on ? 'on' : 'off'));
    if (on) logPlatform();
}
// What this TV is, for a verbose log: OS, Node, every network address, the folders in use.
function logPlatform() {
    var nets = [];
    try { var ifs = os.networkInterfaces();
        for (var n in ifs) for (var i = 0; i < ifs[n].length; i++) nets.push(n + ' ' + ifs[n][i].family + ' ' + ifs[n][i].address + (ifs[n][i].internal ? ' (internal)' : ''));
    } catch (e) { nets.push('networkInterfaces failed: ' + e.message); }
    logv('platform: ' + os.type() + ' ' + os.release() + ' ' + process.arch + ', node ' + process.version + ', pid ' + process.pid + ', uptime ' + Math.round(os.uptime()) + ' s');
    logv('platform: network ' + nets.join('; '));
    logv('platform: package ' + PKG + ', data ' + DATA_DIR + ', cert ' + (CERT_FILE || 'none yet') + ', cert folders ' + CERT_DIRS.join(', '));
}

// How a signed package reaches the TV's installer (#57): wascmd run by the service itself when this
// Node can start it, the binary is there and this service may run it (no Host PC IP involved), else
// pushed to sdbd and installed with vd_appinstall as before. Two Tizen 9 sets (#67, #68) showed what
// merely starting wascmd can cost: 0.3.16 ran it without arguments at start-up for its usage text,
// the fork took the service's host process down on most starts, before the service was up, and the
// TV said EACCES on the starts it survived. So nothing is started at start-up any more; the kernel
// is asked first, without a fork, whether this service may run the binary at all (wascmd.status());
// a marker file stands in the data folder while wascmd runs, so a service that finds it at start
// knows the last run died inside that call and keeps to sdbd from then on; and a spawn that fails
// outright (EACCES, ENOENT) is remembered the same way. A 2019 Tizen 5.0 set then showed the end of
// it (#57): there the run is allowed and the fork still takes the service down before anything is
// installed. So since 0.3.20 wascmd is off by default: the mode is 'sdb' unless the Settings switch
// "Try the TV's own installer" was turned on (kept in the data folder as mode 'auto' with optIn,
// so an older file's 'auto', which meant the default then, is not read as a choice), or
// A2S_INSTALLER=sdb|auto in the environment (a test); setting 'auto' from Settings forgets what was
// learned. INSTALLER_LAST says which way the last install took.
var INSTALLER_FILE = DATA_DIR ? path.join(DATA_DIR, '.a2s-installer.json') : null;
var WASCMD_MARK = DATA_DIR ? path.join(DATA_DIR, '.a2s-wascmd-running') : null;
var INSTALLER_CFG = { mode: 'sdb', off: null };   // off: { why, at } once wascmd is not to be tried again on this TV
try {
    if (INSTALLER_FILE) {
        var ic = JSON.parse(fs.readFileSync(INSTALLER_FILE, 'utf8'));
        if (ic && typeof ic === 'object') {
            if (ic.mode === 'auto' && ic.optIn === true) { INSTALLER_CFG.mode = 'auto'; INSTALLER_CFG.optIn = true; }
            if (ic.off && typeof ic.off === 'object' && ic.off.why) INSTALLER_CFG.off = { why: String(ic.off.why), at: ic.off.at || null };
        }
    }
} catch (e) {}
var INSTALLER_ENV = /^(sdb|auto)$/.test(process.env.A2S_INSTALLER || '') ? process.env.A2S_INSTALLER : null;
var INSTALLER_LAST = null;
// Read once: whether the binary is there, whether this service may run it and how this Node starts
// a process cannot change while the service runs, and the page polls /ping all the time.
var WASCMD = wascmd.status();
// The marker left behind by a run that died inside wascmd, as the time that run started it.
var WASCMD_DIED = null;
try { if (WASCMD_MARK && fs.existsSync(WASCMD_MARK)) WASCMD_DIED = fs.readFileSync(WASCMD_MARK, 'utf8').trim() || 'unknown time'; } catch (e) {}

// TV-Store updating itself (#41, experiment; selfupdate.js has the why). OWN_PKG is this package's
// id (A2S_PACKAGE_ID stands in for it in a test). SELF_UPDATE is the marker a run left behind when
// it sent its own update: { from, to, at, certificate, file, lines }, until the page has shown the
// outcome and said so (POST /selfupdate/ack). The lines of the run that sent it come from the
// previous log, copied into the marker on the first start after it, so a second restart keeps them.
var OWN_PKG = process.env.A2S_PACKAGE_ID || PKG;
var SELF_MARK = DATA_DIR ? path.join(DATA_DIR, '.a2s-self-update.json') : null;
var SELF_UPDATE = null;
try { if (SELF_MARK && fs.existsSync(SELF_MARK)) SELF_UPDATE = JSON.parse(fs.readFileSync(SELF_MARK, 'utf8')); } catch (e) { SELF_UPDATE = { at: '', lines: ['the marker could not be read: ' + e.message] }; }
if (SELF_UPDATE && !Array.isArray(SELF_UPDATE.lines)) {
    var prevLog = ''; try { prevLog = fs.readFileSync(LOG_PREV, 'utf8'); } catch (e) {}
    SELF_UPDATE.lines = selfupdate.linesSince(prevLog, new Date(Date.parse(SELF_UPDATE.at) - 10 * 60 * 1000).toISOString(), 40);
    try { fs.writeFileSync(SELF_MARK, JSON.stringify(SELF_UPDATE)); } catch (e) {}
}
function writeSelfMark(entry) {
    var m = selfupdate.marker(entry, new Date().toISOString());
    try { fs.writeFileSync(SELF_MARK, JSON.stringify(m)); } catch (e) { log('self-update: could not write the marker: ' + e.message); }
}
function clearSelfMark() { SELF_UPDATE = null; unlinkQuiet(SELF_MARK); }
function unlinkQuiet(f) { if (f) { try { fs.unlinkSync(f); } catch (e) {} } }
// An install of TV-Store's own package: refused unless the page asked for it (the Settings switch),
// and never as a replace. Marks the entry so the rest of the pipeline keeps to sdbd.
function selfGate(entry) {
    entry.self = selfupdate.isOwn(entry, OWN_PKG);
    if (!entry.self) return null;
    var r = selfupdate.refusal(entry);
    if (r) { log('install: ' + (entry.file || OWN_PKG) + ' is TV-Store itself; not installing it: ' + r.code); return coded(r.code, r.message); }
    log('self-update: installing TV-Store ' + (entry.toVersion ? 'v' + entry.toVersion + ' ' : '') + 'over itself' + (entry.fromVersion ? ' (this is v' + entry.fromVersion + ')' : '') + ', through sdbd only');
    return null;
}
function saveInstallerCfg() {
    if (!INSTALLER_FILE) return;
    try { fs.writeFileSync(INSTALLER_FILE, JSON.stringify(INSTALLER_CFG)); }
    catch (e) { log('installer: cannot save settings: ' + e.message); }
}
function installerMode() { return INSTALLER_ENV || INSTALLER_CFG.mode; }
// Whether an install goes to wascmd first: the switch on (auto), the binary runnable, nothing learned against it.
function wascmdWanted() { return installerMode() === 'auto' && WASCMD.available && !INSTALLER_CFG.off; }
function installerStatus() { return { mode: installerMode(), env: INSTALLER_ENV, wascmd: WASCMD, off: INSTALLER_CFG.off, last: INSTALLER_LAST }; }
// The marker around a run of wascmd: on before anything is started, off once it answered. A process
// that dies in between leaves the file, and the next start reads it as that.
function markWascmd(on) {
    if (!WASCMD_MARK) return;
    try { if (on) fs.writeFileSync(WASCMD_MARK, new Date().toISOString()); else fs.unlinkSync(WASCMD_MARK); } catch (e) {}
}
// wascmd is not to be tried again on this TV, with why: said in the log, kept for later starts.
function wascmdOff(why) {
    if (INSTALLER_CFG.off) return;
    INSTALLER_CFG.off = { why: why, at: new Date().toISOString() };
    saveInstallerCfg();
    markWascmd(false);
    log('installer: ' + why + '; sdbd only from now on (turn the switch in Settings off and on again to let the TV\'s own installer try once more)');
}
// The log's line about the installer, at start and when Settings changes it.
function installerLine() {
    var w = WASCMD;
    if (INSTALLER_ENV === 'sdb') return 'sdbd only (A2S_INSTALLER=sdb)';
    if (!INSTALLER_ENV && INSTALLER_CFG.mode === 'sdb') return 'sdbd (the TV\'s own installer, wascmd, is off, as it is by default; the switch in Settings turns it on)';
    if (INSTALLER_CFG.off) return 'sdbd only (' + INSTALLER_CFG.off.why + ', since ' + INSTALLER_CFG.off.at + ')';
    if (w.available) return 'wascmd first (' + w.path + ' via ' + w.spawn + '), sdbd as the fallback; nothing is started before the first install';
    if (!w.present) return 'sdbd (' + w.path + ' is not there)';
    if (w.denied) return 'sdbd (' + w.path + ' is there, but this service may not run it: ' + w.denied + ')';
    return 'sdbd (this Node can start no process)';
}
// A /settings installer block checked before anything is applied: an error string, or null.
function installerSettingsProblem(i) {
    if (!i || typeof i !== 'object' || Array.isArray(i)) return 'installer must be an object { mode }';
    if (i.mode !== 'auto' && i.mode !== 'sdb') return 'installer.mode must be auto or sdb';
    return null;
}
// Apply { mode } from Settings (already validated): persist; 'auto' also forgets what was learned.
function applyInstallerSettings(i) {
    INSTALLER_CFG.mode = i.mode;
    if (i.mode === 'auto') { INSTALLER_CFG.off = null; INSTALLER_CFG.optIn = true; markWascmd(false); }
    else delete INSTALLER_CFG.optIn;
    saveInstallerCfg();
    log('installer: ' + (i.mode === 'sdb' ? 'the TV\'s own installer is off again (the switch in Settings): ' : 'the TV\'s own installer is on (the switch in Settings): ') + installerLine());
}
// What wascmd prints without arguments: its flags, which no document gives (the uninstall one in
// particular), so a real set's log is where they get read from. Once, before the first install.
var WASCMD_USAGE_LOGGED = false;
function wascmdUsageOnce(cb) {
    if (WASCMD_USAGE_LOGGED) return cb();
    WASCMD_USAGE_LOGGED = true;
    wascmd.usage(function (err, out) {
        var said = String(out || '').replace(/\s+/g, ' ').trim();
        log('installer: wascmd without arguments says: ' + (said ? said.slice(0, 400) : err ? err.message : 'nothing'));
        cb();
    });
}

// The on-TV sdb relay (TV-Store#52): a TCP proxy from a LAN port to the TV's own sdbd over loopback,
// so clients connect without re-entering Developer Mode's Host PC IP (set it to 127.0.0.1 once). Any
// LAN client that reaches the port can push and install; an optional allow list pins it to specific
// client IPs. The config lives next to the other settings.
// On by default where it is needed: until the switch in Settings was used (chosen), the relay turns
// itself on once this TV's sdbd takes a connection on 127.0.0.1, which it only does when Developer
// Mode's Host PC IP is 127.0.0.1 (see sdbhosts.js). Then no phone or PC reaches sdbd any other way,
// so without the relay nothing could arm TV-Store or install from Apps2Samsung. Checked once at start
// (a changed Host PC IP needs a TV restart, which restarts the service) and on every install over
// loopback. A file written before 0.3.28 came from the switch, so it counts as a choice.
var RELAY_FILE = DATA_DIR ? path.join(DATA_DIR, '.a2s-relay.json') : null;
var RELAY_CFG = { enabled: false, port: RELAY_PORT, allow: [], chosen: false };
var RELAY_AUTO = null;     // why the relay turned itself on, while it is on that way
try {
    if (RELAY_FILE) {
        var rc = JSON.parse(fs.readFileSync(RELAY_FILE, 'utf8'));
        if (rc && typeof rc === 'object') {
            RELAY_CFG.chosen = rc.chosen === undefined ? true : !!rc.chosen;
            RELAY_CFG.enabled = RELAY_CFG.chosen && !!rc.enabled;
            RELAY_CFG.port = parseRelayPort(rc.port, RELAY_PORT);
            RELAY_CFG.allow = relayMod.normList(rc.allow);
        }
    }
} catch (e) {}
var relay = new relayMod.Relay({ sdbPort: SDB_PORT, allow: RELAY_CFG.allow, log: log });
function saveRelayCfg() {
    if (!RELAY_FILE) return;
    // Turned on by itself is not saved as on: the next start checks Host PC IP again.
    var c = { enabled: RELAY_CFG.chosen && RELAY_CFG.enabled, port: RELAY_CFG.port, allow: RELAY_CFG.allow, chosen: RELAY_CFG.chosen };
    try { fs.writeFileSync(RELAY_FILE, JSON.stringify(c)); }
    catch (e) { log('relay: cannot save settings: ' + e.message); }
}
// sdbd took a direct connection on 127.0.0.1, so Host PC IP is 127.0.0.1: the relay goes on, unless
// the switch in Settings decided. A port another app holds (Vetro's tunnel, #90) leaves it off again.
function relayLoopbackSeen() {
    if (RELAY_CFG.chosen || RELAY_CFG.enabled) return;
    RELAY_CFG.enabled = true;
    RELAY_AUTO = 'Host PC IP is 127.0.0.1';
    log('relay: on by default on port ' + RELAY_CFG.port + ': this TV\'s sdbd takes connections on 127.0.0.1 (Host PC IP is 127.0.0.1), so phones and PCs reach it only through the relay; the switch in Settings turns it off');
    startRelay(function (err) {
        if (!err || RELAY_CFG.chosen) return;
        RELAY_CFG.enabled = false; RELAY_AUTO = null;
        log('relay: stays off, since it could not start');
    });
}
// At start, before anyone needs it: one handshake with sdbd on 127.0.0.1, closed straight away.
function probeLoopback() {
    if (RELAY_CFG.chosen || RELAY_CFG.enabled) return;
    var t = { host: sdbhosts.LOOPBACK, port: SDB_PORT, tunnel: false }, c = new sdb.SdbClient(t.host, t.port);
    c.connect(function (err) {
        c.end();
        if (!err) { if (!SDB_WORKED) SDB_WORKED = t; return relayLoopbackSeen(); }
        log('relay: off: sdbd does not take a connection on 127.0.0.1 (' + (err.code || err.message) + '), so Host PC IP is not 127.0.0.1 or Developer Mode is off; the switch in Settings turns the relay on');
    });
}
function startRelay(cb) {
    relay.setAllow(RELAY_CFG.allow);
    relay.start(RELAY_CFG.port, function (err) {
        if (err) log('relay: not started: ' + err.message + (/EADDRINUSE/.test(err.message) ? '; another app on this TV has the port (Vetro\u2019s sdb tunnel uses ' + TUNNEL_PORT + '), and TV-Store installs through that app\u2019s tunnel when it holds sdbd, with Vetro\u2019s \u201cAllow SDB from the local network\u201d on' : ''));
        if (cb) cb(err);
    });
}
function relayStatus() {
    var s = relay.status();
    s.enabled = RELAY_CFG.enabled;
    s.configuredPort = RELAY_CFG.port;
    s.chosen = RELAY_CFG.chosen;      // false: the default decides (on when Host PC IP is 127.0.0.1)
    s.auto = RELAY_AUTO;              // why it turned itself on, or null
    return s;
}
// The relay's state for a phone or PC on the LAN (GET /relay, TV-Store#58): whether it is on and
// listening, the port, and why the last connection through it failed, so Apps2Samsung can show that
// instead of "connection reset". Without the allow list; the TV's own page gets everything via /ping.
function relayPublic() {
    var s = relayStatus();
    return { enabled: s.enabled, auto: s.auto, listening: s.listening, port: s.port, configuredPort: s.configuredPort, sessions: s.sessions,
             served: s.served, failures: s.failures, lastFailure: s.lastFailure, error: s.error };
}
// Apply { enabled?, port?, allow? } from Settings (already validated): persist, then make the listener
// match. The listener is only restarted when enabled or the port changed, since a restart drops every
// live session (a PC mid-install through the relay); the allow list is read per connection, so it
// takes effect without one. Saving the same settings again while enabled retries a failed bind.
// cb(status) runs once the listener is up or has failed, so the answer says which.
function applyRelaySettings(r, cb) {
    var was = { enabled: RELAY_CFG.enabled, port: RELAY_CFG.port };
    if (typeof r.enabled === 'boolean') { RELAY_CFG.enabled = r.enabled; RELAY_CFG.chosen = true; RELAY_AUTO = null; }
    if (r.port !== undefined) RELAY_CFG.port = r.port;
    if (r.allow !== undefined) RELAY_CFG.allow = relayMod.normList(r.allow);
    saveRelayCfg();
    relay.setAllow(RELAY_CFG.allow);
    var changed = RELAY_CFG.enabled !== was.enabled || RELAY_CFG.port !== was.port;
    if (changed) {
        relay.stop();
        log('relay: ' + (RELAY_CFG.enabled ? 'enabled on port ' + RELAY_CFG.port : 'disabled'));
    }
    if (r.allow !== undefined) log('relay: allow ' + (RELAY_CFG.allow.length ? RELAY_CFG.allow.join(', ') : 'any LAN client'));
    if (RELAY_CFG.enabled) return startRelay(function () { cb(relayStatus()); });
    cb(relayStatus());
}
// A /settings relay block checked before anything is applied: an error string, or null when it is
// fine; a port given as a string is turned into the number.
function relaySettingsProblem(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return 'relay must be an object { enabled, port, allow }';
    if (r.enabled !== undefined && typeof r.enabled !== 'boolean') return 'relay.enabled must be true or false';
    if (r.port !== undefined) {
        var n = typeof r.port === 'number' ? r.port : parseInt(String(r.port), 10);
        var why = relayPortProblem(n);
        if (why) return why;
        r.port = n;
    }
    if (r.allow !== undefined && r.allow !== null && typeof r.allow !== 'string' && !Array.isArray(r.allow)) return 'relay.allow must be a list of IPs or a comma string';
    return null;
}
// Uploads (#30): a .wgt or .tpk that anyone in the network sends to http://<TV IP>:8077/upload
// waits here, one at a time, until the person at the TV presses Install or Discard on the
// TV-Store screen. Only that screen can start the install: it sends the token below, which the
// service writes into the package's private data folder at start, where only TV-Store's own page
// can read it. Other apps on the TV reach this port too, and none of them gets an upload signed
// with the user's certificate that way. The page is open to the LAN like the log; the file is
// capped, checked to be a Tizen package, and shown on the TV with where it came from.
var UPLOAD = null;             // { id, name, size, sha256, from, at, ids }, the file at UPLOAD_FILE
var UPLOAD_BUSY = false;       // its install is running: no replacing or discarding meanwhile
var UPLOAD_MAX = 400 * 1024 * 1024;
var UPLOAD_FILE = DATA_DIR ? path.join(DATA_DIR, 'upload.pkg') : null;
var UPLOAD_TOKEN = crypto.randomBytes(24).toString('hex');
var TOKEN_FILE = DATA_DIR ? path.join(DATA_DIR, '.a2s-upload-token') : null;
try { if (TOKEN_FILE) fs.writeFileSync(TOKEN_FILE, UPLOAD_TOKEN); } catch (e) { log('upload: cannot write the token file: ' + e.message); }
if (UPLOAD_FILE) { try { fs.unlinkSync(UPLOAD_FILE); } catch (e) {} }     // a previous run's leftover
function unlink(f) { try { fs.unlinkSync(f); } catch (e) {} }
function publicUpload() { return UPLOAD ? { id: UPLOAD.id, name: UPLOAD.name, size: UPLOAD.size, sha256: UPLOAD.sha256, from: UPLOAD.from, at: UPLOAD.at, ids: UPLOAD.ids } : null; }

// PUT /upload?name=<file> with the package as the body, from a browser on the upload page.
function receiveUpload(req, res) {
    var name = String(url.parse(req.url, true).query.name || '').replace(/^.*[\\\/]/, '').replace(/[^A-Za-z0-9._ -]/g, '_').trim();
    var from = relayMod.peerIp(req.socket);
    function refuse(code, why) { req.resume(); json(res, code, { ok: false, error: why }); }
    if (!/\.(wgt|tpk)$/i.test(name)) return refuse(400, 'send a .wgt or .tpk file');
    if (!UPLOAD_FILE) return refuse(500, 'the service has no folder it can write to');
    if (UPLOAD_BUSY) return refuse(409, 'the TV is installing the previous file; try again in a minute');
    var declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > UPLOAD_MAX) return refuse(413, 'too big: at most ' + Math.round(UPLOAD_MAX / 1048576) + ' MB');
    var tmp = UPLOAD_FILE + '.part', out = fs.createWriteStream(tmp), h = crypto.createHash('sha256'), size = 0, done = false;
    function fin(code, obj) { if (done) return; done = true; if (!obj.ok) { try { out.destroy(); } catch (e) {} unlink(tmp); log('upload: refused ' + name + ' from ' + from + ': ' + obj.error); } json(res, code, obj); }
    log('upload: receiving ' + name + ' from ' + from + (declared ? ', ' + declared + ' bytes' : ''));
    req.on('data', function (d) {
        if (done) return;
        size += d.length; h.update(d);
        if (size > UPLOAD_MAX) { fin(413, { ok: false, error: 'too big: at most ' + Math.round(UPLOAD_MAX / 1048576) + ' MB' }); req.destroy(); }
    });
    req.on('error', function (e) { fin(400, { ok: false, error: 'the upload broke off: ' + e.message }); });
    out.on('error', function (e) { fin(500, { ok: false, error: 'could not store the file: ' + e.message }); });
    out.on('finish', function () {
        if (done) return;
        if (!size) return fin(400, { ok: false, error: 'the file is empty' });
        manifest.read(tmp, function (err, ids) {
            if (err) return fin(400, { ok: false, error: err.message });
            try { fs.renameSync(tmp, UPLOAD_FILE); } catch (e) { return fin(500, { ok: false, error: 'could not store the file: ' + e.message }); }
            UPLOAD = { id: crypto.randomBytes(8).toString('hex'), name: name, size: size, sha256: h.digest('hex'), from: from, at: new Date().toISOString(), ids: ids };
            log('upload: ' + name + ' (' + size + ' bytes, ' + ids.kind + ' ' + (ids.appId || ids.packageId) + (ids.version ? ' v' + ids.version : '') + ') from ' + from + ' waits for OK on the TV');
            fin(200, { ok: true, upload: publicUpload() });
        });
    });
    req.pipe(out);
}

// POST /install { upload, token } from the TV-Store screen: sign the waiting file and install it.
// No catalog, no hash: the person at the TV saw the file, where it came from and pressed Install.
function installUpload(b, cb) {
    if (!UPLOAD || b.upload !== UPLOAD.id) return cb(coded('NO_UPLOAD', 'that file is no longer waiting on the TV; send it again'));
    if (String(b.token || '') !== UPLOAD_TOKEN) { log('upload: refused an install of ' + UPLOAD.name + ' without the token'); return cb(coded('NO_TOKEN', 'only the TV-Store screen may install an uploaded file')); }
    if (UPLOAD_BUSY) return cb(coded('BUSY', 'that file is being installed'));
    if (!DATA_DIR) return cb(new Error('the service has no folder it can write to'));
    var up = UPLOAD, outFile = path.join(DATA_DIR, 'job-' + Date.now() + '.signed.wgt');
    UPLOAD_BUSY = true;
    log('install: uploaded ' + up.size + ' bytes, ' + up.name + ' from ' + up.from + ', SHA-256 ' + up.sha256 + ', confirmed on the TV; signing');
    var entry = { appId: up.ids.appId, packageId: up.ids.packageId, file: up.name, name: up.ids.name, requiredVersion: up.ids.requiredVersion, tizen: b.tizen, installed: !!b.installed, replace: !!b.replace,
                  certLevel: b.certLevel, manifestPartner: !!up.ids.partner,
                  selfUpdate: b.selfUpdate === true, fromVersion: b.fromVersion, toVersion: up.ids.version };
    var gate = selfGate(entry) || tizenGate(entry);
    if (gate) { UPLOAD_BUSY = false; return cb(gate); }
    signAndInstall(entry, up.name.replace(/[^A-Za-z0-9._-]/g, '_'), UPLOAD_FILE, outFile, function (err, r) {
        UPLOAD_BUSY = false;
        unlink(outFile);
        // The file is gone once signed (signAndInstall drops it); a failure before that (no
        // certificate yet) keeps the upload waiting for another try.
        if (!err || !fs.existsSync(UPLOAD_FILE)) { UPLOAD = null; unlink(UPLOAD_FILE); }
        // A file sent in by hand comes from no source: the app is read as before #82 again.
        if (!err) forgetSource(entry.packageId);
        cb(err, r);
    });
}

// The page a phone or PC gets at http://<TV IP>:8077/upload: pick a file, send it, then look at
// the TV. Plain, inline, works in any browser of the last ten years.
function uploadPage() {
    var ip = ownIp() || 'this TV', waiting = UPLOAD ? '<p class="ok"><b>' + escHtml(UPLOAD.name) + '</b> is already waiting on the TV. Sending another file replaces it.</p>' : '';
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TV-Store: send an app to the TV</title>'
        + '<style>body{margin:0;background:#0D1B2A;color:#F4F7FB;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:24px 16px}.card{max-width:520px;margin:0 auto;background:#142638;border-radius:20px;padding:22px}h1{font-size:22px;margin:0 0 6px}p{color:#9FB0C6;line-height:1.5;margin:8px 0}'
        + '.btn{display:block;width:100%;padding:16px;border:0;border-radius:14px;background:#2DD4BF;color:#042F2E;font:inherit;font-weight:700;font-size:18px;margin-top:16px}.btn[disabled]{background:rgba(244,247,251,.14);color:#9FB0C6}input[type=file]{width:100%;margin-top:12px;color:#9FB0C6}'
        + '.bar{height:10px;border-radius:5px;background:rgba(244,247,251,.14);overflow:hidden;margin-top:16px;display:none}.bar i{display:block;height:100%;width:0;background:#2DD4BF}.msg{margin-top:14px;font-size:16px;line-height:1.5}.ok{color:#30C46E}.bad{color:#FF6B5E}.mono{font-family:Menlo,Consolas,monospace;font-size:14px}</style></head>'
        + '<body><div class="card"><h1>Send an app to this TV</h1><p>Pick a Tizen package (<b>.wgt</b> or <b>.tpk</b>). It goes to TV-Store on <span class="mono">' + escHtml(ip) + '</span>. Nothing installs until you press <b>Install</b> on the TV screen.</p>' + waiting
        + '<input type="file" id="f" accept=".wgt,.tpk"><button class="btn" id="b" disabled>Send to the TV</button><div class="bar"><i id="i"></i></div><div class="msg" id="m"></div></div>'
        + '<script>(function(){var f=document.getElementById("f"),b=document.getElementById("b"),m=document.getElementById("m"),bar=document.querySelector(".bar"),i=document.getElementById("i");'
        + 'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")}'
        + 'f.onchange=function(){b.disabled=!f.files.length;m.textContent=""};'
        + 'b.onclick=function(){var file=f.files[0];if(!file)return;b.disabled=true;bar.style.display="block";i.style.width="0";m.className="msg";m.textContent="Sending "+file.name+" ("+(file.size/1048576).toFixed(1)+" MB)\\u2026";'
        + 'var x=new XMLHttpRequest();x.open("PUT","/upload?name="+encodeURIComponent(file.name),true);'
        + 'x.upload.onprogress=function(e){if(e.lengthComputable)i.style.width=Math.round(e.loaded/e.total*100)+"%"};'
        + 'x.onload=function(){var r={};try{r=JSON.parse(x.responseText)}catch(e){}if(x.status===200&&r.ok){i.style.width="100%";m.className="msg ok";m.innerHTML="<b>Sent.</b> Now look at the TV: TV-Store shows "+esc(r.upload.name)+" and asks whether to install it."}else{m.className="msg bad";m.textContent="The TV did not take it: "+(r.error||("HTTP "+x.status));b.disabled=false}};'
        + 'x.onerror=function(){m.className="msg bad";m.textContent="Could not reach the TV.";b.disabled=false};x.send(file)}})();</script></body></html>';
}
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function logText() {
    var t = '';
    try { t += '--- previous run ---\n' + fs.readFileSync(LOG_PREV, 'utf8') + '\n'; } catch (e) {}
    try { t += '--- this run ---\n' + fs.readFileSync(LOG_FILE, 'utf8'); } catch (e) { t += '--- this run (memory) ---\n' + LOGS.join('\n') + '\n'; }
    return t;
}

// Every address of this TV, loopback included: the only peers the service answers (besides /log.txt).
function ownAddresses() {
    var out = ['127.0.0.1'];
    try { var ifs = os.networkInterfaces();
        for (var n in ifs) for (var i = 0; i < ifs[n].length; i++) if (ifs[n][i].family === 'IPv4') out.push(ifs[n][i].address);
    } catch (e) {}
    return out;
}
function fromThisTv(req) {
    var a = relayMod.peerIp(req.socket);
    return /^127\./.test(a) || ownAddresses().indexOf(a) >= 0;
}

// This TV's own LAN IPv4 is the address sdbd accepts a connection on (phase 0: not loopback).
function ownIp() {
    try { var ifs = os.networkInterfaces();
        for (var n in ifs) for (var i = 0; i < ifs[n].length; i++) { var a = ifs[n][i]; if (a.family === 'IPv4' && !a.internal) return a.address; }
    } catch (e) {}
    return null;
}

// HTTPS without certificate validation: the TV's CA store is too old for today's chains, so
// nothing fetched here is trusted for where it came from. The catalog is trusted through its
// signature and a package through the hash the catalog gives it (catalog.js).
function requestOpts(u) {
    var o = url.parse(u), secure = o.protocol === 'https:', r = RESOLVE[String(o.hostname || '').toLowerCase()];
    var opts = { protocol: o.protocol, hostname: r ? r.host : o.hostname, port: r ? r.port : (o.port || (secure ? 443 : 80)), path: o.path,
                 headers: { 'User-Agent': 'Apps2Samsung-TV-Store' } };
    if (r) { opts.headers.Host = o.host; opts.servername = o.hostname; }
    if (secure) opts.rejectUnauthorized = false;
    return { opts: opts, mod: secure ? https : http };
}
// lim (optional): { maxBytes, deadlineMs }, for what someone other than Apps2Samsung publishes (#82):
// a response bigger than maxBytes is cut off with err.reason 'size', and the whole fetch, redirects
// included, gives up after deadlineMs. Five redirects at most, 30 s of silence at most, always.
function get(u, cb, hops, lim) {
    hops = hops || 0; lim = lim || {};
    if (lim.deadlineMs && !lim.until) lim = { maxBytes: lim.maxBytes, until: Date.now() + lim.deadlineMs };
    if (hops > 5) return cb(new Error('too many redirects for ' + u));
    var done = false, timer = null, req;
    function fin(err, buf) { if (done) return; done = true; if (timer) clearTimeout(timer); cb(err, buf); }
    function tooBig() { var e = new Error('the answer from ' + u + ' is larger than ' + lim.maxBytes + ' bytes'); e.reason = 'size'; return e; }
    var ro = requestOpts(u);
    req = ro.mod.get(ro.opts, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume(); logv('http: ' + res.statusCode + ' redirect to ' + res.headers.location);
            if (done) return;
            done = true; if (timer) clearTimeout(timer);
            return get(url.resolve(u, res.headers.location), cb, hops + 1, lim);
        }
        if (res.statusCode !== 200) { res.resume(); return fin(new Error('HTTP ' + res.statusCode + ' for ' + u)); }
        if (lim.maxBytes && parseInt(res.headers['content-length'] || '0', 10) > lim.maxBytes) { req.abort(); return fin(tooBig()); }
        var chunks = [], size = 0;
        res.on('data', function (d) {
            size += d.length;
            if (lim.maxBytes && size > lim.maxBytes) { req.abort(); return fin(tooBig()); }
            chunks.push(d);
        });
        res.on('end', function () { fin(null, Buffer.concat(chunks)); });
        res.on('error', fin);
    });
    req.on('error', fin); req.setTimeout(30000, function () { req.abort(); });
    if (lim.until) timer = setTimeout(function () { req.abort(); fin(new Error('no complete answer from ' + u + ' in time')); }, Math.max(1, lim.until - Date.now()));
}

// get() to a file, hashing on the way: cb(err, { size, sha256 }). A package never sits in memory.
function getToFile(u, file, cb, hops) {
    hops = hops || 0;
    if (hops > 5) return cb(new Error('too many redirects for ' + u));
    var done = false;
    function fin(err, r) { if (done) return; done = true; cb(err, r); }
    var ro = requestOpts(u);
    var req = ro.mod.get(ro.opts, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); done = true; logv('http: ' + res.statusCode + ' redirect to ' + res.headers.location); return getToFile(url.resolve(u, res.headers.location), file, cb, hops + 1); }
        if (res.statusCode !== 200) { res.resume(); return fin(new Error('HTTP ' + res.statusCode + ' for ' + u)); }
        var h = crypto.createHash('sha256'), size = 0, out = fs.createWriteStream(file);
        res.on('data', function (d) { size += d.length; h.update(d); });
        res.on('error', fin); out.on('error', fin);
        out.on('finish', function () { fin(null, { size: size, sha256: h.digest('hex') }); });
        res.pipe(out);
    });
    req.on('error', fin); req.setTimeout(30000, function () { req.abort(); });
}

// POST body JSON helper
function body(req, cb) { var c = []; req.on('data', function (d) { c.push(d); }); req.on('end', function () { try { cb(null, c.length ? JSON.parse(Buffer.concat(c).toString('utf8')) : {}); } catch (e) { cb(e); } }); }

function cors(res, code, type) { res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); }
function json(res, code, obj) { cors(res, code, 'application/json'); res.end(JSON.stringify(obj)); }

// The full install pipeline for one package. progress via log; final state via cb.
function install(entry, cb) {
    var downloadUrl = entry.url, remoteName = (entry.file || 'package.wgt').replace(/[^A-Za-z0-9._-]/g, '_');
    // Only what the signed catalog, or a signed repository the user added (#82), lists, with the
    // hash it gives: the loopback port is open to every app on the TV, and none of them gets to
    // choose what is signed with the user's certificate. (A file the user sent in by hand goes
    // through installUpload instead, behind the token only the TV-Store screen has.)
    trustFor(entry.source, function (err, cat) {
        if (err) return cb(err);
        if (!cat.index.hasOwnProperty(downloadUrl)) return cb(coded('NOT_IN_CATALOG', 'this download is not in ' + cat.label));
        var want = cat.index[downloadUrl];
        if (!want) return cb(coded('NO_HASH', 'the catalog has no hash for this file, so the TV cannot check it; install it from Apps2Samsung on a phone or PC'));
        // An installed app updates from the source it came from (#82). Another source's copy of the
        // same package replaces it only when the person at the TV said so. Checked once the package
        // says where it goes on this TV: another app's id is no replace when the package gets its own (#84).
        function sourceSwitch() {
            var from = installedFrom(entry);
            if (from && from !== cat.id && entry.switchSource !== true) {
                log('install: ' + entry.packageId + ' came from ' + sourceLabel(from) + ', not from ' + cat.label + '; not switching without a yes on the TV');
                return coded('SOURCE_SWITCH', (entry.name || entry.packageId) + ' on this TV came from ' + sourceLabel(from) + '. Installing this copy from ' + cat.label + ' replaces it, and its updates then come from there. Confirm that on the TV first.');
            }
            if (from && from !== cat.id) log('install: moving ' + entry.packageId + ' from ' + sourceLabel(from) + ' to ' + cat.label + ', confirmed on the TV');
            return null;
        }
        var early = entry.tvApps ? null : sourceSwitch();
        if (early) return cb(early);
        var done = cb;
        cb = function (err, r) {
            if (!err) {
                rememberSource(entry.packageId, cat.id);
                if (entry.renamed) rememberRename(entry, cat.id);
                if (r) { r.source = cat.id; r.packageId = entry.packageId; r.appId = entry.appId || ''; if (entry.renamed) r.renamed = { from: entry.renamed.from, to: entry.renamed.to, why: entry.renamed.why, other: entry.renamed.other || null }; }
            }
            done(err, r);
        };
        entry.catalogLevel = cat.levels[downloadUrl] || '';
        entry.key = (cat.keys && cat.keys[downloadUrl]) || '';
        if (!DATA_DIR) return cb(new Error('the service has no folder it can write to'));
        var own = selfGate(entry);
        if (own) return cb(own);
        var base = path.join(DATA_DIR, 'job-' + Date.now()), inFile = base + '.in.wgt', outFile = base + '.signed.wgt', renFile = base + '.renamed.wgt';
        function clean(err, r) { [inFile, outFile, renFile].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} }); cb(err, r); }
        log('install: downloading ' + downloadUrl);
        var started = Date.now();
        getToFile(downloadUrl, inFile, function (err, got) {
            logv('timing: download took ' + (Date.now() - started) + ' ms');
            if (err) return clean(err);
            if (got.sha256 !== want) { log('install: hash mismatch, got ' + got.sha256 + ' want ' + want); return clean(coded('HASH_MISMATCH', 'the download does not match ' + cat.label + ' (SHA-256 differs); not installing it')); }
            log('install: downloaded ' + got.size + ' bytes, SHA-256 matches ' + cat.label + '; signing');
            // The Tizen version the package asks for, against the one the page reports for this TV
            // (#47): a package the TV would refuse with [118, -19] is turned away before the push.
            manifest.read(inFile, function (err, ids) {
                if (err) logv('install: could not read the manifest (' + err.message + '); the TV decides');
                else { entry.requiredVersion = ids.requiredVersion; entry.manifestPartner = !!ids.partner; }
                var gate = tizenGate(entry);
                if (gate) return clean(gate);
                placeOnTv(entry, err ? null : ids, inFile, renFile, function (err, file) {
                    if (err) return clean(err);
                    var sw = entry.tvApps ? sourceSwitch() : null;
                    if (sw) return clean(sw);
                    signAndInstall(entry, remoteName, file, outFile, clean);
                });
            });
        });
    });
}

function coded(code, message) { var e = new Error(message); e.code = code; return e; }

// ---- another app's package id (#84) -----------------------------------------------------------------
// What the page says the TV has, { packageId: [names] } (tizen.application.getAppsInfo), cleaned up;
// null when it did not say (an older page), which leaves every package on its own id as before.
function tvAppsOf(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    var out = {};
    for (var k in v) {
        if (!v.hasOwnProperty(k) || !pkgid.isValidId(k)) continue;
        var names = Array.isArray(v[k]) ? v[k] : [v[k]];
        out[k] = names.filter(function (n) { return typeof n === 'string'; }).map(function (n) { return n.slice(0, 200); }).slice(0, 20);
    }
    return out;
}
// The renames made on this TV, oldest first: [{ originalPackageId, newPackageId, originalAppId,
// newAppId, key, source, file, at }]. Kept so another build of a renamed app lands on its tile, and
// so the page can tell which catalog entry a renamed app came from. The id itself is derived from
// the catalog entry, so a rename Apps2Samsung made is found without a record.
var RENAMES = null, RENAMES_NAME = '.a2s-package-renames.json';
function renames() {
    if (RENAMES) return RENAMES;
    try { RENAMES = JSON.parse(fs.readFileSync(path.join(DATA_DIR, RENAMES_NAME), 'utf8')); } catch (e) { RENAMES = []; }
    if (!Array.isArray(RENAMES)) RENAMES = [];
    return RENAMES;
}
function rememberRename(entry, source) {
    var r = entry.renamed, list = renames().filter(function (x) { return x.newPackageId !== r.to; });
    list.push({ originalPackageId: r.from, newPackageId: r.to, originalAppId: r.fromAppId || '', newAppId: entry.appId || '', key: entry.key || '', source: source || 'official', file: entry.file || '', at: new Date().toISOString() });
    RENAMES = list;
    if (DATA_DIR) { try { fs.writeFileSync(path.join(DATA_DIR, RENAMES_NAME), JSON.stringify(list)); } catch (e) { log('install: cannot save the package id rename: ' + e.message); } }
}
// Decides where the package at inFile goes on this TV (pkgid.decide) and renames it into renFile
// when it gets an id of its own; cb(err, the file to sign). entry.packageId and entry.appId are the
// ones it installs under afterwards, entry.renamed says what changed.
function placeOnTv(entry, ids, inFile, renFile, cb) {
    entry.tvApps = tvAppsOf(entry.tvApps);
    // The package's own ids over what the page took from the catalog.
    if (ids) { entry.packageId = ids.packageId || entry.packageId; entry.appId = ids.appId || entry.appId; }
    if (!ids || !entry.tvApps) return cb(null, inFile);
    var d = pkgid.decide({ kind: ids.kind, packageId: ids.packageId, names: ids.names, key: entry.key, tvApps: entry.tvApps, renames: renames() });
    var name = ids.name || entry.name || ids.packageId;
    function onTv(id) { return entry.tvApps.hasOwnProperty(id); }
    if (d.taken) {
        if (entry.replaceOther === true) {
            log('install: ' + ids.packageId + ' is ‘' + d.taken + '’ on this TV, and ' + name + ' replaces it, confirmed on the TV');
            entry.installed = true;
            return cb(null, inFile);
        }
        log('install: ' + name + ' uses package id ' + ids.packageId + ', which ‘' + d.taken + '’ on this TV has; ' + (ids.kind === 'tpk' ? 'a native app keeps its own id' : 'the catalog names no entry to derive another id from') + ', so not installing without a yes on the TV');
        return cb(coded('PACKAGE_ID_TAKEN', 'Already on your TV: ' + d.taken + '. Installing ' + name + ' would replace it' + (ids.kind === 'tpk' ? ' (a native app cannot be installed under another id)' : '') + '.'));
    }
    if (!d.rename) {
        if (ids.packageId) entry.installed = onTv(ids.packageId);
        return cb(null, inFile);
    }
    log('install: ' + (d.why === 'collision'
        ? name + ' uses package id ' + ids.packageId + ', which ‘' + d.other + '’ on this TV already has; installing it as a separate app under ' + d.rename
        : name + ' is on this TV as ' + d.rename + ' (renamed from ' + ids.packageId + ' when it was installed); updating that copy'));
    pkgid.rewrite(inFile, renFile, ids.packageId, d.rename, function (err, r) {
        if (err) { log('install: the rename failed: ' + err.message); return cb(coded('RENAME_FAILED', 'TV-Store could not give ' + name + ' a package id of its own: ' + err.message)); }
        logv('install: renamed ' + r.from + ' to ' + r.to + ' in ' + r.files.join(', '));
        manifest.read(renFile, function (err, now) {
            if (err) return cb(coded('RENAME_FAILED', 'the renamed package does not read back: ' + err.message));
            entry.renamed = { from: ids.packageId, to: d.rename, why: d.why, other: d.other || null, fromAppId: ids.appId };
            entry.packageId = now.packageId; entry.appId = now.appId; entry.installed = onTv(now.packageId);
            cb(null, renFile);
        });
    });
}
// GET /pkgids: download URL -> the package id a rename gives that file, for every file of the
// official catalog and of each repository that verified, so the page finds a renamed app (#84).
// Second: the official catalog's removed apps by package id (#87), renamed ids included, which
// the page cannot derive itself.
function pkgIds(cb) {
    withCatalog(function (err, cat) {
        var out = {}, u;
        if (cat && cat.keys) for (u in cat.keys) if (cat.keys.hasOwnProperty(u)) out[u] = pkgid.derive(cat.keys[u]);
        withSources(false, function (list) {
            list.forEach(function (r) {
                if (!r.verified || !r.verified.files) return;
                for (var u in r.verified.files) if (r.verified.files.hasOwnProperty(u)) out[u] = pkgid.derive(pkgid.key(r.source.url, r.verified.files[u]));
            });
            cb(out, (cat && cat.removed) || {});
        });
    });
}

// The page sends the TV's platform version with every install (entry.tizen, "4.0"); the package's
// own manifest says what it asks for (entry.requiredVersion). A mismatch is refused here with the
// reason, instead of by the TV with a bare [118, -19] (#44, #47). Either side unknown: no gate.
function tizenGate(entry) {
    var tv = refusals.tizenVersionOf(entry), req = entry.requiredVersion || '';
    if (!manifest.needsNewer(req, tv)) return null;
    log('install: ' + (entry.file || 'the package') + ' asks for Tizen ' + req + ', this TV runs Tizen ' + tv + '; not pushing it');
    return coded('NEEDS_NEWER_TIZEN', 'This app asks for Tizen ' + req + ' or newer, and this TV runs Tizen ' + tv + '. The TV would refuse it. If the catalog has a build for older sets, pick that one.');
}

// An app installed from a phone or PC carries that device's author certificate, and the TV only
// updates it with the same one (#44). When the page asks for a replace, the old copy goes first
// (0 vd_appuninstall, the verb the heads use), on its own connection; a refusal is logged and the
// install goes ahead anyway, so the TV's own answer is what the user sees.
// With wascmd doing the installs (#57) sdbd may be out of reach (Host PC IP at a phone or PC), and
// the removal is the one step that still needs it: going ahead would hit the same mismatch and
// offer the same removal again, so that case stops here with what to do instead. (wascmd's own
// uninstall flag is not documented; the usage text logged before the first install is where it
// will be read from.)
function removeOld(entry, cb) {
    if (!entry.replace || !entry.packageId) return cb();
    log('install: removing the old copy of ' + entry.packageId + ' first (installed with another certificate)');
    connectSdb(sdbHosts(), function (err, c) {
        if (err) {
            log('install: could not remove the old copy: ' + err.message);
            if (wascmdWanted()) return cb(coded('REPLACE_NEEDS_SDB', 'TV-Store cannot remove the old copy: that step still goes through the TV’s developer connection, and ' + err.message + ' Or remove the app from the TV’s Apps menu by hand, then install it from here.'));
            return cb();
        }
        c.shell('0 vd_appuninstall ' + entry.packageId, function (err, out) {
            c.end();
            log('install: vd_appuninstall reply: ' + (err ? err.message : out.replace(/\s+/g, ' ').slice(0, 200)));
            cb();
        });
    });
}

// sdbd on this TV, at the first address that completes the handshake (#26, #52). Developer Mode's
// Host PC IP lets a connection in only on the address it names, which is either the TV's own LAN IP
// or 127.0.0.1 (a rooted TV is pinned there), so both are tried and whichever answers is kept and
// tried first next time (SDB_WORKED). After them, another app's sdb tunnel on 127.0.0.1 (#90): Vetro
// holds sdbd's one connection for as long as it runs and shares it there, so with Vetro on the TV
// both direct addresses are dropped and the tunnel is the way in. The TV keeps one app out of another
// app's port on loopback (EHOSTUNREACH on an S95F), so the tunnel is tried on the TV's own LAN IP as
// well, which Vetro lets in with its "Allow SDB from the local network" switch on. Not when TV-Store's
// own relay has that port: the relay only leads back to the same sdbd. When none gets in, the error
// says what to change on the TV instead of the socket error.
var SDB_WORKED = null;
function tunnelPort() { var s = relay.status(); return s.listening && s.port === TUNNEL_PORT ? 0 : TUNNEL_PORT; }
function sdbHosts() { return sdbhosts.targets(ownIp(), SDB_WORKED, SDB_PORT, tunnelPort()); }
function sdbName(t) { return t.tunnel ? t.host + ':' + t.port + ' (another app\u2019s sdb tunnel, as Vetro has' + (t.host === sdbhosts.LOOPBACK ? '' : ', through this TV\u2019s own IP') + ')' : t.host; }
function connectSdb(hosts, cb, i, seen) {
    i = i || 0; seen = seen || [];
    var t = hosts[i];
    var c = new sdb.SdbClient(t.host, t.port);
    c.trace = VERBOSE ? function (m) { logv('sdb ' + t.host + ':' + t.port + ': ' + m); } : null;
    c.connect(function (err) {
        if (!err) {
            SDB_WORKED = t; log('install: sdb connected to ' + sdbName(t) + ', first frame ' + c.firstFrame);
            if (!t.tunnel && t.host === sdbhosts.LOOPBACK) relayLoopbackSeen();
            return cb(null, c);
        }
        c.end();
        log('install: ' + err.message);
        seen.push({ host: t.host, code: err.code, frame: c.firstFrame, tunnel: t.tunnel });
        if (i + 1 < hosts.length) return connectSdb(hosts, cb, i + 1, seen);
        SDB_WORKED = null;   // the remembered address stopped answering; relearn next time
        cb(sdbAdvice(err, seen));
    });
}

// What the user can do about a failed sdb connection. A refused connection means sdbd is not
// listening: Developer Mode is off. One that sdbd accepts and drops without a word is what a caller
// the Host PC IP does not name gets (#26). Both the TV's own IP and 127.0.0.1 are tried (#52), so a
// drop on every address means Host PC IP points somewhere else (a phone or PC). Unless a phone or PC
// is on the developer connection right now: sdbd takes one client at a time (seen on a 2019 Tizen
// 5.0 set, #73), and drops a second one the same silent way. The relay knows about its own sessions,
// so with one open the drop is read as that, not as a wrong Host PC IP. Only the direct attempts
// count here: a tunnel that is not there, or that cannot reach sdbd either, says nothing new. Except
// when the TV kept TV-Store out of the tunnel's port on loopback (#90): then another app (Vetro)
// listens there and holds sdbd, and the drops say that, not a wrong Host PC IP.
function sdbAdvice(err, seen) {
    var held = sdbhosts.heldByApp(seen);
    seen = seen.filter(function (s) { return !s.tunnel; });
    var ip = ownIp();
    var either = 'this TV\u2019s own IP' + (ip ? ' (' + ip + ')' : '') + ' or 127.0.0.1';
    if (seen.every(function (s) { return s.code === 'ECONNREFUSED'; }))
        return coded('DEV_MODE_OFF', 'Developer Mode is off on this TV. Turn it on (Apps, then 1 2 3 4 5) with Host PC IP set to ' + either + ', restart the TV and try again.');
    var dropped = seen.some(function (s) { return !s.frame && /^(ECONNRESET|EPIPE|SDB_CLOSED)$/.test(s.code || ''); });
    var busy = relayStatus().sessions;
    if (dropped && busy > 0)
        return coded('SDB_BUSY', 'The TV\u2019s developer connection is in use: a phone or PC is connected to this TV through the relay (' + busy + (busy === 1 ? ' session' : ' sessions') + '), and the TV takes one connection at a time. Close Apps2Samsung there, or wait until it is done, and try again.');
    if (dropped && held && held.lanBlocked)
        return coded('APP_HOLDS_SDB', 'Another app on this TV, most likely Vetro, holds the TV\u2019s developer connection, and the TV does not let TV-Store into that app\u2019s sdb tunnel. Until that app lets other apps on the TV in, install from a phone or PC: turn on Vetro\u2019s \u201cAllow SDB from the local network\u201d and connect Apps2Samsung to ' + (ip || 'this TV') + ':' + TUNNEL_PORT + '.');
    if (dropped && held)
        return coded('APP_HOLDS_SDB', 'Another app on this TV, most likely Vetro, holds the TV\u2019s developer connection, and TV-Store can only reach it through that app\u2019s sdb tunnel on this TV\u2019s own IP. In Vetro, turn on \u201cAllow SDB from the local network\u201d and try again. Host PC IP stays at 127.0.0.1.');
    if (dropped)
        return coded('HOST_PC_IP', 'The TV turned the install away. In Developer Mode (Apps, then 1 2 3 4 5), Host PC IP must be ' + either + ', not a phone or PC. Change it, restart the TV and try again.');
    return err;
}

// Which privilege level an install signs with (#50), from entry: certLevel is the choice made on
// the TV ('public' | 'partner', Sign with in the app sheet); catalogLevel 'partner' is the
// catalog's word that the app cannot do without one; manifestPartner is a partner-level privilege
// in the package's own manifest. The first two are firm: { want } names the level and the install
// is refused when the TV holds no such profile. The manifest alone only makes Partner the first
// choice for a package the TV has not installed before, when it holds one: { prefer }.
function wantedLevel(entry, store, remembered) {
    var wish = /^(public|partner)$/.test(String(entry.certLevel || '')) ? entry.certLevel : '';
    var want = wish || (entry.catalogLevel === 'partner' ? 'partner' : '');
    var why = wish ? 'chosen on the TV' : want ? 'the catalog says this app needs one' : '';
    if (want) return { want: want, why: why, missing: !certs.has(store, want) };
    if (entry.manifestPartner && !remembered && certs.has(store, 'partner')) return { prefer: 'partner', why: 'the package asks for partner-level privileges' };
    return {};
}
function missingLevel(want, store) {
    var have = certs.summary(store).map(function (c) { return '\u2018' + c.name + '\u2019' + (c.level === 'unknown' ? '' : ' (' + levelName(c.level) + ')'); }).join(', ');
    if (want === 'partner') return coded('NEEDS_PARTNER', 'This app needs a Partner certificate, and this TV only holds ' + (have || 'none') + '. In Apps2Samsung on your phone or PC, set the signing certificate to Partner in Settings and install any app once, so it creates one; then press Arm TV-Store again. Both certificates come along.');
    return coded('NEEDS_PUBLIC', 'Public was chosen for this app, and this TV only holds ' + (have || 'none') + '. Arm this TV again from a phone or PC that has a Public certificate, or pick Partner.');
}

// Signs with the profile the package took last time (else the head's first choice), pushes and
// installs. A TV only updates an app with the author certificate it was installed with (#44): when
// it refuses the certificate ("same id and different certificate", or any other [118, -12]: a
// distributor that does not cover this set, a chain the TV will not take), the next profile on
// this TV is tried, from the same input file, until one is taken or none is left. The answer is
// then the mismatch when any attempt was one, else the last refusal. inFile is gone once an
// attempt was signed; a failure before that (no certificate yet) keeps it, so an upload stays waiting.
function signAndInstall(entry, remoteName, inFile, outFile, cb) {
    var store = loadCerts(), remembered = entry.packageId ? certByPackage()[entry.packageId] : null;
    if (!certs.order(store).length) { var none = coded('NO_CERT', 'No signing certificate available on this TV yet (#844 cert hand-over).'); log('install: ' + none.message); return cb(none); }
    var lvl = wantedLevel(entry, store, remembered);
    if (lvl.missing) { var miss = missingLevel(lvl.want, store); log('install: ' + lvl.why + ', but the TV holds no ' + levelName(lvl.want) + ' certificate; not installing'); return cb(miss); }
    if (lvl.want || lvl.prefer) log('install: signing with a ' + levelName(lvl.want || lvl.prefer) + ' certificate: ' + lvl.why);
    var tries = certs.order(store, remembered, lvl.want, lvl.prefer), tried = [], i = 0, mismatch = null;
    function finish(err, r) { try { fs.unlinkSync(inFile); } catch (e) {} try { fs.unlinkSync(outFile); } catch (e) {} cb(err, r); }
    removeOld(entry, function (err) { if (err) { log('install: ' + err.message); return cb(err); } (function attempt() {
        var cert = tries[i++], started = Date.now();
        tried.push(cert);
        if (entry.self) entry.selfCert = cert.name;
        signer.signFile(inFile, outFile, cert, function (err) {
            if (err) { log('install: ' + err.message); return tried.length > 1 ? finish(err) : cb(err); }
            var size = fs.statSync(outFile).size;
            log('install: signed with ' + certLabel(cert) + ' in ' + Math.round((Date.now() - started) / 1000) + ' s, ' + size + ' bytes');
            installSigned(entry, remoteName, outFile, size, function (err, out, via) {
                        if (err) return finish(err);
                        // The installer's own words say whether it worked, whichever way the package
                        // reached it ("install failed[118, -12], reason: ..." on a refused package).
                        var failed = /install failed\[([^\]]*)\](?:,\s*reason:\s*([^\n]*))?/i.exec(out);
                        if (failed) {
                            var r = refusals.refusal(failed[1], failed[2], entry);
                            if (r.code === 'CERT_MISMATCH') mismatch = r;
                            if ((r.code === 'CERT_MISMATCH' || r.code === 'CERT_REJECTED') && i < tries.length) {
                                log('install: the TV refused the copy signed with ' + certLabel(cert) + (r.code === 'CERT_MISMATCH' ? ' (another certificate installed it)' : ' (' + (failed[2] || failed[1]).trim() + ')') + '; trying ' + certLabel(tries[i]));
                                return attempt();
                            }
                            if (mismatch) r = { code: 'CERT_MISMATCH', message: mismatch.message + ' None of the ' + tried.length + ' ' + (lvl.want ? levelName(lvl.want) + ' ' : '') + 'certificate' + (tried.length === 1 ? '' : 's') + ' on this TV (' + tried.map(certLabel).join(', ') + ') is the one it was installed with: ' + (lvl.want ? 'it was installed with another certificate, so let TV-Store remove the old copy and install it again signed ' + levelName(lvl.want) + '.' : 'arm this TV from the phone or PC that installed it, or let TV-Store remove the old copy.') };
                            return finish(coded(r.code, r.message));
                        }
                        rememberCert(entry.packageId, cert.id);
                        finish(null, { reply: out, certificate: cert.name, level: cert.level, via: via });
            });
        });
    })(); });
}

// A signed package to the TV's installer (#57): wascmd first when this TV lets the service run it,
// else (or when wascmd never got to install: not found, refused under the service's label, "cannot
// working in released image", said nothing) over sdbd as before. cb(err, out, via) with out the
// installer's own reply, read by the caller the same way for both. The marker is on from before
// the first process starts (the usage probe, once) until wascmd answered (#67, #68); a spawn that
// fails outright is remembered, so the next install and the next start skip wascmd without a fork.
function installSigned(entry, remoteName, outFile, size, cb) {
    var id = entry.appId || entry.packageId || '';
    if (wascmdWanted() && !entry.self) {
        log('install: handing to wascmd on the TV itself (' + wascmd.path + ', no sdbd and no Host PC IP involved)');
        var wasStarted = Date.now();
        markWascmd(true);
        return wascmdUsageOnce(function () { wascmd.run(id, outFile, function (err, out, code) {
            markWascmd(false);
            logv('timing: wascmd took ' + (Date.now() - wasStarted) + ' ms');
            var said = String(out || '').replace(/\s+/g, ' ').trim();
            var verdict = err ? 'error' : wascmd.interpret(out);
            if (verdict === 'ok' || verdict === 'refused') {
                INSTALLER_LAST = 'wascmd';
                log('install: wascmd reply: ' + said.slice(0, 200));
                return cb(null, out, 'wascmd');
            }
            log('install: wascmd did not install (' + (err ? err.message : 'exit ' + code + (said ? ', said: ' + said.slice(0, 200) : ', said nothing')) + '); falling back to sdbd');
            if (err && err.code && err.code !== 'TIMEOUT') wascmdOff(err.message);
            viaSdb();
        }); });
    }
    viaSdb();
    function viaSdb() {
        connectSdb(sdbHosts(), function (err, c) {
            if (err) return cb(err);
            var remote = STAGING + '/' + remoteName, fd;
            try { fd = fs.openSync(outFile, 'r'); } catch (e) { c.end(); return cb(e); }
            log('install: pushing to ' + remote);
            var pushStarted = Date.now();
            c.push(remote, { size: size, read: function (off, len) { return zip.readAt(fd, off, len); } }, function (err) {
                try { fs.closeSync(fd); } catch (e) {}
                if (err) { c.end(); return cb(err); }
                logv('timing: push took ' + (Date.now() - pushStarted) + ' ms');
                var installStarted = Date.now();
                // TV-Store's own package: the installer is expected to stop this service from here
                // on. The marker and the log line are on disk before the command goes out.
                if (entry.self) { writeSelfMark(entry); log('self-update: sending vd_appinstall; the installer stops TV-Store now. Open TV-Store again in a minute'); }
                c.shell('0 vd_appinstall ' + id + ' ' + remote, function (err, out) {
                    c.end();
                    // Still running: a refusal or a lost connection means nothing was replaced, so the
                    // marker goes; "install completed" keeps it, for the next start to confirm the version.
                    if (entry.self) {
                        var refused = !!err || /install failed/i.test(out);
                        if (refused) unlinkQuiet(SELF_MARK);
                        log('self-update: still running after vd_appinstall ' + (err ? 'failed: ' + err.message : refused ? 'refused it' : 'answered; TV-Store may still be restarted'));
                    }
                    if (err) return cb(err);
                    INSTALLER_LAST = 'sdb';
                    logv('timing: vd_appinstall took ' + (Date.now() - installStarted) + ' ms');
                    log('install: vd_appinstall reply: ' + out.replace(/\s+/g, ' ').slice(0, 200));
                    cb(null, out, 'sdb');
                });
            });
        });
    }
}

// The signed catalog, fetched and verified, cached for 10 minutes (the workflow publishes every
// 30). A download URL is installable only when this lists it.
// Requests that arrive while a fetch is running wait for that one.
var CATALOG_WAITING = null;
function withCatalog(cb, fresh) {
    if (CATALOG && !fresh && Date.now() - CATALOG.at < 10 * 60 * 1000) return cb(null, CATALOG);
    if (CATALOG_WAITING) return CATALOG_WAITING.push(cb);
    CATALOG_WAITING = [cb];
    function done(err, cat) { var w = CATALOG_WAITING; CATALOG_WAITING = null; w.forEach(function (f) { f(err, cat); }); }
    get(CATALOG_URL, function (err, buf) {
        if (err) return done(err);
        var cat;
        try { cat = catalogTrust.verify(buf, CATALOG_KEY_PEM); }
        catch (e) { log('catalog: ' + e.message); return done(e); }
        cat.at = Date.now(); CATALOG = cat;
        log('catalog: signature ok, generated ' + cat.catalog.generatedAt + ', ' + Object.keys(cat.index).length + ' files, ' + Object.keys(cat.icons).length + ' icons');
        cat.id = 'official'; cat.label = 'the signed catalog';
        pruneIcons();
        done(null, cat);
    });
}

// App icons (#66): fetched like a package, kept only when they hash to what the signed catalog
// says, cached in the data folder, served at GET /icon/<sha256>. See icons.js.
var icons = iconsMod.create({ dir: DATA_DIR ? path.join(DATA_DIR, 'icons') : null, get: get, withCatalog: withIconIndex, log: log, logv: logv });
// The icons the official catalog and every repository that verified name, hash -> URL. The official
// catalog failing leaves the repositories' icons, and the other way round.
function withIconIndex(cb) {
    withCatalog(function (err, cat) {
        var all = {}, k;
        if (cat) for (k in cat.icons) if (cat.icons.hasOwnProperty(k)) all[k] = cat.icons[k];
        withSources(false, function (list) {
            list.forEach(function (r) { if (r.verified) for (var h in r.verified.icons) if (r.verified.icons.hasOwnProperty(h) && !all.hasOwnProperty(h)) all[h] = r.verified.icons[h]; });
            if (err && !Object.keys(all).length) return cb(err);
            cb(null, { icons: all });
        });
    });
}
// Drops cached icons nothing names any more, once the official catalog and every enabled repository
// had a go: one that has not loaded yet would otherwise lose its icons at every start.
function pruneIcons() {
    if (!CATALOG) return;
    var all = {}, k;
    for (k in CATALOG.icons) if (CATALOG.icons.hasOwnProperty(k)) all[k] = true;
    for (var i = 0; i < SOURCES.length; i++) {
        if (!SOURCES[i].enabled) continue;
        var st = SOURCE_STATE[SOURCES[i].repositoryId];
        if (!st) return;
        if (st.verified) for (k in st.verified.icons) if (st.verified.icons.hasOwnProperty(k)) all[k] = true;
    }
    icons.prune(all);
}

// ---- independent repositories (#82) ----------------------------------------------------------------
// Signed repositories next to the official catalog, Cydia-style. repos.js has the trust model: a
// source reaches the TV only from Apps2Samsung (Send sources to TV), with the fingerprint of the key
// the user approved there, and the person at the TV confirms it once more; every manifest is
// checked against that fingerprint, its repository id, its age, and the last one accepted from it
// (no rollback). Kept in the data folder next to the other settings:
//   { url, repositoryId, fingerprint, name, maintainer, publicKeyPem, enabled, addedAt,
//     lastGeneratedAt, lastOkAt, lastError, lastErrorReason, lastErrorAt }
// A source that fails says why and drops out; the official catalog and the others carry on.
var SOURCES_FILE = DATA_DIR ? path.join(DATA_DIR, '.a2s-sources.json') : null;
var SOURCES = [];
try {
    if (SOURCES_FILE && fs.existsSync(SOURCES_FILE)) {
        var sf = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
        (sf && Array.isArray(sf.sources) ? sf.sources : []).forEach(function (s) {
            var n = repos.normalizeSource(s);
            if (!n.source) return log('sources: dropping a stored source that is not valid (' + n.error + ')');
            var e = n.source;
            ['maintainer', 'addedAt', 'lastGeneratedAt', 'lastOkAt', 'lastError', 'lastErrorReason', 'lastErrorAt'].forEach(function (k) { if (typeof s[k] === 'string') e[k] = s[k]; });
            e.enabled = s.enabled !== false;
            SOURCES.push(e);
        });
    }
} catch (e) { log('sources: cannot read ' + SOURCES_FILE + ': ' + e.message); }
var SOURCE_STATE = {};     // repositoryId -> { at, verified } or { at, error }
var SOURCE_WAITING = {};   // repositoryId -> callbacks waiting for the fetch that runs
var SOURCE_LIMIT = { maxBytes: repos.MAX_BYTES, deadlineMs: 60000 };
var SOURCE_TTL = 10 * 60 * 1000, SOURCE_FAIL_TTL = 2 * 60 * 1000;
function saveSources() {
    if (!SOURCES_FILE) return;
    try { fs.writeFileSync(SOURCES_FILE, JSON.stringify({ sources: SOURCES })); }
    catch (e) { log('sources: cannot save: ' + e.message); }
}
function sourceById(id) { for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i].repositoryId === id) return SOURCES[i]; return null; }
function sourceLabel(id) { if (!id || id === 'official') return 'the official catalog'; var s = sourceById(id); return s ? '‘' + (s.name || id) + '’' : id + ' (a source no longer on this TV)'; }
// What the page and Apps2Samsung get to see of a source: everything but the key itself.
function publicSource(s) {
    var st = SOURCE_STATE[s.repositoryId];
    return { url: s.url, repositoryId: s.repositoryId, fingerprint: s.fingerprint, name: s.name || s.repositoryId, maintainer: s.maintainer || '', domain: repos.hostOf(s.url),
             enabled: s.enabled, addedAt: s.addedAt || null, lastGeneratedAt: s.lastGeneratedAt || null, lastOkAt: s.lastOkAt || null,
             lastError: s.lastError || null, lastErrorReason: s.lastErrorReason || null, lastErrorAt: s.lastErrorAt || null,
             ok: !!(st && st.verified), apps: st && st.verified ? st.verified.manifest.providers.length : null };
}

// The public key of a source: the one Apps2Samsung handed over or the TV pinned before, else
// repository.pem next to the manifest, kept only when it hashes to the approved fingerprint.
function sourceKey(s, cb) {
    if (s.publicKeyPem) return cb(null, s.publicKeyPem);
    var ku = url.resolve(s.url, 'repository.pem');
    get(ku, function (err, buf) {
        if (err) return cb(new Error('could not fetch the repository key (' + err.message + ')'));
        var pem = buf.toString('utf8'), k = repos.keyInfo(pem);
        if (!k || k.fingerprint !== s.fingerprint) {
            var e = new Error('repository.pem next to the repository is not the key approved in Apps2Samsung' + (k ? ' (it is ' + k.fingerprint.slice(0, 16) + '…)' : '') + ': if the publisher changed keys, approve the new one in Apps2Samsung and send the source to this TV again');
            e.reason = 'fingerprint';
            return cb(e);
        }
        cb(null, pem);
    }, 0, { maxBytes: 64 * 1024, deadlineMs: 30000 });
}
// Fetch and verify one source, nothing stored: cb(err, verified) with verified.publicKeyPem.
function fetchSource(s, cb) {
    sourceKey(s, function (err, pem) {
        if (err) return cb(err);
        get(s.url, function (err, buf) {
            if (err) return cb(err);
            var v;
            try { v = repos.verify(buf, { publicKeyPem: pem, fingerprint: s.fingerprint, repositoryId: s.repositoryId, notBefore: s.lastGeneratedAt }); }
            catch (e) { return cb(e); }
            v.publicKeyPem = pem;
            cb(null, v);
        }, 0, SOURCE_LIMIT);
    });
}
// A stored source, fetched and verified, cached like the official catalog (a failure for 2 min);
// the outcome is written back to the store. cb({ verified } | { error }).
function loadSource(s, fresh, cb) {
    var id = s.repositoryId, st = SOURCE_STATE[id];
    if (st && !fresh && Date.now() - st.at < (st.verified ? SOURCE_TTL : SOURCE_FAIL_TTL)) return cb(st);
    if (SOURCE_WAITING[id]) return SOURCE_WAITING[id].push(cb);
    SOURCE_WAITING[id] = [cb];
    fetchSource(s, function (err, v) {
        var now = new Date().toISOString();
        if (sourceById(id) === s) {
            if (err) {
                s.lastError = err.message; s.lastErrorReason = err.reason || null; s.lastErrorAt = now;
                SOURCE_STATE[id] = { at: Date.now(), error: err };
                log('sources: ' + (s.name || id) + ' failed' + (err.reason ? ' [' + err.reason + ']' : '') + ': ' + err.message);
            } else {
                if (!s.lastGeneratedAt || Date.parse(v.generatedAt) > Date.parse(s.lastGeneratedAt)) s.lastGeneratedAt = v.generatedAt;
                s.publicKeyPem = v.publicKeyPem; s.name = v.repository.name; s.maintainer = v.repository.maintainer;
                s.lastOkAt = now; delete s.lastError; delete s.lastErrorReason; delete s.lastErrorAt;
                SOURCE_STATE[id] = { at: Date.now(), verified: v };
                log('sources: ' + s.name + ' (' + id + '): signature ok, generated ' + v.generatedAt + ', ' + Object.keys(v.index).length + ' files');
            }
            saveSources();
        }
        var w = SOURCE_WAITING[id]; delete SOURCE_WAITING[id];
        var out = err ? { error: err } : SOURCE_STATE[id] || { at: Date.now(), verified: v };
        w.forEach(function (f) { f(out); });
        pruneIcons();
    });
}
// Every enabled source, loaded side by side: cb([{ source, verified } | { source, error }]).
function withSources(fresh, cb) {
    var list = SOURCES.filter(function (s) { return s.enabled; }), out = [], left = list.length;
    if (!left) return cb([]);
    list.forEach(function (s, i) {
        loadSource(s, fresh, function (st) {
            out[i] = { source: s, verified: st.verified || null, error: st.error || null };
            if (--left === 0) cb(out);
        });
    });
}
// What an install from `source` may download: { id, label, index, levels }. No source, or
// 'official': the signed catalog, as before #82.
function trustFor(source, cb) {
    if (!source || source === 'official') return withCatalog(function (err, cat) { cb(err, cat); });
    var s = sourceById(String(source));
    if (!s) return cb(coded('UNKNOWN_SOURCE', 'that source is no longer on this TV; nothing is installed from it'));
    if (!s.enabled) return cb(coded('SOURCE_OFF', '‘' + (s.name || s.repositoryId) + '’ is turned off in Settings, Sources'));
    loadSource(s, false, function (st) {
        if (st.error) return cb(coded('SOURCE_FAILED', '‘' + (s.name || s.repositoryId) + '’ did not load, so nothing is installed from it: ' + st.error.message));
        var keys = {}, files = st.verified.files || {};
        for (var u in files) if (files.hasOwnProperty(u)) keys[u] = pkgid.key(s.url, files[u]);
        cb(null, { id: s.repositoryId, label: '‘' + (s.name || s.repositoryId) + '’', index: st.verified.index, levels: st.verified.levels, keys: keys });
    });
}

// Where each package TV-Store installed came from: packageId -> 'official' | repositoryId. An app
// without an entry that the TV lists counts as the official catalog's, as before #82.
var SOURCE_OF = null, SOURCE_OF_NAME = '.a2s-source-by-package.json';
function sourceOfPackage() {
    if (SOURCE_OF) return SOURCE_OF;
    try { SOURCE_OF = JSON.parse(fs.readFileSync(path.join(DATA_DIR, SOURCE_OF_NAME), 'utf8')) || {}; } catch (e) { SOURCE_OF = {}; }
    return SOURCE_OF;
}
function saveSourceOf() { if (DATA_DIR) { try { fs.writeFileSync(path.join(DATA_DIR, SOURCE_OF_NAME), JSON.stringify(SOURCE_OF)); } catch (e) { log('sources: cannot save where apps came from: ' + e.message); } } }
function rememberSource(packageId, id) { if (!packageId) return; var m = sourceOfPackage(); if (m[packageId] === id) return; m[packageId] = id; saveSourceOf(); }
function forgetSource(packageId) { if (!packageId) return; var m = sourceOfPackage(); if (!m.hasOwnProperty(packageId)) return; delete m[packageId]; saveSourceOf(); }
// The source an install would replace: the one remembered, else the official catalog when the page
// says the TV has the package; null when it is not on the TV.
function installedFrom(entry) {
    if (!entry.packageId || !entry.installed) return null;
    return sourceOfPackage()[entry.packageId] || 'official';
}

// Settings and Apps2Samsung's Send sources to TV, both through the page (POST /sources/...):
// check one without keeping it, add it with the page's token, turn it off or on, remove it.
// { moved: true } is a source the signed official catalog names in moved_to (#82): its URL and
// fingerprint must be what the catalog says for some package, which stands in for the approval in
// Apps2Samsung, and its repository id comes from the manifest itself (moved_to carries none).
function checkSource(b, cb) {
    var moved = !!(b && b.moved === true);
    var n = repos.normalizeSource(b, { idFromManifest: moved });
    if (n.error) return cb(coded('BAD_SOURCE', n.error));
    var s = n.source;
    function go(vouched) {
        var had = s.repositoryId ? sourceById(s.repositoryId) : null;
        if (had && had.fingerprint === s.fingerprint) s.lastGeneratedAt = had.lastGeneratedAt;
        fetchSource(s, function (err, v) {
            if (err) { var e = coded('SOURCE_REFUSED', err.message); e.reason = err.reason || null; return cb(e); }
            if (!s.repositoryId) {
                s.repositoryId = v.repository.id;
                had = sourceById(s.repositoryId);
                if (had && had.fingerprint === s.fingerprint && had.lastGeneratedAt && Date.parse(v.generatedAt) < Date.parse(had.lastGeneratedAt)) {
                    var r = coded('SOURCE_REFUSED', 'the repository is from ' + v.generatedAt + ', older than the one already accepted (' + had.lastGeneratedAt + '): refused as a rollback'); r.reason = 'rollback'; return cb(r);
                }
            }
            v.vouched = vouched;
            cb(null, s, v, had);
        });
    }
    if (!moved) return go(null);
    withCatalog(function (err, cat) {
        if (err) return cb(coded('SOURCE_REFUSED', 'the official catalog did not load, so it cannot vouch for this source: ' + err.message));
        var pkgs = movedPackages(cat, s);
        if (!pkgs.length) return cb(coded('NOT_MOVED', 'the official catalog names no app that moved to this repository with this key'));
        go(pkgs);
    });
}
// The package ids the official catalog says moved to source s (same URL and key).
function movedPackages(cat, s) {
    var out = [], m = (cat && cat.moved) || {};
    for (var pkg in m) if (m.hasOwnProperty(pkg) && m[pkg].url === s.url && m[pkg].fingerprint === s.fingerprint) out.push(pkg);
    return out;
}
function describe(s, v, had) {
    var r = v.repository;
    return { url: s.url, repositoryId: s.repositoryId, fingerprint: s.fingerprint, domain: repos.hostOf(s.url), name: r.name, maintainer: r.maintainer, description: r.description || '', homepage: r.homepage || '',
             generatedAt: v.generatedAt, apps: v.manifest.providers.length, files: Object.keys(v.index).length, known: !!(had && had.enabled !== false), keyChanged: !!(had && had.fingerprint !== s.fingerprint),
             movedFrom: v.vouched || null };
}
// The package ids a verified repository lists.
function packagesIn(v) {
    var out = {};
    v.manifest.providers.forEach(function (p) { p.releases.forEach(function (r) { r.assets.forEach(function (a) { if (a.package_id) out[a.package_id] = true; }); }); });
    return out;
}
function addSource(b, cb) {
    checkSource(b, function (err, s, v, had) {
        if (err) { log('sources: refused ' + (b && b.url) + ': ' + err.message); return cb(err); }
        var at = new Date().toISOString();
        s.publicKeyPem = v.publicKeyPem; s.name = v.repository.name; s.maintainer = v.repository.maintainer;
        s.lastGeneratedAt = had && had.lastGeneratedAt && Date.parse(had.lastGeneratedAt) > Date.parse(v.generatedAt) ? had.lastGeneratedAt : v.generatedAt;
        s.lastOkAt = at; s.addedAt = had && had.addedAt || at; s.enabled = true;
        if (had) SOURCES[SOURCES.indexOf(had)] = s; else SOURCES.push(s);
        SOURCE_STATE[s.repositoryId] = { at: Date.now(), verified: v };
        saveSources();
        log('sources: ' + (had ? (had.fingerprint !== s.fingerprint ? 'updated (new key) ' : 'updated ') : 'added ') + s.name + ' (' + s.repositoryId + ', ' + repos.hostOf(s.url) + ', key ' + s.fingerprint.slice(0, 16) + '…), '
            + (v.vouched ? 'named by the official catalog as where ' + v.vouched.join(', ') + ' moved, ' : '') + 'confirmed on the TV; ' + Object.keys(v.index).length + ' files');
        // Moved apps (#82): their updates come from the new repository from now on, for each package the
        // official catalog says moved there, that it lists, and that came from the official catalog.
        var adopted = [];
        if (v.vouched) {
            var listed = packagesIn(v), m = sourceOfPackage();
            v.vouched.forEach(function (pkg) {
                if (!listed[pkg] || (m[pkg] && m[pkg] !== 'official')) return;
                rememberSource(pkg, s.repositoryId); adopted.push(pkg);
            });
            if (adopted.length) log('sources: updates of ' + adopted.join(', ') + ' come from ' + s.name + ' now (moved there, says the official catalog)');
        }
        var d = describe(s, v, had); d.adopted = adopted;
        cb(null, d);
    });
}
function pageToken(b) { return String((b && b.token) || '') === UPLOAD_TOKEN; }


// The signing certificates a head hands over (see #844): author/distributor key+cert as PEM (not
// a .p12: Node has no PKCS#12 parser), every profile the head holds since #44 (certs.js has the
// shape). Kept in memory and persisted best-effort.
function loadCerts() {
    if (CERTS) return CERTS;
    for (var i = 0; i < CERT_DIRS.length; i++) {
        var f = path.join(CERT_DIRS[i], CERT_NAME), raw;
        try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
        var store = certs.fromStored(raw);
        if (!store) continue;
        CERTS = store; CERT_FILE = f;
        // Found in a worse place (0.3.3 kept it in $HOME or /tmp), or in the one-profile shape: write it back.
        if (i > 0 || !Array.isArray(raw.certificates)) saveCerts(CERTS);
        return CERTS;
    }
    return null;
}
// Which profile each package was last signed with here, so an update takes the same one first.
var CERT_BY_PKG = null, CERT_BY_PKG_NAME = '.a2s-tvstore-cert-by-package.json';
function certByPackage() {
    if (CERT_BY_PKG) return CERT_BY_PKG;
    try { CERT_BY_PKG = JSON.parse(fs.readFileSync(path.join(DATA_DIR, CERT_BY_PKG_NAME), 'utf8')) || {}; } catch (e) { CERT_BY_PKG = {}; }
    return CERT_BY_PKG;
}
// Package id -> { name, level } of the profile it was last signed with here, for the page's "Sign
// with" line: the service signs an app it installed before with that profile first, whatever the
// manifest asks (#50), so the page should say the same.
function rememberedLevels() {
    var map = certByPackage(), store = loadCerts(), out = {};
    var byId = {};
    ((store && store.certificates) || []).forEach(function (c) { byId[c.id] = c; });
    for (var pkg in map) if (map.hasOwnProperty(pkg) && byId[map[pkg]]) out[pkg] = { name: byId[map[pkg]].name, level: byId[map[pkg]].level };
    return out;
}
function rememberCert(packageId, certId) {
    if (!packageId || !certId || !DATA_DIR) return;
    var map = certByPackage(); if (map[packageId] === certId) return;
    map[packageId] = certId;
    try { fs.writeFileSync(path.join(DATA_DIR, CERT_BY_PKG_NAME), JSON.stringify(map)); } catch (e) {}
}
// A removed profile is no longer the one any package took first.
function forgetCert(certId) {
    var map = certByPackage(), changed = false;
    for (var pkg in map) if (map.hasOwnProperty(pkg) && map[pkg] === certId) { delete map[pkg]; changed = true; }
    if (changed && DATA_DIR) { try { fs.writeFileSync(path.join(DATA_DIR, CERT_BY_PKG_NAME), JSON.stringify(map)); } catch (e) {} }
}
function certById(store, id) { return ((store && store.certificates) || []).filter(function (c) { return !!id && c.id === id; })[0] || null; }
function saveCerts(b) {
    CERTS = b; CERT_ERROR = null;
    for (var i = 0; i < CERT_DIRS.length; i++) {
        var f = path.join(CERT_DIRS[i], CERT_NAME);
        try { fs.writeFileSync(f, JSON.stringify(b)); CERT_FILE = f; log('cert: stored in ' + f); return; }
        catch (e) { CERT_ERROR = f + ': ' + e.message; log('cert: cannot write ' + CERT_ERROR); }
    }
}
function haveCerts() { var c = loadCerts(); return !!(c && c.certificates && c.certificates.length); }
function certLabel(c) { return '\u2018' + (c.name || c.id.slice(0, 12)) + '\u2019' + (c.level === 'partner' ? ' (Partner)' : c.level === 'public' ? ' (Public)' : ''); }
function levelName(l) { return l === 'partner' ? 'Partner' : 'Public'; }

http.createServer(function (req, res) {
    if (req.method === 'OPTIONS') { cors(res, 204, 'text/plain'); return res.end(); }
    var route = url.parse(req.url).pathname;
    // The page polls /ping and /logs all the time; those would drown the rest.
    if (VERBOSE && !/^\/(ping|logs|log\.txt|uploads|icon\/.*)$/.test(route)) res.on('finish', function () { logv('http: ' + req.method + ' ' + route + ' -> ' + res.statusCode); });
    if (route === '/log.txt') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); return res.end(logText()); }
    // The upload page and the upload itself come from a phone or PC (#30); the install of it only
    // from the TV-Store screen, below the gate and with the token.
    if (route === '/upload' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(uploadPage()); }
    if (route === '/upload' && (req.method === 'PUT' || req.method === 'POST')) return receiveUpload(req, res);
    // The relay's state is for the phone or PC that could not get through it (#58).
    if (route === '/relay' && req.method === 'GET') return json(res, 200, { ok: true, relay: relayPublic() });
    // The rest only for this TV: the port is open to the LAN because Tizen 10 may not route a page's
    // request to the service over loopback, but nothing else on the network gets to hand over a
    // certificate or start an install.
    if (!fromThisTv(req)) { cors(res, 403, 'text/plain'); return res.end('only this TV may use TV-Store'); }
    if (route === '/ping') return json(res, 200, { ok: true, service: 'tv-store', ownIp: ownIp(), logUrl: 'http://' + ownIp() + ':' + PORT + '/log.txt', signerReady: signer.ready, certReady: haveCerts(),
        certCount: haveCerts() ? loadCerts().certificates.length : 0, certNames: certs.names(loadCerts()), certificates: certs.summary(loadCerts()),
        certFile: CERT_FILE, certError: CERT_ERROR, node: process.version, verbose: VERBOSE, relay: relayStatus(), installer: installerStatus(), remembered: rememberedLevels(), selfUpdate: SELF_UPDATE,
        sources: SOURCES.map(publicSource), sourceOf: sourceOfPackage() });
    // The page has shown how the last self-update went (#41); { version } is what runs now.
    if (route === '/selfupdate/ack' && req.method === 'POST') return body(req, function (err, b) {
        var running = !err && b && typeof b.version === 'string' ? b.version : '';
        if (SELF_UPDATE) log('self-update: the update to v' + (SELF_UPDATE.to || '?') + ' sent at ' + SELF_UPDATE.at + ' ' + ({ landed: 'landed', 'not-landed': 'did not land', unknown: 'has an unknown outcome' })[selfupdate.outcome(SELF_UPDATE, running)] + '; TV-Store v' + (running || '?') + ' runs now');
        clearSelfMark();
        json(res, 200, { ok: true });
    });
    if (route === '/settings' && req.method === 'POST') return body(req, function (err, b) {
        if (err || !b || (typeof b.verbose !== 'boolean' && b.relay === undefined && b.installer === undefined)) return json(res, 400, { ok: false, error: 'need { verbose: true|false }, { relay: { enabled, port, allow } } and/or { installer: { mode } }' });
        if (b.relay !== undefined) { var why = relaySettingsProblem(b.relay); if (why) return json(res, 400, { ok: false, error: why }); }
        if (b.installer !== undefined) { var iwhy = installerSettingsProblem(b.installer); if (iwhy) return json(res, 400, { ok: false, error: iwhy }); }
        if (typeof b.verbose === 'boolean') setVerbose(b.verbose);
        if (b.installer !== undefined) applyInstallerSettings(b.installer);
        if (b.relay === undefined) return json(res, 200, { ok: true, verbose: VERBOSE, relay: relayStatus(), installer: installerStatus() });
        applyRelaySettings(b.relay, function (status) { json(res, 200, { ok: true, verbose: VERBOSE, relay: status, installer: installerStatus() }); });
    });
    if (route === '/logs') return json(res, 200, { logs: LOGS });
    if (route === '/uploads') return json(res, 200, { pending: publicUpload(), busy: UPLOAD_BUSY });
    if (route === '/upload/discard' && req.method === 'POST') return body(req, function () {
        if (UPLOAD_BUSY) return json(res, 409, { ok: false, error: 'that file is being installed' });
        if (UPLOAD) log('upload: ' + UPLOAD.name + ' discarded on the TV');
        UPLOAD = null; unlink(UPLOAD_FILE);
        json(res, 200, { ok: true });
    });
    var iconHex = /^\/icon\/([0-9a-fA-F]{64})$/.exec(route);
    if (iconHex && req.method === 'GET') return icons.serve(iconHex[1].toLowerCase(), res);
    // Independent repositories (#82). Reading is open to this TV; a change needs the page's token,
    // like an upload, since other apps on the TV reach this port too.
    if (route === '/sources' && req.method === 'GET') return json(res, 200, { ok: true, sources: SOURCES.map(publicSource) });
    // Every source, in the order added; the enabled ones loaded and with their manifest when it verified.
    if (route === '/sources/catalog') return withSources(/fresh=1/.test(url.parse(req.url).query || ''), function (list) {
        json(res, 200, { ok: true, sources: SOURCES.map(function (s) {
            var r = list.filter(function (x) { return x.source === s; })[0] || {}, p = publicSource(s);
            p.error = r.error ? r.error.message : null; p.reason = r.error ? r.error.reason || null : null;
            p.manifest = r.verified ? r.verified.manifest : null;
            return p;
        }) });
    });
    if (route === '/sources/check' && req.method === 'POST') return body(req, function (err, b) {
        if (err) return json(res, 400, { ok: false, error: 'need { url, repositoryId, fingerprint }' });
        checkSource(b, function (err, s, v, had) { if (err) return json(res, 200, { ok: false, error: err.message, code: err.code, reason: err.reason || null }); json(res, 200, { ok: true, source: describe(s, v, had) }); });
    });
    if (route === '/sources/add' && req.method === 'POST') return body(req, function (err, b) {
        if (err) return json(res, 400, { ok: false, error: 'need { url, repositoryId, fingerprint, token }' });
        if (!pageToken(b)) { log('sources: refused an add without the token'); return json(res, 403, { ok: false, error: 'only the TV-Store screen may add a source', code: 'NO_TOKEN' }); }
        addSource(b, function (err, d) { if (err) return json(res, 200, { ok: false, error: err.message, code: err.code, reason: err.reason || null }); json(res, 200, { ok: true, source: d, sources: SOURCES.map(publicSource), sourceOf: sourceOfPackage() }); });
    });
    if ((route === '/sources/remove' || route === '/sources/enable') && req.method === 'POST') return body(req, function (err, b) {
        var s = !err && b ? sourceById(String(b.repositoryId || '')) : null;
        if (!s) return json(res, 400, { ok: false, error: 'no source with that repositoryId on this TV' });
        if (!pageToken(b)) return json(res, 403, { ok: false, error: 'only the TV-Store screen may change the sources', code: 'NO_TOKEN' });
        if (route === '/sources/remove') {
            SOURCES.splice(SOURCES.indexOf(s), 1); delete SOURCE_STATE[s.repositoryId];
            log('sources: removed ' + (s.name || s.repositoryId) + ' (' + s.repositoryId + ') on the TV; apps installed from it stay, without updates');
        } else {
            s.enabled = b.enabled !== false;
            if (!s.enabled) delete SOURCE_STATE[s.repositoryId];
            log('sources: ' + (s.name || s.repositoryId) + ' turned ' + (s.enabled ? 'on' : 'off') + ' on the TV');
        }
        saveSources();
        json(res, 200, { ok: true, sources: SOURCES.map(publicSource) });
    });
    if (route === '/pkgids' && req.method === 'GET') return pkgIds(function (ids, removed) { json(res, 200, { ok: true, ids: ids, renames: renames(), removed: removed }); });
    if (route === '/catalog') return withCatalog(function (err, cat) { if (err) { log('catalog: failed: ' + err.message); return json(res, 502, { ok: false, error: err.message }); } cors(res, 200, 'application/json'); res.end(cat.payload); });
    if (route === '/cert' && req.method === 'POST') return body(req, function (err, b) {
        var incoming = err ? [] : certs.normalize(b);
        if (!incoming.length) {
            log('cert: refused a handover that is not { authorKeyPem, authorCertPem, distributorKeyPem, distributorCertPem } or { certificates: [...] }');
            return json(res, 400, { ok: false, error: 'need { authorKeyPem, authorCertPem, distributorKeyPem, distributorCertPem } or { certificates: [ ... ] }' });
        }
        var store = certs.merge(loadCerts(), incoming);
        log('cert: received ' + incoming.length + ' signing certificate(s) from a head (' + incoming.map(certLabel).join(', ') + '); ' + store.certificates.length + ' on this TV now'
            + (store.tvDefault ? ', the default stays ' + certLabel(certById(store, store.tvDefault)) + ' (chosen on the TV)' : ''));
        saveCerts(store);
        json(res, 200, { ok: true, certFile: CERT_FILE, certError: CERT_FILE ? null : CERT_ERROR, certCount: store.certificates.length, certificates: certs.summary(store) });
    });
    // Settings on the TV (#78): pick the default profile, or drop one. { id } is the profile's id
    // from /ping's certificates.
    if ((route === '/cert/default' || route === '/cert/remove') && req.method === 'POST') return body(req, function (err, b) {
        var store = loadCerts(), id = !err && b && typeof b.id === 'string' ? b.id : '', c = certById(store, id);
        if (!c) return json(res, 400, { ok: false, error: 'no signing certificate with that id on this TV' });
        if (route === '/cert/default') { store = certs.setDefault(store, id); log('cert: ' + certLabel(c) + ' is the default now, chosen on the TV'); }
        else { store = certs.remove(store, id); forgetCert(id); log('cert: ' + certLabel(c) + ' (' + id.slice(0, 12) + ') removed on the TV; ' + store.certificates.length + ' left'); }
        saveCerts(store);
        json(res, 200, { ok: true, certReady: haveCerts(), certCount: store.certificates.length, certificates: certs.summary(store) });
    });
    if (route === '/install' && req.method === 'POST') return body(req, function (err, b) {
        if (err || !b || !(b.url || b.upload)) return json(res, 400, { ok: false, error: 'need { url, file, appId } or { upload, token }' });
        (b.upload ? installUpload : install)(b, function (err, r) { if (err) { log('install: failed' + (err.code ? ' [' + err.code + ']' : '') + ': ' + err.message); return json(res, 200, { ok: false, error: err.message, code: err.code || null }); } json(res, 200, { ok: true, result: r }); });
    });
    cors(res, 404, 'text/plain'); res.end('not found');
}).listen(PORT, '0.0.0.0', function () {
    log('TV-Store service on port ' + PORT + ', node ' + process.version + ' ' + process.arch + ', this TV ' + ownIp() + ', data ' + DATA_DIR + (VERBOSE ? ', verbose logging on' : ''));
    // A marker from the last run: it ended inside a wascmd call (the Tizen 9 start-up crash of
    // #67 and #68, or TV-Store closed mid-install), so this TV keeps to sdbd until Settings says
    // otherwise. Nothing is started here: a probe at start-up is what took the service down.
    if (WASCMD_DIED && installerMode() === 'auto' && !INSTALLER_CFG.off) wascmdOff('the last run of this service ended while wascmd was running (started ' + WASCMD_DIED + ')');
    log('installer: ' + installerLine());
    if (SELF_UPDATE) log('self-update: the last run sent an update of TV-Store' + (SELF_UPDATE.to ? ' to v' + SELF_UPDATE.to : '') + ' at ' + SELF_UPDATE.at + ' and was stopped; the page says whether it landed');
    logPlatform();
    if (RELAY_CFG.enabled) { log('relay: enabled, starting on port ' + RELAY_CFG.port); startRelay(); }
    else if (!RELAY_CFG.chosen) setTimeout(probeLoopback, 1000);
});

module.exports.onStart = function () { log('service onStart'); };
module.exports.onRequest = function () { log('service onRequest'); };
