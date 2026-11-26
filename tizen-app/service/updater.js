/* Updates while TV-Store is closed (#157): what the service may install by itself when no screen
 * is there to decide. Pure, so test/updater.test.js covers every reading. ES5 for the TV's Node 4.4.3.
 *
 * Which build of which app is on the TV is a question only the screen can answer: it knows the
 * file TV-Store installed per package, the pinned builds, the certificate chosen per app, and it
 * asks the platform. So the screen hands over a list, the plan: one line per app it would update
 * by itself, with the build that is on the TV. The service never picks a build. It looks the same
 * build up in the catalog as it is now (same app, same file name), and installs it when its
 * version is newer than both the one the screen saw and the one the TV lists. Anything else (the
 * app left the TV or the catalog, the build now needs a phone or PC, the TV has a newer copy from
 * somewhere else) is no update.
 */
'use strict';

var TRIES = 3;               // times one version is tried by itself in all, as on the screen (#154)
var MAX_ITEMS = 400;
var HEAD_ONLY = /tvapp|immitv|camerapip|camera-pip/i;   // the heads' injectors, as in the page

// True when version a is newer than b, comparing the numbers in them; a downgrade or a version
// that cannot be read is no update. The same rule as the page's.
function newer(a, b) {
    if (!a || !b || a === b) return false;
    var x = String(a).match(/\d+/g) || [], y = String(b).match(/\d+/g) || [];
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
        var p = parseInt(x[i] || '0', 10), q = parseInt(y[i] || '0', 10);
        if (p !== q) return p > q;
    }
    return false;
}
function webOf(w) { return typeof w === 'string' && /^\d+(?:\.\d+){0,3}$/.test(w) ? w : ''; }
function str(v, max) { return typeof v === 'string' ? v.slice(0, max || 200) : ''; }
function hasRoot(flags) { return Array.isArray(flags) && flags.indexOf('root') >= 0; }

// Every build a catalog lists, keyed the way the page keys its apps: [{ key, file, url, version,
// web, packageId, appId, head }]. srcId: the repository the catalog is from (#82), none for the
// official one. head: the build needs a phone or PC (it gains root, asks for settings TV-Store
// cannot type, is configured while it installs, or has no hash), so it is never installed here.
function builds(cat, srcId) {
    var out = [];
    ((cat && cat.providers) || []).forEach(function (p) {
        if (!p || p.ok === false) return;
        var rel = (p.releases || [])[0];
        if (!rel) return;
        var assets = (rel.assets || []).filter(function (a) { return a && /\.(wgt|tpk)$/i.test(a.name || ''); });
        var byFile = {};
        assets.forEach(function (a) { byFile[a.name] = a; });
        function push(key, a, e, head, settings) {
            out.push({ key: (srcId ? 'r:' + srcId + ':' : '') + key, file: a.name, url: a.browser_download_url || '',
                       version: (e && e.version) || a.package_version || '', web: webOf(a.web_version),
                       packageId: (e && e.package_id) || a.package_id || '', appId: (e && e.app_id) || a.app_id || '',
                       head: !!head || !a.digest, settings: !!settings });
        }
        if (p.catalog && p.catalog.apps) {
            p.catalog.apps.forEach(function (e) {
                var a = e && byFile[e.file];
                if (!a) return;
                var typed = !!e.user_settings;
                push('c:' + (e.group || e.name), a, e, hasRoot(e.flags) || (typed && !!srcId) || (!typed && HEAD_ONLY.test(e.file)), typed && !srcId);
            });
            return;
        }
        var root = !!srcId && hasRoot(p.flags);
        assets.forEach(function (a) { push('p:' + p.id, a, null, root, false); });
    });
    return out;
}

// The plan as the screen sent it, cleaned up: { settings: { apps, self, closed }, tizen, tvApps,
// items: [{ key, name, file, source, packageId, appId, have, web, certLevel, self }] }.
// packageId and appId are the ones the app has on this TV (a rename gave it its own, #84).
function plan(b) {
    var s = (b && b.settings) || {}, out = { settings: { apps: s.apps === true, self: s.self === true, closed: s.closed === true }, tizen: str(b && b.tizen, 20), tvApps: null, items: [] };
    if (b && b.tvApps && typeof b.tvApps === 'object' && !Array.isArray(b.tvApps)) out.tvApps = b.tvApps;
    var seen = {};
    ((b && Array.isArray(b.items)) ? b.items : []).slice(0, MAX_ITEMS).forEach(function (i) {
        if (!i || typeof i !== 'object') return;
        var key = str(i.key, 300), file = str(i.file, 300), pkg = str(i.packageId, 100);
        if (!key || !file || !pkg || seen.hasOwnProperty(key)) return;
        seen[key] = true;
        out.items.push({ key: key, name: str(i.name, 200) || key, file: file, source: str(i.source, 200) || 'official', packageId: pkg, appId: str(i.appId, 200),
                         have: str(i.have, 60), web: i.web === true, certLevel: i.certLevel === 'partner' || i.certLevel === 'public' ? i.certLevel : '', self: i.self === true });
    });
    return out;
}

// Whether the app `id` on the TV is (part of) the package `pkg`, as in tvapps.js.
function belongs(id, pkg) { return !!pkg && (id === pkg || (pkg.indexOf('.') < 0 && String(id).indexOf(pkg + '.') === 0)); }
function onTv(tvApps, pkg) { for (var i = 0; i < tvApps.length; i++) if (belongs(tvApps[i].id, pkg)) return tvApps[i]; return null; }

// What a round installs, in order (TV-Store's own first): [{ item, build, version }], and why the
// rest waits: skipped [{ item, why }].
//   p         the plan
//   all       builds() of every catalog that loaded, the official one and the repositories'
//   tvApps    the TV's own listing (tvapps.parse)
//   tried     { key: { v, n } }: versions tried by itself before, over every start
//   now       { key: version }: tried since this service started
//   running   application ids that run now, or null when the TV does not say
//   hasSettings(file): whether the TV holds the settings a build asks for
function due(p, all, tvApps, tried, now, running, hasSettings) {
    var list = [], skipped = [];
    function skip(item, why) { skipped.push({ item: item, why: why }); }
    p.items.forEach(function (item) {
        if (item.self ? !p.settings.self : !p.settings.apps) return;
        var b = null;
        for (var i = 0; i < all.length; i++) if (all[i].key === item.key && all[i].file === item.file) { b = all[i]; break; }
        if (!b) return skip(item, 'its build is not in the catalog any more');
        var latest = item.web ? b.web : b.version;
        if (item.web && !b.web) return skip(item, 'the catalog no longer says which version is inside');
        var tv = onTv(tvApps, item.packageId);
        if (!tv) return skip(item, 'it is not on the TV any more');
        // Newer than what the screen saw, and, for a build that is compared on the package's own
        // version, newer than what the TV lists now: a copy updated from a phone or PC stays.
        if (!newer(latest, item.have)) return;
        if (!item.web && tv.version && !newer(latest, tv.version)) return;
        if (b.head) return skip(item, 'this version needs Apps2Samsung on a phone or PC');
        if (b.settings && !(hasSettings && hasSettings(b.file))) return skip(item, 'it has settings that were typed on the phone or PC that installed it');
        if (!b.url) return skip(item, 'the catalog has no download for it');
        var t = tried && tried.hasOwnProperty(item.key) ? tried[item.key] : null;
        if (t && t.v === latest && t.n >= TRIES) return skip(item, 'v' + latest + ' was tried ' + TRIES + ' times and did not land');
        if (now && now.hasOwnProperty(item.key) && now[item.key] === latest) return skip(item, 'v' + latest + ' was tried already since the service started');
        if (running && running.some(function (id) { return belongs(id, item.packageId); })) return skip(item, 'it is running');
        list.push({ item: item, build: b, version: latest });
    });
    list.sort(function (a, b) { return (b.item.self ? 1 : 0) - (a.item.self ? 1 : 0); });
    return { list: list, skipped: skipped };
}

// One more try of `version` for the app `key` written down; times: how many it counts for.
function mark(tried, key, version, times) {
    var t = tried.hasOwnProperty(key) && tried[key] && tried[key].v === version ? tried[key].n : 0;
    tried[key] = { v: version, n: Math.min(TRIES, t + (times || 1)) };
    return tried;
}

module.exports = { TRIES: TRIES, newer: newer, builds: builds, plan: plan, due: due, mark: mark, belongs: belongs };
