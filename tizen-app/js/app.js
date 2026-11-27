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
 * Another certificate (#44): an app installed from a phone or PC carries that device's author
 * certificate, and the TV only updates it with the same one. Arming hands over every profile the
 * phone or PC holds, and the service tries them in turn on a [118, -12]. Only when none is taken
 * does the install screen offer to remove the old copy and install again (0 vd_appuninstall first);
 * the app's settings on the TV go with it, so it is a choice.
 *
 * Public or Partner (#50): a phone or PC holds a Public profile and, when the user made one, a
 * Partner one, and arming hands both over. The service tells which is which (the Samsung CA that
 * issued the distributor certificate). An app the catalog marks cert_level: partner (SushyDev's
 * YouTube) carries a "Partner certificate" badge and is signed Partner by itself; when the TV
 * holds no Partner profile its Install button is off and the sheet says how to get one. When the
 * TV holds both, the sheet has "Sign with": Automatic (the default), Public or Partner, remembered
 * per package, for the apps the catalog does not know about. A file sent in by hand gets the same.
 *
 * Tizen version (#47): the catalog says what Tizen each file asks for (required_version). A build
 * this TV is too old for carries a "Needs Tizen X" badge, its card is dimmed, and its Install button
 * is off: the TV would refuse it with install failed[118, -19] (#44). The service checks the same
 * from the package itself before pushing, so a file sent in by hand is caught too.
 *
 * Pins (#29): the app sheet pins one build of an app to the top of the store, remembered on the TV.
 * A pinned card shows that build's own state (installed version, update waiting). For apps whose
 * builds share one package id the pin also tells TV-Store which build the TV has.
 *
 * Your own file (#30): a .wgt or .tpk sent from a phone or PC to http://<TV IP>:8077/upload waits
 * in the service until this screen shows it (who sent it, what it calls itself) and OK confirms
 * the install. Only this page can: it sends the token the service writes into the package's
 * private folder (wgt-private), which no other app on the TV can read.
 *
 * Independent repositories (#82): signed repositories a developer publishes, added in Apps2Samsung
 * (which can validate HTTPS; the TV cannot) and handed over with Send sources to TV, which calls
 * window.A2SStore.addSources here. Each one is checked by the service and confirmed on this screen
 * (name, domain, key fingerprint) before it is kept. Their apps sit next to the official catalog's
 * with the source on every card and sheet once there is more than one source, and a From row of
 * chips filters by source. An installed app belongs to the source it came from (the service
 * remembers it per package; none remembered is the official catalog): its updates come only from
 * there, and the same package from another source is a separate card whose install says it moves
 * the app. Settings, Sources lists them with their state, turns them off or removes them.
 * An app the official catalog says moved to its developer's own repository (moved_to: { url,
 * fingerprint }) gets a banner while it is installed, and its sheet a notice, both with Add source:
 * the same confirmation, with the key vouched for by the signed official catalog instead of
 * Apps2Samsung, after which the app's updates come from that repository.
 *
 * Navigation is spatial: every focusable element carries the class `f`, and an arrow key moves to
 * the nearest one in that direction (inside the sheet while it is open). Scrolling follows the
 * focus: a row of cards sideways, the page and the variant list vertically. On the TV page, right
 * from the list goes to the selected app's panel and left comes back (#29).
 */
(function () {
    'use strict';
    // Apps2Samsung writes this TV's own IP in here when it installs TV-Store: Tizen 10 may not route
    // a page's request to the service over loopback. When that address stops answering (the router
    // gave the TV another one, or TV-Store was updated without Apps2Samsung), startService tries the
    // TV's current IP and loopback too, and keeps whichever answers.
    var BASE = 'http://127.0.0.1:8077';
    var KOFI = 'https://ko-fi.com/patrickst';
    var VERSION = '0.3.44';
    var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, RETURN: 10009, ESC: 27, BACK: 8, IME_DONE: 65376, IME_CANCEL: 65385 };

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
    // The categories: the community catalog says which there are, in which order, what they are
    // called and their tile colour (its "categories" and "category_colors"), so one can be added,
    // renamed or dropped there without a TV-Store release. These are the fallback for a catalog
    // that says nothing, and the colours for one that names no colour for a category it knows.
    var CATEGORY_ORDER = ['media', 'iptv', 'streaming', 'games', 'casting', 'tools', 'other'];
    var CATEGORY_NAMES = { media: 'Media servers & players', iptv: 'IPTV & Live TV', streaming: 'Streaming', games: 'Games & emulators', casting: 'Casting & cameras', tools: 'Tools & system', other: 'Other' };
    var CATEGORY_COLORS = { media: '#2B59FF', iptv: '#E8590C', streaming: '#D6336C', games: '#7048E8', casting: '#0CA678', tools: '#5C677D', other: '#868E96' };
    var PALETTE = ['#2B59FF', '#E8590C', '#D6336C', '#7048E8', '#0CA678', '#5C677D', '#868E96'];
    var HEAD_ONLY = /tvapp|immitv|camerapip|camera-pip/i;   // the heads' injectors, keyed by file name
    var NO_HASH = 'has no published hash, so the TV cannot check the download';

    var $ = function (id) { return document.getElementById(id); };
    var appEl = $('app'), pageEl = $('page'), sheetEl = $('sheet'), searchEl = $('search');

    // ---- state ------------------------------------------------------------------------------------
    var catalogApps = [];      // every app in the catalog, before the Settings filters
    var apps = [];             // what the Settings let through
    var installed = {};        // packageId -> version, from the platform
    var appIds = {};           // application ids the platform lists, exact case
    var tvNames = {};          // packageId -> the names its apps have on the TV, for the service's rename check (#84)
    var tvIcons = {};          // application id -> its icon on the TV as a file: address, from the platform (#126)
    // Another app's package id (#84): download URL -> the id a rename gives that file, from the
    // service's /pkgids. Apps2Samsung derives the same one, so an app either of them renamed is found.
    var pkgIds = {};
    // Which file TV-Store installed per package id. Variants of one app often share the package id
    // and the version (all six Litefin builds are LitefinApp 2.0.30, #17), so the TV alone cannot
    // say which one it has.
    var VARIANTS_KEY = 'a2s.tvstore.variants';
    var installedFile = (function () { try { return JSON.parse(window.localStorage.getItem(VARIANTS_KEY)) || {}; } catch (e) { return {}; } })();
    function rememberVariant(v, pkg) {
        pkg = pkg || v.packageId;
        if (!pkg) return;
        installedFile[pkg] = v.file;
        try { window.localStorage.setItem(VARIANTS_KEY, JSON.stringify(installedFile)); } catch (e) {}
        handPage();
    }
    // The jellyfin-web version TV-Store installed per package id (#124): { key, file, web }. Every
    // Jellyfin build declares 0.1.0, the wrapper's own version, so the TV cannot tell a 12.4 from a
    // 12.5; the catalog's web_version can, and only for a build TV-Store installed itself is the
    // one on the TV known. `key` is the app it belongs to: the Jellyfin apps share one package id.
    var WEB_KEY = 'a2s.tvstore.webversions';
    var installedWeb = (function () { try { var w = JSON.parse(window.localStorage.getItem(WEB_KEY)); return w && typeof w === 'object' && !Array.isArray(w) ? w : {}; } catch (e) { return {}; } })();
    function saveWeb() { try { window.localStorage.setItem(WEB_KEY, JSON.stringify(installedWeb)); } catch (e) {} handPage(); }
    // After an install from here: what went on the TV under pkg. A build without a web_version
    // takes the record away, since it replaced whatever the record was about.
    function rememberWeb(x, v, pkg) {
        if (!pkg) return;
        if (v.webVersion && !v.upload) installedWeb[pkg] = { key: x.key, file: v.file, web: v.webVersion };
        else if (installedWeb.hasOwnProperty(pkg)) delete installedWeb[pkg];
        else return;
        saveWeb();
    }
    // The record of package pkg when it is about app x, else null.
    function webRecord(x, pkg) {
        var r = installedWeb.hasOwnProperty(pkg) ? installedWeb[pkg] : null;
        return r && r.key === x.key && typeof r.web === 'string' && r.web ? r : null;
    }
    // A package that left the TV takes its record along: what comes back under that id may be
    // another build, from a phone or PC.
    function pruneWeb(map) {
        var gone = Object.keys(installedWeb).filter(function (p) { return !map.hasOwnProperty(p); });
        if (!gone.length) return;
        gone.forEach(function (p) { delete installedWeb[p]; });
        saveWeb();
    }
    // Sign with (#50): packageId -> 'public' | 'partner', only when chosen by hand; Automatic is no entry.
    var CERT_CHOICE_KEY = 'a2s.tvstore.certchoice';
    var certChoice = (function () { try { return JSON.parse(window.localStorage.getItem(CERT_CHOICE_KEY)) || {}; } catch (e) { return {}; } })();
    function chooseCert(v, level) {
        var k = v.packageId || v.file; if (!k) return;
        if (level === 'public' || level === 'partner') certChoice[k] = level; else delete certChoice[k];
        try { window.localStorage.setItem(CERT_CHOICE_KEY, JSON.stringify(certChoice)); } catch (e) {}
        handPage();
    }
    function certChoiceOf(v) { var c = certChoice[v.packageId || v.file]; return c === 'public' || c === 'partner' ? c : ''; }
    // The levels this TV holds, from the service: { public, partner }. A chain from elsewhere counts as public.
    function levelsHeld() {
        var out = { public: false, partner: false };
        ((ready && ready.certificates) || []).forEach(function (c) { if (c.level === 'partner') out.partner = true; else out.public = true; });
        if (!ready || !ready.certificates) out.public = armed();   // an older service: one level, taken as public
        return out;
    }
    // What an install of v signs with, as the sheet says it: the choice, else what the catalog or
    // the TV decides; with `auto` what Automatic would do, the choice set aside.
    function signPlan(v, auto) {
        var held = levelsHeld(), choice = auto ? '' : certChoiceOf(v);
        if (choice) return { level: choice, by: 'chosen', missing: !held[choice] };
        if (v.certLevel === 'partner') return { level: 'partner', by: 'catalog', missing: !held.partner };
        // An app TV-Store signed before is signed with that profile first, whatever the manifest asks
        // (the service's wantedLevel(); /ping lists them as remembered).
        var rem = ready && ready.remembered && v.packageId && ready.remembered[tvPkg(v)];
        if (rem) { var rl = rem.level === 'partner' ? 'partner' : 'public'; if (held[rl]) return { level: rl, by: 'remembered', name: rem.name, missing: false }; }   // an unknown chain serves as Public, as in certs.js
        if (v.manifestPartner && held.partner) return { level: 'partner', by: 'manifest', missing: false };
        return { level: held.public ? 'public' : 'partner', by: 'auto', missing: false };
    }
    function levelName(l) { return l === 'partner' ? 'Partner' : 'Public'; }
    var PARTNER_HOW = 'In Apps2Samsung on your phone or PC, set the signing certificate to Partner in Settings and install any app once, so it creates one; then press Arm TV-Store again. Both certificates come along.';

    // Pinned builds (#29): [{ key, file }], one entry per build, in the order they were pinned. The
    // file names the build, so a catalog that reorders variants keeps the pin on the same one.
    var PINS_KEY = 'a2s.tvstore.pins';
    var pins = (function () {
        try { var p = JSON.parse(window.localStorage.getItem(PINS_KEY)); return Array.isArray(p) ? p.filter(function (e) { return e && e.key && e.file; }) : []; }
        catch (e) { return []; }
    })();
    function savePins() { try { window.localStorage.setItem(PINS_KEY, JSON.stringify(pins)); } catch (e) {} handPage(); }
    function pinAt(x, i) { var f = x.variants[i].file; for (var n = 0; n < pins.length; n++) if (pins[n].key === x.key && pins[n].file === f) return n; return -1; }
    function isPinned(x, i) { return pinAt(x, i) >= 0; }
    function togglePin(x, i) {
        var n = pinAt(x, i);
        if (n >= 0) pins.splice(n, 1); else pins.push({ key: x.key, file: x.variants[i].file });
        savePins();
    }
    // Vetro (#102), a TV manager for rooted sets: while it is on the TV it leads the Pinned row, and OK
    // there opens it. It cannot be unpinned; it leaves the row when it leaves the TV. Its own
    // "Get apps" opens TV-Store the other way round.
    var VETRO_PKG = 'vetrotvapp', VETRO_APP = 'vetrotvapp.app';
    function vetroOnTv() { return installed.hasOwnProperty(VETRO_PKG); }
    function vetroCard() {
        return '<div class="card f vetro" tabindex="0" data-k="card:vetro" data-act="vetro">'
            + '<div class="tile s68" style="background:#7C3AED"><span class="lt">V</span></div>'
            + '<div class="nm">Vetro</div><div class="mt">Opens Vetro</div><div class="badges">' + badge('b-root', 'Needs root') + '</div></div>';
    }

    // The pinned builds that are in the store now: [{ app, v }]. A pin whose app or build left the
    // catalog (or is hidden by Settings) stays stored and comes back with it.
    function pinned() {
        var out = [];
        pins.forEach(function (p) {
            var x = byKey(p.key); if (!x || apps.indexOf(x) < 0) return;
            for (var i = 0; i < x.variants.length; i++) if (x.variants[i].file === p.file) { out.push({ app: x, v: i }); return; }
        });
        return out;
    }
    var ready = null;          // the service's /ping
    var tvTizen = '';          // the Tizen version this TV runs ("4.0"), from the platform; '' off a TV
    var tvDuid = '';           // this TV's DUID (webapis.productinfo), held against each certificate's device list (#78); '' when it cannot be read
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
    var storeHtml = null;      // what the store page was last built from, null when the page shows something else
    var selHtml = '';          // the Selected card as the page has it
    var rowsFit = 0;           // how many rows of cards the store shows at once; 0 when it is not laid out in rows
    var linesFit = 0, linePitch = 0;   // one category or a search: how many lines of cards show at once, and a line's height with its gap; 0 when not laid out so
    var LINE_ROOM = 12;        // what shows under the last line: room for the card under the focus, which is a little larger
    var tvHtml = null;         // what the On the TV page was last built from, null when the page shows something else
    var confirmingAdult = false;
    var device = '';
    var tvIp = '';             // this TV's IP now, from systeminfo
    var tvFree = 0;            // free bytes on the TV's own storage, 0 when unknown
    var upload = null;         // the file waiting in the service (#30), from /uploads
    var seenUpload = null;     // the id this page already asked about
    var uploadToken = null, uploadTokenError = null;
    var tried = [];            // what startService got from each address, for the error screen
    var officialCat = null;    // the official catalog as the service verified it
    // The catalog's format version when it is newer than this TV-Store knows (tizen-community-packages
    // docs/catalog.md, Versioning; the service's catalog.js has the same check): 0 when all is known.
    var KNOWN_SCHEMA = 1, catalogNewer = 0;
    function newerFormat(cat) {
        var top = 0;
        function see(v) { if (typeof v === 'number' && v % 1 === 0 && v > KNOWN_SCHEMA && v > top) top = v; }
        see(cat && cat.schemaVersion);
        ((cat && cat.providers) || []).forEach(function (p) { if (p && p.catalog) see(p.catalog.schemaVersion); });
        return top;
    }
    var sources = [];          // the independent repositories (#82), from /sources/catalog: [{ repositoryId, name, ..., manifest | error }]
    var srcFilter = 'all';     // 'all', 'official' or a repositoryId: the From chips
    var offers = [];           // sources Apps2Samsung sent (A2SStore.addSources) still to confirm: [{ src, done }]
    var offer = null;          // the one the sheet shows: { src, done, check, error, busy }
    var srcSel = null, srcConfirm = false, srcBusy = false, srcError = null;   // Settings, Sources

    // ---- settings, remembered on the TV -------------------------------------------------------------
    var SETTINGS_KEY = 'a2s.store.settings';
    var settings = (function () {
        // hideSelfNotice: the TV-Store version whose "vX is out" banner was dismissed (#43); the
        // banner comes back for the next release. autoUpdateApps, autoUpdateSelf: updates that
        // install by themselves (#154), both off by default. selfUpdate: the #41 switch, which
        // Settings no longer shows since autoUpdateSelf took its place. One that was on is kept
        // (Update under On the TV still works for TV-Store) until autoUpdateSelf is set either way.
        var s = { showAdult: false, showNeedsHead: true, verboseLog: false, hideSelfNotice: '', selfUpdate: false, autoUpdateApps: false, autoUpdateSelf: false };
        try {
            var saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || '{}');
            if (typeof saved.showAdult === 'boolean') s.showAdult = saved.showAdult;
            if (typeof saved.showNeedsHead === 'boolean') s.showNeedsHead = saved.showNeedsHead;
            if (typeof saved.verboseLog === 'boolean') s.verboseLog = saved.verboseLog;
            if (typeof saved.hideSelfNotice === 'string') s.hideSelfNotice = saved.hideSelfNotice;
            if (typeof saved.selfUpdate === 'boolean') s.selfUpdate = saved.selfUpdate;
            if (typeof saved.autoUpdateApps === 'boolean') s.autoUpdateApps = saved.autoUpdateApps;
            if (typeof saved.autoUpdateSelf === 'boolean') s.autoUpdateSelf = saved.autoUpdateSelf;
        } catch (e) {}
        return s;
    })();
    function saveSettings() { try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} handPage(); }
    // The service keeps its own copy (it logs before the page is up); this page's setting wins.
    function syncVerbose() {
        if (ready && ready.verbose === settings.verboseLog) return;
        xhr('POST', '/settings', { verbose: settings.verboseLog }, function (err, res) { if (!err && res && res.ok && ready) ready.verbose = res.verbose; });
    }

    // The sdb relay (#52): lives in the service, not in this page's settings, since it is a port the
    // service holds open; /ping carries its state and POST /settings { relay } changes it. With
    // Developer Mode's Host PC IP at 127.0.0.1 the TV's sdbd takes only loopback, which locks every
    // phone and PC out; the relay hands their connections to sdbd over loopback, so Apps2Samsung
    // (3.2 or newer) reaches this TV from any address without anyone typing one into Developer Mode.
    var relayBusy = false, relayError = null;   // relayError: why the last switch flip failed, shown under the row
    function relayAddress() { var r = ready && ready.relay; return (ready && ready.ownIp ? ready.ownIp : 'this TV') + ':' + (r && (r.port || r.configuredPort) || 26201); }
    function relayRow() {
        var r = ready && ready.relay;
        if (!r) return '';
        // r.auto: on by itself, since this TV's Host PC IP is 127.0.0.1 and the switch was never used (0.3.28).
        var hint = r.enabled
            ? (r.listening ? (r.auto ? 'On by default, because Host PC IP is 127.0.0.1: ' : 'On: ') + 'Apps2Samsung connects through ' + relayAddress() + '. ' : 'On, but not running. ') + (r.allow && r.allow.length ? 'Only the devices picked below can install apps through this port.' : 'Any device in your network can install apps through this port while it is on.')
            : 'Lets Apps2Samsung on a phone or PC reach this TV while Developer Mode\'s Host PC IP is 127.0.0.1, so you never type an address into Developer Mode again.'
                + (r.chosen === false ? ' Turns on by itself when Host PC IP is 127.0.0.1.' : '');
        return '<div class="opt f" tabindex="0" data-k="opt:relay" data-opt="relay"><div class="ot"><div class="ont">Connect from Apps2Samsung (sdb relay)</div><div class="oh">' + esc(hint) + '</div></div>'
            + '<span class="sw' + (r.enabled ? ' on' : '') + '"><i></i></span></div>';
    }
    // Who may connect (the relay's allow list, which holds for the store in a browser too): the phones
    // and PCs that came by since TV-Store started, each with a switch, so nobody types an address with
    // the remote. None on: any device in the network. One or more on: only those.
    function devicesRows() {
        var r = ready && ready.relay;
        if (!r || !(r.enabled || browserOn())) return '';
        var allow = r.allow || [], seen = r.seen || [], rows = [];
        seen.forEach(function (d) { rows.push(d); });
        allow.forEach(function (ip) { if (!seen.some(function (d) { return d.ip === ip; })) rows.push({ ip: ip }); });
        var h = '<div class="opt"><div class="ot"><div class="ont">Devices that may connect</div><div class="oh">'
            + esc(allow.length ? 'Only the ' + (allow.length === 1 ? 'device' : allow.length + ' devices') + ' switched on here, from Apps2Samsung or a browser. Switch all off to let any device in your network in again.'
                : rows.length ? 'Any device in your network, from Apps2Samsung or a browser. Switch one on and only the devices you picked can connect.'
                : 'Any device in your network, from Apps2Samsung or a browser. Once a phone or PC has connected it is listed here, and you can pick the ones that may.') + '</div></div></div>';
        rows.forEach(function (d) {
            var on = allow.indexOf(d.ip) >= 0, when = '';
            try { if (d.at) { var t = new Date(d.at); when = ' at ' + t.getHours() + ':' + (t.getMinutes() < 10 ? '0' : '') + t.getMinutes(); } } catch (e) {}
            var how = d.via === 'browser' ? 'a browser' : 'Apps2Samsung';
            var out = d.refused && allow.length > 0;   // kept out, and still would be
            var hint = !d.at ? 'Not seen since TV-Store started.' : d.refused && !out ? 'Last tried' + when + ' from ' + how + '.' : out ? 'Kept out' + when + ' (' + how + '): not one of the devices you picked.' : 'Connected' + when + ' from ' + how + '.';
            h += '<div class="opt f" tabindex="0" data-k="opt:allow:' + esc(d.ip) + '" data-opt="allow:' + esc(d.ip) + '"><div class="ot"><div class="ont mono">' + esc(d.ip) + '</div><div class="oh' + (out && !on ? ' warn' : '') + '">' + esc(hint) + '</div></div>'
                + '<span class="sw' + (on ? ' on' : '') + '"><i></i></span></div>';
        });
        return h;
    }
    function toggleAllow(ip) {
        if (!ready || !ready.relay || relayBusy) return;
        var allow = (ready.relay.allow || []).slice(), i = allow.indexOf(ip);
        if (i >= 0) allow.splice(i, 1); else allow.push(ip);
        relayBusy = true;
        xhr('POST', '/settings', { relay: { allow: allow } }, function (err, res) {
            relayBusy = false;
            if (!err && res && res.ok) { ready.relay = res.relay; relayError = null; }
            else relayError = { want: 'change who may connect to', why: err ? err.message : (res && res.error) || 'no answer from the service' };
            renderSheet(); focusKey('opt:allow:' + ip);
        });
    }
    function relayNotice() {
        var r = ready && ready.relay;
        if (!r) return '';
        // A flip that the service refused or that got no answer: said here, since this sheet has no
        // hint line for flash() and a re-render would wipe one anyway.
        var flip = relayError ? '<div class="notice bad">' + esc('Could not ' + relayError.want + ' the relay: ' + relayError.why) + '</div>' : '';
        if (!r.enabled) return flip;
        // Another app has the port (#90): Vetro's sdb tunnel sits on 26201 too, and turning it off and on
        // will not free it. Installs from this TV go through that app's tunnel instead.
        if (r.error && /EADDRINUSE/.test(r.error)) return flip + '<div class="notice bad">' + esc('Another app on this TV already uses port ' + (r.configuredPort || 26201) + ' (Vetro\u2019s sdb tunnel does), so the relay cannot start. TV-Store still installs through that app\u2019s tunnel, once Vetro\u2019s \u201cAllow SDB from the local network\u201d is on (the TV keeps apps out of each other\u2019s ports otherwise). That app runs in the background even when it is closed, so the port stays taken; the same switch lets Apps2Samsung on a phone or PC in.') + '</div>';
        if (r.error) return flip + '<div class="notice bad">' + esc('The relay could not start: ' + r.error + '. Turn it off and on again; if that does not help, restart TV-Store.') + '</div>';
        if (!r.listening) return flip + '<div class="notice">' + esc('The relay is starting…') + '</div>';
        return flip + '<div class="notice info">' + esc('Once: on the TV open Apps, type 1 2 3 4 5, set Host PC IP to 127.0.0.1 and restart the TV. From then on Apps2Samsung 3.2 or newer finds ' + relayAddress() + ' by itself'
+ '. This TV keeps installing from TV-Store either way.') + '</div>'
            + relayFailureNotice(r);
    }
    // The last connection through the relay that failed, with why (#58): the sdb protocol cannot tell
    // the phone or PC, so it sees "connection reset" and this screen says what happened.
    function relayFailureNotice(r) {
        var f = r.lastFailure;
        if (!f) return '';
        var when = '';
        try { var d = new Date(f.at); when = ' at ' + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes(); } catch (e) {}
        return '<div class="notice bad">' + esc('The last connection' + (f.client ? ' from ' + f.client : '') + when + ' failed: ' + f.reason + '.'
            + (r.served ? ' ' + r.served + ' connection' + (r.served === 1 ? '' : 's') + ' went through since TV-Store started.' : '')) + '</div>';
    }
    // While Settings is open with the relay on, keep its state fresh: a failed connection shows up here
    // within a few seconds, which is when the person at the TV is looking for it.
    function refreshRelay() {
        if (!sheet || sheet.mode !== 'settings' || !ready || !ready.relay || !(ready.relay.enabled || browserOn()) || relayBusy) return;
        xhr('GET', '/ping', null, function (err, res) {
            if (err || !res || !res.relay || !sheet || sheet.mode !== 'settings' || relayBusy) return;
            var before = JSON.stringify(ready.relay);
            ready.relay = res.relay;
            if (JSON.stringify(res.relay) !== before) renderSheet();
        }, null, 2500);
    }
    function toggleRelay() {
        if (!ready || !ready.relay || relayBusy) return;
        var want = !ready.relay.enabled;
        relayBusy = true;
        xhr('POST', '/settings', { relay: { enabled: want } }, function (err, res) {
            relayBusy = false;
            if (!err && res && res.ok) { ready.relay = res.relay; relayError = null; }
            else relayError = { want: want ? 'turn on' : 'turn off', why: err ? err.message : (res && res.error) || 'no answer from the service' };
            renderSheet(); focusKey('opt:relay');
        });
    }

    // The installer switch (#57, #67, #68; off by default since 0.3.20): whether a signed package may go to the TV's own installer
    // (wascmd, run by the service) or only through sdbd, as before 0.3.16. Lives in the service like
    // the relay: /ping carries it (installer.mode, and installer.off when the service learned on its
    // own to keep to sdbd), POST /settings { installer: { mode } } flips it.
    var installerBusy = false, installerError = null;
    function installerRow() {
        var i = ready && ready.installer;
        if (!i) return '';
        var on = i.mode === 'auto', w = i.wascmd || {};
        var hint = !on ? 'Off: installs go through the TV\'s developer connection (sdbd). On, TV-Store hands an install to the TV\'s own installer first; on every TV tried so far (Tizen 5 and 9) that took the service down, so leave this off unless you want to report what your TV does.'
            : i.off ? 'On, but TV-Store keeps to sdbd on this TV anyway: ' + i.off.why + '. Turn this off and on again to let it try the TV\'s own installer once more.'
            : w.available ? 'On: TV-Store hands an install to the TV\'s own installer first and uses sdbd when that does not work. If the service stops during an install, turn this off.'
            : 'On, but this TV lets TV-Store install through sdbd only anyway' + (w.denied ? ' (it may not run ' + w.path + ': ' + w.denied + ')' : '') + '.';
        return '<div class="opt f" tabindex="0" data-k="opt:installer" data-opt="installer"><div class="ot"><div class="ont">Try the TV\'s own installer (wascmd)</div><div class="oh">' + esc(hint) + '</div></div>'
            + '<span class="sw' + (on ? ' on' : '') + '"><i></i></span></div>';
    }
    function installerNotice() { return installerError ? '<div class="notice bad">' + esc('Could not change the installer setting: ' + installerError) + '</div>' : ''; }
    function toggleInstaller() {
        if (!ready || !ready.installer || installerBusy) return;
        var want = ready.installer.mode === 'sdb' ? 'auto' : 'sdb';
        installerBusy = true;
        xhr('POST', '/settings', { installer: { mode: want } }, function (err, res) {
            installerBusy = false;
            if (!err && res && res.ok && res.installer) { ready.installer = res.installer; installerError = null; }
            else installerError = err ? err.message : (res && res.error) || 'no answer from the service';
            renderSheet(); focusKey('opt:installer');
        });
    }

    // The signing certificates on this TV (#78): one row per profile the service holds, with what a
    // user needs to tell them apart and to see why one cannot install here. OK on a row offers "Use
    // as default" (the profile tried first when an app has none of its own; a pick made here survives
    // the next arm from a phone or PC) and "Remove", which asks first. Fingerprint: the first 12
    // characters of the id, the same value the Apps2Samsung debug log prints.
    var certSel = null, certConfirm = false, certBusy = false, certError = null;
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var EXPIRES_SOON_DAYS = 30;
    function dayOf(iso) { var d = new Date(iso); return isNaN(d.getTime()) ? '' : d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
    function daysLeft(iso) { var t = new Date(iso).getTime(); return isNaN(t) ? null : Math.ceil((t - Date.now()) / 864e5); }
    function certName(c) { return c.name || c.id.slice(0, 12); }
    // How long a profile holds: the author certificate, and the distributor one when it runs out first.
    function certExpiry(c) {
        var which = 'Valid until', iso = c.validUntil;
        if (c.distributorValidUntil && (!iso || new Date(c.distributorValidUntil) < new Date(iso))) { which = 'Distributor certificate valid until'; iso = c.distributorValidUntil; }
        var left = iso ? daysLeft(iso) : null;
        if (left === null) return { cls: '', text: 'Expiry not known' };
        if (left <= 0) return { cls: ' bad', text: (which === 'Valid until' ? 'Expired on ' : 'Distributor certificate expired on ') + dayOf(iso) + '; the TV may refuse apps signed with it' };
        if (left <= EXPIRES_SOON_DAYS) return { cls: ' warn', text: which + ' ' + dayOf(iso) + ', ' + (left === 1 ? 'tomorrow' : 'in ' + left + ' days') + '. Create a new one in Apps2Samsung and arm TV-Store again' };
        return { cls: '', text: which + ' ' + dayOf(iso) };
    }
    // Whether the distributor certificate lists this TV. A certificate without a device list (a Tizen
    // Studio one) says nothing either way.
    function certCoverage(c) {
        var list = c.deviceIds || [];
        if (!list.length) return { cls: '', text: 'No device list in the certificate' };
        function has(id) { id = String(id || '').toUpperCase(); return !!id && list.some(function (d) { return String(d).toUpperCase() === id; }); }
        // The id sdbd gives is the one Samsung puts in a certificate (the service reads it once a
        // developer connection was open): held against the list, it says yes or no.
        var real = ready && ready.duid;
        if (real) return has(real) ? { cls: '', text: 'Covers this TV' } : { cls: ' bad', text: 'Does not cover this TV (' + real + '), so it cannot install here' };
        if (has(tvDuid)) return { cls: '', text: 'Covers this TV' };
        // No match says nothing: on many sets the id an app can read is not the one Samsung puts in
        // a certificate (this said "does not cover" on a TV the certificate installed on fine).
        return { cls: '', text: 'Made for ' + (list.length === 1 ? 'the TV with id ' + list[0] : list.length + ' TVs: ' + list.slice(0, 3).join(', ') + (list.length > 3 ? ', \u2026' : '')) };
    }
    function certsBlock() {
        var list = (ready && ready.certificates) || [];
        if (!armed() || !list.length || !list[0].id) return '';   // an older service sends no ids: the line in the table below says it
        var h = '<div class="vhead"><span class="t">Signing certificates</span><span class="h">' + list.length + ' on this TV</span></div><div class="opts crts">';
        list.forEach(function (c) {
            var sel = c.id === certSel, exp = certExpiry(c), cov = certCoverage(c);
            var lvl = c.level === 'partner' ? 'Partner' : c.level === 'public' ? 'Public' : 'Unknown level, used as Public';
            h += '<div class="opt crt f' + (sel ? ' sel' : '') + '" tabindex="0" data-k="certrow:' + c.id + '" data-certrow="' + c.id + '"><div class="ot">'
                + '<div class="ont">' + esc(certName(c)) + (c.primary ? badge('b-ok', 'Default') : '') + '</div>'
                + '<div class="oh">' + esc(lvl) + ' · author <span class="fp">' + esc(c.id.slice(0, 12)) + '</span>' + (c.primary && c.chosenOnTv ? esc(' · chosen on this TV') : '') + '</div>'
                + '<div class="oh' + exp.cls + '">' + esc(exp.text) + '</div>'
                + '<div class="oh' + cov.cls + '">' + esc(cov.text) + '</div></div></div>';
            if (!sel) return;
            if (certConfirm) {
                var last = list.length === 1;
                h += '<div class="crtact"><div class="notice">' + esc('Remove \u2018' + certName(c) + '\u2019 from this TV? ' + (last
                        ? 'It is the only one here: TV-Store cannot install anything until a phone or PC arms it again.'
                        : 'Apps installed with it cannot be updated from TV-Store until a phone or PC arms this TV with it again.')) + '</div>'
                    + '<div class="btns"><button class="btn danger grow f" data-k="certremoveyes" data-act="certremoveyes"' + (certBusy ? ' disabled' : '') + '>Remove</button><button class="btn f" data-k="certremoveno" data-act="certremoveno">Cancel</button></div></div>';
            } else {
                h += '<div class="crtact"><div class="btns">' + (c.primary ? '' : '<button class="btn primary grow f" data-k="certdefault" data-act="certdefault"' + (certBusy ? ' disabled' : '') + '>Use as default</button>')
                    + '<button class="btn grow f" data-k="certremove" data-act="certremove"' + (certBusy ? ' disabled' : '') + '>Remove</button></div></div>';
            }
        });
        h += '</div>';
        if (certError) h += '<div class="notice bad">' + esc(certError) + '</div>';
        if (list.length > 1) h += '<div class="notice info">' + esc('An app is signed with the certificate it was installed with first, then with the default, then with the rest. An app that needs a Partner certificate only takes a Partner one.') + '</div>';
        return h;
    }
    function selectCert(id) { certSel = certSel === id ? null : id; certConfirm = false; certError = null; renderSheet(); focusKey('certrow:' + id); }
    function certAction(route, then) {
        if (!certSel || certBusy) return;
        var id = certSel;
        certBusy = true; certError = null;
        xhr('POST', route, { id: id }, function (err, res) {
            certBusy = false;
            if (err || !res || !res.ok) { certError = 'Could not change the certificates: ' + (err ? err.message : (res && res.error) || 'no answer from the service'); renderSheet(); focusKey('certrow:' + id); return; }
            var next = {};
            for (var k in ready) if (ready.hasOwnProperty(k)) next[k] = ready[k];
            next.certificates = res.certificates || []; next.certCount = res.certCount || 0; next.certReady = !!res.certReady;
            next.certNames = next.certificates.map(function (c) { return c.name; });
            certConfirm = false;
            setReady(next);
            then(id);
        });
    }

    // Settings, Sources (#82): the official catalog, always there, then every repository Apps2Samsung
    // sent, with when it last verified or why it does not. OK on a repository offers Turn off / on
    // and Remove (which asks first). Adding one only happens through Send sources to TV.
    function whenOf(iso) {
        var d = new Date(iso); if (!iso || isNaN(d.getTime())) return '';
        return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
    }
    function fpShort(fp) { return String(fp || '').slice(0, 16).replace(/(.{4})(?=.)/g, '$1 '); }
    function sourcesBlock() {
        var list = (ready && ready.sources) || [];
        var official = catalogApps.filter(function (x) { return x.source === 'official'; }).length;
        var h = '<div class="vhead"><span class="t">Sources</span><span class="h">' + (list.length ? (list.length + 1) + ' on this TV' : 'Only the official catalog') + '</span></div><div class="opts crts">'
            + '<div class="opt crt"><div class="ot"><div class="ont">Official' + badge('b-mute', 'Always on') + '</div><div class="oh">' + esc('The Apps2Samsung catalog, ' + official + ' apps, signature checked. It cannot be removed.') + '</div></div></div>';
        list.forEach(function (s) {
            var sel = s.repositoryId === srcSel, full = null;
            sources.forEach(function (t) { if (t.repositoryId === s.repositoryId) full = t; });
            var err = full && full.error ? full.error : s.enabled !== false && !s.ok && s.lastError ? s.lastError : '';
            var state = s.enabled === false ? { cls: '', text: 'Turned off: its apps are not shown, and nothing installs from it' }
                : err ? { cls: ' bad', text: 'Not loading: ' + err + (s.lastOkAt ? ' (last good ' + whenOf(s.lastOkAt) + ')' : '') }
                : { cls: '', text: 'Checked ' + whenOf(s.lastOkAt) + (s.apps != null ? ', ' + s.apps + (s.apps === 1 ? ' app' : ' apps') : '') + (s.lastGeneratedAt ? ', signed ' + whenOf(s.lastGeneratedAt) : '') };
            h += '<div class="opt crt f' + (sel ? ' sel' : '') + '" tabindex="0" data-k="srcrow:' + esc(s.repositoryId) + '" data-srcrow="' + esc(s.repositoryId) + '"><div class="ot">'
                + '<div class="ont">' + esc(s.name || s.repositoryId) + (s.enabled === false ? badge('b-mute', 'Off') : err ? badge('b-warn', 'Not loading') : '') + '</div>'
                + '<div class="oh">' + esc((s.maintainer ? 'by ' + s.maintainer + ' · ' : '') + s.domain + ' · key ') + '<span class="fp">' + esc(fpShort(s.fingerprint)) + '</span></div>'
                + '<div class="oh' + state.cls + '">' + esc(state.text) + '</div></div></div>';
            if (!sel) return;
            if (srcConfirm) {
                h += '<div class="crtact"><div class="notice">' + esc('Remove ‘' + (s.name || s.repositoryId) + '’ from this TV? Apps installed from it stay on the TV, but get no updates until Apps2Samsung sends this source again.') + '</div>'
                    + '<div class="btns"><button class="btn danger grow f" data-k="srcremoveyes" data-act="srcremoveyes"' + (srcBusy ? ' disabled' : '') + '>Remove</button><button class="btn f" data-k="srcremoveno" data-act="srcremoveno">Cancel</button></div></div>';
            } else {
                h += '<div class="crtact"><div class="btns"><button class="btn grow f" data-k="srctoggle" data-act="srctoggle"' + (srcBusy ? ' disabled' : '') + '>' + (s.enabled === false ? 'Turn on' : 'Turn off') + '</button>'
                    + '<button class="btn grow f" data-k="srcremove" data-act="srcremove"' + (srcBusy ? ' disabled' : '') + '>Remove</button></div></div>';
            }
        });
        h += '</div>';
        if (srcError) h += '<div class="notice bad">' + esc(srcError) + '</div>';
        h += '<div class="notice info">' + esc('More sources come from Apps2Samsung on a phone or PC: add a signed repository there, then press Send sources to TV in this TV’s Toolbox. TV-Store asks here before it adds one. Every app shows which source it comes from, and updates only from that source.') + '</div>';
        return h;
    }
    function selectSource(id) { srcSel = srcSel === id ? null : id; srcConfirm = false; srcError = null; renderSheet(); focusKey('srcrow:' + id); }
    // A change to the sources, with the page's token (only this screen may make one).
    function sourceAction(route, extra, then) {
        if (!srcSel || srcBusy) return;
        var id = srcSel;
        srcBusy = true; srcError = null; renderSheet();
        withUploadToken(function () {
            var b = { repositoryId: id, token: uploadToken };
            for (var k in extra) if (extra.hasOwnProperty(k)) b[k] = extra[k];
            xhr('POST', route, b, function (err, res) {
                if (err || !res || !res.ok) { srcBusy = false; srcError = 'Could not change the sources: ' + (err ? err.message : (res && res.error) || 'no answer from the service'); renderSheet(); focusKey('srcrow:' + id); return; }
                if (ready) ready.sources = res.sources || [];
                loadSources(false, function () {
                    srcBusy = false; srcConfirm = false;
                    rebuild(); renderPage(); then(id);
                });
            });
        });
    }

    // Send sources to TV (#82): Apps2Samsung calls A2SStore.addSources, and each source waits here
    // until the person at the TV has seen what the service verified (name, maintainer, domain, the
    // key's fingerprint, how many apps) and said yes or no.
    function offerSource(src, done) { offers.push({ src: src, done: done }); nextOffer(); }
    function nextOffer() {
        if (offer || !offers.length || loading || problem) return;
        if (sheet && (sheet.mode === 'job' && job && job.running || sheet.mode === 'upload' || sheet.mode === 'remove' || sheet.mode === 'backup' || sheet.mode === 'restore')) return;   // the 3 s tick asks again
        offer = offers.shift();
        offer.check = null; offer.error = null; offer.busy = false;
        openSheet({ mode: 'source' });
        xhr('POST', '/sources/check', offer.src, function (err, res) {
            if (!offer || !sheet || sheet.mode !== 'source') return;
            if (err || !res || !res.ok) offer.error = err ? err.message : (res && res.error) || 'no answer from the service';
            else offer.check = res.source;
            renderSheet(true);
        }, null, 120000);
    }
    function sourceHtml() {
        var o = offer, src = (o && o.src) || {}, c = o && o.check;
        var h = '<div class="shd"><div style="min-width:0"><div class="nm">' + esc(c ? c.name : src.moved ? 'Where ' + (src.name || 'the app') + ' moved' : src.name || 'A new source') + '</div><div class="mt">' + esc((src.moved ? 'Named by the official catalog' : 'Sent from Apps2Samsung') + (c ? ' · ' + c.domain : '')) + '</div></div></div>';
        if (!c && !o.error) return h + '<div class="waiting" style="margin-top:22px"><span class="spin"></span>Checking the source and its signature…</div>'
            + '<div class="sfoot"><div class="btns"><button class="btn grow f" data-k="srcno" data-act="srcno" data-default>Don’t add</button></div></div>';
        if (o.error) return h + '<div class="notice bad">' + esc('This source cannot be added: ' + o.error) + '</div>'
            + '<div class="sfoot"><div class="btns"><button class="btn grow f" data-k="srcno" data-act="srcno" data-default>Close</button></div></div>';
        if (c.description) h += '<div class="sdesc">' + esc(c.description) + '</div>';
        h += '<div class="table kv"><div class="trow"><span class="k">Maintainer</span><span class="v">' + esc(c.maintainer) + '</span></div>'
            + '<div class="trow"><span class="k">Address</span><span class="v">' + esc(c.domain) + '</span></div>'
            + '<div class="trow"><span class="k">Apps</span><span class="v">' + esc(c.apps + (c.apps === 1 ? ' app' : ' apps') + ', signed ' + whenOf(c.generatedAt)) + '</span></div>'
            + '<div class="trow fprow"><span class="k">Key fingerprint (SHA-256)</span><span class="fpbig">' + esc(c.fingerprint.slice(0, 32).replace(/(.{4})(?=.)/g, '$1 ')) + '<br>' + esc(c.fingerprint.slice(32).replace(/(.{4})(?=.)/g, '$1 ')) + '</span></div></div>';
        if (c.keyChanged) h += '<div class="notice bad">' + esc('This source is on the TV already, with another key. The publisher changed keys: add it only if Apps2Samsung showed you the same new key.') + '</div>';
        else if (c.known && !c.movedFrom) h += '<div class="notice info">' + esc('This source is on the TV already. Adding it again turns it on and keeps its apps where they are.') + '</div>';
        if (c.movedFrom) h += '<div class="notice info">' + esc('The official catalog says ' + (c.movedFrom.length === 1 ? 'an app on its list moved' : c.movedFrom.length + ' apps on its list moved') + ' here, and names this key, so the key is vouched for by the signed catalog. Apps you have from there take their updates from this repository once it is added.') + '</div>'
            + '<div class="notice">' + esc('A valid signature means the apps come from this publisher. Apps2Samsung does not review independent repositories.') + '</div>';
        else h += '<div class="notice">' + esc('Check that the key matches the one Apps2Samsung showed. A valid signature means the apps come from this publisher. Apps2Samsung has not reviewed them.') + '</div>';
        h += '<div class="sfoot"><div class="btns"><button class="btn primary grow f" data-k="srcyes" data-act="srcyes"' + (o.busy ? ' disabled' : '') + '>' + (o.busy ? 'Adding…' : c.known && c.movedFrom ? 'Take updates from there' : c.known ? 'Add again' : 'Add source') + '</button>'
            + '<button class="btn f" data-k="srcno" data-act="srcno" data-default>Don’t add</button></div><div class="hint">RETURN does not add it.</div></div>';
        return h;
    }
    function answerOffer(yes) {
        var o = offer;
        if (!o || o.busy) return;
        function finish(r) {
            offer = null; o.done(r);
            closeSheet(function () { renderPage(); focusFirst(); nextOffer(); });
        }
        if (!yes || !o.check) return finish({ url: o.src.url, repositoryId: o.src.repositoryId, added: false, error: o.error || 'declined on the TV' });
        o.busy = true; renderSheet();
        withUploadToken(function () {
            var b = {}; for (var k in o.src) if (o.src.hasOwnProperty(k)) b[k] = o.src[k];
            b.token = uploadToken;
            xhr('POST', '/sources/add', b, function (err, res) {
                if (err || !res || !res.ok) { o.busy = false; o.check = null; o.error = err ? err.message : (res && res.error) || 'no answer from the service'; renderSheet(true); return; }
                if (ready) { ready.sources = res.sources || []; if (res.sourceOf) ready.sourceOf = res.sourceOf; }
                loadSources(false, function () { rebuild(); finish({ url: o.src.url, repositoryId: o.src.repositoryId, added: true, name: res.source && res.source.name }); });
            });
        });
    }

    // ---- backup and restore of TV-Store's own data (#146) -------------------------------------------
    // A firmware update or a reset wipes the TV, TV-Store's data with it. Settings has "Back up or
    // restore": the TV shows a code and the address of the service's backup page, a phone or PC
    // downloads one file there with that code (favorites, Settings, sources, the signing certificates
    // and the settings typed for apps), and sends it back after a reset. A file that came in waits in
    // the service until this screen has shown what it holds and Restore was pressed. Apps2Samsung
    // takes the same two steps through A2SStore.backup() and A2SStore.restore() (see below).
    var backupOffer = null;    // the code sheet: { busy } | { error } | { code, until, url, taken }
    var restore = null;        // the backup waiting in the service, from /uploads: { id, from, at, summary, otherTv }
    var seenRestore = null;    // the id this page already asked about
    var restoreState = null;   // { busy } | { error } | { done: what the service put back }
    var restoreWaiters = {};   // id -> { resolve, at }, for A2SStore.restore
    // What this screen keeps itself (its localStorage); the service adds what it keeps.
    function pageState() { return { settings: settings, pins: pins, certChoice: certChoice, movedSeen: movedSeen, variants: installedFile, webVersions: installedWeb }; }
    function backupMeta() { return { version: VERSION, device: device }; }
    // The service gives a device on the LAN the backup without keys by itself (GET /backup/public,
    // #149), and this screen's part of it lives in this screen's storage: hand it over when
    // TV-Store starts and whenever one of its parts is saved. The service keeps the last one.
    var pageHandTimer = null;
    function handPage() {
        if (pageHandTimer) return;
        pageHandTimer = setTimeout(function () {
            pageHandTimer = null;
            withUploadToken(function () { if (!uploadTokenError) xhr('POST', '/backup/page', { token: uploadToken, page: pageState(), app: backupMeta() }, function () {}); });
        }, 1000);
    }
    function backupBlock() {
        return '<div class="vhead"><span class="t">Backup</span><span class="h">For after a reset or a firmware update</span></div><div class="opts">'
            + '<div class="opt f" tabindex="0" data-k="backupopen" data-act="backupopen"><div class="ot"><div class="ont">Back up or restore</div>'
            + '<div class="oh">' + esc('Your pinned apps, these Settings, the sources, the signing certificates and the settings you typed for apps, as one file on your phone or PC. Send it back here when the TV was wiped.') + '</div></div>' + CHEV + '</div></div>';
    }
    function openBackup() {
        backupOffer = { busy: true };
        sheet = { mode: 'backup' }; renderSheet(true);
        withUploadToken(function () {
            if (!sheet || sheet.mode !== 'backup') return;
            if (uploadTokenError) { backupOffer = { error: 'TV-Store could not read its key on this TV (' + uploadTokenError + '), so it cannot hand out a backup here.' }; renderSheet(true); return; }
            xhr('POST', '/backup/offer', { token: uploadToken, page: pageState(), app: backupMeta() }, function (err, res) {
                if (!sheet || sheet.mode !== 'backup') return;
                backupOffer = err || !res || !res.ok ? { error: 'Could not start a backup: ' + (err ? err.message : (res && res.error) || 'no answer from the service') } : { code: res.code, until: res.until, url: res.url };
                renderSheet(true);
            });
        });
    }
    // The code is void once its sheet is gone.
    function endBackupOffer() {
        if (backupOffer && backupOffer.code && !backupOffer.taken) xhr('POST', '/backup/offer', { token: uploadToken, close: true }, function () {});
        backupOffer = null;
    }
    function backupToSettings() { endBackupOffer(); sheet = { mode: 'settings' }; renderSheet(); focusKey('backupopen'); }
    function backupExpired() { return !!(backupOffer && backupOffer.until && Date.now() > new Date(backupOffer.until).getTime()); }
    function backupHtml() {
        var o = backupOffer || {}, close = '<button class="btn f" data-k="backupclose" data-act="backupclose">Back to Settings</button>';
        var h = '<div class="shd"><div style="min-width:0"><div class="nm">Back up or restore</div><div class="mt">TV-Store’s own data, as a file on your phone or PC</div></div></div>';
        if (o.busy) return h + '<div class="waiting" style="margin-top:22px"><span class="spin"></span>Asking the service for a code…</div><div class="sfoot"><div class="btns">' + close.replace('class="btn f"', 'class="btn grow f" data-default') + '</div></div>';
        if (o.error) return h + '<div class="notice bad">' + esc(o.error) + '</div><div class="sfoot"><div class="btns"><button class="btn primary grow f" data-k="backupnew" data-act="backupnew" data-default>Try again</button>' + close + '</div></div>';
        if (o.taken) return h + '<div class="notice info">' + esc('The backup was downloaded by ' + o.taken.from + '. Keep the file somewhere safe: with the signing certificates in it, whoever has it can sign apps as you.') + '</div>'
            + '<div class="sfoot"><div class="btns"><button class="btn primary grow f" data-k="backupclose" data-act="backupclose" data-default>Done</button><button class="btn f" data-k="backupnew" data-act="backupnew">New code</button></div></div>';
        if (backupExpired()) return h + '<div class="notice">The code ran out. A code is good for ten minutes and for one download.</div>'
            + '<div class="sfoot"><div class="btns"><button class="btn primary grow f" data-k="backupnew" data-act="backupnew" data-default>New code</button>' + close + '</div></div>';
        var u = o.url || (tvIp ? 'http://' + tvIp + ':8077/backup' : '');
        h += '<div class="qrrow">' + (u ? qr(u + '#code=' + o.code, 170) : '') + '<div><b>Type this code on the backup page</b><span class="bcode">' + esc(o.code.slice(0, 3) + ' ' + o.code.slice(3)) + '</span>'
            + '<span>' + (u ? 'Scan with your phone, or open <span class="mono">' + esc(u) + '</span> on a computer in the same network. ' : '') + esc('Good for one download, until ' + whenOf(o.until).replace(/^.* /, '') + '.') + '</span></div></div>';
        h += '<div class="notice info">' + esc('The file holds your pinned apps, the Settings, the sources, the signing certificates with their keys and the settings you typed for apps. The page can leave the certificates and the apps’ settings out.') + '</div>'
            + '<div class="notice info">' + esc('To restore, send a backup file from that same page. TV-Store shows here what it holds and asks before it puts anything back.') + '</div>';
        return h + '<div class="sfoot"><div class="btns">' + close.replace('class="btn f"', 'class="btn grow f" data-default') + '<button class="btn f" data-k="backupnew" data-act="backupnew">New code</button></div><div class="hint">The code stops working when this screen closes.</div></div>';
    }
    function restoreHtml() {
        var st = restoreState || {}, r = restore, m = r && r.summary;
        if (st.done) {
            var d = st.done, got = [];
            if (d.certificates) got.push(d.certificates + (d.certificates === 1 ? ' signing certificate' : ' signing certificates'));
            if (d.sources) got.push(d.sources + (d.sources === 1 ? ' source' : ' sources'));
            if (d.userSettings) got.push('the settings of ' + d.userSettings + (d.userSettings === 1 ? ' app' : ' apps'));
            got.push('your pinned apps and Settings');
            var again = d.sourcesReenter || [];
            return '<div class="shd"><div style="min-width:0"><div class="nm">Restored</div><div class="mt">TV-Store starts again to show it</div></div></div>'
                + '<div class="notice info">' + esc('Back on this TV: ' + got.join(', ') + '.' + (armed() || d.certificates ? '' : ' The backup held no signing certificates: press Arm TV-Store in this TV’s Toolbox in Apps2Samsung once.')) + '</div>'
                + (again.length ? '<div class="notice">' + esc('Not added: ' + again.map(function (x) { return x.name + ' (' + x.domain + ')'; }).join(', ') + '. The backup left out the key in ' + (again.length === 1 ? 'its address' : 'their addresses') + ', so send ' + (again.length === 1 ? 'it' : 'them') + ' to this TV again with Send sources to TV in Apps2Samsung.') + '</div>' : '')
                + '<div class="sfoot"><div class="btns"><button class="btn primary grow f" data-k="restoredone" data-act="restoredone" data-default>Start TV-Store again</button></div></div>';
        }
        if (!r) return '<div class="shd"><div><div class="nm">Nothing waiting</div><div class="mt">The backup is no longer on the TV.</div></div></div>'
            + '<div class="sfoot"><div class="btns"><button class="btn grow f" data-k="close" data-act="close" data-default>Back to the store</button></div></div>';
        var h = '<div class="shd"><div style="min-width:0"><div class="nm">Restore this backup?</div><div class="mt">' + esc('Sent from ' + r.from + (m.madeAt ? ' · made ' + whenOf(m.madeAt) : '')) + '</div></div></div>';
        var certText = !m.secrets ? 'left out of this backup' : m.certificates.length ? m.certificates.map(function (c) { return c.name + (c.level === 'partner' || c.level === 'public' ? ' (' + levelName(c.level) + ')' : ''); }).join(', ') : 'none';
        h += '<div class="table kv">'
            + (m.tv || m.tvStore ? '<div class="trow"><span class="k">Made on</span><span class="v">' + esc((m.tv || 'a TV') + (m.tvStore ? ' · TV-Store v' + m.tvStore : '')) + '</span></div>' : '')
            + '<div class="trow"><span class="k">Pinned apps</span><span class="v">' + m.pins + '</span></div>'
            + '<div class="trow"><span class="k">Settings</span><span class="v">' + (m.settings ? 'the switches as they were' : 'none') + '</span></div>'
            + '<div class="trow"><span class="k">Sources</span><span class="v">' + esc(m.sources.length ? m.sources.map(function (x) { return x.name + ' (' + x.domain + ')'; }).join(', ') : 'none') + '</span></div>'
            + '<div class="trow"><span class="k">Signing certificates</span><span class="v">' + esc(certText) + '</span></div>'
            + '<div class="trow"><span class="k">Settings typed for apps</span><span class="v">' + esc(!m.secrets ? 'left out of this backup' : m.userSettings ? m.userSettings + (m.userSettings === 1 ? ' app' : ' apps') : 'none') + '</span></div></div>';
        var reenter = m.sourcesReenter || [];
        if (reenter.length) h += '<div class="notice">' + esc((reenter.length === 1 ? 'One source is' : reenter.length + ' sources are') + ' not in this backup with a full address: ' + reenter.map(function (x) { return x.name + ' (' + x.domain + ')'; }).join(', ') + '. The address held a key, which a backup made without anybody at the TV leaves out. After the restore, send ' + (reenter.length === 1 ? 'it' : 'them') + ' to this TV again with Send sources to TV in Apps2Samsung.') + '</div>';
        if (st.error) h += '<div class="notice bad">' + esc('Could not restore it: ' + st.error) + '</div>';
        if (r.otherTv && m.secrets && m.certificates.length) h += '<div class="notice">' + esc('This backup was made on another TV. A signing certificate only installs on the TVs it lists; Settings shows per certificate whether it covers this one.') + '</div>';
        h += '<div class="notice">' + esc('Restore it only if the file is yours' + (m.sources.length || m.certificates.length ? ': its sources and certificates decide what TV-Store installs and signs, and are added without another question.' : '.')) + '</div>'
            + '<div class="notice info">' + esc('What this TV has stays. Certificates, sources and pinned apps are added to those here; the Settings switches and the settings typed for apps become the backup’s.') + '</div>';
        return h + '<div class="sfoot"><div class="btns"><button class="btn primary grow f" data-k="restoreyes" data-act="restoreyes"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? 'Restoring…' : 'Restore') + '</button>'
            + '<button class="btn f" data-k="restoreno" data-act="restoreno" data-default' + (st.busy ? ' disabled' : '') + '>Don’t restore</button></div><div class="hint">RETURN does not restore it.</div></div>';
    }
    // The screen's part of a backup, into its storage: added to what is here, the switches replaced.
    function storeRestored(p) {
        var k;
        function put(key, v) { try { window.localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }
        if (p.settings) { for (k in p.settings) if (p.settings.hasOwnProperty(k) && settings.hasOwnProperty(k) && typeof p.settings[k] === typeof settings[k]) settings[k] = p.settings[k]; saveSettings(); }
        if (p.pins) { p.pins.forEach(function (e) { if (!pins.some(function (q) { return q.key === e.key && q.file === e.file; })) pins.push({ key: e.key, file: e.file }); }); savePins(); }
        if (p.certChoice) { for (k in p.certChoice) if (p.certChoice.hasOwnProperty(k) && !certChoice.hasOwnProperty(k)) certChoice[k] = p.certChoice[k]; put(CERT_CHOICE_KEY, certChoice); }
        if (p.movedSeen) { p.movedSeen.forEach(function (u) { if (movedSeen.indexOf(u) < 0) movedSeen.push(u); }); put(MOVED_SEEN_KEY, movedSeen); }
        if (p.variants) { for (k in p.variants) if (p.variants.hasOwnProperty(k) && !installedFile.hasOwnProperty(k)) installedFile[k] = p.variants[k]; put(VARIANTS_KEY, installedFile); }
        if (p.webVersions) { for (k in p.webVersions) if (p.webVersions.hasOwnProperty(k) && !installedWeb.hasOwnProperty(k)) installedWeb[k] = p.webVersions[k]; saveWeb(); }
    }
    function restoreAnswered(id, out) { var w = restoreWaiters[id]; if (w) { delete restoreWaiters[id]; w.resolve(out); } }
    function answerRestore(yes) {
        var r = restore;
        if (restoreState && (restoreState.busy || restoreState.done)) return;
        if (!yes || !r) {
            if (r) { xhr('POST', '/backup/discard', { token: uploadToken, id: r.id }, function () {}); restoreAnswered(r.id, { ok: true, restored: false, error: 'declined on the TV' }); }
            restore = null; restoreState = null;
            closeSheet(); return;
        }
        restoreState = { busy: true }; renderSheet();
        withUploadToken(function () {
            xhr('POST', '/backup/apply', { token: uploadToken, id: r.id, installed: Object.keys(installed) }, function (err, res) {
                if (err || !res || !res.ok) { restoreState = { error: err ? err.message : (res && res.error) || 'no answer from the service' }; renderSheet(true); return; }
                storeRestored(res.page || {});
                restoreState = { done: res.applied || {} }; restore = null;
                restoreAnswered(r.id, { ok: true, restored: true, applied: res.applied || {} });
                renderSheet(true);
            });
        });
    }
    // The 3 s tick: what /uploads says about the code and about a backup that waits.
    function backupTick(res) {
        if (sheet && sheet.mode === 'backup' && backupOffer && backupOffer.code) {
            if (res.backup && res.backup.taken && !backupOffer.taken) { backupOffer.taken = res.backup.taken; renderSheet(true); }
            else if (backupExpired() && !backupOffer.ranOut) { backupOffer.ranOut = true; renderSheet(true); }
        }
        if (restoreState && (restoreState.busy || restoreState.done)) return false;
        var was = restore; restore = res.restore || null;
        // A request of Apps2Samsung's whose backup is no longer the one waiting gets its answer.
        for (var id in restoreWaiters) if (restoreWaiters.hasOwnProperty(id) && (!restore || restore.id !== id) && Date.now() - restoreWaiters[id].at > 10000) restoreAnswered(id, { ok: true, restored: false, error: 'the backup is no longer waiting on the TV' });
        var free = !sheet || sheet.mode === 'backup' || sheet.mode === 'settings';
        if (restore && restore.id !== seenRestore && free && !loading && !problem) {
            seenRestore = restore.id; restoreState = null;
            if (sheet && sheet.mode === 'backup') endBackupOffer();
            if (sheet) { sheet = { mode: 'restore' }; renderSheet(true); } else openSheet({ mode: 'restore' });
            return true;
        }
        if (sheet && sheet.mode === 'restore' && (!!was !== !!restore || (was && restore && was.id !== restore.id))) { restoreState = null; renderSheet(true); }
        return false;
    }

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
        return '<div class="qrrow">' + qr(u, 120) + '<div><b>The TV-Store log</b><span>Scan with your phone, or open <span class="mono">' + esc(u) + '</span> on a computer in the same network. Attach it to a bug report.</span></div></div>';
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
    // Tizen 9 and later start a web service through the Service class of the wrt:service module.
    // Only there is the module loaded, from a script added here, so older TVs run none of this and
    // start the service as before. A module that never answers (3 s) falls back to the old start.
    function platformMajor() {
        try { return parseInt(tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version'), 10) || 0; }
        catch (e) { return 0; }
    }
    function withWrtService(cb) {
        if (platformMajor() < 9) return cb();
        var done = false;
        function once() { if (done) return; done = true; window.removeEventListener('a2s-wrt-service', once); cb(); }
        window.addEventListener('a2s-wrt-service', once);
        setTimeout(once, 3000);
        try {
            var s = document.createElement('script');
            s.type = 'module';
            s.text = "import { Service } from 'wrt:service'; window.a2sService = Service; window.dispatchEvent(new Event('a2s-wrt-service'));";
            s.onerror = once;
            document.body.appendChild(s);
        } catch (e) { once(); }
    }

    function startService(cb) {
        var launch = 'pending';
        // Through an app control first, as TizenBrew starts its service (which comes up on Tizen 10),
        // and plain launch when the platform refuses that.
        function go() {
            var id;
            try { id = tizen.application.getCurrentApplication().appInfo.id.split('.')[0] + '.sdbservice'; }
            catch (e) { launch = 'launch failed (' + (e.name ? e.name + ': ' + e.message : e) + ')'; return; }
            // Tizen 9/10 start a web service only through wrt:service (loaded by withWrtService).
            if (typeof window.a2sService === 'function') {
                try {
                    var started = new window.a2sService(id).start();
                    if (started && typeof started.then === 'function') started.then(function () { launch = 'ok'; }, function (e) { launch = 'launch failed (wrt:service: ' + (e && e.message || e) + ')'; });
                    else launch = 'ok';
                    return;
                } catch (e) { launch = 'launch failed (wrt:service: ' + (e && e.message || e) + ')'; }
            }
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
        withWrtService(go);
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

    // The upload token (#30): the service writes it into the package's private data folder at
    // every start, and only TV-Store's own page can read that folder, so only this screen can
    // confirm an upload. Read fresh before each use: the service may have restarted since.
    function withUploadToken(cb) {
        function got(t) { t = String(t || '').trim(); if (t) { uploadToken = t; uploadTokenError = null; } else uploadTokenError = 'empty token file'; cb(); }
        function failed(e) { uploadTokenError = (e && e.message) || String(e || 'cannot read wgt-private'); cb(); }
        try {
            tizen.filesystem.resolve('wgt-private', function (dir) {
                try { dir.resolve('.a2s-upload-token').readAsText(got, failed, 'UTF-8'); } catch (e) { failed(e); }
            }, failed, 'r');
        } catch (e) { failed(e); }
    }

    // What the platform says is installed: packageId -> version. Empty off a TV.
    function readInstalled(cb) {
        try {
            tizen.application.getAppsInfo(function (infos) {
                var map = {};
                appIds = {}; tvNames = {}; tvIcons = {};
                for (var i = 0; i < infos.length; i++) {
                    var p = infos[i].packageId;
                    if (p) { map[p] = infos[i].version || ''; var n = tvNames[p] || (tvNames[p] = []); if (infos[i].name && n.indexOf(infos[i].name) < 0) n.push(infos[i].name); }
                    if (infos[i].id) appIds[infos[i].id] = true;
                    var ip = infos[i].id ? fileUrl(infos[i].iconPath) : '';
                    if (ip) tvIcons[infos[i].id] = ip;
                }
                queueThumbs();
                cb(map);
            }, function () { cb({}); });
        } catch (e) { cb({}); }
    }

    // A path on the TV as an address an <img> takes; '' for anything that is not an absolute path.
    function fileUrl(p) {
        p = typeof p === 'string' ? p : '';
        return /^file:\/\/\//.test(p) ? p : p.charAt(0) === '/' ? 'file://' + encodeURI(p) : '';
    }

    function readDevice() {
        // "4.0", "6.5", "10.0": what the apps' required_version is held against (#47).
        try { var pv = /^\s*(\d+(?:\.\d+)?)/.exec(String(tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version') || '')); if (pv) tvTizen = pv[1]; } catch (e) {}
        ['ETHERNET_NETWORK', 'WIFI_NETWORK'].forEach(function (t) {
            try { tizen.systeminfo.getPropertyValue(t, function (n) { if (n && n.ipAddress && !tvIp) tvIp = n.ipAddress; }, function () {}); } catch (e) {}
        });
        // Free space, for the store in a browser (#101): the internal storage's available bytes.
        try { tizen.systeminfo.getPropertyValue('STORAGE', function (st) { var u = st && st.units && st.units[0]; if (u && u.availableCapacity) tvFree = u.availableCapacity; }, function () {}); } catch (e) {}
        try { if (window.webapis && webapis.productinfo && webapis.productinfo.getDuid) tvDuid = String(webapis.productinfo.getDuid() || '').trim(); } catch (e) {}
        try {
            tizen.systeminfo.getPropertyValue('BUILD', function (b) {
                device = b && b.model ? b.model : '';
                handPage();
                renderFoot();
            }, function () {});
        } catch (e) {}
    }

    // ---- the catalog ------------------------------------------------------------------------------
    function variant(label, file, url, version, appId, packageId, tizen, certLevel, icon, webVersion) {
        return { label: label || file.replace(/\.(wgt|tpk)$/i, ''), file: file, url: url, version: version || '', appId: appId || '', packageId: packageId || '', tizen: tizen || '',
                 certLevel: String(certLevel || '').toLowerCase() === 'partner' ? 'partner' : '', icon: icon || '', webVersion: webOf(webVersion) };
    }
    // The catalog's web_version (#124), on Jellyfin builds only: the jellyfin-web version inside.
    // Anything that is not a plain version is left out, and the build compares as before.
    function webOf(w) { return typeof w === 'string' && /^\d+(?:\.\d+){0,3}$/.test(w) ? w : ''; }
    // The version a build is shown and compared with: its web_version when the catalog gives one.
    function verOf(v) { return v.webVersion || v.version; }
    // The icon a package file names in the catalog (#66), as the lower-case hex SHA-256 the service
    // serves it under (GET /icon/<hash>): only with its hash, the service shows nothing else.
    function iconOf(a) {
        var m = /^sha256:([0-9a-fA-F]{64})$/.exec((a && a.icon_digest) || '');
        return m && a.icon ? m[1].toLowerCase() : '';
    }
    // Whether this TV can run a build that asks for Tizen v.tizen ("6.0"): yes when either side is
    // unknown; the service checks the package itself and the TV has the last word (#47).
    function fits(v) { return !tvTizen || !v.tizen || !newer(v.tizen, tvTizen); }
    // The lowest Tizen any build of the app asks for, '' when no build says.
    function lowestTizen(x) { var low = ''; x.variants.forEach(function (v) { if (v.tizen && (!low || newer(low, v.tizen))) low = v.tizen; }); return low; }
    // No build of the app runs on this TV.
    function tooNew(x) { return !!tvTizen && x.variants.length > 0 && !x.variants.some(fits); }

    function ownerOf(repoOrUrl) {
        var m = /(?:repos\/)?([^\/]+)\/[^\/]+(?:\/releases)?$/.exec(String(repoOrUrl || '').replace(/^https?:\/\/[^\/]+\//, ''));
        return m ? m[1] : '';
    }

    // src: { id, name } of an independent repository (#82); none for the official catalog.
    function build(cat, src) {
        var out = [], byKey = {}, sid = src ? src.id : 'official';
        function app(key, name, category, description, author) {
            if (src) key = 'r:' + src.id + ':' + key;
            if (!byKey[key]) {
                byKey[key] = { key: key, name: name, category: knownCategory(category), description: description || '', author: author || '',
                               variants: [], needsHead: null, adult: false, root: false, partner: false, icon: '', source: sid, sourceName: src ? src.name : 'Official' };
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
                    var v = variant(e.variant, e.file, a.browser_download_url, e.version || a.package_version, e.app_id || a.app_id, e.package_id || a.package_id, e.required_version || a.required_version, e.cert_level || p.cert_level, iconOf(a), a.web_version);
                    var x = app('c:' + (e.group || e.name), e.group || e.name, e.category, e.description, ownerOf(e.repo));
                    v.app = x;
                    var mt = e.moved_to;
                    if (!src && mt && /^https:\/\/[^\s\/@:]+(?::\d+)?\/\S*[.]signed$/.test(mt.url || '') && /^[0-9a-f]{64}$/.test(mt.fingerprint || '')) v.movedTo = x.movedTo = { url: mt.url, fingerprint: mt.fingerprint };
                    x.variants.push(v);
                    if (v.icon && !x.icon) x.icon = v.icon;
                    if (v.certLevel === 'partner') x.partner = true;
                    if (e.adult) x.adult = true;
                    var root = (e.flags || []).indexOf('root') >= 0;
                    if (root) x.root = true;
                    if (root) v.needsHead = 'gains root on the TV and needs Host PC IP changed afterwards';
                    // Settings (user_settings): the official catalog's are typed on a phone or PC at
                    // TV-Store's own page and written in by the service; a repository's stay for Apps2Samsung.
                    else if (e.user_settings && src) v.needsHead = 'asks for settings before it installs';
                    if (e.user_settings && !src && !v.needsHead) v.settings = settingsInfo(e.user_settings);
                    else if (HEAD_ONLY.test(e.file)) v.needsHead = 'is configured by Apps2Samsung while it installs';
                    else if (!a.digest) v.needsHead = NO_HASH;
                });
                return;
            }

            // A repository's provider says what it is itself; the official ones are named here.
            var info = src ? { name: p.displayName || (p.buildInfo && p.buildInfo.name) || p.id, category: p.category, description: (p.buildInfo && p.buildInfo.description) || '' }
                : PROVIDERS[p.id] || { name: p.id, category: 'other', description: '' };
            var x = app('p:' + p.id, info.name, info.category, info.description, ownerOf(p.source_url || p.url) || (src && src.maintainer) || '');
            if (src && p.adult === true) x.adult = true;
            if (src && (p.flags || []).indexOf('root') >= 0) x.root = true;
            assets.forEach(function (a) {
                var v = variant(null, a.name, a.browser_download_url, a.package_version, a.app_id, a.package_id, a.required_version, p.cert_level, iconOf(a), a.web_version);
                v.app = x;
                if (!a.digest) v.needsHead = NO_HASH;
                else if (x.root) v.needsHead = 'gains root on the TV and needs Host PC IP changed afterwards';
                x.variants.push(v);
                if (v.icon && !x.icon) x.icon = v.icon;
                if (v.certLevel === 'partner') x.partner = true;
            });
        });

        out = out.filter(function (x) { return x.variants.length > 0; });
        out.forEach(function (x) {
            // An app needs a head when every file of it does.
            var all = x.variants.every(function (v) { return !!v.needsHead; });
            x.needsHead = all ? x.variants[0].needsHead : null;
            x.sort = x.name.toLowerCase();
        });
        return sortApps(out);
    }
    // By category, then name; the same app from two sources stays together, the official one first.
    function sortApps(list) {
        return list.sort(function (a, b) {
            var ca = CATEGORY_ORDER.indexOf(a.category), cb = CATEGORY_ORDER.indexOf(b.category);
            if (ca !== cb) return ca - cb;
            if (a.sort !== b.sort) return a.sort < b.sort ? -1 : 1;
            return (a.source === 'official' ? 0 : 1) - (b.source === 'official' ? 0 : 1);
        });
    }
    // Every app: the official catalog's and those of each repository that verified (#82).
    function buildAll() {
        var all = officialCat ? build(officialCat) : [];
        sources.forEach(function (s) { if (s.manifest && s.enabled !== false) all = all.concat(build(s.manifest, { id: s.repositoryId, name: s.name, maintainer: s.maintainer })); });
        return sortApps(all);
    }
    function rebuild() { catalogApps = buildAll(); apps = visible(catalogApps); claims = null; }

    // ---- the catalog, kept current ------------------------------------------------------------------
    // The store used to show the catalog as it was when TV-Store opened, for as long as it stayed
    // open: days, on a TV that is only put to sleep. An app taken out of the catalog was still on
    // screen, and a new version was not. Now the 3 s tick asks the service again every ten minutes
    // (the service keeps its own copy that long) and after two when that failed. The screen is drawn
    // again only when something changed, and then only when no sheet is open and nobody is typing
    // in the search box; until then the change waits.
    var CATALOG_EVERY = 10 * 60 * 1000, CATALOG_RETRY = 2 * 60 * 1000;
    var catalogDue = 0, catalogBusy = false, catalogChanged = false;
    // What the store is built from, as one short string. The times a catalog was signed or fetched
    // are left out: the workflow signs again every half hour, mostly with the same apps in it.
    var CATALOG_TIMES = { generatedAt: 1, lastGeneratedAt: 1, lastOkAt: 1, lastErrorAt: 1 };
    function catalogState() {
        var t = JSON.stringify([officialCat, sources, pkgIds, removedIds], function (k, v) { return CATALOG_TIMES.hasOwnProperty(k) ? undefined : v; });
        return t.length + ':' + hashOf(t);
    }
    function useCatalog(cat) {
        var community = (cat.providers || []).filter(function (p) { return p.catalog && p.catalog.categories; })[0];
        if (community) applyCategories(community.catalog);
        officialCat = cat;
        catalogNewer = newerFormat(cat);
        catalogDue = Date.now() + CATALOG_EVERY;
    }
    function refreshCatalog() {
        if (catalogBusy) return;
        catalogBusy = true;
        var before = catalogState();
        xhr('GET', '/catalog', null, function (err, cat) {
            // A catalog that does not come keeps the one on screen, and installing still checks.
            if (err || !cat || typeof cat !== 'object' || cat.ok === false) { catalogBusy = false; catalogDue = Date.now() + CATALOG_RETRY; return; }
            useCatalog(cat);
            loadSources(false, function () {
                catalogBusy = false;
                if (catalogState() !== before) catalogChanged = true;
                showCatalog();
            });
        }, null, 60000);
    }
    function showCatalog() {
        if (!catalogChanged || sheet || loading || problem || document.activeElement === searchEl) return;
        catalogChanged = false;
        var at = document.activeElement && document.activeElement.getAttribute('data-k');
        rebuild(); renderPage(); focusKey(at) || focusFirst();
    }
    // The repositories, verified by the service; cb() when they are in, or when there are none.
    function loadSources(fresh, cb) {
        xhr('GET', '/sources/catalog' + (fresh ? '?fresh=1' : ''), null, function (err, res) {
            if (!err && res && res.ok) {
                sources = res.sources || [];
                if (ready) ready.sources = sources.map(function (s) { var c = {}; for (var k in s) if (k !== 'manifest') c[k] = s[k]; return c; });
            }
            if (srcFilter !== 'all' && srcFilter !== 'official' && !sourceName(srcFilter, true)) srcFilter = 'all';
            // The rename ids follow the sources: a repository's files have them too (#84).
            xhr('GET', '/pkgids', null, function (err, res) {
                if (!err && res && res.ok && res.ids) { pkgIds = res.ids; claims = null; }
                if (!err && res && res.ok && res.removed && typeof res.removed === 'object') removedIds = res.removed;
                if (cb) cb();
            }, null, 30000);
        }, null, 120000);
    }
    // The package id build v has on this TV (#84): the one a rename gave its app when the TV has
    // that, else its own. Every build of the app with the same package id counts, since one build
    // can take over another's tile (a variant of the same group).
    function renamedOnTv(v) {
        if (!v || !v.packageId || !v.app) return '';
        var list = v.app.variants;
        for (var i = 0; i < list.length; i++) {
            var w = list[i], d = w.packageId === v.packageId ? pkgIds[w.url] : '';
            if (d && d !== v.packageId && installed.hasOwnProperty(d)) return d;
        }
        return '';
    }
    function tvPkg(v) { return renamedOnTv(v) || (v && v.packageId) || ''; }
    // The application id build v has on this TV: a rename keeps the part after the package id.
    function tvAppId(v) {
        var p = renamedOnTv(v);
        return p && v.appId && v.appId.indexOf(v.packageId + '.') === 0 ? p + v.appId.slice(v.packageId.length) : v.appId;
    }
    // App x is on the TV under an id of its own (#84), so the package's own id there is another app.
    function renamedApp(x, pkg) { return x.variants.some(function (v) { return v.packageId === pkg && !!renamedOnTv(v); }); }
    // Whether the TV has any source besides the official catalog: only then do cards say where an app comes from.
    function sourcesOn() { return !!(ready && ready.sources && ready.sources.some(function (s) { return s.enabled !== false; })); }
    function sourceName(id, strict) {
        if (!id || id === 'official') return 'Official';
        var list = (ready && ready.sources) || sources;
        for (var i = 0; i < list.length; i++) if (list[i].repositoryId === id) return list[i].name || id;
        return strict ? '' : id;
    }
    // The source an installed package came from, as the service remembers it; none is the official catalog.
    function sourceOfPkg(pkg) { var m = ready && ready.sourceOf; return (m && m[pkg]) || 'official'; }
    function srcBadge(x) { return sourcesOn() ? badge(x.source === 'official' ? 'b-mute' : 'b-src', x.sourceName || sourceName(x.source)) : ''; }
    // The package of build v is on the TV, from another source than app x: that source's name, else ''.
    // moved_to (#82): where an official app moved, and what is left to do about it: { url, fingerprint,
    // domain, source (the repository when the TV has it), done (its updates come from there already) }.
    function hostOf(u) { var m = /^https?:\/\/([^\/:?#]+)/i.exec(String(u || '')); return m ? m[1].toLowerCase() : ''; }
    function movedInfo(x) {
        if (!x || !x.movedTo || x.source !== 'official') return null;
        var m = x.movedTo, src = null, v = x.variants[0];
        ((ready && ready.sources) || []).forEach(function (t) { if (t.url === m.url && t.fingerprint === m.fingerprint && t.enabled !== false) src = t; });
        return { url: m.url, fingerprint: m.fingerprint, domain: hostOf(m.url), source: src, done: !!(src && v.packageId && sourceOfPkg(tvPkg(v)) === src.repositoryId) };
    }
    var MOVED_SEEN_KEY = 'a2s.tvstore.movedseen';
    var movedSeen = (function () { try { var a = JSON.parse(window.localStorage.getItem(MOVED_SEEN_KEY)); return Array.isArray(a) ? a : []; } catch (e) { return []; } })();
    // Installed official apps that moved and still update from the official catalog, by repository URL.
    function movedGroups() {
        var by = {}, out = [];
        catalogApps.forEach(function (x) {
            var m = movedInfo(x);
            if (!m || m.done || !state(x).installed) return;
            if (!by[m.url]) { by[m.url] = { url: m.url, fingerprint: m.fingerprint, domain: m.domain, source: m.source, apps: [] }; out.push(by[m.url]); }
            by[m.url].apps.push(x);
        });
        return out;
    }
    function names(list) { var n = list.map(function (x) { return x.name; }); return n.length < 3 ? n.join(' and ') : n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1]; }
    function addMoved(url, fingerprint, label) {
        offerSource({ url: url, fingerprint: fingerprint, moved: true, name: label }, function () {});
    }

    // Apps the community catalog took out (#87): catalog.removed in the official catalog. They never
    // install and stay out of the store's sections and counts; an installed copy gets a row of its
    // own on the On the TV page, and a search for one says it is gone and why. The service matches
    // package ids (its own and the one a rename gave each file, which only it can derive) in /pkgids.
    var removedIds = {};       // package id -> { name, category, reason, note, since, appIds, derived }, from /pkgids
    var REMOVED_WHY = {
        'unlicensed-content': 'Removed: it ships streams or links to content it has no licence for.',
        'unlicensed-service': 'Removed: it\u2019s a client for a service without a licence for its content.',
        'unlicensed-game-data': 'Removed: it ships game data it may not redistribute.',
        'takedown': 'Removed after a copyright (DMCA) notice.',
        'superseded': 'Removed: replaced by another app in the catalog.',
        'upstream-gone': 'Removed: the developer took the project down.'
    };
    var REMOVED_KEEPS = 'Your installed copy keeps working, but it won\u2019t get updates.';
    function removedWhy(g) { return REMOVED_WHY.hasOwnProperty(g.reason) ? REMOVED_WHY[g.reason] : 'Removed from the catalog.'; }
    function normName(n) { return String(n || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
    // A package under the entry's own id is that app only when the TV has one of the entry's
    // application ids, or its name for the package fits the entry's (a fork can share another app's
    // id, #84); no name on either side counts as a fit. The catalog name often differs from the
    // one in config.xml, so the application id comes first.
    function nameFits(name, list) {
        var a = normName(name);
        if (!a || !list || !list.length) return true;
        return list.some(function (n) { n = normName(n); return !n || n.indexOf(a) >= 0 || a.indexOf(n) >= 0; });
    }
    function hasAppId(list) { return (list || []).some(function (id) { return appIds.hasOwnProperty(id); }); }
    function appIdOf(pkg) { for (var id in appIds) if (appIds.hasOwnProperty(id) && id.indexOf(pkg + '.') === 0) return id; return ''; }
    function goneEntry(r, pkg) {
        return { key: 'gone:' + (pkg || normName(r.name)), gone: true, pkg: pkg || '', name: r.name, category: knownCategory(r.category), reason: r.reason || '', note: r.note || '', since: r.since || '', appId: pkg ? appIdOf(pkg) : '' };
    }
    function byName(a, b) { return normName(a.name) < normName(b.name) ? -1 : normName(a.name) > normName(b.name) ? 1 : 0; }
    // Removed apps on this TV: an installed package with a removed id that no catalog app claims.
    function goneOnTv() {
        var out = [];
        Object.keys(installed).forEach(function (p) {
            var r = removedIds.hasOwnProperty(p) ? removedIds[p] : null;
            if (!r || !r.name || claimOf(p) || !(r.derived || hasAppId(r.appIds) || nameFits(r.name, tvNames[p]))) return;
            out.push(goneEntry(r, p));
        });
        return out.sort(byName);
    }
    // Every removed entry of the official catalog, one per name; the installed copy's when the TV has it.
    function goneAll() {
        var out = [], seen = {}, tv = goneOnTv();
        tv.forEach(function (g) { seen[normName(g.name)] = true; out.push(g); });
        ((officialCat && officialCat.providers) || []).forEach(function (p) {
            ((p.catalog && Array.isArray(p.catalog.removed)) ? p.catalog.removed : []).forEach(function (e) {
                if (!e || typeof e.name !== 'string' || !normName(e.name) || seen[normName(e.name)]) return;
                seen[normName(e.name)] = true;
                out.push(goneEntry({ name: e.name.trim(), category: typeof e.category === 'string' ? e.category : '', reason: typeof e.reason === 'string' ? e.reason : '', note: typeof e.note === 'string' ? e.note : '', since: /^\d{4}-\d{2}-\d{2}$/.test(e.since || '') ? e.since : '' }, ''));
            });
        });
        return out;
    }
    function goneByKey(k) { var l = goneAll(); for (var i = 0; i < l.length; i++) if (l[i].key === k) return l[i]; return null; }
    // Search: removed entries by name, only where the official catalog is in view.
    function goneMatches(q) {
        if (srcFilter !== 'all' && srcFilter !== 'official') return [];
        return goneAll().filter(function (g) { return normName(g.name).indexOf(q) >= 0; }).sort(byName);
    }
    function heldElsewhere(x, v) {
        var p = tvPkg(v);
        if (!p || !installed.hasOwnProperty(p)) return '';
        var from = sourceOfPkg(p);
        return from === x.source ? '' : from === 'official' ? 'the official catalog' : sourceName(from, true) || from + ' (a source no longer on this TV)';
    }

    function visible(all) {
        return all.filter(function (x) {
            if (srcFilter !== 'all' && x.source !== srcFilter) return false;
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
                // Only the source the package came from claims it (#82): its updates come from there.
                var from = sourceOfPkg(p);
                catalogApps.forEach(function (x) {
                    if (x.source !== from || renamedApp(x, p)) return;
                    x.variants.forEach(function (v) {
                        if (v.packageId !== p) return;
                        if (!first) first = x;
                        if (!exact && v.version && v.version === installed[p]) exact = x;
                    });
                });
                // The Jellyfin apps all declare 0.1.0 (#124): the one TV-Store installed is the one it wrote down.
                var rec = installedWeb.hasOwnProperty(p) ? byKey(installedWeb[p].key) : null;
                if (rec && rec.source === from && !renamedApp(rec, p) && rec.variants.some(function (v) { return v.packageId === p; })) exact = rec;
                if (first) claims[p] = (exact || first).key;
            });
        }
        return claims[pkg];
    }
    function setInstalled(map) { installed = map; claims = null; if (Object.keys(map).length) pruneWeb(map); }

    // Installed / update state of an app: from the variants whose package id the TV lists. Several
    // can match (#17); then the installed application id narrows it down where the builds differ in
    // it, the file TV-Store itself installed settles it, and failing that the one build the user
    // pinned (#29: an app installed from a phone leaves no file behind). Otherwise known is false:
    // the screens say the variant is not known instead of naming the first one, and no update starts
    // without the user picking the build (it could swap theirs for another).
    function state(x) {
        var hits = [];
        for (var i = 0; i < x.variants.length; i++) {
            var v = x.variants[i], p = tvPkg(v);
            if (p && installed.hasOwnProperty(p) && (p !== v.packageId || claimOf(p) === x.key)) hits.push(i);
        }
        if (!hits.length) return { installed: false };
        var byApp = hits.filter(function (i) { return x.variants[i].appId && appIds[tvAppId(x.variants[i])]; });
        if (byApp.length) hits = byApp;
        var pick = hits[0], known = hits.length === 1, byPin = false, file = installedFile[tvPkg(x.variants[pick])];
        for (var j = 0; j < hits.length; j++) if (x.variants[hits[j]].file === file) { pick = hits[j]; known = true; }
        if (!known) {
            var pinnedHits = hits.filter(function (i) { return isPinned(x, i); });
            if (pinnedHits.length === 1) { pick = pinnedHits[0]; known = true; byPin = true; }
        }
        var c = versions(x, x.variants[pick]);
        return { installed: true, version: c.version, update: c.update, variant: pick, known: known, byPin: byPin, latest: c.latest, unknown: c.unknown };
    }
    // The version of build v on the TV against the catalog's: { version, latest, update, unknown }.
    // A build with a web_version (#124) is compared on that, with the one TV-Store wrote down when
    // it installed the app. Nothing written down (it came from a phone or PC, or from before this)
    // is `unknown`: no version to show and no update, since TV-Store's plain package would replace
    // a Jellyfin the desktop app built with the user's server, sign-in and plugins.
    function versions(x, v) {
        var pkg = tvPkg(v);
        if (v.webVersion) {
            var rec = webRecord(x, pkg), have = rec ? rec.web : '';
            return { version: have, latest: v.webVersion, update: newer(v.webVersion, have), unknown: !have };
        }
        return { version: installed[pkg], latest: v.version, update: newer(v.version, installed[pkg]), unknown: false };
    }
    // How the version on the TV reads: "v12.4.0", or that it is not known.
    function haveText(st) { return st.unknown ? 'version not known' : st.version ? 'v' + st.version : ''; }
    var WEB_UNKNOWN = 'TV-Store did not install this copy, so it cannot tell which version is on the TV and offers no update. Installing it from here once settles that; a copy built by Apps2Samsung on a PC with your server, sign-in or plugins would be replaced by the plain package.';

    // The state of one build of an app, for its pinned card (#29): installed when the TV has that
    // build's package and nothing says it is another build; `other` when the TV is known to have a
    // different build of the same package.
    function variantState(x, i) {
        var st = state(x), v = x.variants[i];
        if (!st.installed || x.variants[st.variant].packageId !== v.packageId) return { installed: false };
        if (st.known && st.variant !== i) return { installed: false, other: true };
        var c = versions(x, v);
        return { installed: true, version: c.version, update: c.update, latest: c.latest, exact: st.known, unknown: c.unknown };
    }

    // What the platform says about this very app: null off a TV.
    // Asked once: the call into the platform blocks the page for some 15 ms on a TV, and the picture
    // for the browser store page asks it for every app, every 3 s. The answer cannot change while
    // this page lives (an update of TV-Store starts it again).
    var selfKnown = false, selfIs = null;
    function selfInfo() {
        if (!selfKnown) {
            selfKnown = true;
            try { var i = tizen.application.getCurrentApplication().appInfo; selfIs = i ? { id: i.id, packageId: i.packageId, version: i.version } : null; } catch (e) { selfIs = null; }
        }
        return selfIs;
    }
    // TV-Store's own catalog entry: by its package id, or, when a head installed it under another id
    // (Apps2Samsung's "Install under a new package id" rewrites the package part only), by the
    // application part of the id, which the rename keeps, plus the entry's name.
    function self() {
        var info = selfInfo(), pkg = info ? info.packageId : '', app = info && info.id ? String(info.id).split('.').pop() : '', byName = null;
        for (var i = 0; i < catalogApps.length; i++)
            for (var j = 0; j < catalogApps[i].variants.length && catalogApps[i].source === 'official'; j++) {
                var v = catalogApps[i].variants[j];
                if (pkg && v.packageId === pkg) return catalogApps[i];
                if (app && v.appId && String(v.appId).split('.').pop() === app && /TV-Store/i.test(catalogApps[i].name)) byName = byName || catalogApps[i];
            }
        return byName;
    }
    // This copy runs under a package id that is not its catalog one: a head renamed it at install.
    // It cannot update itself then (an install from here would land a second TV-Store under the
    // catalog id); the head that renamed it remembers the id and updates the right tile.
    function selfRenamed() {
        var me = self(), info = selfInfo();
        return !!(me && info && info.packageId && !me.variants.some(function (v) { return v.packageId === info.packageId; }));
    }
    // TV-Store cannot replace itself from here: the installer stops every process of the package
    // it updates, and that includes the service driving the install, so the install never lands
    // (#41). A head on a phone or PC is outside the package and updates it fine.
    function isSelf(x) { return !!x && x === self(); }
    var SELF_HOW = 'TV-Store cannot replace itself while it runs: the installer stops the service that drives the install. Update it from Apps2Samsung on a phone or PC (On the TV, Update).';
    // With "Update TV-Store automatically" on (#154; before it the #41 switch "Let TV-Store update
    // itself", still honoured where it was on), the service installs TV-Store's own package
    // through sdbd and expects to be stopped by the installer on the way (Apps2Samsung#1005 saw
    // the install land anyway). Not for a copy a head installed under another package id: an
    // install from here would land a second TV-Store. Never part of Update all, which it would end.
    function selfCan(x) { return isSelf(x) && (settings.selfUpdate || settings.autoUpdateSelf) && !selfRenamed(); }
    var SELF_AUTO = 'TV-Store is updating itself, because \u201cUpdate TV-Store automatically\u201d is on in Settings. It closes during the install; open it again after a minute and it says whether the update landed.';
    var SELF_TRY = 'TV-Store installs its own update. It closes during the install; open it again after a minute and it says whether the update landed.';
    // How the last self-update went, from the marker the service found at start: { mark, outcome }.
    var selfResult = null;
    function selfOutcome(mark) { return mark && mark.to && mark.to === VERSION ? 'landed' : mark && mark.from && mark.from === VERSION ? 'not-landed' : 'unknown'; }
    function selfResultHtml() {
        if (!selfResult) return '';
        var m = selfResult.mark, o = selfResult.outcome, last = m.lines && m.lines.length ? m.lines[m.lines.length - 1].replace(/^\S+\s+/, '') : '';
        var text = o === 'landed' ? 'TV-Store updated itself to v' + VERSION + '.'
            : o === 'not-landed' ? 'The update to v' + (m.to || '?') + ' did not land; this is still v' + VERSION + '.' + (last ? ' Last log line before TV-Store closed: ' + last + '.' : '') + ' Please add the TV-Store log (Settings) to GitHub issue #41, and update from Apps2Samsung on a phone or PC.'
            : 'TV-Store sent an update of itself' + (m.to ? ' to v' + m.to : '') + ' and now runs v' + VERSION + '. Please add the TV-Store log (Settings) to GitHub issue #41.';
        return '<div class="notice row' + (o === 'landed' ? ' info' : o === 'not-landed' ? ' bad' : '') + '"><span>' + esc(text) + '</span><button class="btn f" data-k="selfack" data-act="selfack">Got it</button></div>';
    }
    function updates() { return catalogApps.filter(function (x) { return state(x).update; }); }
    function onTv() { return catalogApps.filter(function (x) { return state(x).installed; }); }
    function byKey(k) { for (var i = 0; i < catalogApps.length; i++) if (catalogApps[i].key === k) return catalogApps[i]; return null; }
    function armed() { return !!(ready && ready.certReady); }

    // ---- small builders ---------------------------------------------------------------------------
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function catName(id) { return CATEGORY_NAMES[knownCategory(id)]; }
    function knownCategory(id) { return typeof id === 'string' && CATEGORY_NAMES.hasOwnProperty(id) ? id : 'other'; }
    function hashOf(text) { var h = 0; for (var i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) >>> 0; return h; }
    // Takes the categories from the community catalog: { id: name } in display order, and
    // { id: "#RRGGBB" }. Ids and colours that do not look right are skipped, "other" is always
    // there (last, unless the catalog places it), and a catalog without categories keeps the
    // built-in ones. A category without a colour gets one from the palette by its id.
    function applyCategories(catalog) {
        var names = catalog && catalog.categories, colors = (catalog && catalog.category_colors) || {}, order = [], map = {};
        if (names && typeof names === 'object') for (var id in names) {
            if (!names.hasOwnProperty(id) || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) || map.hasOwnProperty(id)) continue;
            var n = typeof names[id] === 'string' ? names[id].trim() : '';
            if (!n) continue;
            order.push(id); map[id] = n.slice(0, 60);
        }
        if (!order.length) return;
        if (!map.hasOwnProperty('other')) { order.push('other'); map.other = 'Other'; }
        var col = {};
        order.forEach(function (c) {
            var v = colors.hasOwnProperty(c) && typeof colors[c] === 'string' ? colors[c].trim() : '';
            col[c] = /^#[0-9A-Fa-f]{6}$/.test(v) ? v : CATEGORY_COLORS[c] || PALETTE[hashOf(c) % PALETTE.length];
        });
        CATEGORY_ORDER = order; CATEGORY_NAMES = map; CATEGORY_COLORS = col;
    }
    // The app's tile: its icon from the service when the catalog names one (#66), the first letter
    // on the category colour until it is there, or for good when the service has none to show.
    // The letter stays underneath: the icon only covers it once it has loaded, and a failed load
    // takes the image out again.
    function tile(x, size, icon) {
        // Its category's colour; an app under "other" gets one from the palette by its name, so the
        // same app always looks the same.
        var m = String(x.name || '').match(/[A-Za-z0-9]/), c = knownCategory(x.category);
        var bg = c !== 'other' ? CATEGORY_COLORS[c] : x.name ? PALETTE[hashOf(String(x.name)) % PALETTE.length] : CATEGORY_COLORS.other;
        // An app the catalog has no icon for shows the one it has on the TV, once it is installed
        // (#126): the apps that are not in the catalog, and a repository's that names no icon.
        icon = icon || x.icon;
        var src = icon ? BASE + '/icon/' + icon : tvIconOf(x);
        // decoding="sync" (#126): a browser that decodes large images off the frame (Chromium 65 and up)
        // first paints the tile without its icon and adds it a frame later, again every time the focus
        // scales a card or the Selected card is rebuilt: the icon blinked between the bare rounded tile
        // and its own shape. An older browser ignores the attribute and decodes in the frame anyway.
        var img = src ? '<img class="ic" alt="" decoding="sync" src="' + esc(src) + '" onload="this.parentNode.classList.add(\'has\')" onerror="if(this.parentNode)this.parentNode.removeChild(this)">' : '';
        return '<div class="tile s' + size + '" style="background:' + bg + '">' + img + '<span class="lt">' + esc(m ? m[0].toUpperCase() : '?') + '</span></div>';
    }
    // The icon the TV itself has for the app: by the application id of any of its builds.
    function tvIconOf(x) {
        var ids = x.other ? [x.id] : x.gone ? [x.appId] : (x.variants || []).map(tvAppId);
        for (var i = 0; i < ids.length; i++) if (ids[i] && tvIcons.hasOwnProperty(ids[i])) return thumbOf(tvIcons[ids[i]]);
        return '';
    }
    // A small copy of each of the TV's own icons (#126). An app's icon on the TV is as large as its
    // developer made it, and the list under On the TV shows dozens of them at 66 px: the TV decoded
    // and scaled every one of them again while the list moved, and moving through the apps that are
    // not in the catalog stuttered. Each icon is drawn once on a canvas of at most THUMB px and kept
    // as a blob: address; the page shows that copy from then on. One at a time, and only while the
    // remote rests, so making them holds nothing up. Where the browser cannot do this (no toBlob
    // before Tizen 4, or a canvas it will not let the page read back) the icon shows as it is.
    var THUMB = 192;
    var tvThumbs = {};         // file: address -> blob: address of its small copy, or '' when it shows as it is
    var thumbQueue = [], thumbBusy = false, thumbNow = '', thumbAgain = false;   // thumbNow: the one being made; thumbAgain: its icon changed meanwhile
    var thumbsWork = (function () {
        try { var c = document.createElement('canvas'); return typeof Image === 'function' && !!c.getContext && typeof c.toBlob === 'function' && !!window.URL && typeof window.URL.createObjectURL === 'function'; }
        catch (e) { return false; }
    })();
    function thumbOf(file) {
        if (!thumbsWork) return file;
        if (tvThumbs.hasOwnProperty(file)) return tvThumbs[file] || file;
        if (file === thumbNow) return file;
        // Asked for by a page: before the ones nothing shows yet.
        var at = thumbQueue.indexOf(file);
        if (at > 0) thumbQueue.splice(at, 1);
        if (at !== 0) thumbQueue.unshift(file);
        return file;
    }
    function queueThumbs() {
        if (!thumbsWork) return;
        for (var id in tvIcons) if (tvIcons.hasOwnProperty(id) && !tvThumbs.hasOwnProperty(tvIcons[id]) && tvIcons[id] !== thumbNow && thumbQueue.indexOf(tvIcons[id]) < 0) thumbQueue.push(tvIcons[id]);
    }
    // An app that was installed again may have a new icon at the same place.
    function dropThumb(file) {
        if (!file) return;
        delete iconSeen[file];   // the image that kept the old icon loaded
        if (file === thumbNow) thumbAgain = true;
        if (!tvThumbs.hasOwnProperty(file)) return;
        if (tvThumbs[file]) { delete iconSeen[tvThumbs[file]]; try { window.URL.revokeObjectURL(tvThumbs[file]); } catch (e) {} }
        delete tvThumbs[file];
    }
    function nextThumb() {
        if (thumbBusy || !thumbQueue.length || Date.now() - lastKey < 1500 || (job && job.running)) return;
        var file = thumbQueue.shift(), img = new Image();
        function done(address) {
            thumbBusy = false; thumbNow = '';
            if (thumbAgain) {   // made from the icon as it was: once more, from the new one
                thumbAgain = false;
                if (address) { delete iconSeen[address]; try { window.URL.revokeObjectURL(address); } catch (e) {} }
                thumbQueue.unshift(file); return;
            }
            tvThumbs[file] = address || '';
            // The large original need not stay loaded once its small copy is there.
            if (address) delete iconSeen[file];
        }
        thumbBusy = true; thumbNow = file;
        img.onerror = function () { done(''); };
        img.onload = function () {
            try {
                var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, THUMB / Math.max(w, h));
                if (!(w > 0) || !(h > 0) || k === 1) return done('');
                var c = document.createElement('canvas');
                c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                c.toBlob(function (blob) {
                    if (!blob) return done('');
                    // Loaded once here, so the page shows it from its first frame (see iconSeen).
                    var address = window.URL.createObjectURL(blob), keep = new Image();
                    keep.onload = function () { iconSeen[address] = keep; done(address); };
                    keep.onerror = function () { done(''); };
                    keep.src = address;
                });
            } catch (e) { done(''); }
        };
        img.src = file;
    }
    // An icon that loaded once is shown from the first frame wherever it comes back (#126). A tile
    // starts as its letter and turns into its icon when the image has loaded, which is a frame or
    // more after the page is built: every time a page was built again (a search, a category, Show
    // all, On the TV, and back) all icons blinked from letter to icon. The images that loaded are
    // remembered by address, and a tile that is added to the page with one of those is marked
    // before the browser draws it.
    // Each of them is also held on to, as an image of its own that is in no page: after a couple of
    // minutes on another page the browser had let the icons go, and going back drew every tile empty
    // first and its icon a moment later. An image that something still holds stays loaded.
    var iconSeen = {};         // address -> the image that keeps it loaded
    document.addEventListener('load', function (e) {
        var t = e.target, src = t && t.className === 'ic' && t.getAttribute ? t.getAttribute('src') : '';
        if (!src || iconSeen.hasOwnProperty(src)) return;
        var keep = true;
        if (typeof Image === 'function') { keep = new Image(); keep.src = src; }
        iconSeen[src] = keep;
    }, true);
    if (typeof MutationObserver === 'function') new MutationObserver(function (recs) {
        recs.forEach(function (r) {
            Array.prototype.forEach.call(r.addedNodes, function (n) {
                if (n.nodeType !== 1) return;
                Array.prototype.forEach.call(n.querySelectorAll('img.ic'), function (img) {
                    if (iconSeen.hasOwnProperty(img.getAttribute('src')) && img.parentNode) img.parentNode.classList.add('has');
                });
            });
        });
    }).observe(appEl, { childList: true, subtree: true });
    function badge(cls, text) { return '<span class="badge ' + cls + '">' + esc(text) + '</span>'; }
    function subline(x) { return x.variants.length > 1 ? x.variants.length + ' variants' : (verOf(x.variants[0]) ? 'v' + verOf(x.variants[0]) : x.variants[0].file); }
    function cardBadges(x) {
        var st = state(x), b = srcBadge(x);
        if (st.installed) b += st.update ? badge('b-warn', 'Update') : badge('b-ok', 'Installed');
        if (tooNew(x)) b += badge('b-warn', 'Needs Tizen ' + lowestTizen(x));
        if (x.adult) b += badge('b-warn', '18+');
        if (x.root) b += badge('b-warn', 'root');
        if (x.partner) b += badge('b-mute', 'Partner certificate');
        if (x.needsHead) b += badge('b-mute', 'Phone or PC');
        return b;
    }
    function pinBadges(x, i) {
        var vs = variantState(x, i), v = x.variants[i], b = srcBadge(x);
        if (vs.installed) b += vs.update ? badge('b-warn', 'Update to v' + vs.latest) : badge('b-ok', 'Installed' + (haveText(vs) ? ' · ' + haveText(vs) : ''));
        else if (vs.other) b += badge('b-mute', 'Other build on the TV');
        else if (verOf(v)) b += badge('b-mute', 'v' + verOf(v));
        if (vs.installed && vs.unknown) b += badge('b-mute', 'v' + vs.latest + ' in the catalog');
        if (!fits(v)) b += badge('b-warn', 'Needs Tizen ' + v.tizen);
        if (x.adult) b += badge('b-warn', '18+');
        if (x.root) b += badge('b-warn', 'root');
        if (v.certLevel === 'partner') b += badge('b-mute', 'Partner');
        if (v.needsHead) b += badge('b-mute', 'Phone or PC');
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
        var st = state(x), b = srcBadge(x);
        if (st.installed) b += st.update ? badge('b-warn', 'Update to v' + st.latest) : badge('b-ok', 'Installed' + (haveText(st) ? ' · ' + haveText(st) : ''));
        if (st.installed && st.unknown) b += badge('b-mute', 'v' + st.latest + ' in the catalog');
        if (x.variants.length > 1) b += badge('b-mute', x.variants.length + ' variants');
        else if (verOf(x.variants[0]) && !st.installed) b += badge('b-mute', 'v' + verOf(x.variants[0]));
        if (tooNew(x)) b += badge('b-warn', 'Needs Tizen ' + lowestTizen(x));
        if (x.adult) b += badge('b-warn', '18+');
        if (x.needsHead) b += badge('b-mute', 'Phone or PC');
        return '<div class="selcard" id="selcard">' + tile(x, 110)
            + '<div class="selbody"><div class="eyebrow">Selected</div><div class="selname">' + esc(x.name) + '</div>'
            + '<div class="seldesc">' + esc(x.description || catName(x.category)) + '</div><div class="badges">' + b + '</div></div>'
            + '<div class="selok">Press OK<svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="#2DD4BF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg></div></div>';
    }

    // From (#82): one chip per source, when the TV has more than the official catalog.
    function srcChips() {
        if (!sourcesOn()) return '';
        var list = [['all', 'All sources'], ['official', 'Official']];
        sources.forEach(function (s) { if (s.manifest && s.enabled !== false) list.push([s.repositoryId, s.name || s.repositoryId]); });
        return '<div class="chips srcchips"><span class="clabel">From</span>' + list.map(function (o) {
            return '<span class="chip f' + (srcFilter === o[0] ? ' on' : '') + '" tabindex="0" data-k="src:' + esc(o[0]) + '" data-src="' + esc(o[0]) + '">' + esc(o[1]) + '</span>';
        }).join('') + '</div>';
    }
    function card(x, where) {
        return '<div class="card f' + (x.needsHead || tooNew(x) ? ' dim' : '') + '" tabindex="0" data-k="card:' + where + ':' + esc(x.key) + '" data-app="' + esc(x.key) + '">'
            + tile(x, 68) + '<div class="nm">' + esc(x.name) + '</div><div class="mt">' + esc(subline(x)) + '</div><div class="badges">' + cardBadges(x) + '</div></div>';
    }
    // A pinned build's card (#29): the build's own label and state, and OK opens the sheet on it.
    function pinCard(x, i) {
        var v = x.variants[i];
        return '<div class="card f' + (v.needsHead || !fits(v) ? ' dim' : '') + '" tabindex="0" data-k="card:pinned:' + esc(x.key) + ':' + i + '" data-app="' + esc(x.key) + '" data-vi="' + i + '">'
            + tile(x, 68, v.icon) + '<div class="nm">' + esc(x.name) + '</div><div class="mt">' + esc(x.variants.length > 1 ? v.label : (verOf(v) ? 'v' + verOf(v) : v.file)) + '</div><div class="badges">' + pinBadges(x, i) + '</div></div>';
    }

    function shead(title, n) { return '<div class="shead"><span class="t">' + esc(title) + '</span><span class="n">' + n + '</span></div>'; }
    // A row of cards with its heading, or (grid) every card of one list in lines of six. The grid's
    // heading stands above the list, not in it (shead() where the page is built): the list then
    // holds lines of cards only and moves by whole lines (#126).
    function section(id, title, list, grid, more) {
        return '<div class="sect' + (grid ? ' grid lines' : '') + '">' + (grid ? '' : '<div class="shead"><span class="t">' + esc(title) + '</span><span class="n">' + list.length + '</span>'
            + (more ? '<span class="link f" tabindex="0" data-k="more:' + id + '" data-chip="' + id + '">Show all ›</span>' : '') + '</div>')
            + '<div class="strip" data-row="' + id + '"><div class="cards">' + list.map(function (x) { return card(x, id); }).join('') + '</div></div></div>';
    }

    // The Selected card takes this place in the page as it is built: what the rest of the page is
    // built from stays the same while the focus moves from app to app.
    var SEL = '<!--selected-->';
    function showSel(html) {
        if (html === selHtml && $('selcard')) return;
        var sc = $('selcard');
        if (sc) { sc.outerHTML = html; selHtml = html; }
    }
    // Where the rows stand, to put them back after the page is built again: an install that ends
    // changes a badge, and the row under the focus should not jump back to its first card for that.
    function rowsPlace() {
        var rows = $('rows'), at = { mode: chip + '|' + query, top: 0, strips: {} };
        if (!rows) return null;
        at.top = rows.scrollTop;
        Array.prototype.forEach.call(rows.querySelectorAll('.strip'), function (s) { var id = s.getAttribute('data-row'); if (id && s.scrollLeft) at.strips[id] = s.scrollLeft; });
        return at;
    }
    function putRowsBack(at) {
        var rows = $('rows');
        if (!rows || !at || at.mode !== chip + '|' + query) return;
        Array.prototype.forEach.call(rows.querySelectorAll('.strip'), function (s) { var id = s.getAttribute('data-row'); if (id && at.strips[id]) s.scrollLeft = at.strips[id]; });
        rows.scrollTop = at.top;
    }
    // The rows of cards show as whole rows (#126): the list is as high as the rows that fit, plus the
    // heading of the next one when there is room for all of it. Left to the room there happened to be,
    // the list ended anywhere: through the next row's heading on a TV with the "From" chips, which
    // take a line of their own.
    // The cards of one category or of a search stand in lines of six, and the list is as high as the
    // lines that fit: it showed two lines and the top half of a third.
    function fitRows() {
        var rows = $('rows');
        rowsFit = 0; linesFit = 0;
        if (!rows) return;
        rows.style.maxHeight = '';
        var sects = rows.querySelectorAll('.sect');
        if (!sects.length) return;
        var pad = parseFloat(window.getComputedStyle(rows).paddingTop) || 0, room = rows.clientHeight - pad;
        if (sects.length && sects[0].classList.contains('lines')) {
            var c = sects[0].querySelector('.card'), under = c ? parseFloat(window.getComputedStyle(c).marginBottom) || 0 : 0, lp = c ? c.offsetHeight + under : 0;
            if (!(lp > 0) || !(room > 0)) return;
            linesFit = Math.max(1, Math.floor((room + under - LINE_ROOM) / lp)); linePitch = lp;
            rows.style.maxHeight = Math.round(pad + linesFit * lp - under + LINE_ROOM) + 'px';
            return;
        }
        if (sects.length < 2 || sects[0].classList.contains('grid')) return;
        var pitch = sects[1].offsetTop - sects[0].offsetTop;
        if (!(pitch > 0) || !(room > 0)) return;
        var gap = pitch - sects[0].offsetHeight, head = sects[0].querySelector('.shead'), headH = head ? head.offsetHeight : 0;
        var n = Math.max(1, Math.floor((room + gap / 2) / pitch)), left = room - n * pitch;
        rowsFit = n;
        rows.style.maxHeight = Math.round(pad + n * pitch + (headH && left >= headH + 6 ? headH + 4 : -gap / 2)) + 'px';
    }

    function renderStore() {
        var h = '', was = storeHtml, sel = '';
        storeHtml = null;
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
                + '<p>Once armed, set Host PC IP to the TV’s own address, ' + esc(ip) + ', or to 127.0.0.1, in Apps › Developer Mode. TV-Store talks to the TV through that door either way. Arm first: your phone or PC needs it pointing at them until then.</p></div></div>';
            h += section('all', 'Meanwhile, have a look around', apps, false, false);
            pageEl.innerHTML = h; return;
        }

        // TV-Store is in its own catalog: say so when a newer one is there (like Moonfin's update
        // popup, but from the signed catalog instead of the GitHub API). Not installable from here
        // (#41): the installer would stop the service doing it. Nothing to do on the TV, so the banner
        // has a Got it that hides it for that version (#43); the On the TV row and the sheet keep
        // saying it. It comes back for the next release.
        var me = self(), ms = me ? state(me) : null, selfLatest = '', selfText = '';
        if (ms && ms.update) { selfLatest = ms.latest; selfText = 'TV-Store v' + ms.latest + ' is out (this is v' + ms.version + '). ' + (selfCan(me) ? 'Find it under On the TV and press Update. ' + SELF_TRY : SELF_HOW); }
        else if (me && selfRenamed()) {
            // Installed under another package id: the platform lists this copy under that id, so
            // state() cannot see it. Compare the catalog's version with our own and send the user to
            // the head that renamed it rather than install a second TV-Store from here.
            var own = (selfInfo() || {}).version || '', latest = me.variants[0] ? me.variants[0].version : '';
            if (own && latest && newer(latest, own)) { selfLatest = latest; selfText = 'TV-Store v' + latest + ' is out (this is v' + own + '). This copy was installed under another package id by Apps2Samsung, so update it from Apps2Samsung (On the TV, Update) rather than from here.'; }
        }
        // What the store has to say goes where the greeting stands (#126): as a line of its own above
        // it, one notice took the room of a whole row of cards. Only a second one still does.
        var notes = [];
        if (selfResult) notes.push(selfResultHtml());
        // A breaking change in the catalog's format is announced 30 days ahead, so an up-to-date
        // TV-Store never sees this; one left behind keeps working on what it understands.
        if (catalogNewer) notes.push('<div class="notice bad">' + esc('The app catalog uses a newer format (version ' + catalogNewer + ') than this TV-Store understands. Update TV-Store from Apps2Samsung on a phone or PC (On the TV, Update). Until then some apps may be missing or shown wrongly; what it installs is still checked against the signed catalog.') + '</div>');
        movedGroups().forEach(function (g) {
            if (movedSeen.indexOf(g.url) >= 0) return;
            notes.push('<div class="notice row"><span>' + esc(names(g.apps) + (g.apps.length === 1 ? ' has' : ' have') + ' moved to ' + (g.source ? '\u2018' + g.source.name + '\u2019' : 'the developer\u2019s own repository at ' + g.domain) + '. The official catalog stops updating ' + (g.apps.length === 1 ? 'it' : 'them') + ' soon. ' + (g.source ? 'Take the updates from there to keep getting them.' : 'Add that repository to keep getting updates.')) + '</span>'
                + '<button class="btn f" data-k="movedadd:' + esc(g.url) + '" data-act="movedadd" data-url="' + esc(g.url) + '" data-fp="' + esc(g.fingerprint) + '" data-name="' + esc(g.apps[0].name) + '">' + (g.source ? 'Take updates from there' : 'Add source') + '</button>'
                + '<button class="btn f" data-k="movedlater:' + esc(g.url) + '" data-act="movedlater" data-url="' + esc(g.url) + '">Not now</button></div>');
        });
        if (selfLatest && settings.hideSelfNotice !== selfLatest)
            notes.push('<div class="notice row"><span>' + esc(selfText) + '</span><button class="btn f" data-k="dismissself" data-act="dismissself" data-v="' + esc(selfLatest) + '">Got it</button></div>');
        var lead = !query && notes.length ? notes.shift() : '';
        h += notes.join('');

        if (!hover || apps.indexOf(hover) < 0) hover = apps[0] || null;
        // The Selected card stays put (with the greeting and the chips) and the rows scroll under it,
        // so the description of the app under the remote always shows.
        if (!query) {
            h += '<div class="hero"><div class="greet">' + (lead || '<h1>' + greeting() + '</h1><p>Everything here installs straight onto this TV. Pick an app, press OK, and it shows up in your Apps row in about a minute.</p>') + '</div>' + SEL + '</div>';
            sel = selCard(hover);
            var cats = CATEGORY_ORDER.filter(function (c) { return apps.some(function (x) { return x.category === c; }); });
            h += '<div class="chips"><span class="chip f' + (chip === 'all' ? ' on' : '') + '" tabindex="0" data-k="chip:all" data-chip="all">All</span>'
                + cats.map(function (c) { return '<span class="chip f' + (chip === c ? ' on' : '') + '" tabindex="0" data-k="chip:' + c + '" data-chip="' + c + '">' + esc(catName(c)) + '</span>'; }).join('') + '</div>';
            var open = '<div class="fade"></div><div class="rows vscroll" id="rows">';
            h += srcChips();
            if (chip === 'all') {
                h += open;
                var pinnedNow = pinned(), vetro = vetroOnTv();
                if (pinnedNow.length || vetro) h += '<div class="sect"><div class="shead"><span class="t">Pinned</span><span class="n">' + (pinnedNow.length + (vetro ? 1 : 0)) + '</span>'
                    + '<span class="hintline">Pin an app from its page, or from On the TV</span></div>'
                    + '<div class="strip" data-row="pinned"><div class="cards">' + (vetro ? vetroCard() : '') + pinnedNow.map(function (p) { return pinCard(p.app, p.v); }).join('') + '</div></div></div>';
                cats.forEach(function (c) {
                    var list = apps.filter(function (x) { return x.category === c; });
                    h += section(c, catName(c), list, false, list.length > 6);
                });
            } else {
                var inChip = apps.filter(function (x) { return x.category === chip; });
                h += shead(catName(chip), inChip.length) + open + section(chip, '', inChip, true, false);
            }
        } else {
            // Name, description or developer (the heads match the author too since Apps2Samsung #906).
            var q = query.toLowerCase();
            var found = apps.filter(function (x) { return x.name.toLowerCase().indexOf(q) >= 0 || (x.description || '').toLowerCase().indexOf(q) >= 0 || (x.author || '').toLowerCase().indexOf(q) >= 0; });
            if (found.length && found.indexOf(hover) < 0) hover = found[0];
            h += '<div class="hero"><div class="greet"><h1>Search</h1><p>' + esc(found.length ? found.length + (found.length === 1 ? ' app matches' : ' apps match') + ' \u201c' + query + '\u201d, by name, description or developer.' : 'Nothing matches \u201c' + query + '\u201d.') + '</p></div>' + SEL + '</div>'
                + (found.length ? shead('Results for “' + query + '”', found.length) : '') + '<div class="fade"></div><div class="rows vscroll" id="rows">';
            sel = selCard(found.length ? hover : null);
            // Apps the catalog took out (#87) answer too, after the results, without an install.
            var gq = goneMatches(q);
            h += found.length ? section('search', '', found, true, false)
                : gq.length ? '' : '<div class="empty">Nothing in the catalog matches “' + esc(query) + '”.</div>';
            if (gq.length) h += '<div class="sect grid"><div class="shead"><span class="t">No longer in the catalog</span><span class="n">' + gq.length + '</span></div>'
                + '<div class="strip"><div class="cards">' + gq.map(goneCard).join('') + '</div></div></div>';
        }
        if (!apps.length) h += srcFilter !== 'all' && !query ? '<div class="empty">' + esc(sourceName(srcFilter) + ' has no apps to show here.') + '</div>' : '<div class="empty">No apps to show. The gear at the top has the Settings.</div>';
        // Room after the last row, so it can stand where every other row stands.
        h += (!query && chip === 'all' ? '<div class="rowsend"></div>' : '') + '</div>';
        // Nothing but the app under the focus differs from what the page shows: the page stays as
        // it is. Building it again for every sheet that closes drew every icon anew and put the rows
        // back at their start (#126).
        if (h === was && $('rows')) { storeHtml = h; showSel(sel); return; }
        var at = was === null ? null : rowsPlace();
        storeHtml = h; selHtml = sel;
        pageEl.innerHTML = h.replace(SEL, function () { return sel; });
        fitRows();
        putRowsBack(at);
    }

    function goneCard(g) {
        return '<div class="card f dim" tabindex="0" data-k="card:gone:' + esc(g.key) + '" data-gone="' + esc(g.key) + '">'
            + tile(g, 68) + '<div class="nm">' + esc(g.name) + '</div><div class="mt">' + esc(g.pkg ? 'On this TV' : catName(g.category)) + '</div><div class="badges">' + badge('b-warn', 'Removed') + '</div></div>';
    }

    // ---- the TV's own list of its apps, and removing one (#142) -------------------------------------
    // The service reads the list over the TV's developer connection (GET /tvapps): every app, also
    // the ones that are not in the catalog and the ones that came with the TV, each with its size and
    // the TV's own word on whether it can be removed. Removing goes the same way (POST /uninstall).
    var tvApps = null;         // [{ id, title, version, installed, size, removable }], null until read
    var tvAppsError = null;    // why it could not be read
    var tvAppsAt = 0, tvAppsAsking = false;
    function loadTvApps(force) {
        // A list that was read is good for a minute; one that could not be read is asked for again.
        if (tvAppsAsking || (!force && tvApps && !tvAppsError && Date.now() - tvAppsAt < 60000)) return;
        tvAppsAsking = true;
        xhr('GET', '/tvapps', null, function (err, res) {
            tvAppsAsking = false; tvAppsAt = Date.now();
            if (err || !res || !res.ok || !Array.isArray(res.apps)) tvAppsError = err ? err.message : (res && res.error) || 'the service sent no list';
            else { tvApps = res.apps; tvAppsError = null; }
            if (view !== 'tv' || sheet) return;
            var at = document.activeElement && document.activeElement.getAttribute('data-k');
            renderPage();
            if (document.activeElement !== searchEl) focusKey(at) || focusFirst();
        }, null, 45000);
    }
    // While TV-Store installs, the TV's developer connection is taken and the list cannot be read
    // (the service answers BUSY). When the install is over, the page that said so asks again.
    function tvAppsAgain() { if (view === 'tv' && tvAppsError) loadTvApps(true); }
    function sizeText(bytes) { return !(bytes > 0) ? '' : bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : bytes < 1073741824 ? (bytes / 1048576).toFixed(1) + ' MB' : (bytes / 1073741824).toFixed(1) + ' GB'; }
    // The package an app of the TV's list is in: `AbCdEfGhIj.App` is in `AbCdEfGhIj`, an app that
    // came with the TV (`org.tizen.netflix-app`) is its own.
    function tvAppPkg(id) { var m = /^([A-Za-z0-9]{10})\.[^.]+$/.exec(id); return m ? m[1] : id; }
    function tvAppOf(pkg) {
        var list = tvApps || [];
        for (var i = 0; i < list.length; i++) if (list[i].id === pkg || tvAppPkg(list[i].id) === pkg) return list[i];
        return null;
    }
    // What the TV has besides the catalog's apps: the ones it lets go first, then its own.
    function otherOnTv() {
        var own = (selfInfo() || {}).packageId || '', gone = {}, out = [];
        goneOnTv().forEach(function (g) { gone[g.pkg] = true; });
        (tvApps || []).forEach(function (a) {
            var p = tvAppPkg(a.id);
            if (p === own || claimOf(p) || gone[p]) return;
            out.push({ key: 'tvapp:' + a.id, other: true, id: a.id, name: a.title || a.id, category: 'other', version: a.version, size: a.size, installed: a.installed, removable: a.removable, appId: appIds.hasOwnProperty(a.id) ? a.id : '' });
        });
        return out.sort(function (a, b) { return a.removable !== b.removable ? (a.removable ? -1 : 1) : byName(a, b); });
    }
    function otherRow(o) {
        return '<div class="lrow f" tabindex="0" data-k="tv:' + esc(o.key) + '" data-tvapp="' + esc(o.key) + '">' + tile(o, 66)
            + '<div class="txt"><div class="nm">' + esc(o.name) + '</div><div class="mt">' + esc([o.version ? 'v' + o.version : '', sizeText(o.size)].filter(Boolean).join(' · ') || o.id) + '</div></div>'
            + (o.removable ? '' : badge('b-mute', 'Built in')) + CHEV + '</div>';
    }
    function otherPanel(o) {
        return '<div class="panel" id="tvpanel"><div class="phead">' + tile(o, 96) + '<div style="min-width:0"><div class="nm">' + esc(o.name) + '</div><div class="mt">' + esc(o.id) + '</div></div></div>'
            + '<div class="table kv" style="margin-top:0">'
            + (o.version ? '<div class="trow"><span class="k">Installed</span><span class="v">v' + esc(o.version) + '</span></div>' : '')
            + (sizeText(o.size) ? '<div class="trow"><span class="k">Size</span><span class="v">' + sizeText(o.size) + '</span></div>' : '')
            + (o.installed ? '<div class="trow"><span class="k">On this TV since</span><span class="v">' + esc(o.installed.slice(0, 10)) + '</span></div>' : '')
            + '<div class="trow"><span class="k">In the catalog</span><span class="v">No</span></div></div>'
            + '<div class="btns" style="margin-top:18px">' + (o.appId ? '<button class="btn f" data-k="tvappopen" data-act="tvappopen">Open</button>' : '')
            + '<button class="btn grow danger f" data-k="tvremove" data-act="tvremove">Uninstall</button></div>'
            + '<div class="hint" style="text-align:left">' + esc(o.removable ? o.name + ' is not in the catalog, so TV-Store cannot install it again.' : 'The TV lists ' + o.name + ' as one of its own apps. It may not let it go.') + '</div></div>';
    }
    // What Uninstall on the On the TV page is about: the selected row, whichever kind it is.
    function removeTarget() {
        var x = tvSel, a;
        if (!x) return null;
        if (x.other) return { id: x.id, name: x.name, tile: x, removable: x.removable, size: x.size, back: false };
        if (x.gone) { a = tvAppOf(x.pkg); return x.pkg ? { id: a ? a.id : x.pkg, name: x.name, tile: x, removable: a ? a.removable : true, size: a ? a.size : 0, back: false } : null; }
        if (isSelf(x)) return null;
        var v = x.variants[state(x).variant], pkg = tvPkg(v);
        a = tvAppOf(pkg);
        return pkg ? { id: a ? a.id : pkg, name: x.name, tile: x, icon: v.icon, removable: a ? a.removable : true, size: a ? a.size : 0, back: true } : null;
    }
    function removeHtml() {
        var t = sheet.target, st = sheet.state;
        var h = '<div class="shd">' + tile(t.tile, 88, t.icon) + '<div style="min-width:0"><div class="nm">' + esc(t.name) + '</div><div class="mt">' + esc(t.id + (sizeText(t.size) ? ' · ' + sizeText(t.size) : '')) + '</div></div></div>';
        if (st === 'busy') return h + '<div class="waiting"><span class="spin"></span>' + esc('Removing ' + t.name + ' from this TV…') + '</div><div class="sfoot"><div class="hint">This takes a few seconds.</div></div>';
        if (st === 'done') return h + '<div class="notice info">' + esc(t.name + (sheet.already ? ' was no longer on this TV.' : ' is off this TV.') + (!sheet.already && sizeText(t.size) ? ' That frees ' + sizeText(t.size) + '.' : '')) + '</div>'
            + '<div class="sfoot"><div class="btns"><button class="btn grow f" data-k="close" data-act="close" data-default>Back</button></div><div class="hint">RETURN goes back.</div></div>';
        h += '<div class="sdesc">' + esc('Uninstall ' + t.name + ' from this TV? The app goes, with everything it keeps on the TV: sign-ins, settings and downloads.') + '</div>';
        if (!t.removable) h += '<div class="notice">' + esc('The TV lists ' + t.name + ' as one of its own apps. It may refuse to remove it. If it does remove it, TV-Store cannot put it back: it would have to come from the TV\u2019s own Apps store again.') + '</div>';
        else h += '<div class="notice info">' + esc(t.back ? 'You can install it again from the store.' : t.name + ' is not in the catalog, so TV-Store cannot install it again.') + '</div>';
        if (st === 'failed') h += '<div class="notice bad">' + esc(sheet.error) + '</div>';
        return h + '<div class="sfoot"><div class="btns"><button class="btn grow danger f" data-k="removeyes" data-act="removeyes">' + (st === 'failed' ? 'Try again' : 'Uninstall') + '</button>'
            + '<button class="btn f" data-k="close" data-act="close" data-default>Cancel</button></div><div class="hint">RETURN goes back without removing anything.</div></div>';
    }
    function askRemove() {
        var t = removeTarget();
        if (t) openSheet({ mode: 'remove', target: t, state: 'ask' });
    }
    function doRemove() {
        var me = sheet;
        if (!me || me.mode !== 'remove' || me.state === 'busy') return;
        if (job && job.running) { me.state = 'failed'; me.error = 'TV-Store is installing ' + job.app.name + ' right now. Try again when that is done.'; renderSheet(); focusKey('close'); return; }
        me.state = 'busy'; renderSheet();
        // The token fresh from the service's folder, as before an upload's install: a service that
        // started again has a new one.
        withUploadToken(function () {
            xhr('POST', '/uninstall', { token: uploadToken, id: me.target.id }, function (err, res) {
                var ok = !err && res && res.ok;
                me.state = ok ? 'done' : 'failed';
                me.already = !!(ok && res.result && res.result.already);
                me.error = ok ? null : err ? err.message : (res && res.error) || 'the service gave no reason';
                if (!ok && res && res.code === 'NO_TOKEN') me.error = 'TV-Store\u2019s screen could not show its service that it is the one asking' + (uploadTokenError ? ' (' + uploadTokenError + ')' : '') + '. Close TV-Store, open it again and try once more.';
                // What the platform lists now, and the TV's own list again: the row goes.
                readInstalled(function (map) {
                    setInstalled(map);
                    if (ok && tvApps) tvApps = tvApps.filter(function (a) { return a.id !== me.target.id && tvAppPkg(a.id) !== me.target.id; });
                    // The row is gone: back from the sheet goes to the list, not to the next app's Uninstall.
                    if (ok) { tvSel = null; returnFocus = null; }
                    renderHeader(); pushStore();
                    if (sheet === me) { renderSheet(true); if (!ok) focusKey('close'); }
                    else { toast(ok ? me.target.name + ' is off this TV.' : 'Could not remove ' + me.target.name + ': ' + me.error); if (!sheet) { renderPage(); focusFirst(); } }
                    loadTvApps(true);
                });
            }, null, 120000);
        });
    }

    // ---- On the TV (C6) -----------------------------------------------------------------------------
    function goneRow(g) {
        return '<div class="lrow f" tabindex="0" data-k="tv:' + esc(g.key) + '" data-gone="' + esc(g.key) + '">' + tile(g, 66)
            + '<div class="txt"><div class="nm">' + esc(g.name) + '</div><div class="mt">' + esc((installed[g.pkg] ? 'v' + installed[g.pkg] + ' · ' : '') + 'no more updates') + '</div></div>'
            + badge('b-warn', 'Removed') + CHEV + '</div>';
    }
    function gonePanel(g) {
        var h = '<div class="panel" id="tvpanel"><div class="phead">' + tile(g, 96) + '<div style="min-width:0"><div class="nm">' + esc(g.name) + '</div><div class="mt">' + esc(catName(g.category) + (g.appId ? ' · ' + g.appId : '')) + '</div></div></div>'
            + '<div class="table kv" style="margin-top:0"><div class="trow"><span class="k">Installed</span><span class="v">' + esc(installed[g.pkg] ? 'v' + installed[g.pkg] : 'Yes') + '</span></div>'
            + '<div class="trow"><span class="k">In the catalog</span><span class="v" style="color:#F0A020">' + esc(g.since ? 'Removed on ' + g.since : 'Removed') + '</span></div></div>'
            + '<div class="btns" style="margin-top:18px"><button class="btn grow f" data-k="gonesheet" data-act="gonesheet">Details</button>'
            + (g.appId ? '<button class="btn f" data-k="goneopen" data-act="goneopen">Open</button>' : '')
            + (g.pkg ? '<button class="btn danger f" data-k="tvremove" data-act="tvremove">Uninstall</button>' : '') + '</div>'
            + '<div class="hint" style="text-align:left">' + esc(removedWhy(g)) + '</div>';
        return h + '</div>';
    }
    function goneHtml() {
        var g = sheet.entry;
        var h = '<div class="shd">' + tile(g, 88) + '<div style="min-width:0"><div class="nm">' + esc(g.name) + '</div><div class="mt">' + esc(catName(g.category) + (g.since ? ' · removed from the catalog on ' + g.since : ' · removed from the catalog')) + '</div></div></div>';
        h += '<div class="badges">' + badge('b-warn', 'Removed') + (g.pkg ? badge('b-ok', 'On this TV' + (installed[g.pkg] ? ' · v' + installed[g.pkg] : '')) : '') + '</div>';
        h += '<div class="notice">' + esc(removedWhy(g)) + '</div>';
        if (g.note) h += '<div class="sdesc">' + esc(g.note) + '</div>';
        if (g.pkg) h += '<div class="notice info">' + esc(REMOVED_KEEPS) + '</div>';
        h += '<div class="sfoot"><div class="btns">' + (g.appId ? '<button class="btn primary grow f" data-k="goneopen" data-act="goneopen" data-default>Open</button><button class="btn f" data-k="close" data-act="close">Back</button>'
            : '<button class="btn grow f" data-k="close" data-act="close" data-default>Back</button>') + '</div><div class="hint">RETURN goes back.</div></div>';
        return h;
    }
    function tvRow(x) {
        var st = state(x), v = x.variants[st.variant];
        var inCat = ' in ' + (x.source === 'official' ? 'the catalog' : x.sourceName);
        var mt = st.update ? 'v' + st.version + ' installed · v' + st.latest + inCat : (st.unknown ? 'Version not known · v' + st.latest + inCat : 'v' + (st.version || v.version)) + (x.variants.length > 1 ? ' · ' + (st.known ? v.label : 'variant not known') : '') + (sourcesOn() ? ' · ' + x.sourceName : '');
        return '<div class="lrow f" tabindex="0" data-k="tv:' + esc(x.key) + '" data-app="' + esc(x.key) + '">' + tile(x, 66)
            + '<div class="txt"><div class="nm">' + esc(x.name) + '</div><div class="mt">' + esc(mt) + '</div></div>'
            + (isPinned(x, st.variant) ? badge('b-pin', 'Pinned') : '') + (st.update ? badge('b-warn', 'Update') : st.unknown ? badge('b-mute', 'Version not known') : badge('b-ok', 'Up to date')) + CHEV + '</div>';
    }

    // What the page lists besides the catalog's apps, as it was last built: focus() looks a row up
    // in these. It asked for both lists again at every step of the remote, which goes through
    // every app on the TV and every app in the catalog (#126: moving through the other apps lagged).
    var tvGoneNow = [], tvOtherNow = [];
    function tvRowOf(list, key) { for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i]; return null; }
    function renderTv() {
        // The search box on this page searches this page (#126): the apps on the TV, by name (and
        // by description or developer for the catalog's, by id for the others). It used to jump to
        // the store and search the catalog.
        var q = query.toLowerCase();
        function has(text) { return String(text || '').toLowerCase().indexOf(q) >= 0; }
        var every = onTv(), everyGone = goneOnTv(), everyOther = otherOnTv();
        tvGoneNow = everyGone; tvOtherNow = everyOther;
        var all = !q ? every : every.filter(function (x) { return has(x.name) || has(x.description) || has(x.author); });
        var ups = all.filter(function (x) { return state(x).update; }), ok = all.filter(function (x) { return !state(x).update; });
        var gone = !q ? everyGone : everyGone.filter(function (g) { return has(g.name); });
        var other = !q ? everyOther : everyOther.filter(function (o) { return has(o.name) || has(o.id); });
        var mine = other.filter(function (o) { return o.removable; }), builtIn = other.filter(function (o) { return !o.removable; });
        if (tvSel && tvSel.gone) tvSel = gone.filter(function (g) { return g.key === tvSel.key; })[0] || null;
        if (tvSel && tvSel.other) tvSel = other.filter(function (o) { return o.key === tvSel.key; })[0] || null;
        // TV-Store itself updates from a head (#41); an app that needs a certificate level this TV lacks waits too (#50).
        var doable = ups.filter(function (x) { var s = state(x), uv = x.variants[s.variant]; return !isSelf(x) && !signPlan(uv).missing && !settingsBlock(x, uv, s); });
        if (!tvSel || (!tvSel.gone && !tvSel.other && all.indexOf(tvSel) < 0)) tvSel = ups[0] || ok[0] || gone[0] || mine[0] || builtIn[0] || null;
        var found = all.length + gone.length + other.length;
        var h = '<div class="tvtop"><div><h1>Your apps</h1><p>' + (q
            ? esc(found ? found + (found === 1 ? ' app on this TV matches' : ' apps on this TV match') + ' \u201c' + query + '\u201d. RETURN shows them all again.' : 'Nothing on this TV matches \u201c' + query + '\u201d.')
            : (all.length
                ? all.length + (all.length === 1 ? ' catalog app is' : ' catalog apps are') + ' on this TV. ' + (ups.length ? (ups.length === 1 ? 'One has' : ups.length + ' have') + ' a newer version in the catalog.' : 'All up to date.')
                : 'No apps from the catalog on this TV yet.') + (gone.length ? ' ' + (gone.length === 1 ? 'One app here was' : gone.length + ' apps here were') + ' removed from the catalog.' : '')
              + (other.length ? ' ' + (other.length === 1 ? 'One other app is' : other.length + ' other apps are') + ' listed below.' : '')) + '</p></div>';
        // Not while searching: Update all is about every update, not about the ones the search shows.
        if (doable.length && armed() && !q) h += '<button class="btn primary f" data-k="updall" data-act="updall">' + (doable.length === 1 ? 'Update ' + esc(doable[0].name) : doable.length === 2 ? 'Update both' : 'Update all ' + doable.length) + '</button>';
        h += '</div>';
        // The TV's own list could not be read: the catalog's apps still show, from what the platform lists.
        // Above the list (#126): at its end the note stood below the last app, where nothing takes
        // the focus, so with more apps than fit it was cut off by the bottom of the screen and the
        // reason at its end could not be read.
        var listNote = tvAppsError ? '<div class="notice">' + esc('The TV\u2019s own list of apps could not be read, so the apps that are not in the catalog do not show here. ' + tvAppsError) + '</div>' : '';
        h += listNote;
        if (!found) { tvHtml = null; pageEl.innerHTML = h + '<div class="empty">' + (q ? 'RETURN shows every app on this TV again.' : 'Install something from the store and it shows up here, with its updates.') + '</div>'; return; }
        h += '<div class="tvcols"><div class="tvlist vscroll">';
        if (ups.length) h += '<div class="glabel warn">Updates<span class="n">' + ups.length + '</span></div><div class="group">' + ups.map(tvRow).join('') + '</div>';
        if (ok.length) h += '<div class="glabel">Up to date<span class="n">' + ok.length + '</span></div><div class="group">' + ok.map(tvRow).join('') + '</div>';
        if (gone.length) h += '<div class="glabel warn">Removed from the catalog<span class="n">' + gone.length + '</span></div><div class="group">' + gone.map(goneRow).join('') + '</div>';
        if (mine.length) h += '<div class="glabel">Other apps<span class="n">' + mine.length + '</span></div><div class="group">' + mine.map(otherRow).join('') + '</div>';
        if (builtIn.length) h += '<div class="glabel">Built into the TV<span class="n">' + builtIn.length + '</span></div><div class="group">' + builtIn.map(otherRow).join('') + '</div>';
        var panel = tvPanel(tvSel);
        h += '</div><div class="tvpanel"><div class="glabel">Selected</div>' + PANEL + '</div></div>';
        // Nothing but the selected app's panel differs from what the page shows: the page stays as
        // it is, like the store (#126). Built again for every sheet that closed, the list drew
        // every icon anew.
        if (h === tvHtml && pageEl.querySelector('.tvlist')) { showPanel(panel); return; }
        tvHtml = h; panelHtml = panel;
        pageEl.innerHTML = h.replace(PANEL, function () { return panel; });
    }

    // The selected app's panel takes this place in the On the TV page as it is built.
    var PANEL = '<!--panel-->', panelHtml = '';
    function showPanel(html) {
        var tp = $('tvpanel');
        if (!tp || (html === panelHtml)) return;
        tp.outerHTML = html; panelHtml = html;
    }
    function tvPanel(x) {
        if (!x) return '';
        if (x.gone) return gonePanel(x);
        if (x.other) return otherPanel(x);
        var st = state(x), v = x.variants[st.variant];
        var h = '<div class="panel" id="tvpanel"><div class="phead">' + tile(x, 96, v.icon) + '<div style="min-width:0"><div class="nm">' + esc(x.name) + '</div><div class="mt">' + esc(catName(x.category) + (v.appId ? ' · ' + v.appId : '')) + '</div></div></div>'
            + '<div class="table kv" style="margin-top:0"><div class="trow"><span class="k">Installed</span><span class="v">' + esc(st.unknown ? 'Not known' : 'v' + st.version) + '</span></div>'
            + (sourcesOn() ? '<div class="trow"><span class="k">Source</span><span class="v">' + esc(x.sourceName) + '</span></div>' : '')
            + '<div class="trow"><span class="k">' + (x.source === 'official' ? 'In the catalog' : 'In ' + esc(x.sourceName)) + '</span><span class="v"' + (st.update ? ' style="color:#F0A020"' : '') + '>v' + esc(st.latest || v.version) + '</span></div>'
            + (x.variants.length > 1 ? '<div class="trow"><span class="k">Variant</span><span class="v">' + esc(st.known ? v.label + (st.byPin ? ' · pinned' : '') : 'Not known: the builds share one package') + '</span></div>' : '') + '</div>'
            + '<div class="btns" style="margin-top:18px">';
        if (st.update && st.known && !v.needsHead && fits(v) && (!isSelf(x) || selfCan(x)) && armed() && !signPlan(v).missing && !settingsBlock(x, v, st)) h += '<button class="btn primary grow f" data-k="tvupd" data-act="tvupd">Update</button>';
        else h += '<button class="btn grow f" data-k="tvsheet" data-act="tvsheet">Details</button>';
        if (v.appId) h += '<button class="btn f" data-k="tvopen" data-act="tvopen">Open</button>';
        // Pin (#102): the build on the TV goes to the Pinned row on the home screen too.
        h += '<button class="btn f" data-k="tvpin" data-act="tvpin">' + (isPinned(x, st.variant) ? 'Unpin' : 'Pin') + '</button>';
        // Uninstall (#142). Not TV-Store itself: the service doing it would go with the app.
        if (!isSelf(x)) h += '<button class="btn danger f" data-k="tvremove" data-act="tvremove">Uninstall</button>';
        h += '</div>';
        var mvp = movedInfo(x);
        if (mvp && !mvp.done) h += '<div class="hint" style="text-align:left">' + esc(x.name + ' moved to ' + (mvp.source ? '\u2018' + mvp.source.name + '\u2019' : mvp.domain) + '. Open Details to keep getting its updates.') + '</div>';
        else if (st.update && isSelf(x)) h += '<div class="hint" style="text-align:left">' + esc(selfCan(x) ? SELF_TRY : SELF_HOW) + '</div>';
        else if (st.update && v.needsHead) h += '<div class="hint" style="text-align:left">' + esc(x.name + ' ' + v.needsHead + ': update it with Apps2Samsung on a phone or PC.') + '</div>';
        else if (st.update && settingsBlock(x, v, st)) h += '<div class="hint" style="text-align:left">' + esc(settingsBlock(x, v, st) + ' Open Details for how to fill them in.') + '</div>';
        else if (!st.known && x.variants.length > 1) h += '<div class="hint" style="text-align:left">' + esc('TV-Store cannot tell which build of ' + x.name + ' this is: the builds share one package. Open Details, pick your build and pin it; the pinned build is the one that gets updated.') + '</div>';
        else if (st.unknown) h += '<div class="hint" style="text-align:left">' + esc(WEB_UNKNOWN) + '</div>';
        return h + '</div>';
    }

    function renderPage() {
        renderHeader();
        if (view === 'tv') { storeHtml = null; renderTv(); } else { tvHtml = null; renderStore(); }
    }

    // ---- the sheet (C2, C3, C4, Settings) --------------------------------------------------------
    function openSheet(s) {
        if (!sheet) returnFocus = document.activeElement && document.activeElement.getAttribute('data-k');
        sheet = s; renderSheet(true);
    }
    function closeSheet(then) {
        if (sheet && sheet.mode === 'backup') endBackupOffer();
        sheet = null; confirmingAdult = false; certSel = null; certConfirm = false; certError = null; srcSel = null; srcConfirm = false; srcError = null;
        sheetEl.className = 'sheet'; sheetEl.innerHTML = ''; appEl.className = 'app';
        if (then) return then();
        renderPage(); focusKey(returnFocus) || focusFirst();
    }
    // Searches the store for `text` as if typed in the search box: the developer link in the sheet
    // lands on every app by that developer (Apps2Samsung #906 does the same on the phone and PC).
    function searchFor(text) {
        query = text; searchEl.value = text; view = 'install'; chip = 'all';
        renderPage(); focusFirst();
    }

    function renderSheet(focusDefault) {
        if (!sheet) return;
        var keep = !focusDefault && document.activeElement && document.activeElement.getAttribute('data-k');
        appEl.className = 'app behind'; sheetEl.className = 'sheet on';
        if (sheet.mode === 'settings') sheetEl.innerHTML = settingsHtml();
        else if (sheet.mode === 'job') sheetEl.innerHTML = job && job.finished && job.ok ? doneHtml() : jobHtml();
        else if (sheet.mode === 'upload') sheetEl.innerHTML = uploadHtml();
        else if (sheet.mode === 'source') sheetEl.innerHTML = sourceHtml();
        else if (sheet.mode === 'gone') sheetEl.innerHTML = goneHtml();
        else if (sheet.mode === 'remove') sheetEl.innerHTML = removeHtml();
        else if (sheet.mode === 'backup') sheetEl.innerHTML = backupHtml();
        else if (sheet.mode === 'restore') sheetEl.innerHTML = restoreHtml();
        else sheetEl.innerHTML = appHtml();
        if (!(keep && focusKey(keep))) {
            var d = sheetEl.querySelector('[data-default]') || sheetEl.querySelector('.f:not([disabled])');
            if (d) focus(d);
        }
    }

    function appHtml() {
        var x = sheet.app, st = state(x), v = x.variants[sheet.v];
        // The developer's name is a link: OK shows every app by them (#29, Apps2Samsung #906).
        var h = '<div class="shd">' + tile(x, 88, v.icon) + '<div style="min-width:0"><div class="nm">' + esc(x.name) + '</div><div class="mt">' + esc(catName(x.category)) + (sourcesOn() || x.source !== 'official' ? esc(' · from ' + (x.source === 'official' ? 'the official catalog' : x.sourceName)) : '')
            + (x.author ? ' · <span class="by f" tabindex="0" data-k="author" data-act="author" title="All apps by ' + esc(x.author) + '">by ' + esc(x.author) + ' ›</span>' : '') + '</div></div></div>';
        if (x.description) h += '<div class="sdesc">' + esc(x.description) + '</div>';
        var b = '';
        if (st.installed) b += badge('b-ok', 'Installed' + (haveText(st) ? ' · ' + haveText(st) : ''));
        if (st.update) b += badge('b-warn', 'Update to v' + st.latest);
        else if (st.installed && st.unknown) b += badge('b-mute', 'v' + st.latest + ' in the catalog');
        if (x.adult) b += badge('b-warn', 'Adults only (18+)');
        if (x.root) b += badge('b-warn', 'Gains root on the TV');
        if (v.tizen) b += badge(fits(v) ? 'b-mute' : 'b-warn', 'Tizen ' + v.tizen + ' or newer');
        if (v.certLevel === 'partner') b += badge(levelsHeld().partner ? 'b-mute' : 'b-warn', 'Partner certificate');
        if (b) h += '<div class="badges">' + b + '</div>';

        if (x.variants.length > 1) {
            var shown = x.variants.map(function (vv, i) { return i; });
            if (!sheet.all && x.variants.length > 4) shown = sheet.v < 4 ? [0, 1, 2, 3] : [0, 1, 2, sheet.v];
            h += '<div class="vhead"><span class="t">Variant</span><span class="h">Pick the build for your set</span></div><div class="vbox"><div class="vscroll" id="vscroll">'
                + shown.map(function (i) {
                    var vv = x.variants[i], inst = st.installed && st.known && st.variant === i;
                    return '<div class="var f' + (i === sheet.v ? ' sel' : '') + '" tabindex="0" data-k="var:' + i + '" data-var="' + i + '"' + (i === sheet.v ? ' data-default' : '') + '>'
                        + '<span class="radio"></span><span class="vl">' + esc(vv.label) + '</span>'
                        + (inst ? badge('b-ok', 'on the TV') : '') + (isPinned(x, i) ? badge('b-pin', 'Pinned') : '') + (vv.needsHead ? badge('b-mute', 'Phone or PC') : '') + (fits(vv) ? '' : badge('b-warn', 'Needs Tizen ' + vv.tizen)) + (vv.certLevel === 'partner' ? badge('b-mute', 'Partner') : '')
                        + '<span class="vv">' + esc(verOf(vv) ? 'v' + verOf(vv) : '') + '</span></div>';
                }).join('') + '</div></div>';
            if (!sheet.all && x.variants.length > 4) h += '<span class="link f" tabindex="0" data-k="allvars" data-act="allvars">Show all ' + x.variants.length + ' variants ›</span>';
        }

        var label = st.installed && st.known && st.variant === sheet.v ? (st.update ? 'Update to v' + verOf(v) : 'Reinstall') : (st.installed ? 'Install this variant' : 'Install on this TV');
        // The same package came from another source (#82): installing this copy moves the app here,
        // and the button says so; that press is the explicit yes the service wants.
        var elsewhere = heldElsewhere(x, v);
        if (elsewhere) label = 'Install from ' + x.sourceName + ' instead';
        var me = isSelf(x) && !selfCan(x), plan = signPlan(v);
        if (!me && fits(v) && !v.needsHead && armed()) h += signWithHtml(v, plan);
        if (me) h += '<div class="notice">' + SELF_HOW + '</div>';
        else if (isSelf(x)) h += '<div class="notice">' + esc(SELF_TRY) + '</div>';
        else if (!fits(v)) h += '<div class="notice">' + esc(x.name + (x.variants.length > 1 ? ' (' + v.label + ')' : '') + ' asks for Tizen ' + v.tizen + ' or newer, and this TV runs Tizen ' + tvTizen + '. The TV would refuse it' + (x.variants.some(fits) ? ', so pick a build above that fits this set.' : '.')) + '</div>';
        else if (v.needsHead) h += '<div class="notice">' + esc(x.name + ' ' + v.needsHead + ', which this TV cannot do yet. Install it with Apps2Samsung on a phone or PC.') + '</div>';
        else if (!armed()) h += '<div class="notice">Not armed yet. Open this TV’s Toolbox in Apps2Samsung 3.0 or newer on your phone or PC and press Arm TV-Store once; after that every install runs here.</div>';
        else if (plan.missing) h += '<div class="notice">' + esc(missingLevelText(x.name, plan)) + '</div>';
        var setBlock = !me && fits(v) && !v.needsHead ? settingsBlock(x, v, st) : '';
        if (!me && fits(v) && !v.needsHead) h += appSettingsHtml(x, v, st);
        if (elsewhere && !me) h += '<div class="notice">' + esc(x.name + ' on this TV' + (v.webVersion ? '' : ' (v' + installed[tvPkg(v)] + ')') + ' came from ' + elsewhere + '. Installing this copy from ' + x.sourceName + ' replaces it, and its updates come from ' + x.sourceName + ' from then on.') + '</div>';
        var mv = movedInfo(x);
        if (mv && !mv.done) h += '<div class="notice row"><span>' + esc('The developer moved ' + x.name + ' to ' + (mv.source ? '\u2018' + mv.source.name + '\u2019' : 'their own repository at ' + mv.domain) + '. The official catalog stops updating it soon. ' + (st.installed ? (mv.source ? 'Take its updates from there.' : 'Add that repository to keep getting updates.') : 'Add that repository to install it from there.')) + '</span>'
            + '<button class="btn f" data-k="movedadd" data-act="movedadd" data-url="' + esc(mv.url) + '" data-fp="' + esc(mv.fingerprint) + '" data-name="' + esc(x.name) + '">' + (mv.source ? 'Take updates from there' : 'Add source') + '</button></div>';
        else if (mv && mv.done) h += '<div class="notice info">' + esc(x.name + ' moved to \u2018' + mv.source.name + '\u2019; its updates come from there now.') + '</div>';
        if (x.source !== 'official') h += '<div class="notice info">' + esc('From ' + x.sourceName + ', an independent repository you added. Its signature says the files come from its publisher; Apps2Samsung has not reviewed them.') + '</div>';
        var can = !v.needsHead && fits(v) && !me && armed() && !plan.missing && !setBlock && !(job && job.running);
        h += '<div class="sfoot"><div class="btns"><button class="btn primary grow f" data-k="install" data-act="install"' + (can ? (x.variants.length > 1 ? '' : ' data-default') : ' disabled') + '>'
            + esc(me ? (st.update ? 'Update' : 'Reinstall') + ' from a phone or PC' : !fits(v) ? 'Needs Tizen ' + v.tizen + ' or newer' : v.needsHead ? 'Install from a phone or PC' : setBlock ? 'Fill in its settings first' : plan.missing ? 'Needs a ' + levelName(plan.level) + ' certificate' : job && job.running ? 'Another install is running' : label) + '</button>';
        if (st.installed && x.variants[st.variant].appId) h += '<button class="btn f" data-k="open" data-act="open">Open</button>';
        // Pin this build to the top of the store (#29); for a one-build app the button pins the app.
        h += '<button class="btn f" data-k="pin" data-act="pin">' + (isPinned(x, sheet.v) ? 'Unpin' : 'Pin') + '</button>';
        if (st.installed && !st.known && x.variants.length > 1) h = h.replace('<div class="sfoot">', '<div class="notice">' + esc('Your TV has ' + x.name + (st.version ? ' v' + st.version : '') + ', but every build of it uses the same package, so TV-Store cannot tell which one. Pick yours above to reinstall or update it, or pin it so TV-Store knows.') + '</div><div class="sfoot">');
        if (st.installed && st.unknown && !me) h = h.replace('<div class="sfoot">', '<div class="notice">' + esc(WEB_UNKNOWN) + '</div><div class="sfoot">');
        // Came from a phone or PC (TV-Store never installed this package): the TV keeps that device's
        // certificate, and an update from here may need the old copy removed first (#44).
        var fromHead = can && st.installed && v.packageId && !installedFile.hasOwnProperty(tvPkg(v));
        h += '</div><div class="hint">' + (fromHead ? esc(x.name + ' was installed from a phone or PC. TV-Store signs with the certificate that installed it when that phone or PC armed this TV; otherwise it offers to remove the old copy first. RETURN goes back to the store.') : can ? 'Takes about a minute. RETURN goes back to the store.' : 'RETURN goes back to the store.') + '</div></div>';
        return h;
    }

    // Sign with (#50): only when the TV holds both levels; otherwise there is nothing to choose and
    // the plan is said in one line where it matters (a Partner app on a Public-only TV).
    function signWithHtml(v, plan) {
        var held = levelsHeld();
        if (!(held.public && held.partner)) return '';
        var choice = certChoiceOf(v) || 'auto';
        var auto = plan.by === 'chosen' ? signPlan(v, true) : plan;
        var why = auto.by === 'catalog' ? 'Automatic: Partner, the catalog says this app needs it'
            : auto.by === 'remembered' ? 'Automatic: ' + levelName(auto.level) + ', the certificate this app was installed with (' + auto.name + ')'
            : auto.by === 'manifest' ? 'Automatic: Partner, the package asks for partner-level rights' : 'Automatic: Public';
        return '<div class="vhead"><span class="t">Sign with</span><span class="h">' + esc(why) + '</span></div><div class="chips" style="margin-bottom:0">'
            + [['auto', 'Automatic'], ['public', 'Public'], ['partner', 'Partner']].map(function (o) {
                return '<div class="chip f' + (o[0] === choice ? ' on' : '') + '" tabindex="0" data-k="cert:' + o[0] + '" data-cert="' + o[0] + '">' + o[1] + '</div>';
            }).join('') + '</div>';
    }
    function missingLevelText(name, plan) {
        if (plan.level === 'partner') return name + ' needs a Partner certificate' + (plan.by === 'chosen' ? ' (your choice)' : '') + ', and this TV only has a Public one. ' + PARTNER_HOW;
        return 'Public was chosen for ' + name + ', and this TV only has a Partner certificate. Arm it again from a phone or PC with a Public one, or pick Partner.';
    }

    // The file a phone or PC sent (#30), as the app the install screens show: one build, no catalog.
    function uploadApp(up) {
        var ids = up.ids || {}, v = variant(up.name, up.name, '', ids.version, ids.appId, ids.packageId, ids.requiredVersion);
        v.upload = up.id; v.manifestPartner = !!ids.partner;
        return { key: 'upload:' + up.id, name: ids.name || up.name.replace(/\.(wgt|tpk)$/i, ''), category: 'other', description: '', author: '', variants: [v], needsHead: null, adult: false, root: false };
    }
    function uploadHtml() {
        var up = upload;
        if (!up) return '<div class="shd"><div><div class="nm">Nothing waiting</div><div class="mt">The file is no longer on the TV.</div></div></div>'
            + '<div class="sfoot"><div class="btns"><button class="btn grow f" data-k="close" data-act="close" data-default>Back to the store</button></div></div>';
        var ids = up.ids || {}, x = uploadApp(up), have = ids.packageId && installed.hasOwnProperty(ids.packageId) ? installed[ids.packageId] : null;
        var h = '<div class="shd">' + tile(x, 88) + '<div style="min-width:0"><div class="nm">' + esc(x.name) + '</div><div class="mt">' + esc('Sent from ' + up.from + ' · ' + (up.size / 1048576).toFixed(1) + ' MB') + '</div></div></div>';
        h += '<div class="sdesc">A file arrived from a phone or PC in your network. It is not from the Apps2Samsung catalog, so TV-Store cannot check it. Install it only if you sent it yourself or know where it came from.</div>';
        var b = '';
        if (have !== null) b += newer(ids.version, have) ? badge('b-warn', 'Update from v' + have) : badge('b-ok', 'Installed · v' + have);
        if (ids.partner) b += badge(levelsHeld().partner ? 'b-mute' : 'b-warn', 'Asks for partner-level rights');
        // The TV has another app under this package id (#84): a file sent in has no catalog entry to
        // derive an id of its own from, so installing it replaces that app.
        var others = ids.packageId && tvNames[ids.packageId] || [], same = !ids.name || !others.length || others.some(function (n) { return String(n).trim().toLowerCase() === String(ids.name).trim().toLowerCase(); });
        if (b) h += '<div class="badges">' + b + '</div>';
        if (!same) h += '<div class="notice">' + esc('Already on your TV: ' + others[0] + '. It has the same package id, so installing this file replaces it.') + '</div>';
        h += '<div class="table kv"><div class="trow"><span class="k">File</span><span class="v">' + esc(up.name) + '</span></div>'
            + '<div class="trow"><span class="k">Application</span><span class="v">' + esc((ids.appId || ids.packageId || 'unknown') + (ids.version ? ' · v' + ids.version : '')) + '</span></div>'
            + (ids.requiredVersion ? '<div class="trow"><span class="k">Asks for</span><span class="v">' + esc('Tizen ' + ids.requiredVersion + ' or newer' + (tvTizen ? ' · this TV runs Tizen ' + tvTizen : '')) + '</span></div>' : '')
            + '<div class="trow"><span class="k">SHA-256</span><span class="v mono">' + esc(String(up.sha256).slice(0, 20)) + '…</span></div></div>';
        var plan = signPlan(x.variants[0]);
        if (armed() && !uploadTokenError && fits(x.variants[0])) h += signWithHtml(x.variants[0], plan);
        if (!armed()) h += '<div class="notice">Not armed yet. Open this TV’s Toolbox in Apps2Samsung on your phone or PC and press Arm TV-Store once; the file keeps waiting.</div>';
        else if (uploadTokenError) h += '<div class="notice">TV-Store could not read its upload key on this TV (' + esc(uploadTokenError) + '), so it cannot confirm uploads here. Install the file with Apps2Samsung on a phone or PC instead.</div>';
        else if (!fits(x.variants[0])) h += '<div class="notice">' + esc('This file asks for Tizen ' + ids.requiredVersion + ' or newer, and this TV runs Tizen ' + tvTizen + '. The TV would refuse it.') + '</div>';
        else if (plan.missing) h += '<div class="notice">' + esc(missingLevelText(x.name, plan)) + '</div>';
        else if (ids.partner && !levelsHeld().partner) h += '<div class="notice info">' + esc('This file asks for partner-level rights, and this TV only has a Public certificate. It will install, but those parts of the app will not work. ' + PARTNER_HOW) + '</div>';
        var can = armed() && !uploadTokenError && fits(x.variants[0]) && !plan.missing && !(job && job.running);
        h += '<div class="sfoot"><div class="btns"><button class="btn primary grow f" data-k="upinstall" data-act="upinstall"' + (can ? ' data-default' : ' disabled') + '>' + (job && job.running ? 'Another install is running' : !fits(x.variants[0]) ? 'Needs Tizen ' + ids.requiredVersion + ' or newer' : plan.missing ? 'Needs a ' + levelName(plan.level) + ' certificate' : 'Install on this TV') + '</button>'
            + '<button class="btn f" data-k="close" data-act="close"' + (can ? '' : ' data-default') + '>Not now</button><button class="btn danger f" data-k="updiscard" data-act="updiscard">Discard</button></div>'
            + '<div class="hint">' + esc('Signed with your ' + (levelsHeld().public && levelsHeld().partner ? levelName(plan.level) + ' ' : '') + 'certificate, like every install. RETURN keeps the file waiting.') + '</div></div>';
        return h;
    }

    var STEPS = [['Downloaded', 'Downloading'], ['Checked and signed for this TV', 'Checking and signing'], ['Installed on the TV', 'Installing on the TV'], ['Ready to open', 'Ready to open']];
    function jobHtml() {
        var x = job.app, v = job.v, upd = job.update;
        var done = job.step, pct = Math.min(100, Math.round((done / 4) * 100 + (job.running && done < 3 ? 8 : 0)));
        var h = '<div class="shd">' + tile(x, 88, v.icon) + '<div style="min-width:0"><div class="nm">' + esc(x.name) + '</div><div class="mt">' + esc(v.label + (verOf(v) ? ' · v' + verOf(v) : '')) + '</div></div></div>';
        h += '<div class="prog"><div class="top"><b>' + (job.error ? (upd ? 'Update failed' : 'Install failed') : (upd ? 'Updating…' : 'Installing…')) + '</b><span>' + (job.error ? '' : 'step ' + Math.min(done + 1, 4) + ' of 4') + '</span></div>'
            + '<div class="bar' + (job.error ? ' bad' : '') + '"><i style="width:' + (job.error ? 100 : pct) + '%"></i></div></div>';
        h += '<div class="table">' + STEPS.map(function (s, i) {
            var cls, ico, side = '';
            if (i < done) { ico = '<span class="ico done">' + CHECK + '</span>'; cls = ''; }
            else if (i === done && job.error) { ico = '<span class="ico fail">' + CROSS + '</span>'; cls = ''; }
            else if (i === done && job.running) { ico = '<span class="ico run"></span>'; cls = ''; }
            else { ico = '<span class="ico wait"></span>'; cls = ' pending'; }
            if (i === 0 && v.upload) s = ['Received from your phone or PC', 'Picking up the file'];
            if (i === 0) side = job.bytes ? (job.bytes / 1048576).toFixed(1) + ' MB' : '';
            if (i === 1) side = job.certificate ? 'with ' + job.certificate : job.plan && (levelsHeld().public && levelsHeld().partner || job.plan.by === 'catalog') ? 'with your ' + levelName(job.plan.level) + ' certificate' : 'with your certificate';
            if (i === 2) side = job.replace ? 'the old copy goes first' : 'the TV is doing this part';
            return '<div class="trow' + cls + '">' + ico + '<span style="flex:1">' + (i < done ? s[0] : s[1]) + '</span><span class="v">' + side + '</span></div>';
        }).join('') + '</div>';
        if (job.error) h += '<div class="notice bad">' + esc(job.error) + '</div>';
        else if (isSelf(job.app)) h += '<div class="notice">' + esc(job.auto ? SELF_AUTO : SELF_TRY) + '</div>';
        else h += '<div class="notice info">You can keep browsing with RETURN; the ' + (upd ? 'update' : 'install') + ' carries on in the background and the app shows up under On the TV when it is in.</div>';
        h += '<div class="sfoot"><div class="btns">';
        if (job.error && job.code === 'PACKAGE_ID_TAKEN' && !job.replaceOther) h += '<button class="btn f" data-k="close" data-act="close" data-default>Cancel</button><button class="btn danger f" data-k="replaceother" data-act="replaceother">Replace it</button>';
        else if (job.error && job.code === 'CERT_MISMATCH' && !job.replace && !isSelf(job.app)) h += '<button class="btn primary grow f" data-k="replacejob" data-act="replacejob" data-default>Remove the old copy and install again</button><button class="btn f" data-k="close" data-act="close">Keep the old copy</button>';
        else if (job.error) h += '<button class="btn primary grow f" data-k="retryjob" data-act="retryjob" data-default>Try again</button><button class="btn f" data-k="close" data-act="close">Back to the store</button>';
        else h += '<button class="btn grow f" data-k="close" data-act="close" data-default>Keep browsing</button>';
        h += '</div><div class="hint mono">' + esc(job.line || '') + '</div></div>';
        return h;
    }

    function doneHtml() {
        var x = job.app, v = job.v, secs = Math.max(1, Math.round((job.ended - job.started) / 1000));
        var more = updates();
        var h = '<div class="donehead"><div class="tw">' + tile(x, 150) + '<span class="ico done bigok">' + CHECK.replace('width="18" height="18"', 'width="30" height="30"') + '</span></div>'
            + '<h2>' + esc(x.name) + ' is on your TV</h2><p>' + esc((job.update ? 'Updated to v' : 'Installed v') + (verOf(v) || '') + '. You will find it in the Apps row' + (job.update ? ', right where it was.' : '.')) + '</p></div>';
        // Installed beside another app that has its package id (#84): say so, or it looks like that app went.
        if (job.renamed && job.renamed.why === 'collision') h += '<div class="notice info" style="margin-top:24px">' + esc('Installed as a separate app, because ' + (job.renamed.other || 'another app') + ' already uses this id.') + '</div>';
        h += '<div class="table kv" style="margin-top:' + (job.renamed && job.renamed.why === 'collision' ? 16 : 38) + 'px"><div class="trow"><span class="k">Variant</span><span class="v">' + esc(v.label) + '</span></div>'
            + '<div class="trow"><span class="k">Took</span><span class="v">' + secs + ' seconds</span></div>'
            + '<div class="trow"><span class="k">Signed with</span><span class="v">' + esc(job.certificate ? job.certificate + (job.level === 'partner' || job.level === 'public' ? ' (' + levelName(job.level) + ')' : '') : 'your certificate') + '</span></div></div>';
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
            + '<div class="sbody vscroll"><div class="opts">' + opt('showAdult', 'Show adult (18+) apps', 'Apps marked adult-only stay out of the store until this is on.')
            + opt('showNeedsHead', 'Show apps that need a phone or PC', 'Some apps need Apps2Samsung on a phone or PC to install. Turn this off to keep them out of the store.')
            + opt('verboseLog', 'Verbose logging', 'Writes much more detail to the TV-Store log. Turn it on when a bug report asks for it, and off again afterwards.')
            + browserRow() + relayRow() + devicesRows() + installerRow()
            + opt('autoUpdateApps', 'Update apps automatically', 'Off: updates wait under On the TV until you press Update. On: while TV-Store is open it installs the updates for the apps on this TV by itself, one after another. An app that needs a phone or PC, or a choice from you, still waits there.')
            + opt('autoUpdateSelf', 'Update TV-Store automatically', 'Off: TV-Store only says that a newer version is out; update it from Apps2Samsung on a phone or PC. On: when TV-Store is open and a newer version is out, it installs it by itself. It closes during the install; open it again after a minute and it says whether the update landed.') + '</div>' + browserNotice() + relayNotice() + installerNotice();
        if (confirmingAdult) h += '<div class="notice">These apps are meant for adults only. Turn them on only if you are 18 or older.</div>'
            + '<div class="btns" style="margin-top:16px"><button class="btn primary grow f" data-k="adultyes" data-act="adultyes" data-default>I am 18 or older</button><button class="btn f" data-k="adultno" data-act="adultno">Cancel</button></div>';
        var certList = (ready && ready.certificates ? ready.certificates.map(function (c) { return c.name + (c.level === 'partner' || c.level === 'public' ? ' (' + levelName(c.level) + ')' : ''); }) : (ready && ready.certNames) || []);
        var certText = !armed() ? 'not yet' : ready.certCount > 1 ? ready.certCount + ' handed over: ' + certList.join(', ') : 'handed over' + (certList[0] ? ': ' + certList[0] : '');
        var certs = certsBlock();
        h += certs + sourcesBlock() + backupBlock() + '<div class="table kv f stop" tabindex="0" data-k="stop:info">' + (certs ? '' : '<div class="trow"><span class="k">Signing certificate' + (ready && ready.certCount > 1 ? 's' : '') + '</span><span class="v">' + esc(certText) + '</span></div>')
            + '<div class="trow"><span class="k">Catalog</span><span class="v">' + esc(catalogApps.length + ' apps, signature checked' + (catalogNewer ? ' · format version ' + catalogNewer + ', newer than this TV-Store knows: update TV-Store' : '')) + '</span></div>'
            + '<div class="trow"><span class="k">TV-Store</span><span class="v">v' + VERSION + (ready && ready.node ? ' · Node ' + esc(ready.node) : '') + '</span></div>'
            + '<div class="trow"><span class="k">This TV</span><span class="v">' + esc((device ? device + ' · ' : '') + (tvTizen ? 'Tizen ' + tvTizen : 'Tizen version not known')) + '</span></div></div>';
        if (confirmingAdult) return h + '</div>';    // the question needs the room the QR codes take
        // The store in a browser (#101): its address, as a QR for a phone.
        if (browserOn() && ready.browser.url) h += '<div class="qrrow">' + qr(ready.browser.url, 120) + '<div><b>Browse and install from your phone</b><span>Scan, or open <span class="mono">' + esc(ready.browser.url) + '</span> on a computer in the same network. Install there and TV-Store installs it here, while it is open.</span></div></div>';
        // Your own file (#30): the upload page's address, as a QR for a phone.
        if (ready && ready.ownIp) {
            var u = 'http://' + ready.ownIp + ':8077/upload';
            h += '<div class="qrrow">' + qr(u, 120) + '<div><b>Install your own app</b><span>Scan with your phone, or open <span class="mono">' + esc(u) + '</span> on a computer in the same network, and send a .wgt or .tpk. TV-Store then asks here whether to install it.</span></div></div>';
        }
        // The table and the QR codes take the focus too, one after another, so the way down to the
        // end of Settings always shows where the remote is.
        var stops = 0;
        return (h + logBlock()).replace(/<div class="qrrow">/g, function () { return '<div class="qrrow f stop" tabindex="0" data-k="stop:qr' + (stops++) + '">'; }) + '</div>';
    }

    // ---- actions ----------------------------------------------------------------------------------
    // The build an app's page lands on: the one on the TV, else the first, but not a build this TV
    // cannot run when another can (#47).
    function pickVariant(x) {
        var st = state(x), v = st.installed ? st.variant : 0;
        if (!fits(x.variants[v])) for (var i = 0; i < x.variants.length; i++) if (fits(x.variants[i])) { v = i; break; }
        return v;
    }
    function openApp(x, vIdx) {
        openSheet({ mode: 'app', app: x, v: vIdx != null ? vIdx : pickVariant(x), all: false });
    }

    // ---- the store in a phone or PC browser (#101) ------------------------------------------------
    // http://<TV IP>:8077/ (the service's storepage.js) shows what this screen sends it: every app the
    // Settings let through, with its state and, when it cannot be installed from there, why. Install
    // there becomes a request this screen takes in the answer to its next send and installs as if OK
    // was pressed on it, so every check and question stays here, and the TV shows it happening. Only
    // the page token lets this screen send or take: other apps on the TV reach the port too.
    var browserBusy = false, browserError = null;   // the Settings switch, as for the relay
    var storeSent = '', storeBusy = false;          // the picture the service has, as JSON
    var lastKey = 0;                                // when the remote was last pressed
    var browserTaken = {};                          // request id -> true, taken once
    var browserReq = {};                            // app key -> the request id it was installed for
    function browserOn() { return !!(ready && ready.browser && ready.browser.enabled); }
    // An app's settings (user_settings), as the TV needs them: { required, labels }.
    function settingsInfo(us) {
        var f = (us && Array.isArray(us.fields) ? us.fields : []).filter(function (x) { return x && x.key; });
        return { required: f.some(function (x) { return x.required === true; }), labels: f.map(function (x) { return String(x.label || x.key).replace(/[;(].*$/, '').trim(); }) };
    }
    // Whether the TV holds settings for this build (saved from a phone or PC, maybe all left empty).
    function settingsSaved(v) { var m = ready && ready.userSettings; return !!(m && v && v.file && m.hasOwnProperty(v.file)); }
    // What stops an install of v from the TV because of its settings, in words, or ''.
    function settingsBlock(x, v, st) {
        if (!v.settings || settingsSaved(v)) return '';
        if (st.installed) return x.name + ' is on this TV with settings typed on the phone or PC that installed it. Updating it from here would drop them.';
        if (v.settings.required) return x.name + ' needs its settings before it installs: ' + v.settings.labels.join(', ') + '.';
        return '';
    }
    // The address of an app on the store page, for the QR code: its form opens there.
    function settingsUrl(x) { return ready && ready.browser && ready.browser.url ? ready.browser.url + '#app=' + encodeURIComponent(x.key) : ''; }
    function appSettingsHtml(x, v, st) {
        if (!v.settings) return '';
        var block = settingsBlock(x, v, st), u = browserOn() ? settingsUrl(x) : '';
        var text = block ? block + (u ? ' Scan the code, or open the address on a phone or PC, and fill them in there; TV-Store then installs it here.' : ' Turn on \u201cInstall from a browser\u201d in Settings to fill them in on a phone or PC, or install it from Apps2Samsung.')
            : settingsSaved(v) ? 'Its settings (' + v.settings.labels.join(', ') + ') are saved on this TV and written into it at every install.' + (u ? ' Change them by scanning the code.' : '')
            : x.name + ' has optional settings (' + v.settings.labels.join(', ') + '). Install it as it is, or fill them in on a phone or PC first' + (u ? ' by scanning the code.' : '.');
        if (!u) return '<div class="notice' + (block ? '' : ' info') + '">' + esc(text) + '</div>';
        return '<div class="qrrow">' + qr(u, 120) + '<div><b>' + esc(block ? 'Needs its settings' : 'Its settings') + '</b><span>' + esc(text) + ' <span class="mono">' + esc(u) + '</span></span></div></div>';
    }
    // Why x cannot be installed from a browser, or '' when it can; for an app on the TV that is up to
    // date, '' as well (the page shows it as installed, without a button).
    function browserWhy(x, st, v) {
        if (isSelf(x)) return 'TV-Store updates itself from the TV, or from Apps2Samsung on a phone or PC.';
        if (!armed()) return 'TV-Store is not armed yet.';
        if (v.needsHead) return 'Needs Apps2Samsung on a phone or PC: this build ' + v.needsHead + '.';
        if (!fits(v)) return 'Needs Tizen ' + v.tizen + ' or newer; this TV runs Tizen ' + tvTizen + '.';
        if (signPlan(v).missing) return 'Needs a ' + levelName(signPlan(v).level) + ' certificate on the TV.';
        if (st.installed && !st.known) return 'Several builds match the one on the TV: pick it on the TV.';
        var from = heldElsewhere(x, v);
        if (from) return 'On the TV from ' + from + ': switching it to this source needs a yes on the TV.';
        return '';
    }
    function storeSnapshot() {
        var list = catalogApps.filter(function (x) { return !(x.adult && !settings.showAdult) && !(x.needsHead && !settings.showNeedsHead); });
        return {
            tv: { model: device, tizen: tvTizen, version: VERSION, armed: armed(), free: tvFree,
                  certs: ((ready && ready.certificates) || []).map(function (c) { return { name: certName(c), level: c.level === 'partner' || c.level === 'public' ? levelName(c.level) : '' }; }) },
            categories: CATEGORY_ORDER.map(function (c) { return { id: c, name: CATEGORY_NAMES[c], color: CATEGORY_COLORS[c] }; }),
            apps: list.map(function (x) {
                var st = state(x), vi = pickVariant(x), v = x.variants[vi], why = browserWhy(x, st, v);
                var current = st.installed && !st.update;
                return { key: x.key, url: v.url || '', file: v.file || '', name: x.name, cat: knownCategory(x.category), author: x.author || '', desc: String(x.description || '').slice(0, 300),
                         source: x.source === 'official' ? '' : x.sourceName || '', icon: x.icon || '', installed: st.installed ? st.version || '' : null,
                         update: !!st.update, latest: st.installed ? st.latest || '' : verOf(v) || '', unknown: !!(st.installed && st.unknown), variant: x.variants.length > 1 ? v.label : '',
                         adult: !!x.adult, root: !!x.root, partner: !!x.partner, can: !current && !why, why: why };
            }),
            job: job ? { key: job.app.key, name: job.app.name, update: !!job.update, step: job.step, running: !!job.running, ok: !!job.ok, error: job.error || null,
                         onTv: !!(job.error && /^(PACKAGE_ID_TAKEN|CERT_MISMATCH|SOURCE_SWITCH)$/.test(job.code || '')) } : null,
            queue: queue.map(function (x) { return x.name; })
        };
    }
    // Every tick, and right after an install starts or ends: the whole picture when it changed, else
    // only "still open". The answer brings the requests from browsers.
    function pushStore(tick) {
        if (loading || problem || !ready || !uploadToken || storeBusy || !browserOn()) return;
        // While the remote is in use the tick only says "still open": building the whole picture for
        // every app held the screen up every 3 s. It follows once the remote rests.
        var body = { token: uploadToken }, snap = null;
        if (!(tick && storeSent && Date.now() - lastKey < 3000)) {
            var now = storeSnapshot(); snap = JSON.stringify(now);
            if (snap !== storeSent) body.state = now;
        }
        storeBusy = true;
        xhr('POST', '/store/state', body, function (err, res) {
            storeBusy = false;
            if (err) { if (/only the TV-Store screen/.test(err.message)) withUploadToken(function () {}); return; }
            if (!res || !res.ok) return;
            if (body.state) storeSent = snap;
            if (res.want) storeSent = '';
            // Settings saved from a browser: the app's page on the TV says so, and installs with them.
            if (res.userSettings && ready && JSON.stringify(res.userSettings) !== JSON.stringify(ready.userSettings || {})) {
                ready.userSettings = res.userSettings; storeSent = '';
                if (sheet && sheet.mode === 'app') renderSheet();
            }
            (res.requests || []).forEach(takeRequest);
        }, null, 5000);
    }
    function ackRequest(id, status, message) { if (id) xhr('POST', '/store/ack', { token: uploadToken, id: id, status: status, message: message || '' }, function () {}, null, 5000); }
    function ackBrowser(x, status, message) { var id = x && browserReq[x.key]; if (!id) return; delete browserReq[x.key]; ackRequest(id, status, message); }
    // The updates Update all installs: known builds, none that needs a phone or PC, not TV-Store itself.
    function updatable() { return updates().filter(function (x) { var st = state(x), v = x.variants[st.variant]; return st.known && !v.needsHead && !isSelf(x) && !signPlan(v).missing && !settingsBlock(x, v, st); }); }
    // While something installs (an update that started by itself runs without a sheet, #154), what
    // is asked for is lined up behind it, and the app that is installing is not installed twice.
    function installing(x) { return !!(job && job.running && job.app === x); }
    function updateAll() {
        var list = updatable().filter(function (x) { return queue.indexOf(x) < 0 && !installing(x); });
        if (job && job.running) { queue = queue.concat(list); if (list.length) toast((list.length === 1 ? list[0].name + ' is' : list.length + ' updates are') + ' installed after ' + job.app.name + '.'); return; }
        queue = list;
        if (queue.length) { var first = queue.shift(); startInstall(first, state(first).variant); }
    }
    function updateOne(x) {
        if (!x) return;
        if (!(job && job.running)) return startInstall(x, state(x).variant);
        if (installing(x)) return toast(x.name + ' is being installed right now.');
        if (queue.indexOf(x) < 0) queue.push(x);
        toast(x.name + ' is installed after ' + job.app.name + '.');
    }
    function takeRequest(r) {
        if (!r || !r.id || browserTaken[r.id]) return;
        browserTaken[r.id] = true;
        if (r.all) {
            var list = updatable().filter(function (x) { return queue.indexOf(x) < 0 && !(job && job.running && job.app === x); });
            if (!list.length) return ackRequest(r.id, 'failed', 'No updates to install.');
            ackRequest(r.id, 'taken');
            toast('Update all, asked for from ' + r.from + ': ' + list.length + (list.length === 1 ? ' update' : ' updates'));
            if (job && job.running) queue = queue.concat(list); else { queue = list; var first = queue.shift(); startInstall(first, pickVariant(first)); }
            pushStore();
            return;
        }
        var x = byKey(r.key);
        if (!x) return ackRequest(r.id, 'failed', 'Not in the store on the TV.');
        var st = state(x), why = browserWhy(x, st, x.variants[pickVariant(x)]);
        if (why || (st.installed && !st.update && !r.again)) return ackRequest(r.id, 'failed', why || 'It is on the TV already.');
        if (queue.indexOf(x) >= 0 || (job && job.running && job.app === x)) return ackRequest(r.id, 'taken');
        ackRequest(r.id, 'taken');
        browserReq[x.key] = r.id;
        toast((st.installed ? 'Updating ' : 'Installing ') + x.name + ', asked for from ' + r.from);
        if (job && job.running) queue.push(x); else startInstall(x, pickVariant(x));
        pushStore();
    }
    // ---- updates that install by themselves (#154) ---------------------------------------------------
    // Two switches in Settings, both off until the user turns them on. "Update apps automatically":
    // what Update all would install is installed without anybody pressing it, one app after another,
    // without a sheet; a line at the bottom of the screen says what happened. "Update TV-Store
    // automatically": TV-Store's own update, the #41 way, with its sheet, because TV-Store closes
    // during it. That one goes first: it ends everything else, and the apps follow when TV-Store is
    // open again.
    // Only while TV-Store is open: nothing of it runs when it is closed. The 3 s tick looks, once the
    // store is complete (the catalog and every source are in), and starts something only when the
    // screen is free: no sheet open, nothing installing, nobody typing. Not while the TV's own list
    // is being read either: the TV's developer connection takes one client at a time.
    // A version is tried by itself once per start of TV-Store, and AUTO_TRIES times in all, written
    // down when it starts: one that fails for good (another certificate, say) would fail again at
    // every tick and every start, while one that failed because the download broke off deserves
    // another go next time. A version that was installed is not tried again at all: an app whose
    // package says an older version than the catalog does still has "an update" afterwards, which
    // would install it again without end. TV-Store's own is tried once: it may not live to see how
    // its update ends. What did not land waits under On the TV, where Update still works and shows
    // why, until the catalog has a newer version.
    var AUTO_TRIED_KEY = 'a2s.tvstore.autotried', AUTO_TRIES = 3;
    var autoTried = (function () { try { var t = JSON.parse(window.localStorage.getItem(AUTO_TRIED_KEY)); return t && typeof t === 'object' && !Array.isArray(t) ? t : {}; } catch (e) { return {}; } })();   // app key -> { v: version, n: times tried by itself }
    var autoNow = {};             // app key -> the version tried since TV-Store started
    var AUTO_SELF_REST = 30000;   // TV-Store's own update waits until the remote has rested this long, or was never touched
    var storeComplete = false;    // the catalog and the sources are in: only then is it known what has an update
    function autoRecord(x, version) { var r = autoTried.hasOwnProperty(x.key) ? autoTried[x.key] : null; return r && typeof r === 'object' && r.v === (version || '') && r.n > 0 ? r : null; }
    function autoSave() { try { window.localStorage.setItem(AUTO_TRIED_KEY, JSON.stringify(autoTried)); } catch (e) {} }
    // times: how many tries this one counts for (all of them for TV-Store's own).
    function autoMark(x, version, times) {
        var r = autoRecord(x, version), n = (r ? r.n : 0) + (times || 1);
        // What is not on the TV any more, or not in the catalog, need not be remembered.
        Object.keys(autoTried).forEach(function (k) { var a = byKey(k); if (!a || !state(a).installed) delete autoTried[k]; });
        autoTried[x.key] = { v: version || '', n: Math.min(n, AUTO_TRIES) };
        autoNow[x.key] = version || '';
        autoSave();
    }
    function autoDone(x, version) { autoTried[x.key] = { v: version || '', n: AUTO_TRIES }; autoSave(); }
    function autoWaits(x, st) {
        var v = st.latest || '', r = autoRecord(x, v);
        return (autoNow.hasOwnProperty(x.key) && autoNow[x.key] === v) || !!(r && r.n >= AUTO_TRIES);
    }
    function autoUpdate() {
        if (!settings.autoUpdateApps && !settings.autoUpdateSelf) return;
        if (!storeComplete || loading || problem || reviving || !armed() || sheet || (job && job.running) || queue.length || catalogChanged || document.hidden || typing() || tvAppsAsking) return;
        // First what the service did while TV-Store was closed (#157): an app it updated is not installed again.
        if (!autoHeard || (svcAuto && (svcAuto.running || (svcAuto.landed && svcAuto.landed.length)))) return;
        var me = self();
        if (settings.autoUpdateSelf && me && selfCan(me)) {
            var ms = state(me), mv = ms.installed ? me.variants[ms.variant] : null;
            if (mv && ms.update && ms.known && !mv.needsHead && fits(mv) && !signPlan(mv).missing && !settingsBlock(me, mv, ms) && !autoWaits(me, ms)) {
                if (lastKey && Date.now() - lastKey < AUTO_SELF_REST) return;   // the apps wait too: TV-Store's own goes first
                autoMark(me, ms.latest, AUTO_TRIES);
                startInstall(me, ms.variant, { auto: true });   // its sheet says that it started by itself
                return;
            }
        }
        if (!settings.autoUpdateApps) return;
        var next = updatable().filter(function (x) { var st = state(x); return fits(x.variants[st.variant]) && !autoWaits(x, st); })[0];
        if (next) { var ns = state(next); autoMark(next, ns.latest); startInstall(next, ns.variant, { auto: true, quiet: true }); }
    }

    // ---- updates while TV-Store is closed (#157) ---------------------------------------------------
    // Started without this screen, the service does a round of its own. It cannot tell which build
    // of an app is on the TV (that takes the file TV-Store installed, the pins and the platform),
    // so the screen hands it a plan: every app it would update by itself, with the build that is on
    // the TV and the version it has. The service installs the same build when the catalog has a
    // newer one, and nothing else. The plan is built once a minute at most (it asks for the state
    // of every app), right away after a switch in Settings, and sent only when it changed.
    // What the service installed meanwhile comes back in the tick (`landed`): the screen writes
    // down what it would have after an install of its own, says so once, and tells the service.
    var svcAuto = null;           // the service's side, from the tick: { running, landed, last }
    var planDue = 0, planSent = '', planBusy = false, landedBusy = false;
    var autoHeard = false;        // the tick has heard from the service: what it says about its own updates is in
    function autoPlan() {
        var items = [];
        catalogApps.forEach(function (x) {
            var st = state(x);
            if (!st.installed || !st.known || st.unknown) return;
            var v = x.variants[st.variant], me = isSelf(x);
            if (v.upload || v.needsHead || !fits(v) || signPlan(v).missing || settingsBlock(x, v, st) || (me && !selfCan(x))) return;
            items.push({ key: x.key, name: x.name, file: v.file, source: x.source || 'official', packageId: tvPkg(v), appId: tvAppId(v) || '', have: st.version || '', web: !!v.webVersion, certLevel: certChoiceOf(v), self: me });
        });
        return { settings: { apps: !!settings.autoUpdateApps, self: !!settings.autoUpdateSelf, closed: !!settings.autoUpdateClosed }, tizen: tvTizen, tvApps: tvNames, items: items };
    }
    function sendPlan() {
        if (planBusy || !storeComplete || loading || problem || !armed() || !uploadToken || (job && job.running) || catalogChanged || Date.now() < planDue) return;
        if (svcAuto && (svcAuto.running || (svcAuto.landed && svcAuto.landed.length))) return;   // first what the service did
        if (lastKey && Date.now() - lastKey < 3000) return;   // not while the remote is in use
        planDue = Date.now() + 60000;
        var plan = autoPlan(), text = JSON.stringify(plan);
        if (text === planSent) return;
        plan.token = uploadToken; planBusy = true;
        xhr('POST', '/auto/plan', plan, function (err, res) { planBusy = false; if (!err && res && res.ok) planSent = text; }, null, 5000);
    }
    function takeAuto(a) {
        svcAuto = a && typeof a === 'object' ? a : null;
        autoHeard = true;
        var list = svcAuto && Array.isArray(svcAuto.landed) ? svcAuto.landed : [];
        if (!list.length || landedBusy || !storeComplete || !uploadToken) return;
        var web = false;
        list.forEach(function (l) {
            var x = l && byKey(l.key);
            if (!x) return;
            if (l.packageId && l.file) installedFile[l.packageId] = l.file;
            if (l.web && l.packageId) { installedWeb[l.packageId] = { key: l.key, file: l.file, web: l.web }; web = true; }
            autoDone(x, l.version);
        });
        try { window.localStorage.setItem(VARIANTS_KEY, JSON.stringify(installedFile)); } catch (e) {}
        if (web) saveWeb(); else handPage();
        claims = null; planDue = 0;
        var last = list[list.length - 1];
        toast(list.length === 1 ? (last.name || 'An app') + ' was updated to v' + last.version + ' while TV-Store was closed.' : list.length + ' apps were updated while TV-Store was closed.');
        // The versions on the TV were read before the service was done: read them again.
        readInstalled(function (map) {
            if (map && Object.keys(map).length) setInstalled(map);
            if (sheet) return;
            var at = document.activeElement && document.activeElement !== searchEl ? document.activeElement.getAttribute('data-k') : null;
            renderPage(); if (at) focusKey(at) || focusFirst();
        });
        landedBusy = true;
        xhr('POST', '/auto/seen', { token: uploadToken }, function (err, res) { landedBusy = false; if (!err && res && res.ok && svcAuto) svcAuto.landed = []; }, null, 5000);
    }

    var toastTimer = null;
    function toast(text) {
        var t = $('toast');
        if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
        t.textContent = text; t.className = 'toast on';
        clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = 'toast'; }, 7000);
    }
    function browserRow() {
        if (!ready || !ready.browser) return '';
        var b = ready.browser;
        var hint = b.enabled ? 'On: open ' + (b.url || 'this TV\u2019s address on port 8077') + ' on a phone or PC in your network to browse and install. Installs run here while TV-Store is open, as if OK was pressed.'
            : 'Lets a phone or PC in your network browse the store and press Install; TV-Store then installs it here.';
        return '<div class="opt f" tabindex="0" data-k="opt:browser" data-opt="browser"><div class="ot"><div class="ont">Install from a browser</div><div class="oh">' + esc(hint) + '</div></div>'
            + '<span class="sw' + (b.enabled ? ' on' : '') + '"><i></i></span></div>';
    }
    function browserNotice() { return browserError ? '<div class="notice bad">' + esc('Could not change installing from a browser: ' + browserError) + '</div>' : ''; }
    function toggleBrowser() {
        if (!ready || !ready.browser || browserBusy) return;
        var want = !ready.browser.enabled;
        browserBusy = true;
        xhr('POST', '/settings', { browser: { enabled: want } }, function (err, res) {
            browserBusy = false;
            if (!err && res && res.ok) { ready.browser = res.browser; browserError = null; storeSent = ''; pushStore(); }
            else browserError = err ? err.message : (res && res.error) || 'no answer from the service';
            renderSheet(); focusKey('opt:browser');
        });
    }

    function startInstall(x, vIdx, opts) {
        if ((job && job.running) || (isSelf(x) && !selfCan(x))) return;
        var v = x.variants[vIdx], st = state(x), replace = !!(opts && opts.replace);
        job = { app: x, v: v, vIdx: vIdx, update: st.installed && st.known && st.variant === vIdx, replace: replace, running: true, finished: false, ok: false, step: 0, bytes: 0, line: '', error: null, code: null, started: Date.now(), plan: signPlan(v), certificate: '', level: '',
                auto: !!(opts && opts.auto), quiet: !!(opts && opts.quiet), latest: st.latest || v.version || '' };
        // An update that started by itself (#154) runs without its sheet: the header says what is installing.
        if (job.quiet) { /* no sheet */ } else if (sheet) { sheet = { mode: 'job' }; renderSheet(true); } else openSheet({ mode: 'job' });
        renderHeader(); pushStore();
        var since = job.started - 2000, me = job;
        var timer = setInterval(function () { pollLog(me, since); }, 700);
        // installed: whether the TV lists the package, so the service can read a bare [118, -12] from
        // a 2018 set (no reason text) as "another certificate" (#44); replace: remove that copy first.
        var onTv = !!(v.packageId && installed.hasOwnProperty(tvPkg(v)));
        // tvApps: what the TV has, so the service can tell another app's package id from this app's
        // (#84) and install a fork beside it; replaceOther: the yes to installing over that app anyway.
        var req = v.upload ? { upload: v.upload, token: uploadToken, tizen: tvTizen, installed: onTv, replace: replace } : { url: v.url, file: v.file, appId: tvAppId(v), packageId: tvPkg(v), name: x.name, tizen: tvTizen, installed: onTv, replace: replace, source: x.source || 'official', tvApps: tvNames };
        // Another source's copy of an installed package (#82): only from the sheet that said so.
        if (!v.upload && opts && opts.switchSource) req.switchSource = true;
        if (!v.upload && opts && opts.replaceOther) { req.replaceOther = true; job.replaceOther = true; }
        // Sign with (#50): the choice made on the TV; the service takes the catalog's and the manifest's word otherwise.
        if (certChoiceOf(v)) req.certLevel = certChoiceOf(v);
        // TV-Store's own package sent in by hand (#30) is a self-update as well, under the same switch.
        var ownPkg = (selfInfo() || {}).packageId;
        if (isSelf(x) || (v.upload && settings.selfUpdate && ownPkg && v.packageId === ownPkg)) { req.selfUpdate = true; req.fromVersion = VERSION; req.toVersion = v.version || ''; }
        // Download, sign and install in one call; a slow set with a big package needs more than the
        // usual 3 min, and while wascmd runs (#57) the service answers nothing at all for up to 5 min.
        xhr('POST', '/install', req, function (err, res) {
            clearInterval(timer);
            pollLog(me, since, function () {
                me.running = false; me.finished = true; me.ended = Date.now();
                // TV-Store's own update: the service going away mid-install is what the update does.
                if (err && isSelf(me.app)) err = new Error('The connection to the TV-Store service dropped, which is what installing TV-Store over itself does. Close TV-Store and open it again; it then says whether the update landed.');
                if (err || !res.ok) {
                    me.error = err ? err.message : res.error; me.code = err ? null : (res.code || null); renderHeader(); if (sheet && sheet.mode === 'job') renderSheet(true);
                    // Started by itself (#154), without a sheet to say how it went. What was asked
                    // for meanwhile still installs: nobody asked for the update that failed.
                    if (me.quiet) {
                        toast('The automatic update of ' + me.app.name + ' failed. It waits under On the TV, where Update says why.');
                        ackBrowser(me.app, 'failed', me.error);
                        if (sheet && (sheet.mode === 'app' || sheet.mode === 'upload')) renderSheet();
                        pushStore(); tvAppsAgain();
                        if (queue.length) setTimeout(function () { var nx = queue.shift(); startInstall(nx, pickVariant(nx)); }, 2500);
                        return;
                    }
                    // Asked for from a browser (#101): say how it went there, and that the rest did not start.
                    ackBrowser(me.app, 'failed', me.error);
                    queue.forEach(function (q) { ackBrowser(q, 'failed', 'Not started: ' + me.app.name + ' before it failed.'); });
                    queue = []; pushStore(); tvAppsAgain(); return;
                }
                var rr = res.result || {};
                me.ok = true; me.step = 4; me.certificate = rr.certificate || ''; me.level = rr.level || '';
                // Where it went on the TV: its own id, or one of its own beside another app (#84).
                var pkg = rr.packageId || v.packageId, aid = rr.appId || v.appId;
                me.appId = aid; me.renamed = rr.renamed || null;
                if (rr.renamed && rr.renamed.to && v.url && !pkgIds[v.url]) pkgIds[v.url] = rr.renamed.to;
                if (pkg) { installed[pkg] = v.version; claims = null; rememberVariant(v, pkg); rememberWeb(x, v, pkg); }
                if (pkg && ready) { ready.sourceOf = ready.sourceOf || {}; if (v.upload) delete ready.sourceOf[pkg]; else ready.sourceOf[pkg] = rr.source || x.source || 'official'; }
                if (aid) { appIds[aid] = true; dropThumb(tvIcons[aid]); }
                ackBrowser(me.app, 'done');
                // The service now remembers the profile this package took; the next sheet should say so.
                xhr('GET', '/ping', null, function (e, p) { if (!e && p && p.ok) ready = p; }, null, 5000);
                readInstalled(function (map) {
                    if (map && Object.keys(map).length) setInstalled(map);
                    // Without its sheet (#154) the page under the remote is built again: the focus stays where it was.
                    var at = me.quiet && !sheet && document.activeElement && document.activeElement !== searchEl ? document.activeElement.getAttribute('data-k') : null;
                    renderPage();
                    // The button under the remote may be gone (Update, once the app is updated): its row then.
                    if (at) focusKey(at) || (view === 'tv' && tvSel && focusKey('tv:' + tvSel.key)) || focusFirst();
                    if (sheet && sheet.mode === 'job') renderSheet(true);
                    else if (me.quiet && sheet && (sheet.mode === 'app' || sheet.mode === 'upload')) renderSheet();
                    if (me.quiet) autoDone(me.app, me.latest);
                    if (me.quiet) toast(me.app.name + ' was updated to v' + (verOf(v) || me.latest) + ' automatically.');
                    pushStore(); tvAppsAgain();
                    if (queue.length) setTimeout(function () { var nx = queue.shift(); startInstall(nx, pickVariant(nx)); }, 2500);
                });
            });
        }, null, 15 * 60 * 1000);
    }

    // The service's log tells how far an install is (index.js writes one line per stage).
    function pollLog(me, since, then) {
        xhr('GET', '/logs', null, function (err, res) {
            if (!err && res && res.logs) {
                res.logs.forEach(function (l) {
                    var t = Date.parse(l.slice(0, 24)); if (t && t < since) return;
                    if (l.indexOf(' install:') < 0) return;
                    me.line = l.replace(/^\S+\s+install:\s*/, '');
                    var m = /(?:downloaded|uploaded) (\d+) bytes/.exec(l);
                    if (m) { me.bytes = parseInt(m[1], 10); me.step = Math.max(me.step, 1); }
                    // Signed means the next step has started: a failure to reach the TV after it (#90)
                    // belongs on "Installing on the TV", not on "Checking and signing".
                    if (/signed with|removing the old copy|pushing to|handing to wascmd/.test(l)) me.step = Math.max(me.step, 2);
                    if (/(vd_appinstall|wascmd) reply/.test(l)) me.step = Math.max(me.step, 3);
                });
                if (sheet && sheet.mode === 'job' && job === me && me.running) renderSheet();
            }
            if (then) then();
        });
    }

    // Install the waiting file (#30): with a fresh token, so a restarted service still takes it.
    function installUpload() {
        if (!upload || (job && job.running)) return;
        var x = uploadApp(upload);
        withUploadToken(function () {
            if (uploadTokenError) { renderSheet(true); return; }
            startInstall(x, 0);
        });
    }
    function discardUpload() {
        var id = upload && upload.id;
        xhr('POST', '/upload/discard', { id: id }, function () { if (upload && upload.id === id) upload = null; closeSheet(); });
    }

    function launch(appId) {
        try { tizen.application.launch(appId, function () {}, function (e) { flash('Could not open it: ' + (e && e.message)); }); }
        catch (e) { flash('Could not open it: ' + e.message); }
    }
    function flash(text) { var h = sheetEl.querySelector('.hint'); if (h) { h.textContent = text; h.style.color = '#FF6B5E'; } }

    function toggle(key) {
        if (key === 'relay') { toggleRelay(); return; }
        if (key.indexOf('allow:') === 0) { toggleAllow(key.slice(6)); return; }
        if (key === 'installer') { toggleInstaller(); return; }
        if (key === 'browser') { toggleBrowser(); return; }
        if (key === 'showAdult' && !settings.showAdult) { confirmingAdult = true; renderSheet(true); return; }
        setSetting(key, !settings[key]);
    }
    function setSetting(key, value) {
        settings[key] = value;
        if (key === 'autoUpdateSelf') settings.selfUpdate = false;
        planDue = 0;
        saveSettings(); confirmingAdult = false;
        if (key === 'verboseLog') syncVerbose();
        apps = visible(catalogApps);
        renderPage(); renderSheet(); focusKey('opt:' + key);
    }

    function activate(el) {
        if (!el) return;
        if (el === searchEl) { startTyping(); return; }
        var id = el.id, act = el.getAttribute('data-act'), k;
        if (id === 'tabInstall') { view = 'install'; renderPage(); focusFirst(); return; }
        if (id === 'tabTv') { view = 'tv'; renderPage(); focusFirst(); loadTvApps(); return; }
        if (id === 'gear') {
            openSheet({ mode: 'settings' });
            // The TV's id for the certificates' device lists arrives after the first ping (the service
            // reads it from sdbd): ask again, so Settings says whether each certificate covers this TV.
            if (ready && !ready.duid) xhr('GET', '/ping', null, function (err, res) { if (!err && res && res.duid && ready) { ready.duid = res.duid; if (sheet && sheet.mode === 'settings') renderSheet(); } }, null, 5000);
            return;
        }
        if ((k = el.getAttribute('data-chip'))) { chip = k; renderPage(); focusKey('chip:' + k) || focusFirst(); return; }
        if ((k = el.getAttribute('data-opt'))) { toggle(k); return; }
        if ((k = el.getAttribute('data-certrow'))) { selectCert(k); return; }
        if ((k = el.getAttribute('data-srcrow'))) { selectSource(k); return; }
        if ((k = el.getAttribute('data-src'))) { srcFilter = k; chip = 'all'; apps = visible(catalogApps); renderPage(); focusKey('src:' + k) || focusFirst(); return; }
        if ((k = el.getAttribute('data-var'))) { sheet.v = parseInt(k, 10); renderSheet(); return; }
        if ((k = el.getAttribute('data-cert'))) { chooseCert(sheet.mode === 'upload' ? uploadApp(upload).variants[0] : sheet.app.variants[sheet.v], k); renderSheet(); focusKey('cert:' + k); return; }
        if ((k = el.getAttribute('data-gone'))) { var g = goneByKey(k); if (g) openSheet({ mode: 'gone', entry: g }); return; }
        if (el.getAttribute('data-tvapp')) { move('right'); return; }   // an app that is not in the catalog has no sheet: on to its panel
        if ((k = el.getAttribute('data-app'))) { var x = byKey(k), vi = el.getAttribute('data-vi'); if (x) openApp(x, vi != null ? parseInt(vi, 10) : null); return; }
        switch (act) {
            case 'upinstall': if (!el.disabled) installUpload(); return;
            case 'updiscard': discardUpload(); return;
            case 'author': var by = sheet.app.author; closeSheet(function () { searchFor(by); }); return;
            case 'pin': togglePin(sheet.app, sheet.v); renderPage(); renderSheet(); focusKey('pin'); return;
            case 'retry': location.reload(); return;
            case 'selfack': selfResult = null; xhr('POST', '/selfupdate/ack', { version: VERSION }, function () {}); renderPage(); focusFirst(); return;
            case 'dismissself': settings.hideSelfNotice = el.getAttribute('data-v') || ''; saveSettings(); renderPage(); focusFirst(); return;
            case 'allvars': sheet.all = true; renderSheet(); focusKey('var:' + sheet.v); return;
            case 'install': if (!el.disabled) startInstall(sheet.app, sheet.v, { switchSource: !!heldElsewhere(sheet.app, sheet.app.variants[sheet.v]) }); return;
            case 'open': var s = state(sheet.app); launch(tvAppId(sheet.app.variants[s.variant])); return;
            case 'openjob': launch(job.appId || job.v.appId); return;
            case 'close': closeSheet(); return;
            case 'retryjob': startInstall(job.app, job.vIdx, { switchSource: !!heldElsewhere(job.app, job.v) }); return;
            case 'replacejob': startInstall(job.app, job.vIdx, { replace: true, switchSource: !!heldElsewhere(job.app, job.v) }); return;
            case 'replaceother': startInstall(job.app, job.vIdx, { replaceOther: true, switchSource: !!heldElsewhere(job.app, job.v) }); return;
            case 'adultyes': setSetting('showAdult', true); return;
            case 'adultno': confirmingAdult = false; renderSheet(); focusKey('opt:showAdult'); return;
            case 'certdefault': certAction('/cert/default', function (id) { renderSheet(); focusKey('certrow:' + id); }); return;
            case 'certremove': certConfirm = true; renderSheet(); focusKey('certremoveno'); return;
            case 'certremoveno': certConfirm = false; renderSheet(); focusKey('certremove'); return;
            case 'srcyes': answerOffer(true); return;
            case 'movedadd': var mu = el.getAttribute('data-url'), mf = el.getAttribute('data-fp'), mn = el.getAttribute('data-name');
                if (sheet) closeSheet(function () { renderPage(); addMoved(mu, mf, mn); }); else addMoved(mu, mf, mn); return;
            case 'movedlater': movedSeen.push(el.getAttribute('data-url')); try { window.localStorage.setItem(MOVED_SEEN_KEY, JSON.stringify(movedSeen)); } catch (e) {} handPage(); renderPage(); focusFirst(); return;
            case 'srcno': answerOffer(false); return;
            case 'srctoggle': var cur = null; ((ready && ready.sources) || []).forEach(function (t) { if (t.repositoryId === srcSel) cur = t; });
                sourceAction('/sources/enable', { enabled: !!(cur && cur.enabled === false) }, function (id) { renderSheet(); focusKey('srcrow:' + id); }); return;
            case 'srcremove': srcConfirm = true; renderSheet(); focusKey('srcremoveno'); return;
            case 'srcremoveno': srcConfirm = false; renderSheet(); focusKey('srcremove'); return;
            case 'srcremoveyes': sourceAction('/sources/remove', {}, function () { srcSel = null; renderSheet(); focus(focusables()[0]); }); return;
            case 'certremoveyes': certAction('/cert/remove', function () { certSel = null; renderSheet(); focus(focusables()[0]); }); return;
            case 'tvupd': updateOne(tvSel); return;
            case 'tvsheet': openApp(tvSel); return;
            case 'gonesheet': if (tvSel && tvSel.gone) openSheet({ mode: 'gone', entry: tvSel }); return;
            case 'goneopen': var ge = sheet && sheet.mode === 'gone' ? sheet.entry : tvSel; if (ge && ge.appId) launch(ge.appId); return;
            case 'tvopen': launch(tvAppId(tvSel.variants[state(tvSel).variant])); return;
            case 'tvpin': togglePin(tvSel, state(tvSel).variant); renderPage(); focusKey('tvpin'); return;
            case 'tvremove': askRemove(); return;
            case 'removeyes': doRemove(); return;
            case 'tvappopen': if (tvSel && tvSel.other && tvSel.appId) launch(tvSel.appId); return;
            case 'vetro': launch(VETRO_APP); return;
            case 'updall': updateAll(); return;
            case 'backupopen': openBackup(); return;
            case 'backupnew': endBackupOffer(); openBackup(); return;
            case 'backupclose': backupToSettings(); return;
            case 'restoreyes': if (!el.disabled) answerRestore(true); return;
            case 'restoreno': if (!el.disabled) answerRestore(false); return;
            case 'restoredone': location.reload(); return;
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
        focusOnly(el);
        reveal(el);
        if (el.getAttribute && el.getAttribute('data-app') && view === 'install' && !sheet) {
            var x = byKey(el.getAttribute('data-app'));
            if (x && x !== hover) { hover = x; showSel(selCard(x)); }
        }
        if (el.getAttribute && el.getAttribute('data-app') && view === 'tv' && !sheet) {
            var y = byKey(el.getAttribute('data-app'));
            if (y && y !== tvSel) { tvSel = y; showPanel(tvPanel(y)); }
        }
        if (el.getAttribute && el.getAttribute('data-gone') && view === 'tv' && !sheet) {
            var gk = el.getAttribute('data-gone');
            if (!tvSel || tvSel.key !== gk) { var gs = tvRowOf(tvGoneNow, gk); if (gs) { tvSel = gs; showPanel(tvPanel(gs)); } }
        }
        if (el.getAttribute && el.getAttribute('data-tvapp') && view === 'tv' && !sheet) {
            var ok = el.getAttribute('data-tvapp');
            if (!tvSel || tvSel.key !== ok) { var os = tvRowOf(tvOtherNow, ok); if (os) { tvSel = os; showPanel(tvPanel(os)); } }
        }
    }
    // Give the element the focus without the browser scrolling to it: a TV browser brings a focused
    // element that is cut off to the middle of its row, so the seventh card of a row moved the row
    // three and a half cards instead of one, and reveal() below then found nothing left to do
    // (#126). preventScroll asks for that; browsers that do not know it (Tizen 5 and older) get
    // every scroll offset above the element put back.
    function focusOnly(el) {
        var boxes = [], n;
        for (n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) boxes.push([n, n.scrollLeft, n.scrollTop]);
        try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
        boxes.forEach(function (b) {
            if (b[0].scrollLeft !== b[1]) b[0].scrollLeft = b[1];
            if (b[0].scrollTop !== b[2]) b[0].scrollTop = b[2];
        });
    }
    // Whether a row shows this element: a card scrolled out of its row is still in the page, at a
    // place left or right of what the row shows.
    function inRow(el) {
        var strip = closest(el, 'strip');
        if (!strip) return true;
        var sr = strip.getBoundingClientRect(), r = el.getBoundingClientRect(), mid = (r.left + r.right) / 2;
        return mid > sr.left && mid < sr.right;
    }
    // Left and right inside a row of cards, and around its "Show all" (#126). A row is a line: the
    // next card is the next one in it, shown or not. At its last card, right goes to the row's
    // "Show all" when it has one, and from there right goes nowhere and left goes back to the last
    // card the row shows. Left at its first card goes nowhere either: it went to whatever stood
    // nearest, a category chip or another row. Returns the element to focus, null to stay, undefined
    // when the element is not in a row (the grid of one category and everything else go by position).
    function rowStep(cur, dir) {
        var sect = closest(cur, 'sect');
        if (!sect || sect.classList.contains('grid')) return undefined;
        var cards = Array.prototype.slice.call(sect.querySelectorAll('.strip .card.f')), link = sect.querySelector('.shead .link.f');
        if (cur === link) {
            if (dir === 'right') return null;
            var shown = cards.filter(inRow);
            return shown.length ? shown[shown.length - 1] : null;
        }
        var i = cards.indexOf(cur);
        if (i < 0) return undefined;
        if (dir === 'left') return i > 0 ? cards[i - 1] : null;
        return i < cards.length - 1 ? cards[i + 1] : (link || null);
    }
    // Scroll whatever clips the element so that it shows: a row of cards sideways, the page and the
    // variant list vertically. Rows and the page have overflow hidden; their scroll offsets still work.
    function reveal(el) {
        var strip = closest(el, 'strip');
        if (strip) {
            // The card at its resting size: the focused one is scaled up, and measured that way (or
            // halfway through the transition) the sixth card of a row that fits six looked as if it
            // stuck out, so the whole row moved a little (#126). The scale keeps the centre in place.
            // The room kept at each side is the strip's own padding, which is where a row at rest
            // has its first and its sixth card.
            var sr = strip.getBoundingClientRect(), er = el.getBoundingClientRect(), cs = window.getComputedStyle(strip);
            var mid = (er.left + er.right) / 2, half = el.offsetWidth / 2, left = mid - half, right = mid + half;
            var padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
            // A row moves by whole cards, so the first card it shows always stands where the first
            // card of a row at rest stands, and nothing of the card before it shows at the edge.
            var pitch = el.offsetWidth + (parseFloat(window.getComputedStyle(el).marginRight) || 0);
            if (left < sr.left + padL) strip.scrollLeft = el.offsetLeft - padL;
            else if (right > sr.right - padR) strip.scrollLeft = Math.ceil((strip.scrollLeft + right - sr.right + padR) / pitch - 0.01) * pitch;
        }
        var boxes = [closest(el, 'vscroll'), closest(el, 'page')];
        boxes.forEach(function (box) {
            if (!box) return;
            var br = box.getBoundingClientRect(), r = el.getBoundingClientRect(), m = 20;
            if (box === pageEl && !closest(el, 'sect') && !closest(el, 'group') && !closest(el, 'panel')) { box.scrollTop = 0; return; }
            // A card in the first line of its section brings the section's heading along.
            var sect = box !== pageEl && closest(el, 'sect'), top = r.top;
            // The rows of the store stand in fixed places (#126): the list moves by whole rows, so
            // the first row it shows always stands where the first row stands when the store opens,
            // going down and going up. It used to move just far enough to show the card, which
            // left the rows at one height going down and at another going up.
            if (sect && rowsFit && box.id === 'rows') {
                var all = Array.prototype.slice.call(box.querySelectorAll('.sect')), i = all.indexOf(sect), pad = parseFloat(window.getComputedStyle(box).paddingTop) || 0;
                var below = function (s) { return s.getBoundingClientRect().top - br.top - pad; };
                var first = 0, near = 1e9;
                all.forEach(function (s, n) { var d = Math.abs(below(s)); if (d < near) { near = d; first = n; } });
                if (i < first) first = i; else if (i > first + rowsFit - 1) first = i - rowsFit + 1;
                var by = Math.round(below(all[first]));
                if (by) box.scrollTop += by;
                return;
            }
            // One category or a search (#126): the list moves by whole lines of cards.
            if (sect && linesFit && box.id === 'rows' && sect.classList.contains('lines')) {
                var c0 = sect.querySelector('.card'), line = Math.round((el.offsetTop - c0.offsetTop) / linePitch), firstLine = Math.round(box.scrollTop / linePitch);
                if (line < firstLine) firstLine = line; else if (line > firstLine + linesFit - 1) firstLine = line - linesFit + 1;
                if (box.scrollTop !== firstLine * linePitch) box.scrollTop = firstLine * linePitch;
                return;
            }
            if (sect) { var sr2 = sect.getBoundingClientRect(); if (r.top - sr2.top < 90) top = sr2.top + m - 6; }
            // The first app of a group on the TV page brings the group's heading along (#126):
            // coming back up, "Up to date" stood cut in half above its first app.
            var grp = box !== pageEl && closest(el, 'group'), lab = grp && el === grp.firstElementChild ? grp.previousElementSibling : null;
            if (lab && lab.classList.contains('glabel')) top = lab.getBoundingClientRect().top + m;
            if (top < br.top + m) box.scrollTop -= (br.top + m - top);
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
        // On the TV page the panel on the right belongs to the selected row: right from a row goes to
        // the panel's first button, left from the panel's first button back to that row. By distance
        // alone the search box at the top won from the first row (#29).
        // Inside the panel the buttons are a line of their own (#126): left goes to the button
        // before, and only from the first one to the row; up goes to the header and down nowhere.
        // Left went to the row from every button, and up and down went to whichever row of the
        // list stood nearest, which selected another app.
        var inPanel = !sheet && view === 'tv' && !!closest(cur, 'tvpanel');
        if (!sheet && view === 'tv') {
            var pb = all.filter(function (el) { return closest(el, 'tvpanel'); }), upd = pageEl.querySelector('[data-k="updall"]');
            if (dir === 'right' && closest(cur, 'tvlist') && pb.length) return focus(pb[0]);
            // "Update all" stands right above the panel: up from any of the panel's buttons goes to
            // it, and down from it to the panel's first button. By distance, up from a wide button
            // passed it for the header, and down from it landed on Uninstall.
            if (dir === 'up' && inPanel && upd && !upd.disabled) return focus(upd);
            if (dir === 'down' && cur === upd && pb.length) return focus(pb[0]);
        }
        if (!sheet && (dir === 'left' || dir === 'right')) { var step = rowStep(cur, dir); if (step !== undefined) { if (step) focus(step); return; } }
        var a = cur.getBoundingClientRect(), ax = (a.left + a.right) / 2, ay = (a.top + a.bottom) / 2, best = null, bestScore = 1e9, curList = closest(cur, 'vscroll');
        all.forEach(function (el) {
            // A card its row does not show is not a place to go to from outside that row: from
            // "Show all" the nearest thing to the right was such a card in another row (#126).
            if (el === cur || !inRow(el)) return;
            if (inPanel && closest(el, 'tvlist')) return;
            var b = el.getBoundingClientRect(), bx = (b.left + b.right) / 2, by = (b.top + b.bottom) / 2, main, cross;
            // Left and right stay on their own line: by distance alone, right from the Settings
            // gear went down to a row's "Show all" and left from the first card of a grid went up
            // to a category chip (#126).
            if ((dir === 'left' || dir === 'right') && (b.bottom <= a.top || b.top >= a.bottom)) return;
            // From outside a list, only what the list shows is a place to go to: a row that has
            // scrolled up out of it lies behind the header and the chips, where it was the nearest
            // thing to the gear and to a chip (#126). Inside the list the scroll follows the focus.
            var list = closest(el, 'vscroll');
            if (list && list !== curList) { var lr = list.getBoundingClientRect(); if (by < lr.top || by > lr.bottom) return; }
            if (dir === 'left') { if (b.right > a.left + 4 && bx >= ax) return; main = a.left - b.right; cross = Math.abs(by - ay); }
            else if (dir === 'right') { if (b.left < a.right - 4 && bx <= ax) return; main = b.left - a.right; cross = Math.abs(by - ay); }
            else if (dir === 'up') { if (b.bottom > a.top + 4 && by >= ay) return; main = a.top - b.bottom; cross = Math.abs(bx - ax); }
            else { if (b.top < a.bottom - 4 && by <= ay) return; main = b.top - a.bottom; cross = Math.abs(bx - ax); }
            var score = Math.max(main, 0) + cross * (dir === 'left' || dir === 'right' ? 3 : 0.6);
            if (score < bestScore) { bestScore = score; best = el; }
        });
        if (best) return focus(best);
        if (inPanel && dir === 'left' && tvSel) { var row = pageEl.querySelector('[data-k="tv:' + tvSel.key.replace(/"/g, '\\"') + '"]'); if (row) return focus(row); }
        // Nothing left to move to: what follows may be text only (the tables and QR codes at the end
        // of Settings), so the list itself scrolls on. In a sheet only: under the last row of the
        // store there is nothing to read, and the row moved up a little for it (#126).
        if (sheet && (dir === 'down' || dir === 'up')) { var box = closest(cur, 'vscroll'); if (box) box.scrollTop += dir === 'down' ? 260 : -260; }
    }

    function back() {
        if (sheet) {
            if (sheet.mode === 'settings' && confirmingAdult) { confirmingAdult = false; renderSheet(); focusKey('opt:showAdult'); return; }
            if (sheet.mode === 'source') { answerOffer(false); return; }
            if (sheet.mode === 'backup') { backupToSettings(); return; }
            if (sheet.mode === 'restore') { if (restoreState && restoreState.done) location.reload(); else answerRestore(false); return; }
            if (sheet.mode === 'remove' && sheet.state === 'busy') return;   // the TV is at it; the answer comes
            if (sheet.mode === 'settings' && srcSel) { var sid = srcSel; if (srcConfirm) { srcConfirm = false; renderSheet(); focusKey('srcremove'); return; } srcSel = null; renderSheet(); focusKey('srcrow:' + sid); return; }
            if (sheet.mode === 'settings' && certSel) { var id = certSel; if (certConfirm) { certConfirm = false; renderSheet(); focusKey('certremove'); return; } certSel = null; renderSheet(); focusKey('certrow:' + id); return; }
            closeSheet(); return;
        }
        if (document.activeElement === searchEl && query) { query = ''; searchEl.value = ''; renderPage(); return; }
        if (view === 'tv' && query) { query = ''; searchEl.value = ''; renderPage(); focusFirst(); return; }
        if (view === 'tv') { view = 'install'; renderPage(); focusFirst(); return; }
        if (chip !== 'all' || query) { chip = 'all'; query = ''; searchEl.value = ''; renderPage(); focusFirst(); return; }
        try { tizen.application.getCurrentApplication().exit(); } catch (x) {}
    }

    // The search box stays read-only while the remote moves over it: the TV opens its keyboard for any
    // text field that takes focus, so passing the box on the way to Settings popped the keyboard up.
    // OK on the box makes it editable and opens the keyboard; Done, Cancel or Back closes it again.
    function typing() { return document.activeElement === searchEl && !searchEl.readOnly; }
    function startTyping() {
        searchEl.blur();
        searchEl.readOnly = false;
        searchEl.focus();   // focus again now that it is editable, so the keyboard opens
        try { var n = searchEl.value.length; searchEl.setSelectionRange(n, n); } catch (x) {}
    }
    function stopTyping() {
        searchEl.readOnly = true;
        if (document.activeElement === searchEl) { searchEl.blur(); searchEl.focus(); }   // closes the keyboard, keeps the focus ring
    }
    searchEl.readOnly = true;
    searchEl.addEventListener('blur', function () { if (!searchEl.readOnly) searchEl.readOnly = true; });

    document.addEventListener('keydown', function (e) {
        var k = e.keyCode, inInput = typing();
        lastKey = Date.now();
        if (inInput && (k === KEY.ENTER || k === KEY.IME_DONE || k === KEY.IME_CANCEL || k === KEY.RETURN || k === KEY.ESC)) { e.preventDefault(); stopTyping(); return; }
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
    // The box searches the page it stands above: the catalog on the store, the TV's apps under On the TV.
    searchEl.addEventListener('input', function () { query = searchEl.value.trim(); renderPage(); });

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
                        if (res && res.ok) setReady({ ok: true, certReady: true, certCount: res.certCount || 1, certNames: certs && certs.certificates ? certs.certificates.map(function (c) { return c.name; }) : [], certificates: res.certificates || null, ownIp: ready && ready.ownIp, node: ready && ready.node });
                        resolve(res || { ok: false, error: 'no answer from the service' });
                    });
                })();
            });
        },
        // Send sources to TV (#82, Apps2Samsung#1018): [{ url, repositoryId, fingerprint, name?,
        // publicKeyPem? }], the signed repositories the user approved in Apps2Samsung. Each one is
        // checked by the service and shown on the TV for a yes or no; the promise resolves once all
        // are answered: { ok, results: [{ url, repositoryId, added, name?, error? }] }. /ping's
        // sources (A2SStore.status()) says what the TV holds at any time.
        addSources: function (list) {
            return new Promise(function (resolve) {
                list = Array.isArray(list) ? list : list ? [list] : [];
                var results = [], left = list.length;
                if (!left) return resolve({ ok: true, results: [] });
                list.forEach(function (src, i) {
                    offerSource(src && typeof src === 'object' ? src : {}, function (r) { results[i] = r; if (--left === 0) resolve({ ok: true, results: results }); });
                });
            });
        },
        // Backup and restore of TV-Store's own data (#146), for Apps2Samsung's Backup & restore.
        // backup({ secrets: false }) leaves the certificates and the apps' settings out. Resolves
        // { ok, backup }: the object to keep as it is (service/backup.js has the format).
        backup: function (opts) {
            return new Promise(function (resolve) {
                withUploadToken(function () {
                    xhr('POST', '/backup/make', { token: uploadToken, page: pageState(), app: backupMeta(), secrets: !(opts && opts.secrets === false) }, function (err, res) {
                        resolve(err ? { ok: false, error: err.message } : res || { ok: false, error: 'no answer from the service' });
                    });
                });
            });
        },
        // restore(backup): the object backup() gave, or its JSON text. The service checks it, the TV
        // shows what it holds, and the promise resolves once the person at the TV answered:
        // { ok: true, restored: true, applied: { certificates, sources, userSettings } }, or
        // { ok: true, restored: false, error } when declined, or { ok: false, error } when the
        // service refused the file. TV-Store starts again after a restore.
        restore: function (data) {
            return new Promise(function (resolve) {
                withUploadToken(function () {
                    xhr('POST', '/backup/take', { token: uploadToken, backup: data }, function (err, res) {
                        if (err || !res || !res.ok || !res.restore) return resolve({ ok: false, error: err ? err.message : (res && res.error) || 'no answer from the service' });
                        restoreWaiters[res.restore.id] = { resolve: resolve, at: Date.now() };
                    });
                });
            });
        }
    };

    // Until a head arms the TV, ask the service now and then, so the first-run screen turns into the
    // store by itself (an arm from an older head never touches this page's API). The same tick asks
    // for a file sent from a phone or PC (#30) and shows it once, when no sheet is open.
    setInterval(function () {
        if (loading || problem || reviving) return;
        nextOffer();
        if (!armed()) xhr('GET', '/ping', null, function (err, res) { if (!err) setReady(res); });
        refreshRelay();
        if (!document.hidden && Date.now() >= catalogDue) refreshCatalog();
        showCatalog();
        autoUpdate();
        sendPlan();
        pushStore(true);
        xhr('GET', '/uploads', null, function (err, res) {
            if (err || !res) { if (++missed >= 3) revive(); return; }
            missed = 0;
            takeAuto(res.auto);
            if (backupTick(res)) return;
            var was = upload; upload = res.pending || null;
            if (upload && upload.id !== seenUpload && !sheet) { seenUpload = upload.id; openSheet({ mode: 'upload' }); return; }
            if (sheet && sheet.mode === 'upload' && (!!was !== !!upload || (was && upload && was.id !== upload.id))) renderSheet(true);
        }, null, 2500);
    }, 3000);
    // The small copies of the TV's own icons, one at a time while the remote rests.
    if (thumbsWork) setInterval(nextThumb, 250);

    // The service can die while TV-Store stays open: a TV put to sleep with the store on screen came
    // back with the page but no service, and every action failed. When the TV wakes the page up, or
    // the service misses three ticks in a row, start it again the way boot does. config.xml asks the
    // platform to restart it too (auto-restart); this covers the TVs that do not.
    var missed = 0, reviving = false;
    function revive() {
        if (reviving || loading || problem) return;
        reviving = true; missed = 0;
        startService(function (err, ping) {
            reviving = false;
            if (err) { problem = { title: 'The TV-Store service stopped', short: 'Service stopped', text: err.message + ' Close TV-Store and open it again; if it keeps happening, reinstall it from Apps2Samsung.' }; if (sheet) closeSheet(); renderPage(); focusFirst(); return; }
            withUploadToken(function () {});
            setReady(ping); syncVerbose(); handPage();
        });
    }
    document.addEventListener('visibilitychange', function () {
        if (document.hidden || loading || problem || reviving) return;
        xhr('GET', '/ping', null, function (err, res) { if (err || !res) revive(); else setReady(res); }, null, 2500);
    });

    // ---- opened on an app by another app (#102) ----------------------------------------------------
    // Another app on the TV (Vetro's "Get apps", say) can launch TV-Store with an app control whose data
    // has `app`: a catalog name ("Jellyfin"), a package id or an app id. TV-Store then opens that app's
    // page, where the user decides; nothing installs by itself. Once per request: the boot reads the
    // one TV-Store was started with, the appcontrol event a later one while TV-Store is already open.
    var requestedHandled = null;
    function requestedApp() {
        try {
            var req = tizen.application.getCurrentApplication().getRequestedAppControl();
            var data = (req && req.appControl && req.appControl.data) || [];
            for (var i = 0; i < data.length; i++)
                if (data[i].key === 'app' && data[i].value && data[i].value.length) return String(data[i].value[0]).trim();
        } catch (e) { /* not started with an app control */ }
        return null;
    }
    function findRequested(want) {
        var w = want.toLowerCase();
        var byName = catalogApps.filter(function (x) { return (x.name || '').toLowerCase() === w; });
        if (byName.length) return byName.filter(function (x) { return x.source === 'official'; })[0] || byName[0];
        for (var i = 0; i < catalogApps.length; i++) {
            var vs = catalogApps[i].variants || [];
            for (var j = 0; j < vs.length; j++)
                if ((vs[j].packageId && vs[j].packageId.toLowerCase() === w) || (vs[j].appId && vs[j].appId.toLowerCase() === w)) return catalogApps[i];
        }
        return null;
    }
    function openRequested() {
        var want = requestedApp();
        if (!want || want === requestedHandled || loading || problem) return;
        requestedHandled = want;
        var x = findRequested(want);
        if (!x) { try { console.log('[TV-Store] asked to open "' + want + '", which is not in the catalog'); } catch (e) {} return; }
        if (sheet && sheet.mode === 'job' && job && job.running) return; // an install is on screen: leave it
        if (sheet) closeSheet();
        openApp(x);
    }
    window.addEventListener('appcontrol', function () { requestedHandled = null; openRequested(); });

    // ---- boot -------------------------------------------------------------------------------------
    renderHeader(); renderFoot(); renderPage(); readDevice();
    withUploadToken(function () {});
    startService(function (err, ping) {
        if (err) { loading = false; problem = { title: 'The TV-Store service did not start', short: 'Service stopped', text: err.message + ' Close TV-Store and open it again; if it keeps happening, reinstall it from Apps2Samsung.' }; renderPage(); focusFirst(); return; }
        ready = ping; renderFoot(); syncVerbose(); handPage();
        if (ping && ping.selfUpdate) selfResult = { mark: ping.selfUpdate, outcome: selfOutcome(ping.selfUpdate) };
        readInstalled(function (map) {
            setInstalled(map);
            xhr('GET', '/catalog', null, function (err, cat) {
                if (err) { loading = false; problem = { title: 'The catalog did not load', short: 'No catalog', text: err.message + '.' }; renderPage(); focusFirst(); return; }
                useCatalog(cat);
                loading = false; rebuild(); renderPage(); focusFirst();
                openRequested();
                // The independent repositories (#82) after the official catalog, which shows meanwhile:
                // a slow one takes up to a minute. One that fails says so in Settings and drops out,
                // and none at all leaves the store as it was.
                loadSources(false, function () {
                    var at = document.activeElement && document.activeElement.getAttribute('data-k');
                    rebuild(); storeComplete = true;
                    if (!sheet) { renderPage(); focusKey(at) || focusFirst(); } else renderHeader();
                    nextOffer();
                    // What the service updated while TV-Store was closed (#157), before the screen updates anything itself.
                    xhr('GET', '/uploads', null, function (err, res) { takeAuto(!err && res ? res.auto : null); }, null, 5000);
                    // An app from an independent repository is only known now.
                    if (requestedApp() && requestedApp() !== requestedHandled) openRequested();
                });
            });
        });
    });
})();
