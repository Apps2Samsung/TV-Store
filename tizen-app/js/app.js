/* TV-Store UI: the Apps2Samsung catalog on the TV, driven with the remote, installing through the
 * service (download, check the hash, sign, push, vd_appinstall). Option C, "Cinema", from the
 * design canvas (docs/design/C1..C6). ES5 on purpose: Tizen 3.0 ships Chromium 47.
 *
 * Screens: the store (C1), the app sheet (C2), installing (C3), done (C4), first run until a head
 * arms the TV (C5), On the TV (C6), and Settings in the same sheet.
 *
 * The list is built from the signed catalog the way the heads build theirs: the community bundle's
 * embedded catalog gives every package a name, description, category, group and variant, a
 * version and ids; the other providers (Jellyfin builds and such) are one app each with the
 * release's files as variants. Two kinds of app are filtered by Settings, remembered on the TV:
 *   - adult packages: left out until "Show adult (18+) apps" is on, which asks "I am 18 or older"
 *     first, as the phone does (#850); they carry an 18+ badge then;
 *   - packages the TV cannot install by itself, shown dimmed with "Phone or PC": packages that ask
 *     for settings before they install (`user_settings`), packages a head rewrites with its own
 *     injectors (TVapp channels, ImmiTV and Camera PiP server settings; known by file name, as in
 *     the heads' Packaging/ folder), root packages (`flags: ["root"]`, which afterwards need Host
 *     PC IP set to 127.0.0.1) and files without a hash in the catalog (the TV cannot check those).
 *
 * Navigation is spatial: every focusable element carries the class `f`, and an arrow key moves to
 * the nearest one in that direction (inside the sheet while it is open). Scrolling follows the
 * focus: a row of cards sideways, the page and the variant list vertically.
 */
(function () {
    'use strict';
    // Apps2Samsung writes this TV's own IP in here when it installs TV-Store: Tizen 10 may not route
    // a page's request to the service over loopback. When that address stops answering (the router
    // gave the TV another one, or TV-Store was updated without Apps2Samsung), startService tries the
    // TV's current IP and loopback too, and keeps whichever answers.
    var BASE = 'http://127.0.0.1:8077';
    var KOFI = 'https://ko-fi.com/patrickst';
    var VERSION = '0.3.8';
    var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, RETURN: 10009, ESC: 27, BACK: 8 };

    // What the manifest providers are called; resolved.json carries only their ids.
    var PROVIDERS = {
        'jellyfin-tizen-builds': { name: 'Jellyfin', category: 'media', description: 'Jellyfin for Samsung TV, built from jellyfin-web. Pick the build for your server version; plain builds suit most sets, OblongIcon the newer launchers.' },
        'moonfin': { name: 'Moonfin', category: 'media', description: 'Jellyfin client with a different take on the UI.' },
        'litefin': { name: 'Litefin', category: 'media', description: 'A lighter Jellyfin client for Samsung TVs.' },
        'tizentube': { name: 'TizenTube', category: 'streaming', description: 'YouTube for Samsung TV with ad blocking and SponsorBlock, built on Cobalt.' },
        'jellyfin-avplay': { name: 'Jellyfin AVPlay', category: 'media', description: 'Jellyfin client using the TV’s AVPlay for hardware decoding.' },
        'jellyfin-avplay-smarthub': { name: 'Jellyfin AVPlay (Smart Hub)', category: 'media', description: 'Jellyfin AVPlay build with Smart Hub preview rows.' },
        'jellyfin-legacy': { name: 'Jellyfin (legacy builds)', category: 'media', description: 'Older Jellyfin builds for servers on 10.8 to 10.10 and for older sets.' }
    };
    var CATEGORY_ORDER = ['media', 'iptv', 'streaming', 'games', 'casting', 'tools', 'other'];
    var CATEGORY_NAMES = { media: 'Media servers & players', iptv: 'IPTV & Live TV', streaming: 'Streaming', games: 'Games & emulators', casting: 'Casting & cameras', tools: 'Tools & system', other: 'Other' };
    var HEAD_ONLY = /tvapp|immitv|camerapip|camera-pip/i;   // the heads' injectors, keyed by file name
    var NO_HASH = 'has no published hash, so the TV cannot check the download';

    var $ = function (id) { return document.getElementById(id); };
    var appEl = $('app'), pageEl = $('page'), sheetEl = $('sheet'), searchEl = $('search');

    // ---- state ------------------------------------------------------------------------------------
    var catalogApps = [];      // every app in the catalog, before the Settings filters
    var apps = [];             // what the Settings let through
    var installed = {};        // packageId -> version, from the platform
    var appIds = {};           // application ids the platform lists, exact case
    // Which file TV-Store installed per package id. Variants of one app often share the package id
    // and the version (all six Litefin builds are LitefinApp 2.0.30, #17), so the TV alone cannot
    // say which one it has.
    var VARIANTS_KEY = 'a2s.tvstore.variants';
    var installedFile = (function () { try { return JSON.parse(window.localStorage.getItem(VARIANTS_KEY)) || {}; } catch (e) { return {}; } })();
    function rememberVariant(v) {
        if (!v.packageId) return;
        installedFile[v.packageId] = v.file;
        try { window.localStorage.setItem(VARIANTS_KEY, JSON.stringify(installedFile)); } catch (e) {}
    }
    var ready = null;          // the service's /ping
    var problem = null;        // { title, text } when the service or the catalog failed
    var loading = true;
    var view = 'install';      // 'install' | 'tv'
    var chip = 'all';          // 'all' or a category id
    var query = '';
    var hover = null;          // the app under the focus on the store page (the Selected card)
    var tvSel = null;          // the app selected on the On the TV page
    var sheet = null;          // { mode: 'app'|'job'|'settings', app, v, all }
    var job = null;            // the running or last install
    var queue = [];            // apps still to update after the current job ("Update all")
    var returnFocus = null;    // data-k to focus again when the sheet closes
    var confirmingAdult = false;
    var device = '';
    var tvIp = '';             // this TV's IP now, from systeminfo
    var tried = [];            // what startService got from each address, for the error screen

    // ---- settings, remembered on the TV -------------------------------------------------------------
    var SETTINGS_KEY = 'a2s.store.settings';
    var settings = (function () {
        var s = { showAdult: false, showNeedsHead: true };
        try {
            var saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || '{}');
            if (typeof saved.showAdult === 'boolean') s.showAdult = saved.showAdult;
            if (typeof saved.showNeedsHead === 'boolean') s.showNeedsHead = saved.showNeedsHead;
        } catch (e) {}
        return s;
    })();
    function saveSettings() { try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }

    // A QR code as an <img> (qrcode.js, GIF data URL: old TV engines show that fine), on a white tile.
    function qr(text, px) {
        try {
            var q = qrcode(0, 'M'); q.addData(text); q.make();
            var n = q.getModuleCount(), cell = Math.max(2, Math.floor(px / (n + 8)));
            return '<span class="qr"><img alt="" src="' + q.createDataURL(cell, cell * 4) + '" style="width:' + px + 'px;height:' + px + 'px"></span>';
        } catch (e) { return ''; }
    }
    function logUrl() { return ready && ready.logUrl ? ready.logUrl : (tvIp ? 'http://' + tvIp + ':8077/log.txt' : ''); }
    // The log, for a bug report: scan it with a phone, or type the address on a PC in the same network.
    function logBlock() {
        var u = logUrl();
        if (!u) return '';
        return '<div class="qrrow">' + qr(u, 150) + '<div><b>The TV-Store log</b><span>Scan with your phone, or open <span class="mono">' + esc(u) + '</span> on a computer in the same network. Attach it to a bug report.</span></div></div>';
    }

    // ---- the service ------------------------------------------------------------------------------
    function xhr(method, path, bodyObj, cb, base, timeout) {
        var r = new XMLHttpRequest(); r.open(method, (base || BASE) + path, true); r.timeout = timeout || 180000;
        r.onreadystatechange = function () {
            if (r.readyState !== 4) return;
            var body = null; try { body = JSON.parse(r.responseText); } catch (e) {}
            if (r.status === 200 || r.status === 400) return body ? cb(null, body) : cb(new Error('the service sent no JSON'));
            if (r.status === 0) return cb(new Error('service unreachable'));
            cb(new Error(body && body.error ? body.error : 'HTTP ' + r.status));
        };
        r.ontimeout = function () { cb(new Error('the service did not answer in time')); };
        if (bodyObj) { r.setRequestHeader('Content-Type', 'application/json'); r.send(JSON.stringify(bodyObj)); } else r.send();
    }

    // Launches the service and waits for its /ping. When it never answers, the error says why: the
    // platform refused the launch (with its reason), or the launch went through but nothing listens.
    // The first start after an install is slow: the platform answered nothing within 7.5 s on a
    // 2019 set (#881) and the service was up later. So wait 30 s, and launch again after 10 s in
    // case the first request was dropped.
    function startService(cb) {
        var launch = 'pending';
        // Through an app control first, as TizenBrew starts its service (which comes up on Tizen 10),
        // and plain launch when the platform refuses that.
        function go() {
            var id;
            try { id = tizen.application.getCurrentApplication().appInfo.id.split('.')[0] + '.sdbservice'; }
            catch (e) { launch = 'launch failed (' + (e.name ? e.name + ': ' + e.message : e) + ')'; return; }
            function plain(why) {
                try {
                    tizen.application.launch(id,
                        function () { launch = 'ok'; },
                        function (e) { launch = 'launch failed (' + why + '; ' + e.name + ': ' + e.message + ')'; });
                } catch (e) { launch = 'launch failed (' + why + '; ' + (e.name ? e.name + ': ' + e.message : e) + ')'; }
            }
            try {
                tizen.application.launchAppControl(new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/service'), id,
                    function () { launch = 'ok'; },
                    function (e) { plain('app control: ' + e.name); });
            } catch (e) { plain('app control: ' + (e.name || e)); }
        }
        go();
        var tries = 0, found = false;
        function candidates() {
            var c = [BASE];
            if (tvIp) c.push('http://' + tvIp + ':8077');
            c.push('http://127.0.0.1:8077');
            return c.filter(function (x, i) { return c.indexOf(x) === i; });
        }
        (function poll() {
            var list = candidates(), left = list.length, last = {};
            list.forEach(function (base) {
                xhr('GET', '/ping', null, function (err, res) {
                    if (found) return;
                    if (!err) { found = true; BASE = base; return cb(null, res); }
                    last[base] = err.message;
                    if (--left) return;
                    tried = list.map(function (x) { return x.replace(/^http:\/\//, '') + ': ' + last[x]; });
                    if (tries === 33 && launch !== 'ok') go();
                    if (++tries > 100) {
                        if (launch === 'ok') return cb(new Error('Launched, but nothing answers on port 8077.'));
                        if (launch === 'pending') return cb(new Error('The TV never answered the request to start it.'));
                        return cb(new Error(launch));
                    }
                    setTimeout(poll, 300);
                }, base, 2500);
            });
        })();
    }

    // What the platform says is installed: packageId -> version. Empty off a TV.
    function readInstalled(cb) {
        try {
            tizen.application.getAppsInfo(function (infos) {
                var map = {};
                appIds = {};
                for (var i = 0; i < infos.length; i++) { if (infos[i].packageId) map[infos[i].packageId] = infos[i].version || ''; if (infos[i].id) appIds[infos[i].id] = true; }
                cb(map);
            }, function () { cb({}); });
        } catch (e) { cb({}); }
    }

    function readDevice() {
        ['ETHERNET_NETWORK', 'WIFI_NETWORK'].forEach(function (t) {
            try { tizen.systeminfo.getPropertyValue(t, function (n) { if (n && n.ipAddress && !tvIp) tvIp = n.ipAddress; }, function () {}); } catch (e) {}
        });
        try {
            tizen.systeminfo.getPropertyValue('BUILD', function (b) {
                device = b && b.model ? b.model : '';
                renderFoot();
            }, function () {});
        } catch (e) {}
    }

    // ---- the catalog ------------------------------------------------------------------------------
    function variant(label, file, url, version, appId, packageId) {
        return { label: label || file.replace(/\.(wgt|tpk)$/i, ''), file: file, url: url, version: version || '', appId: appId || '', packageId: packageId || '' };
    }

    function ownerOf(repoOrUrl) {
        var m = /(?:repos\/)?([^\/]+)\/[^\/]+(?:\/releases)?$/.exec(String(repoOrUrl || '').replace(/^https?:\/\/[^\/]+\//, ''));
        return m ? m[1] : '';
    }

    function build(cat) {
        var out = [], byKey = {};
        function app(key, name, category, description, author) {
            if (!byKey[key]) {
                byKey[key] = { key: key, name: name, category: CATEGORY_NAMES[category] ? category : 'other', description: description || '', author: author || '',
                               variants: [], needsHead: null, adult: false, root: false };
                out.push(byKey[key]);
            }
            return byKey[key];
        }
        (cat.providers || []).forEach(function (p) {
            if (p.ok === false) return;
            var rel = (p.releases || [])[0]; if (!rel) return;
            var assets = (rel.assets || []).filter(function (a) { return /\.(wgt|tpk)$/i.test(a.name); });
            var byFile = {}; assets.forEach(function (a) { byFile[a.name] = a; });

            if (p.catalog && p.catalog.apps) {
                // The community bundle: the catalog is the truth, the release gives the download.
                p.catalog.apps.forEach(function (e) {
                    var a = byFile[e.file]; if (!a) return;
                    var v = variant(e.variant, e.file, a.browser_download_url, e.version || a.package_version, e.app_id || a.app_id, e.package_id || a.package_id);
                    var x = app('c:' + (e.group || e.name), e.group || e.name, e.category, e.description, ownerOf(e.repo));
                    x.variants.push(v);
                    if (e.adult) x.adult = true;
                    var root = (e.flags || []).indexOf('root') >= 0;
                    if (root) x.root = true;
                    if (root) v.needsHead = 'gains root on the TV and needs Host PC IP changed afterwards';
                    else if (e.user_settings) v.needsHead = 'asks for settings before it installs';
                    else if (HEAD_ONLY.test(e.file)) v.needsHead = 'is configured by Apps2Samsung while it installs';
                    else if (!a.digest) v.needsHead = NO_HASH;
                });
                return;
            }

            var info = PROVIDERS[p.id] || { name: p.id, category: 'other', description: '' };
            var x = app('p:' + p.id, info.name, info.category, info.description, ownerOf(p.url));
            assets.forEach(function (a) {
                var v = variant(null, a.name, a.browser_download_url, a.package_version, a.app_id, a.package_id);
                if (!a.digest) v.needsHead = NO_HASH;
                x.variants.push(v);
            });
        });

        out = out.filter(function (x) { return x.variants.length > 0; });
        out.forEach(function (x) {
            // An app needs a head when every file of it does.
            var all = x.variants.every(function (v) { return !!v.needsHead; });
            x.needsHead = all ? x.variants[0].needsHead : null;
            x.sort = x.name.toLowerCase();
        });
        out.sort(function (a, b) {
            var ca = CATEGORY_ORDER.indexOf(a.category), cb = CATEGORY_ORDER.indexOf(b.category);
            if (ca !== cb) return ca - cb;
            return a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0;
        });
        return out;
    }

    function visible(all) {
        return all.filter(function (x) {
            if (x.adult && !settings.showAdult) return false;
            if (x.needsHead && !settings.showNeedsHead) return false;
            return true;
        });
    }

    // True when catalog version a is newer than installed version b, comparing the numbers in them
    // ("10.11.2" > "10.10.7", "2.1.1" > "2.0.9"); a downgrade or an unreadable version is no update.
    function newer(a, b) {
        if (!a || !b || a === b) return false;
        var x = String(a).match(/\d+/g) || [], y = String(b).match(/\d+/g) || [];
        for (var i = 0; i < Math.max(x.length, y.length); i++) {
            var p = parseInt(x[i] || '0', 10), q = parseInt(y[i] || '0', 10);
            if (p !== q) return p > q;
        }
        return false;
    }

    // Which catalog app an installed package belongs to. Several apps can ship the same package id
    // (every Jellyfin build is AprZAARz4r), and the TV has one of them: the app whose file carries
    // the installed version, else the first in catalog order (the provider the heads list first).
    var claims = null;
    function claimOf(pkg) {
        if (!claims) {
            claims = {};
            Object.keys(installed).forEach(function (p) {
                var first = null, exact = null;
                catalogApps.forEach(function (x) {
                    x.variants.forEach(function (v) {
                        if (v.packageId !== p) return;
                        if (!first) first = x;
                        if (!exact && v.version && v.version === installed[p]) exact = x;
                    });
                });
                if (first) claims[p] = (exact || first).key;
            });
        }
        return claims[pkg];
    }
    function setInstalled(map) { installed = map; claims = null; }

    // Installed / update state of an app: from the variants whose package id the TV lists. Several
    // can match (#17); then the installed application id narrows it down where the builds differ in
    // it, and the file TV-Store itself installed settles it. Otherwise known is false: the screens
    // say the variant is not known instead of naming the first one, and no update starts without
    // the user picking the build (it could swap theirs for another).
    function state(x) {
        var hits = [];
        for (var i = 0; i < x.variants.length; i++) {
            var v = x.variants[i];
            if (v.packageId && installed.hasOwnProperty(v.packageId) && claimOf(v.packageId) === x.key) hits.push(i);
        }
        if (!hits.length) return { installed: false };
        var byApp = hits.filter(function (i) { return x.variants[i].appId && appIds[x.variants[i].appId]; });
        if (byApp.length) hits = byApp;
        var pick = hits[0], known = hits.length === 1, file = installedFile[x.variants[pick].packageId];
        for (var j = 0; j < hits.length; j++) if (x.variants[hits[j]].file === file) { pick = hits[j]; known = true; }
        var pv = x.variants[pick], have = installed[pv.packageId];
        return { installed: true, version: have, update: newer(pv.version, have), variant: pick, known: known, latest: pv.version };
    }

    // TV-Store's own catalog entry.
    function self() {
        var pkg = '';
        try { pkg = tizen.application.getCurrentApplication().appInfo.packageId; } catch (e) {}
        for (var i = 0; i < catalogApps.length; i++)
            for (var j = 0; j < catalogApps[i].variants.length; j++) if (pkg && catalogApps[i].variants[j].packageId === pkg) return catalogApps[i];
        return null;
    }
    function updates() { return catalogApps.filter(function (x) { return state(x).update; }); }
    function onTv() { return catalogApps.filter(function (x) { return state(x).installed; }); }
    function byKey(k) { for (var i = 0; i < catalogApps.length; i++) if (catalogApps[i].key === k) return catalogApps[i]; return null; }
    function armed() { return !!(ready && ready.certReady); }

    // ---- small builders ---------------------------------------------------------------------------
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function catName(id) { return (window.__categories && window.__categories[id]) || CATEGORY_NAMES[id] || id; }
    var TILES = ['media', 'iptv', 'streaming', 'games', 'casting', 'tools', 'other'];
    function tile(x, size) {
        var m = String(x.name || '').match(/[A-Za-z0-9]/), cls = 't-other';
        if (TILES.indexOf(x.category) >= 0 && x.category !== 'other') cls = 't-' + x.category;
        else if (x.name) { var h = 0; for (var i = 0; i < x.name.length; i++) h = (Math.imul(h, 31) + x.name.charCodeAt(i)) >>> 0; cls = 't-' + TILES[h % TILES.length]; }
        return '<div class="tile s' + size + ' ' + cls + '">' + esc(m ? m[0].toUpperCase() : '?') + '</div>';
    }
    function badge(cls, text) { return '<span class="badge ' + cls + '">' + esc(text) + '</span>'; }
    function subline(x) { return x.variants.length > 1 ? x.variants.length + ' variants' : (x.variants[0].version ? 'v' + x.variants[0].version : x.variants[0].file); }
    function cardBadges(x) {
        var st = state(x), b = '';
        if (st.installed) b += st.update ? badge('b-warn', 'Update') : badge('b-ok', 'Installed');
        if (x.adult) b += badge('b-warn', '18+');
        if (x.root) b += badge('b-warn', 'root');
        if (x.needsHead) b += badge('b-mute', 'Phone or PC');
        return b;
    }
    var CHECK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#0D1B2A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>';
    var CROSS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#0D1B2A" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    var CHEV = '<svg viewBox="0 0 8 14" width="10" height="18" fill="none" stroke="#9FB0C6" stroke-width="1.6" style="margin-left:14px;flex:none"><path d="M1 1l6 6-6 6"/></svg>';

    // ---- header and footer --------------------------------------------------------------------------
    function renderHeader() {
        $('tabInstall').className = 'pillbtn f' + (view === 'install' ? ' on' : '');
        $('tabTv').className = 'pillbtn f' + (view === 'tv' ? ' on' : '');
        var n = updates().length, c = $('updCount');
        c.style.display = n ? '' : 'none'; c.textContent = n;
        var st = $('state'), t = $('stateText');
        if (problem) { st.className = 'state bad'; t.textContent = problem.short || 'Not working'; }
        else if (loading) { st.className = 'state mute'; t.textContent = 'Starting'; }
        else if (job && job.running) { st.className = 'state ok'; t.textContent = 'Installing ' + job.app.name; }
        else if (!armed()) { st.className = 'state warn'; t.textContent = 'Waiting to be armed'; }
        else { st.className = 'state ok'; t.textContent = 'Ready'; }
    }
    function renderFoot() {
        var bits = [];
        if (device) bits.push(device);
        if (ready && ready.ownIp) bits.push(ready.ownIp);
        bits.push('TV-Store v' + VERSION);
        $('dev').textContent = bits.join(' · ');
    }

    // ---- the store page (C1, C5) ------------------------------------------------------------------
    function greeting() { var h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }

    function selCard(x) {
        if (!x) return '<div class="selcard" id="selcard"><div class="selbody"><div class="eyebrow">Selected</div><div class="selname">Pick an app</div></div></div>';
        var st = state(x), b = '';
        if (st.installed) b += st.update ? badge('b-warn', 'Update to v' + st.latest) : badge('b-ok', 'Installed' + (st.version ? ' · v' + st.version : ''));
        if (x.variants.length > 1) b += badge('b-mute', x.variants.length + ' variants');
        else if (x.variants[0].version && !st.installed) b += badge('b-mute', 'v' + x.variants[0].version);
        if (x.adult) b += badge('b-warn', '18+');
        if (x.needsHead) b += badge('b-mute', 'Phone or PC');
        return '<div class="selcard" id="selcard">' + tile(x, 110)
            + '<div class="selbody"><div class="eyebrow">Selected</div><div class="selname">' + esc(x.name) + '</div>'
            + '<div class="seldesc">' + esc(x.description || catName(x.category)) + '</div><div class="badges">' + b + '</div></div>'
            + '<div class="selok">Press OK<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#2DD4BF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg></div></div>';
    }

    function card(x, where) {
        return '<div class="card f' + (x.needsHead ? ' dim' : '') + '" tabindex="0" data-k="card:' + where + ':' + esc(x.key) + '" data-app="' + esc(x.key) + '">'
            + tile(x, 68) + '<div class="nm">' + esc(x.name) + '</div><div class="mt">' + esc(subline(x)) + '</div><div class="badges">' + cardBadges(x) + '</div></div>';
    }

    function section(id, title, list, grid, more) {
        return '<div class="sect' + (grid ? ' grid' : '') + '"><div class="shead"><span class="t">' + esc(title) + '</span><span class="n">' + list.length + '</span>'
            + (more ? '<span class="link f" tabindex="0" data-k="more:' + id + '" data-chip="' + id + '">Show all ›</span>' : '') + '</div>'
            + '<div class="strip"><div class="cards">' + list.map(function (x) { return card(x, id); }).join('') + '</div></div></div>';
    }

    function renderStore() {
        var h = '';
        if (problem) {
            h += '<div class="welcome"><div class="wmain"><h1>' + esc(problem.title) + '</h1><p>' + esc(problem.text) + '</p>'
                + (tried.length ? '<div class="hint mono" style="margin-top:18px">' + tried.map(esc).join('<br>') + '</div>' : '')
                + logBlock()
                + '<div class="btns" style="margin-top:26px"><button class="btn primary f" data-k="retry" data-act="retry">Try again</button></div></div></div>';
            pageEl.innerHTML = h; return;
        }
        if (loading) {
            pageEl.innerHTML = '<div class="welcome"><div class="wmain"><h1>' + greeting() + '</h1><p>Loading the catalog…</p><div class="waiting"><span class="spin"></span>Fetching the signed catalog and checking its signature.</div></div></div>';
            return;
        }
        if (!armed()) {
            var ip = ready && ready.ownIp ? ready.ownIp : 'this TV’s address';
            h += '<div class="welcome"><div class="wmain"><h1>Welcome. One thing to do first.</h1>'
                + '<p>TV-Store signs every app it installs with your own certificate, the same one Apps2Samsung uses. Hand it over once from your phone or PC and this TV installs on its own from then on.</p>'
                + '<div class="steps"><div class="step"><div class="num">1</div><div><b>Open Apps2Samsung</b><span>Version 3.0 or newer, on your phone or PC: the one you installed TV-Store with.</span></div></div>'
                + '<div class="step"><div class="num">2</div><div><b>Pick this TV, open the Toolbox</b><span>' + esc(device ? device + ' at ' + ip : ip) + '.</span></div></div>'
                + '<div class="step"><div class="num">3</div><div><b>Press Arm TV-Store</b><span>This screen turns green by itself. Nothing to type here.</span></div></div></div>'
                + '<div class="waiting"><span class="spin"></span>Waiting for your phone or PC… you can browse the catalog meanwhile.</div></div>'
                + '<div class="wside"><div class="eyebrow">Developer Mode</div><h2>Host PC IP: this TV</h2>'
                + '<p>Once armed, set Host PC IP to the TV’s own address, ' + esc(ip) + ', in Apps › Developer Mode. TV-Store talks to the TV through that door. Arm first: your phone or PC needs it pointing at them until then.</p></div></div>';
            h += section('all', 'Meanwhile, have a look around', apps, false, false);
            pageEl.innerHTML = h; return;
        }

        // TV-Store is in its own catalog: say so when a newer one is there (like Moonfin's update
        // popup, but from the signed catalog instead of the GitHub API, and installable from here).
        var me = self(), ms = me ? state(me) : null;
        if (ms && ms.update) h += '<div class="notice" style="display:flex;align-items:center;margin:0 0 26px"><span style="flex:1">TV-Store v' + esc(ms.latest)
            + ' is out (this is v' + esc(ms.version) + '). TV-Store closes while it updates itself; open it again after a minute.</span>'
            + '<button class="btn primary f" style="margin-left:20px" data-k="selfupd" data-act="selfupd">Update TV-Store</button></div>';

        if (!hover || apps.indexOf(hover) < 0) hover = apps[0] || null;
        if (!query) {
            h += '<div class="hero"><div class="greet"><h1>' + greeting() + '</h1><p>Everything here installs straight onto this TV. Pick an app, press OK, and it shows up in your Apps row in about a minute.</p></div>' + selCard(hover) + '</div>';
            var cats = CATEGORY_ORDER.filter(function (c) { return apps.some(function (x) { return x.category === c; }); });
            h += '<div class="chips"><span class="chip f' + (chip === 'all' ? ' on' : '') + '" tabindex="0" data-k="chip:all" data-chip="all">All</span>'
                + cats.map(function (c) { return '<span class="chip f' + (chip === c ? ' on' : '') + '" tabindex="0" data-k="chip:' + c + '" data-chip="' + c + '">' + esc(catName(c)) + '</span>'; }).join('') + '</div>';
            if (chip === 'all') {
                cats.forEach(function (c) {
                    var list = apps.filter(function (x) { return x.category === c; });
                    h += section(c, catName(c), list, false, list.length > 6);
                });
            } else {
                h += section(chip, catName(chip), apps.filter(function (x) { return x.category === chip; }), true, false);
            }
        } else {
            var q = query.toLowerCase();
            var found = apps.filter(function (x) { return x.name.toLowerCase().indexOf(q) >= 0 || (x.description || '').toLowerCase().indexOf(q) >= 0; });
            h += found.length ? section('search', 'Results for “' + query + '”', found, true, false)
                : '<div class="empty">Nothing in the catalog matches “' + esc(query) + '”.</div>';
        }
        if (!apps.length) h += '<div class="empty">No apps to show. The gear at the top has the Settings.</div>';
        pageEl.innerHTML = h;
    }

    // ---- On the TV (C6) -----------------------------------------------------------------------------
    function tvRow(x) {
        var st = state(x), v = x.variants[st.variant];
        var mt = st.update ? 'v' + st.version + ' installed · v' + st.latest + ' in the catalog' : 'v' + (st.version || v.version) + (x.variants.length > 1 ? ' · ' + (st.known ? v.label : 'variant not known') : '');
        return '<div class="lrow f" tabindex="0" data-k="tv:' + esc(x.key) + '" data-app="' + esc(x.key) + '">' + tile(x, 66)
            + '<div class="txt"><div class="nm">' + esc(x.name) + '</div><div class="mt">' + esc(mt) + '</div></div>'
            + (st.update ? badge('b-warn', 'Update') : badge('b-ok', 'Up to date')) + CHEV + '</div>';
    }

    function renderTv() {
        var all = onTv(), ups = all.filter(function (x) { return state(x).update; }), ok = all.filter(function (x) { return !state(x).update; });
        if (!tvSel || all.indexOf(tvSel) < 0) tvSel = ups[0] || ok[0] || null;
        var h = '<div class="tvtop"><div><h1>Your apps</h1><p>' + (all.length
            ? all.length + (all.length === 1 ? ' catalog app is' : ' catalog apps are') + ' on this TV. ' + (ups.length ? (ups.length === 1 ? 'One has' : ups.length + ' have') + ' a newer version in the catalog.' : 'All up to date.')
            : 'No apps from the catalog on this TV yet.') + '</p></div>';
        if (ups.length && armed()) h += '<button class="btn primary f" data-k="updall" data-act="updall">' + (ups.length === 1 ? 'Update ' + esc(ups[0].name) : ups.length === 2 ? 'Update both' : 'Update all ' + ups.length) + '</button>';
        h += '</div>';
        if (!all.length) { pageEl.innerHTML = h + '<div class="empty">Install something from the store and it shows up here, with its updates.</div>'; return; }
        h += '<div class="tvcols"><div class="tvlist">';
        if (ups.length) h += '<div class="glabel warn">Updates<span class="n">' + ups.length + '</span></div><div class="group">' + ups.map(tvRow).join('') + '</div>';
        if (ok.length) h += '<div class="glabel">Up to date<span class="n">' + ok.length + '</span></div><div class="group">' + ok.map(tvRow).join('') + '</div>';
        h += '</div><div class="tvpanel"><div class="glabel">Selected</div>' + tvPanel(tvSel) + '</div></div>';
        pageEl.innerHTML = h;
    }

    function tvPanel(x) {
        if (!x) return '';
        var st = state(x), v = x.variants[st.variant];
        var h = '<div class="panel" id="tvpanel"><div class="phead">' + tile(x, 96) + '<div style="min-width:0"><div class="nm">' + esc(x.name) + '</div><div class="mt">' + esc(catName(x.category) + (v.appId ? ' · ' + v.appId : '')) + '</div></div></div>'
            + '<div class="table kv" style="margin-top:0"><div class="trow"><span class="k">Installed</span><span class="v">v' + esc(st.version) + '</span></div>'
            + '<div class="trow"><span class="k">In the catalog</span><span class="v"' + (st.update ? ' style="color:#F0A020"' : '') + '>v' + esc(st.latest || v.version) + '</span></div>'
            + (x.variants.length > 1 ? '<div class="trow"><span class="k">Variant</span><span class="v">' + esc(st.known ? v.label : 'Not known: the builds share one package') + '</span></div>' : '') + '</div>'
            + '<div class="btns" style="margin-top:18px">';
        if (st.update && st.known && !v.needsHead && armed()) h += '<button class="btn primary grow f" data-k="tvupd" data-act="tvupd">Update</button>';
        else h += '<button class="btn grow f" data-k="tvsheet" data-act="tvsheet">Details</button>';
        if (v.appId) h += '<button class="btn f" data-k="tvopen" data-act="tvopen">Open</button>';
        h += '</div>';
        if (st.update && v.needsHead) h += '<div class="hint" style="text-align:left">' + esc(x.name + ' ' + v.needsHead + ': update it with Apps2Samsung on a phone or PC.') + '</div>';
        return h + '</div>';
    }

    function renderPage() {
        renderHeader();
        if (view === 'tv') renderTv(); else renderStore();
    }

    // ---- the sheet (C2, C3, C4, Settings) --------------------------------------------------------
    function openSheet(s) {
        if (!sheet) returnFocus = document.activeElement && document.activeElement.getAttribute('data-k');
        sheet = s; renderSheet(true);
    }
    function closeSheet() {
        sheet = null; confirmingAdult = false;
        sheetEl.className = 'sheet'; sheetEl.innerHTML = ''; appEl.className = 'app';
        renderPage(); focusKey(returnFocus) || focusFirst();
    }

    function renderSheet(focusDefault) {
        if (!sheet) return;
        var keep = !focusDefault && document.activeElement && document.activeElement.getAttribute('data-k');
        appEl.className = 'app behind'; sheetEl.className = 'sheet on';
        if (sheet.mode === 'settings') sheetEl.innerHTML = settingsHtml();
        else if (sheet.mode === 'job') sheetEl.innerHTML = job && job.finished && job.ok ? doneHtml() : jobHtml();
        else sheetEl.innerHTML = appHtml();
        if (!(keep && focusKey(keep))) {
            var d = sheetEl.querySelector('[data-default]') || sheetEl.querySelector('.f:not([disabled])');
            if (d) focus(d);
        }
    }

    function appHtml() {
        var x = sheet.app, st = state(x), v = x.variants[sheet.v];
        var h = '<div class="shd">' + tile(x, 88) + '<div style="min-width:0"><div class="nm">' + esc(x.name) + '</div><div class="mt">' + esc(catName(x.category) + (x.author ? ' · by ' + x.author : '')) + '</div></div></div>';
        if (x.description) h += '<div class="sdesc">' + esc(x.description) + '</div>';
        var b = '';
        if (st.installed) b += badge('b-ok', 'Installed' + (st.version ? ' · v' + st.version : ''));
        if (st.update) b += badge('b-warn', 'Update to v' + st.latest);
        if (x.adult) b += badge('b-warn', 'Adults only (18+)');
        if (x.root) b += badge('b-warn', 'Gains root on the TV');
        if (b) h += '<div class="badges">' + b + '</div>';

        if (x.variants.length > 1) {
            var shown = x.variants.map(function (vv, i) { return i; });
            if (!sheet.all && x.variants.length > 4) shown = sheet.v < 4 ? [0, 1, 2, 3] : [0, 1, 2, sheet.v];
            h += '<div class="vhead"><span class="t">Variant</span><span class="h">Pick the build for your set</span></div><div class="vbox"><div class="vscroll" id="vscroll">'
                + shown.map(function (i) {
                    var vv = x.variants[i], inst = st.installed && st.known && st.variant === i;
                    return '<div class="var f' + (i === sheet.v ? ' sel' : '') + '" tabindex="0" data-k="var:' + i + '" data-var="' + i + '"' + (i === sheet.v ? ' data-default' : '') + '>'
                        + '<span class="radio"></span><span class="vl">' + esc(vv.label) + '</span>'
                        + (inst ? badge('b-ok', 'on the TV') : '') + (vv.needsHead ? badge('b-mute', 'Phone or PC') : '')
                        + '<span class="vv">' + esc(vv.version ? 'v' + vv.version : '') + '</span></div>';
                }).join('') + '</div></div>';
            if (!sheet.all && x.variants.length > 4) h += '<span class="link f" tabindex="0" data-k="allvars" data-act="allvars">Show all ' + x.variants.length + ' variants ›</span>';
        }

        var label = st.installed && st.known && st.variant === sheet.v ? (st.update ? 'Update to v' + v.version : 'Reinstall') : (st.installed ? 'Install this variant' : 'Install on this TV');
        if (v.needsHead) h += '<div class="notice">' + esc(x.name + ' ' + v.needsHead + ', which this TV cannot do yet. Install it with Apps2Samsung on a phone or PC.') + '</div>';
        else if (!armed()) h += '<div class="notice">Not armed yet. Open this TV’s Toolbox in Apps2Samsung 3.0 or newer on your phone or PC and press Arm TV-Store once; after that every install runs here.</div>';
        var can = !v.needsHead && armed() && !(job && job.running);
        h += '<div class="sfoot"><div class="btns"><button class="btn primary grow f" data-k="install" data-act="install"' + (can ? (x.variants.length > 1 ? '' : ' data-default') : ' disabled') + '>'
            + esc(v.needsHead ? 'Install from a phone or PC' : job && job.running ? 'Another install is running' : label) + '</button>';
        if (st.installed && x.variants[st.variant].appId) h += '<button class="btn f" data-k="open" data-act="open">Open</button>';
        if (st.installed && !st.known && x.variants.length > 1) h = h.replace('<div class="sfoot">', '<div class="notice">' + esc('Your TV has ' + x.name + ' v' + st.version + ', but every build of it uses the same package, so TV-Store cannot tell which one. Pick yours above to reinstall or update it.') + '</div><div class="sfoot">');
        h += '</div><div class="hint">' + (can ? 'Takes about a minute. RETURN goes back to the store.' : 'RETURN goes back to the store.') + '</div></div>';
        return h;
    }

    var STEPS = [['Downloaded', 'Downloading'], ['Checked and signed for this TV', 'Checking and signing'], ['Installed on the TV', 'Installing on the TV'], ['Ready to open', 'Ready to open']];
    function jobHtml() {
        var x = job.app, v = job.v, upd = job.update;
        var done = job.step, pct = Math.min(100, Math.round((done / 4) * 100 + (job.running && done < 3 ? 8 : 0)));
        var h = '<div class="shd">' + tile(x, 88) + '<div style="min-width:0"><div class="nm">' + esc(x.name) + '</div><div class="mt">' + esc(v.label + (v.version ? ' · v' + v.version : '')) + '</div></div></div>';
        h += '<div class="prog"><div class="top"><b>' + (job.error ? (upd ? 'Update failed' : 'Install failed') : (upd ? 'Updating…' : 'Installing…')) + '</b><span>' + (job.error ? '' : 'step ' + Math.min(done + 1, 4) + ' of 4') + '</span></div>'
            + '<div class="bar' + (job.error ? ' bad' : '') + '"><i style="width:' + (job.error ? 100 : pct) + '%"></i></div></div>';
        h += '<div class="table">' + STEPS.map(function (s, i) {
            var cls, ico, side = '';
            if (i < done) { ico = '<span class="ico done">' + CHECK + '</span>'; cls = ''; }
            else if (i === done && job.error) { ico = '<span class="ico fail">' + CROSS + '</span>'; cls = ''; }
            else if (i === done && job.running) { ico = '<span class="ico run"></span>'; cls = ''; }
            else { ico = '<span class="ico wait"></span>'; cls = ' pending'; }
            if (i === 0) side = job.bytes ? (job.bytes / 1048576).toFixed(1) + ' MB' : '';
            if (i === 1) side = 'with your certificate';
            if (i === 2) side = 'the TV is doing this part';
            return '<div class="trow' + cls + '">' + ico + '<span style="flex:1">' + (i < done ? s[0] : s[1]) + '</span><span class="v">' + side + '</span></div>';
        }).join('') + '</div>';
        if (job.error) h += '<div class="notice bad">' + esc(job.error) + '</div>';
        else h += '<div class="notice info">You can keep browsing with RETURN; the ' + (upd ? 'update' : 'install') + ' carries on in the background and the app shows up under On the TV when it is in.</div>';
        h += '<div class="sfoot"><div class="btns">';
        if (job.error) h += '<button class="btn primary grow f" data-k="retryjob" data-act="retryjob" data-default>Try again</button><button class="btn f" data-k="close" data-act="close">Back to the store</button>';
        else h += '<button class="btn grow f" data-k="close" data-act="close" data-default>Keep browsing</button>';
        h += '</div><div class="hint mono">' + esc(job.line || '') + '</div></div>';
        return h;
    }

    function doneHtml() {
        var x = job.app, v = job.v, secs = Math.max(1, Math.round((job.ended - job.started) / 1000));
        var more = updates();
        var h = '<div class="donehead"><div class="tw">' + tile(x, 150) + '<span class="ico done bigok">' + CHECK.replace('width="18" height="18"', 'width="30" height="30"') + '</span></div>'
            + '<h2>' + esc(x.name) + ' is on your TV</h2><p>' + esc((job.update ? 'Updated to v' : 'Installed v') + (v.version || '') + '. You will find it in the Apps row' + (job.update ? ', right where it was.' : '.')) + '</p></div>';
        h += '<div class="table kv" style="margin-top:38px"><div class="trow"><span class="k">Variant</span><span class="v">' + esc(v.label) + '</span></div>'
            + '<div class="trow"><span class="k">Took</span><span class="v">' + secs + ' seconds</span></div>'
            + '<div class="trow"><span class="k">Signed with</span><span class="v">your certificate</span></div></div>';
        // The heads end an install the same way: a thank-you and the Ko-fi link, as a QR here.
        h += '<div class="qrrow">' + qr(KOFI, 150) + '<div><b>That was easy, right?</b><span>Scan the code to buy me a beer.</span></div></div>';
        h += '<div class="sfoot"><div class="btns">' + (v.appId ? '<button class="btn primary grow f" data-k="openjob" data-act="openjob" data-default>Open ' + esc(x.name) + '</button>' : '')
            + '<button class="btn' + (v.appId ? '' : ' grow') + ' f" data-k="close" data-act="close">Back to the store</button></div>';
        if (queue.length) h += '<div class="hint">Next up: ' + esc(queue[0].name) + (queue.length > 1 ? ' and ' + (queue.length - 1) + ' more' : '') + '. It starts in a moment.</div>';
        else if (more.length) h += '<div class="hint">' + (more.length === 1 ? 'One more update is waiting: ' + esc(more[0].name) : more.length + ' more updates are waiting') + '. Find ' + (more.length === 1 ? 'it' : 'them') + ' under On the TV.</div>';
        return h + '</div>';
    }

    function settingsHtml() {
        function opt(key, title, hint) {
            return '<div class="opt f" tabindex="0" data-k="opt:' + key + '" data-opt="' + key + '"><div class="ot"><div class="ont">' + esc(title) + '</div><div class="oh">' + esc(hint) + '</div></div>'
                + '<span class="sw' + (settings[key] ? ' on' : '') + '"><i></i></span></div>';
        }
        var hidden = catalogApps.length - apps.length;
        var h = '<div class="shd"><div><div class="nm">Settings</div><div class="mt">Remembered on this TV' + (hidden > 0 ? ' · ' + hidden + (hidden === 1 ? ' app' : ' apps') + ' hidden now' : '') + '</div></div></div>'
            + '<div class="opts">' + opt('showAdult', 'Show adult (18+) apps', 'Apps marked adult-only stay out of the store until this is on.')
            + opt('showNeedsHead', 'Show apps that need a phone or PC', 'Some apps need Apps2Samsung on a phone or PC to install. Turn this off to keep them out of the store.') + '</div>';
        if (confirmingAdult) h += '<div class="notice">These apps are meant for adults only. Turn them on only if you are 18 or older.</div>'
            + '<div class="btns" style="margin-top:16px"><button class="btn primary grow f" data-k="adultyes" data-act="adultyes" data-default>I am 18 or older</button><button class="btn f" data-k="adultno" data-act="adultno">Cancel</button></div>';
        h += '<div class="table kv"><div class="trow"><span class="k">Signing certificate</span><span class="v">' + (armed() ? 'handed over' : 'not yet') + '</span></div>'
            + '<div class="trow"><span class="k">Catalog</span><span class="v">' + esc(catalogApps.length + ' apps, signature checked') + '</span></div>'
            + '<div class="trow"><span class="k">TV-Store</span><span class="v">v' + VERSION + (ready && ready.node ? ' · Node ' + esc(ready.node) : '') + '</span></div></div>';
        return h + logBlock();
    }

    // ---- actions ----------------------------------------------------------------------------------
    function openApp(x, vIdx) {
        var st = state(x);
        openSheet({ mode: 'app', app: x, v: vIdx != null ? vIdx : (st.installed ? st.variant : 0), all: false });
    }

    function startInstall(x, vIdx) {
        if (job && job.running) return;
        var v = x.variants[vIdx], st = state(x);
        job = { app: x, v: v, vIdx: vIdx, update: st.installed && st.known && st.variant === vIdx, running: true, finished: false, ok: false, step: 0, bytes: 0, line: '', error: null, started: Date.now() };
        if (sheet) { sheet = { mode: 'job' }; renderSheet(true); } else openSheet({ mode: 'job' });
        renderHeader();
        var since = job.started - 2000, me = job;
        var timer = setInterval(function () { pollLog(me, since); }, 700);
        xhr('POST', '/install', { url: v.url, file: v.file, appId: v.appId, packageId: v.packageId }, function (err, res) {
            clearInterval(timer);
            pollLog(me, since, function () {
                me.running = false; me.finished = true; me.ended = Date.now();
                if (err || !res.ok) { me.error = err ? err.message : res.error; renderHeader(); if (sheet && sheet.mode === 'job') renderSheet(true); queue = []; return; }
                me.ok = true; me.step = 4;
                if (v.packageId) { installed[v.packageId] = v.version; claims = null; rememberVariant(v); }
                if (v.appId) appIds[v.appId] = true;
                readInstalled(function (map) {
                    if (map && Object.keys(map).length) setInstalled(map);
                    renderPage();
                    if (sheet && sheet.mode === 'job') renderSheet(true);
                    if (queue.length) setTimeout(function () { var nx = queue.shift(); startInstall(nx, state(nx).variant); }, 2500);
                });
            });
        });
    }

    // The service's log tells how far an install is (index.js writes one line per stage).
    function pollLog(me, since, then) {
        xhr('GET', '/logs', null, function (err, res) {
            if (!err && res && res.logs) {
                res.logs.forEach(function (l) {
                    var t = Date.parse(l.slice(0, 24)); if (t && t < since) return;
                    if (l.indexOf(' install:') < 0) return;
                    me.line = l.replace(/^\S+\s+install:\s*/, '');
                    var m = /downloaded (\d+) bytes/.exec(l);
                    if (m) { me.bytes = parseInt(m[1], 10); me.step = Math.max(me.step, 1); }
                    if (/pushing to/.test(l)) me.step = Math.max(me.step, 2);
                    if (/vd_appinstall reply/.test(l)) me.step = Math.max(me.step, 3);
                });
                if (sheet && sheet.mode === 'job' && job === me && me.running) renderSheet();
            }
            if (then) then();
        });
    }

    function launch(appId) {
        try { tizen.application.launch(appId, function () {}, function (e) { flash('Could not open it: ' + (e && e.message)); }); }
        catch (e) { flash('Could not open it: ' + e.message); }
    }
    function flash(text) { var h = sheetEl.querySelector('.hint'); if (h) { h.textContent = text; h.style.color = '#FF6B5E'; } }

    function toggle(key) {
        if (key === 'showAdult' && !settings.showAdult) { confirmingAdult = true; renderSheet(true); return; }
        setSetting(key, !settings[key]);
    }
    function setSetting(key, value) {
        settings[key] = value; saveSettings(); confirmingAdult = false;
        apps = visible(catalogApps);
        renderPage(); renderSheet(); focusKey('opt:' + key);
    }

    function activate(el) {
        if (!el) return;
        if (el === searchEl) return;
        var id = el.id, act = el.getAttribute('data-act'), k;
        if (id === 'tabInstall') { view = 'install'; renderPage(); focusFirst(); return; }
        if (id === 'tabTv') { view = 'tv'; renderPage(); focusFirst(); return; }
        if (id === 'gear') { openSheet({ mode: 'settings' }); return; }
        if ((k = el.getAttribute('data-chip'))) { chip = k; renderPage(); focusKey('chip:' + k) || focusFirst(); return; }
        if ((k = el.getAttribute('data-opt'))) { toggle(k); return; }
        if ((k = el.getAttribute('data-var'))) { sheet.v = parseInt(k, 10); renderSheet(); return; }
        if ((k = el.getAttribute('data-app'))) { var x = byKey(k); if (x) openApp(x); return; }
        switch (act) {
            case 'retry': location.reload(); return;
            case 'allvars': sheet.all = true; renderSheet(); focusKey('var:' + sheet.v); return;
            case 'install': if (!el.disabled) startInstall(sheet.app, sheet.v); return;
            case 'open': var s = state(sheet.app); launch(sheet.app.variants[s.variant].appId); return;
            case 'openjob': launch(job.v.appId); return;
            case 'close': closeSheet(); return;
            case 'retryjob': startInstall(job.app, job.vIdx); return;
            case 'adultyes': setSetting('showAdult', true); return;
            case 'adultno': confirmingAdult = false; renderSheet(); focusKey('opt:showAdult'); return;
            case 'tvupd': startInstall(tvSel, state(tvSel).variant); return;
            case 'tvsheet': openApp(tvSel); return;
            case 'selfupd': openApp(self()); return;
            case 'tvopen': launch(tvSel.variants[state(tvSel).variant].appId); return;
            case 'updall':
                queue = updates().filter(function (x) { var st = state(x), v = x.variants[st.variant]; return st.known && !v.needsHead; });
                if (queue.length) { var first = queue.shift(); startInstall(first, state(first).variant); }
                return;
        }
    }

    // ---- focus and spatial navigation -------------------------------------------------------------
    function scope() { return sheet ? sheetEl : appEl; }
    function focusables() {
        var list = Array.prototype.slice.call(scope().querySelectorAll('.f'));
        return list.filter(function (el) { return !el.disabled && el.offsetParent !== null; });
    }
    function focusKey(k) {
        if (!k) return false;
        var el = scope().querySelector('[data-k="' + k.replace(/"/g, '\\"') + '"]');
        if (!el && !sheet && k === 'search') el = searchEl;
        if (!el) { var ids = { tabInstall: 1, tabTv: 1, gear: 1 }; if (!sheet && ids[k]) el = $(k); }
        if (!el || el.disabled) return false;
        focus(el); return true;
    }
    function focusFirst() {
        var el = pageEl.querySelector('.card.f') || pageEl.querySelector('.lrow.f') || pageEl.querySelector('.btn.f') || pageEl.querySelector('.chip.f') || $('tabTv');
        focus(el);
    }
    function focus(el) {
        if (!el) return;
        el.focus();
        reveal(el);
        if (el.getAttribute && el.getAttribute('data-app') && view === 'install' && !sheet) {
            var x = byKey(el.getAttribute('data-app'));
            if (x && x !== hover) { hover = x; var sc = $('selcard'); if (sc) sc.outerHTML = selCard(x); }
        }
        if (el.getAttribute && el.getAttribute('data-app') && view === 'tv' && !sheet) {
            var y = byKey(el.getAttribute('data-app'));
            if (y && y !== tvSel) { tvSel = y; var tp = $('tvpanel'); if (tp) tp.outerHTML = tvPanel(y); }
        }
    }
    // Scroll whatever clips the element so that it shows: a row of cards sideways, the page and the
    // variant list vertically. Rows and the page have overflow hidden; their scroll offsets still work.
    function reveal(el) {
        var strip = closest(el, 'strip');
        if (strip) {
            var sr = strip.getBoundingClientRect(), er = el.getBoundingClientRect(), pad = 24;
            if (er.left < sr.left + pad) strip.scrollLeft -= (sr.left + pad - er.left);
            else if (er.right > sr.right - pad) strip.scrollLeft += (er.right - sr.right + pad);
        }
        var boxes = [closest(el, 'vscroll'), closest(el, 'page')];
        boxes.forEach(function (box) {
            if (!box) return;
            var br = box.getBoundingClientRect(), r = el.getBoundingClientRect(), m = 20;
            if (box === pageEl && !closest(el, 'sect') && !closest(el, 'group') && !closest(el, 'panel')) { box.scrollTop = 0; return; }
            if (r.top < br.top + m) box.scrollTop -= (br.top + m - r.top);
            else if (r.bottom > br.bottom - m) box.scrollTop += (r.bottom - br.bottom + m);
        });
    }
    function closest(el, cls) {
        for (var n = el; n && n !== document.body; n = n.parentNode) if (n.classList && n.classList.contains(cls)) return n;
        return null;
    }

    function move(dir) {
        var cur = document.activeElement, all = focusables();
        if (!cur || all.indexOf(cur) < 0) { if (all.length) focus(sheet ? (sheetEl.querySelector('[data-default]') || all[0]) : all[0]); return; }
        var a = cur.getBoundingClientRect(), ax = (a.left + a.right) / 2, ay = (a.top + a.bottom) / 2, best = null, bestScore = 1e9;
        all.forEach(function (el) {
            if (el === cur) return;
            var b = el.getBoundingClientRect(), bx = (b.left + b.right) / 2, by = (b.top + b.bottom) / 2, main, cross;
            if (dir === 'left') { if (b.right > a.left + 4 && bx >= ax) return; main = a.left - b.right; cross = Math.abs(by - ay); }
            else if (dir === 'right') { if (b.left < a.right - 4 && bx <= ax) return; main = b.left - a.right; cross = Math.abs(by - ay); }
            else if (dir === 'up') { if (b.bottom > a.top + 4 && by >= ay) return; main = a.top - b.bottom; cross = Math.abs(bx - ax); }
            else { if (b.top < a.bottom - 4 && by <= ay) return; main = b.top - a.bottom; cross = Math.abs(bx - ax); }
            var score = Math.max(main, 0) + cross * (dir === 'left' || dir === 'right' ? 3 : 0.6);
            if (score < bestScore) { bestScore = score; best = el; }
        });
        if (best) focus(best);
    }

    function back() {
        if (sheet) { if (sheet.mode === 'settings' && confirmingAdult) { confirmingAdult = false; renderSheet(); focusKey('opt:showAdult'); return; } closeSheet(); return; }
        if (document.activeElement === searchEl && query) { query = ''; searchEl.value = ''; renderPage(); return; }
        if (view === 'tv') { view = 'install'; renderPage(); focusFirst(); return; }
        if (chip !== 'all' || query) { chip = 'all'; query = ''; searchEl.value = ''; renderPage(); focusFirst(); return; }
        try { tizen.application.getCurrentApplication().exit(); } catch (x) {}
    }

    document.addEventListener('keydown', function (e) {
        var k = e.keyCode, inInput = document.activeElement === searchEl;
        if (k === KEY.RETURN || k === KEY.ESC || (k === KEY.BACK && !inInput)) { e.preventDefault(); back(); return; }
        if (inInput && (k === KEY.LEFT || k === KEY.RIGHT) && searchEl.value) return;   // the caret
        if (k === KEY.LEFT) { e.preventDefault(); move('left'); }
        else if (k === KEY.RIGHT) { e.preventDefault(); move('right'); }
        else if (k === KEY.UP) { e.preventDefault(); move('up'); }
        else if (k === KEY.DOWN) { e.preventDefault(); move('down'); }
        else if (k === KEY.ENTER && !inInput) { e.preventDefault(); activate(document.activeElement); }
    });
    document.addEventListener('click', function (e) {
        for (var n = e.target; n && n !== document.body; n = n.parentNode) if (n.classList && n.classList.contains('f')) { focus(n); activate(n); return; }
    });
    searchEl.addEventListener('input', function () { query = searchEl.value.trim(); if (view !== 'install') view = 'install'; renderPage(); });

    // ---- the API a head drives over the web inspector (#844 phase 3) ------------------------------
    function setReady(ping) {
        var was = armed();
        ready = ping; renderFoot();
        if (armed() !== was && !loading) { renderPage(); if (!sheet) focusFirst(); else renderSheet(); }
        renderHeader();
    }
    window.A2SStore = {
        version: VERSION,
        status: function () { return new Promise(function (resolve) { xhr('GET', '/ping', null, function (err, res) { resolve(err ? { ok: false, error: err.message } : res); }); }); },
        // A head arms right after installing, while the service may still be starting (first
        // launch after an install takes seconds): keep trying for 15 s before giving up.
        setCertificate: function (certs) {
            return new Promise(function (resolve) {
                var tries = 0;
                (function post() {
                    xhr('POST', '/cert', certs, function (err, res) {
                        if (err && ++tries < 30) return setTimeout(post, 500);
                        if (err) return resolve({ ok: false, error: err.message });
                        if (res && res.ok) setReady({ ok: true, certReady: true, ownIp: ready && ready.ownIp, node: ready && ready.node });
                        resolve(res || { ok: false, error: 'no answer from the service' });
                    });
                })();
            });
        }
    };

    // Until a head arms the TV, ask the service now and then, so the first-run screen turns into the
    // store by itself (an arm from an older head never touches this page's API).
    setInterval(function () { if (!loading && !problem && !armed()) xhr('GET', '/ping', null, function (err, res) { if (!err) setReady(res); }); }, 3000);

    // ---- boot -------------------------------------------------------------------------------------
    renderHeader(); renderFoot(); renderPage(); readDevice();
    startService(function (err, ping) {
        if (err) { loading = false; problem = { title: 'The TV-Store service did not start', short: 'Service stopped', text: err.message + ' Close TV-Store and open it again; if it keeps happening, reinstall it from Apps2Samsung.' }; renderPage(); focusFirst(); return; }
        ready = ping; renderFoot();
        readInstalled(function (map) {
            setInstalled(map);
            xhr('GET', '/catalog', null, function (err, cat) {
                loading = false;
                if (err) { problem = { title: 'The catalog did not load', short: 'No catalog', text: err.message + '.' }; renderPage(); focusFirst(); return; }
                var community = (cat.providers || []).filter(function (p) { return p.catalog && p.catalog.categories; })[0];
                window.__categories = community ? community.catalog.categories : {};
                catalogApps = build(cat); apps = visible(catalogApps); claims = null;
                renderPage(); focusFirst();
            });
        });
    });
})();
