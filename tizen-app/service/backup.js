/* TV-Store's own state as one file (#146): what a firmware update or a factory reset takes away
 * from the TV, to put back afterwards.
 *
 * A backup is JSON:
 *   { format: 'a2s-tvstore-backup', version: 1, madeAt, tvStore, tv, duid, secrets,
 *     page:    { settings, pins, certChoice, movedSeen, variants, webVersions },
 *     service: { certificates, certByPackage, sources, sourceOf, renames, userSettings,
 *                relay, browser } }
 * page is what the TV-Store screen keeps (its localStorage): the Settings switches, the pinned apps,
 * Sign with per package, the "moved" notices already answered, and which build of an app it
 * installed. service is what the service keeps in its data folder: the signing certificates with
 * their keys (certs.js has the shape), which certificate each package took, the independent
 * repositories, where each app came from, the package id renames, the settings typed for apps
 * (they can be passwords and API keys), and the Settings that live in the service: the relay with
 * its allow list, and Install from a browser. "Try the TV's own installer" is left out: what that
 * experiment learned about a TV belongs to the firmware it ran on, so it starts off again.
 *
 * secrets: false leaves out the certificates and the apps' settings, for a file that can be kept
 * anywhere; the TV is armed from Apps2Samsung again after such a restore.
 *
 * A backup leaves the TV in two ways, both started at the TV: Apps2Samsung asks the TV-Store screen
 * for it (A2SStore.backup(), the same road the certificates came in by), or a browser downloads it
 * from http://<TV IP>:8077/backup with the code the TV shows. It comes back the same two ways, and
 * nothing of it is used until the person at the TV has seen what it holds and pressed Restore.
 *
 * parse() takes nothing on trust: every part is checked and rebuilt, what is not understood is left
 * out, and a file from a newer TV-Store is refused. Pure, ES5, Node 4: test/backup.test.js. */
'use strict';
var certs = require('./certs.js');
var repos = require('./repos.js');
var relayMod = require('./relay.js');

var FORMAT = 'a2s-tvstore-backup';
var VERSION = 1;
var MAX_BYTES = 4 * 1024 * 1024;

function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function text(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }
// A map with string keys, each value passed through `value` (undefined drops the entry).
function mapOf(o, value, maxEntries) {
    var out = {}, n = 0;
    if (!isObj(o)) return out;
    for (var k in o) {
        if (!has(o, k) || k === '__proto__' || k.length > 300) continue;
        var v = value(o[k], k);
        if (v === undefined) continue;
        out[k] = v;
        if (++n >= maxEntries) break;
    }
    return out;
}
function count(o) { return isObj(o) ? Object.keys(o).length : 0; }

// ---- making one -----------------------------------------------------------------------------------
// parts: { page, tvStore, tv, duid, certificates (the store), certByPackage, sources (as stored),
// sourceOf, renames, userSettings, relay, browser }; opts.secrets === false leaves the
// certificates and the apps' settings out.
function make(parts, opts) {
    var secrets = !(opts && opts.secrets === false), p = parts || {};
    var service = {
        certByPackage: p.certByPackage || {},
        sources: (p.sources || []).map(function (s) {
            var o = { url: s.url, repositoryId: s.repositoryId, fingerprint: s.fingerprint, name: s.name || '', enabled: s.enabled !== false };
            if (s.maintainer) o.maintainer = s.maintainer;
            if (s.publicKeyPem) o.publicKeyPem = s.publicKeyPem;
            if (s.addedAt) o.addedAt = s.addedAt;
            if (s.lastGeneratedAt) o.lastGeneratedAt = s.lastGeneratedAt;   // the rollback mark: no older manifest after a restore
            return o;
        }),
        sourceOf: p.sourceOf || {},
        renames: p.renames || [],
        relay: p.relay || null,
        browser: p.browser || null
    };
    if (secrets) {
        if (p.certificates && p.certificates.certificates && p.certificates.certificates.length) service.certificates = p.certificates;
        service.userSettings = p.userSettings || {};
    }
    return { format: FORMAT, version: VERSION, madeAt: new Date().toISOString(), tvStore: text(p.tvStore, 20), tv: text(p.tv, 80), duid: text(p.duid, 40),
             secrets: secrets, page: pagePart(p.page), service: service };
}

// ---- reading one ----------------------------------------------------------------------------------
var LEVELS = { 'public': 1, partner: 1 };
function pagePart(p) {
    var out = {};
    if (!isObj(p)) return out;
    if (isObj(p.settings)) {
        out.settings = {};
        ['showAdult', 'showNeedsHead', 'verboseLog', 'selfUpdate'].forEach(function (k) { if (typeof p.settings[k] === 'boolean') out.settings[k] = p.settings[k]; });
        if (typeof p.settings.hideSelfNotice === 'string') out.settings.hideSelfNotice = p.settings.hideSelfNotice.slice(0, 20);
    }
    if (Array.isArray(p.pins)) {
        out.pins = p.pins.filter(function (e) { return isObj(e) && typeof e.key === 'string' && e.key && typeof e.file === 'string' && e.file; })
            .slice(0, 500).map(function (e) { return { key: e.key.slice(0, 300), file: e.file.slice(0, 300) }; });
    }
    if (isObj(p.certChoice)) out.certChoice = mapOf(p.certChoice, function (v) { return has(LEVELS, v) ? v : undefined; }, 2000);
    if (Array.isArray(p.movedSeen)) out.movedSeen = p.movedSeen.filter(function (u) { return typeof u === 'string' && u; }).slice(0, 500).map(function (u) { return u.slice(0, 600); });
    if (isObj(p.variants)) out.variants = mapOf(p.variants, function (v) { return typeof v === 'string' && v ? v.slice(0, 300) : undefined; }, 2000);
    if (isObj(p.webVersions)) {
        out.webVersions = mapOf(p.webVersions, function (v) {
            return isObj(v) && typeof v.key === 'string' && typeof v.file === 'string' && typeof v.web === 'string' ? { key: v.key.slice(0, 300), file: v.file.slice(0, 300), web: v.web.slice(0, 40) } : undefined;
        }, 2000);
    }
    return out;
}
function sourcesPart(list) {
    var out = [], seen = {};
    (Array.isArray(list) ? list : []).slice(0, 100).forEach(function (s) {
        var n = repos.normalizeSource(s);
        if (!n.source || seen[n.source.repositoryId]) return;
        seen[n.source.repositoryId] = true;
        var e = n.source;
        ['maintainer', 'addedAt', 'lastGeneratedAt'].forEach(function (k) { if (typeof s[k] === 'string' && s[k]) e[k] = s[k].slice(0, 200); });
        e.enabled = s.enabled !== false;
        out.push(e);
    });
    return out;
}
function relayPart(r) {
    if (!isObj(r) || typeof r.enabled !== 'boolean') return null;
    var port = typeof r.port === 'number' && r.port === Math.floor(r.port) && r.port >= 1024 && r.port <= 65535 ? r.port : null;
    return { enabled: r.enabled, port: port, allow: relayMod.normList(r.allow).slice(0, 50), chosen: r.chosen !== false };
}
function servicePart(s) {
    var out = { certificates: null, certByPackage: {}, sources: [], sourceOf: {}, renames: [], userSettings: {}, relay: null, browser: null };
    if (!isObj(s)) return out;
    out.certificates = certs.fromStored(s.certificates);
    if (out.certificates && !out.certificates.certificates.length) out.certificates = null;
    out.certByPackage = mapOf(s.certByPackage, function (v) { return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : undefined; }, 2000);
    out.sources = sourcesPart(s.sources);
    out.sourceOf = mapOf(s.sourceOf, function (v) { return typeof v === 'string' && v && v.length <= 128 ? v : undefined; }, 2000);
    out.renames = (Array.isArray(s.renames) ? s.renames : []).filter(function (r) { return isObj(r) && typeof r.originalPackageId === 'string' && typeof r.newPackageId === 'string' && r.newPackageId; }).slice(0, 500).map(function (r) {
        var e = {};
        ['originalPackageId', 'newPackageId', 'originalAppId', 'newAppId', 'key', 'source', 'file', 'at'].forEach(function (k) { e[k] = text(r[k], 300); });
        return e;
    });
    out.userSettings = mapOf(s.userSettings, function (v) {
        if (!isObj(v) || !isObj(v.values)) return undefined;
        return { values: mapOf(v.values, function (x) { return typeof x === 'string' && x.length <= 4000 ? x : undefined; }, 100), at: text(v.at, 40) || new Date().toISOString() };
    }, 1000);
    out.relay = relayPart(s.relay);
    out.browser = isObj(s.browser) && typeof s.browser.enabled === 'boolean' ? { enabled: s.browser.enabled } : null;
    return out;
}

// A backup as it arrived (text, or the object it parses to): { backup } checked and rebuilt, or
// { error } with words for the person who sent it.
function parse(input) {
    var o = input;
    if (typeof input === 'string') {
        if (input.length > MAX_BYTES) return { error: 'that file is too big to be a TV-Store backup' };
        try { o = JSON.parse(input); } catch (e) { return { error: 'that file is not a TV-Store backup (it is not JSON)' }; }
    }
    if (!isObj(o) || o.format !== FORMAT) return { error: 'that file is not a TV-Store backup' };
    if (typeof o.version !== 'number' || o.version < 1) return { error: 'that backup has no version TV-Store knows' };
    if (o.version > VERSION) return { error: 'that backup was made by a newer TV-Store (format ' + o.version + '); update TV-Store on this TV first' };
    var b = { format: FORMAT, version: VERSION, madeAt: text(o.madeAt, 40), tvStore: text(o.tvStore, 20), tv: text(o.tv, 80), duid: text(o.duid, 40),
              secrets: o.secrets !== false, page: pagePart(o.page), service: servicePart(o.service) };
    if (isNaN(new Date(b.madeAt).getTime())) b.madeAt = '';
    return { backup: b };
}

// What the TV shows before a restore, and the browser after an upload: counts and names, never a key
// or a value.
function summary(b) {
    var p = b.page || {}, s = b.service || {};
    var settings = count(p.settings) + (s.relay ? 1 : 0) + (s.browser ? 1 : 0);
    return { madeAt: b.madeAt || '', tvStore: b.tvStore || '', tv: b.tv || '', duid: b.duid || '', secrets: b.secrets !== false,
             pins: (p.pins || []).length, settings: settings,
             certificates: certs.summary(s.certificates).map(function (c) { return { name: c.name, level: c.level, deviceIds: c.deviceIds }; }),
             sources: (s.sources || []).map(function (x) { return { name: x.name || x.repositoryId, repositoryId: x.repositoryId, domain: repos.hostOf(x.url), fingerprint: x.fingerprint }; }),
             userSettings: count(s.userSettings) };
}

// The package-keyed records of a backup, for the packages this TV has now: after a reset the apps
// are gone, and a record about an app that is not there would say the wrong thing about whatever
// comes under that id next. `installed` is the list of package ids the platform names.
function forInstalled(b, installed) {
    var on = {};
    (Array.isArray(installed) ? installed : []).forEach(function (p) { if (typeof p === 'string') on[p] = true; });
    function keep(m) { var out = {}; for (var k in m) if (has(m, k) && has(on, k)) out[k] = m[k]; return out; }
    return { sourceOf: keep(b.service.sourceOf || {}), renames: (b.service.renames || []).filter(function (r) { return has(on, r.newPackageId); }),
             variants: keep(b.page.variants || {}), webVersions: keep(b.page.webVersions || {}) };
}

// The certificates after a restore. A TV without any takes the backup's store as it was, default
// included. An armed TV keeps its own profiles and its default, and gets the backup's other
// profiles behind them.
function mergeCertificates(stored, fromBackup) {
    if (!fromBackup || !fromBackup.certificates || !fromBackup.certificates.length) return stored || null;
    if (!stored || !stored.certificates || !stored.certificates.length) return fromBackup;
    var extra = fromBackup.certificates.filter(function (c) { return !stored.certificates.some(function (d) { return d.id === c.id; }); });
    return { primary: stored.primary, tvDefault: stored.tvDefault || null, certificates: stored.certificates.concat(extra) };
}

// ---- the page a phone or PC gets at http://<TV IP>:8077/backup -----------------------------------------
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function client() {
    function $(id) { return document.getElementById(id); }
    function say(el, cls, t) { el.className = 'msg ' + cls; el.textContent = t; }
    function post(path, body, cb) {
        var x = new XMLHttpRequest(); x.open('POST', path, true); x.setRequestHeader('Content-Type', 'application/json');
        x.onload = function () { var r = null; try { r = JSON.parse(x.responseText); } catch (e) {} cb(x.status, r, x.responseText); };
        x.onerror = function () { cb(0, null, ''); };
        x.send(body);
    }
    var code = $('code'), get = $('get'), gm = $('gm'), file = $('file'), put = $('put'), pm = $('pm'), lean = $('lean');
    var m = /[#&?]code=(\d{6})/.exec(location.href);
    if (m) code.value = m[1];
    function ready() { get.disabled = !/^\d{6}$/.test(code.value.replace(/\s+/g, '')); }
    code.oninput = ready; ready();
    get.onclick = function () {
        get.disabled = true; say(gm, '', 'Asking the TV…');
        post('/backup/download', JSON.stringify({ code: code.value.replace(/\s+/g, ''), secrets: !lean.checked }), function (status, r, raw) {
            if (status !== 200 || !r || r.format === undefined) { say(gm, 'bad', status ? (r && r.error) || ('The TV answered HTTP ' + status) : 'Could not reach the TV.'); ready(); return; }
            var name = 'tv-store-backup-' + String(r.madeAt || '').slice(0, 10) + '.json';
            try {
                var blob = new Blob([raw], { type: 'application/json' });
                if (navigator.msSaveBlob) navigator.msSaveBlob(blob, name);
                else { var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a); }
                say(gm, 'ok', 'Saved as ' + name + '. Keep it somewhere safe' + (r.secrets === false ? '.' : ': it holds your signing certificates and the settings you typed for apps.'));
            } catch (e) { say(gm, 'bad', 'This browser cannot save the file: ' + e.message); }
            code.value = ''; ready();
        });
    };
    file.onchange = function () { put.disabled = !file.files.length; say(pm, '', ''); };
    put.onclick = function () {
        var f = file.files[0]; if (!f) return;
        put.disabled = true; say(pm, '', 'Sending ' + f.name + '…');
        var rd = new FileReader();
        rd.onerror = function () { say(pm, 'bad', 'This browser could not read the file.'); put.disabled = false; };
        rd.onload = function () {
            post('/backup/restore', String(rd.result), function (status, r) {
                if (status === 200 && r && r.ok) say(pm, 'ok', 'Sent. Now look at the TV: TV-Store shows what the backup holds and asks whether to restore it.');
                else { say(pm, 'bad', status ? 'The TV did not take it: ' + ((r && r.error) || 'HTTP ' + status) : 'Could not reach the TV.'); put.disabled = false; }
            });
        };
        rd.readAsText(f);
    };
}
function page(ip) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TV-Store: back up or restore</title>'
        + '<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0D1B2A;color:#F4F7FB;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:16px;line-height:1.5;padding:24px 16px}'
        + '.card{max-width:520px;margin:0 auto 16px;background:#142638;border-radius:20px;padding:22px}h1{font-size:22px;margin:0 0 6px}h2{font-size:19px;margin:0 0 6px}p{color:#9FB0C6;margin:8px 0}'
        + '.btn{display:block;width:100%;padding:16px;border:0;border-radius:14px;background:#2DD4BF;color:#042F2E;font:inherit;font-weight:700;font-size:18px;margin-top:16px}.btn[disabled]{background:rgba(244,247,251,.14);color:#9FB0C6}'
        + 'input[type=file]{width:100%;margin-top:12px;color:#9FB0C6}input[type=text]{width:100%;margin-top:12px;padding:14px;border-radius:14px;border:2px solid transparent;background:rgba(244,247,251,.08);color:#F4F7FB;font:inherit;font-size:26px;letter-spacing:.3em;text-align:center}input[type=text]:focus{outline:none;border-color:#2DD4BF}'
        + 'label{display:block;margin-top:14px;color:#9FB0C6}.msg{margin-top:14px}.ok{color:#30C46E}.bad{color:#FF6B5E}.mono{font-family:Menlo,Consolas,monospace;font-size:14px}</style></head>'
        + '<body><div class="card"><h1>Back up TV-Store</h1><p>Your pinned apps, Settings, sources, signing certificates and the settings you typed for apps on <span class="mono">' + esc(ip || 'this TV') + '</span>, as one file. '
        + 'On the TV, open TV-Store’s Settings and press <b>Back up or restore</b>: it shows a code.</p>'
        + '<input type="text" id="code" inputmode="numeric" autocomplete="off" maxlength="7" placeholder="000000" aria-label="The code on the TV">'
        + '<label><input type="checkbox" id="lean"> Leave out the signing certificates and the apps’ settings (the TV is armed from Apps2Samsung again after a restore)</label>'
        + '<button class="btn" id="get" disabled>Download the backup</button><div class="msg" id="gm"></div></div>'
        + '<div class="card"><h2>Restore a backup</h2><p>Pick a backup file. Nothing changes until you press <b>Restore</b> on the TV screen, which shows what the file holds.</p>'
        + '<input type="file" id="file" accept=".json,application/json"><button class="btn" id="put" disabled>Send to the TV</button><div class="msg" id="pm"></div></div>'
        + '<script>(' + client.toString() + ')();</script></body></html>';
}

module.exports = { FORMAT: FORMAT, VERSION: VERSION, MAX_BYTES: MAX_BYTES, make: make, parse: parse, summary: summary, forInstalled: forInstalled, mergeCertificates: mergeCertificates, page: page };
