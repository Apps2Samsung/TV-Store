/* Backup and restore on the TV-Store screen (#146), against the real page script (see
 * page-harness.js). Settings has Back up or restore, which sends what the screen keeps to the
 * service with the page token and shows the code; the sheet says so once a browser took the backup,
 * and the code is given up when the sheet closes. A backup that waits in the service is shown with
 * what it holds, Don't restore has the focus, a yes sends the id, the token and the packages on the
 * TV, and what comes back lands in the screen's storage next to what was there before TV-Store
 * starts again. Apps2Samsung does both through A2SStore. */
'use strict';
var harness = require('./page-harness.js'), page = harness.page, fail = harness.fail;

function catalog() {
    return { schemaVersion: 1, generatedAt: '2026-11-24T10:00:00Z', providers: [{ id: 'moonfin', ok: true, url: 'https://api.github.com/repos/x/moonfin/releases',
        releases: [{ assets: [{ name: 'Moonfin.wgt', browser_download_url: 'https://dl.test/Moonfin.wgt', digest: 'sha256:' + new Array(65).join('a'), package_id: 'MoonPkg001', app_id: 'MoonPkg001.App', package_version: '1.1.0' }] }] }] };
}
function has(html, what, why) { if (html.indexOf(what) < 0) fail(why + ': no ' + JSON.stringify(what) + ' in\n' + html.slice(0, 1800)); }
function hasNot(html, what, why) { if (html.indexOf(what) >= 0) fail(why + ': ' + JSON.stringify(what) + ' is there'); }
var WD = setTimeout(function () { fail('watchdog (15 s)'); }, 15000);

var SUMMARY = { madeAt: '2026-11-20T09:30:00.000Z', tvStore: '0.3.40', tv: 'QE55Q60', duid: 'ABCDEFGH1234', secrets: true, pins: 2, settings: 6,
                certificates: [{ name: 'PC', level: 'public', deviceIds: [] }], sources: [{ name: 'Example', repositoryId: 'org.example.tizen', domain: 'example.org', fingerprint: new Array(65).join('a') }], userSettings: 1 };
var PAGE_BACK = { settings: { showAdult: true, showNeedsHead: false, verboseLog: false, selfUpdate: true, hideSelfNotice: '' }, pins: [{ key: 'official:moonfin', file: 'Moonfin.wgt' }, { key: 'official:other', file: 'Other.wgt' }],
                  certChoice: { MoonPkg001: 'partner', OtherPkg01: 'public' }, movedSeen: ['https://example.org/moved'], variants: { MoonPkg001: 'Moonfin.wgt' }, webVersions: {} };

var tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('Settings hands the screen\'s part to the service and shows the code', function (done) {
    var seen = [], uploads = { ok: true, pending: null };
    var p = page({ catalog: catalog(), installed: { MoonPkg001: '1.1.0' }, storage: { 'a2s.tvstore.pins': [{ key: 'official:moonfin', file: 'Moonfin.wgt' }], 'a2s.store.settings': { showAdult: true } },
        answer: function (method, path, body) {
            if (path === '/backup/offer') { seen.push(body); return body.close ? { ok: true } : { ok: true, code: '482913', until: new Date(Date.now() + 600000).toISOString(), url: 'http://192.168.1.9:8077/backup' }; }
            if (path === '/uploads') return uploads;
        } });
    p.settle(function () {
        p.press('gear');
        has(p.html('sheet'), 'data-act="backupopen"', 'Settings has Back up or restore');
        p.press('', { 'data-act': 'backupopen' });
        p.settle(function () {
            var html = p.html('sheet');
            has(html, '482 913', 'the code, in two groups');
            has(html, 'http://192.168.1.9:8077/backup', 'the address of the backup page');
            if (seen.length !== 1 || seen[0].token !== 'token' || seen[0].page.pins.length !== 1 || seen[0].page.settings.showAdult !== true || seen[0].app.version !== p.window.A2SStore.version) fail('what the screen sent: ' + JSON.stringify(seen));
            uploads = { ok: true, pending: null, backup: { open: false, taken: { from: '192.168.1.20', at: new Date().toISOString() } } };
            p.tick(function () {
                has(p.html('sheet'), 'downloaded by 192.168.1.20', 'the sheet says who took it');
                hasNot(p.html('sheet'), '482 913', 'a used code is no longer shown');
                p.press('', { 'data-act': 'backupnew' });
                p.settle(function () {
                    has(p.html('sheet'), '482 913', 'a new code');
                    p.press('', { 'data-act': 'backupclose' });
                    p.settle(function () {
                        has(p.html('sheet'), 'data-act="backupopen"', 'back in Settings');
                        var last = seen[seen.length - 1];
                        if (!last.close || last.token !== 'token') fail('the code must be given up when its sheet closes: ' + JSON.stringify(last));
                        done();
                    });
                });
            });
        });
    });
});

test('a backup that waits is shown, declined by default, and a yes puts it into the screen\'s storage', function (done) {
    var applies = [], discards = [], uploads = { ok: true, pending: null, restore: { id: 'r1', from: '192.168.1.20', at: '2026-11-24T10:00:00.000Z', summary: SUMMARY, otherTv: true } };
    var p = page({ catalog: catalog(), installed: { MoonPkg001: '1.1.0' }, storage: { 'a2s.tvstore.pins': [{ key: 'official:moonfin', file: 'Moonfin.wgt' }], 'a2s.tvstore.certchoice': { MoonPkg001: 'public' } },
        answer: function (method, path, body) {
            if (path === '/uploads') return uploads;
            if (path === '/backup/discard') { discards.push(body); uploads = { ok: true, pending: null }; return { ok: true }; }
            if (path === '/backup/apply') { applies.push(body); uploads = { ok: true, pending: null }; return { ok: true, applied: { certificates: 1, sources: 1, userSettings: 1 }, page: PAGE_BACK }; }
        } });
    p.settle(function () {
        p.tick(function () {
            var html = p.html('sheet');
            has(html, 'Restore this backup?', 'the question');
            has(html, 'Sent from 192.168.1.20', 'where it came from');
            has(html, 'QE55Q60', 'the TV it was made on');
            has(html, 'Example (example.org)', 'its source');
            has(html, 'PC (Public)', 'its certificate');
            has(html, 'made on another TV', 'a backup of another TV says so');
            has(html, 'data-act="restoreno" data-default', 'Don\'t restore has the focus');
            p.press('', { 'data-act': 'restoreno' });
            p.settle(function () {
                if (discards.length !== 1 || discards[0].id !== 'r1' || applies.length) fail('a no drops the backup: ' + JSON.stringify([discards, applies]));
                if (p.html('sheet') !== '') fail('the sheet closes after a no');
                uploads = { ok: true, pending: null, restore: { id: 'r2', from: '192.168.1.20', at: '2026-11-24T10:05:00.000Z', summary: SUMMARY, otherTv: false } };
                p.tick(function () {
                    hasNot(p.html('sheet'), 'made on another TV', 'this TV\'s own backup');
                    p.press('', { 'data-act': 'restoreyes' });
                    p.settle(function () {
                        if (applies.length !== 1 || applies[0].id !== 'r2' || applies[0].token !== 'token' || JSON.stringify(applies[0].installed) !== '["MoonPkg001"]') fail('what a yes sends: ' + JSON.stringify(applies));
                        has(p.html('sheet'), 'Restored', 'it says so');
                        has(p.html('sheet'), '1 signing certificate, 1 source, the settings of 1 app', 'and what came back');
                        var pins = p.stored('a2s.tvstore.pins'), st = p.stored('a2s.store.settings'), cc = p.stored('a2s.tvstore.certchoice');
                        if (pins.length !== 2 || pins[0].key !== 'official:moonfin' || pins[1].key !== 'official:other') fail('pins are added to those here: ' + JSON.stringify(pins));
                        if (st.showAdult !== true || st.showNeedsHead !== false || st.selfUpdate !== true) fail('the switches are the backup\'s: ' + JSON.stringify(st));
                        if (cc.MoonPkg001 !== 'public' || cc.OtherPkg01 !== 'public') fail('Sign with: what the TV has stays, the rest is added: ' + JSON.stringify(cc));
                        if (p.stored('a2s.tvstore.variants').MoonPkg001 !== 'Moonfin.wgt' || p.stored('a2s.tvstore.movedseen')[0] !== 'https://example.org/moved') fail('the rest of the screen\'s part');
                        if (p.reloads.n) fail('TV-Store starts again only after the result was read');
                        p.press('', { 'data-act': 'restoredone' });
                        if (p.reloads.n !== 1) fail('TV-Store starts again after a restore');
                        done();
                    });
                });
            });
        });
    });
});

test('Apps2Samsung takes a backup and hands one back through A2SStore', function (done) {
    var made = [], took = [], uploads = { ok: true, pending: null };
    var p = page({ catalog: catalog(), installed: {}, storage: { 'a2s.tvstore.pins': [{ key: 'official:moonfin', file: 'Moonfin.wgt' }] },
        answer: function (method, path, body) {
            if (path === '/uploads') return uploads;
            if (path === '/backup/make') { made.push(body); return { ok: true, backup: { format: 'a2s-tvstore-backup', version: 1 } }; }
            if (path === '/backup/take') { took.push(body); if (body.backup === 'junk') return { ok: false, error: 'that file is not a TV-Store backup' }; uploads = { ok: true, pending: null, restore: { id: 'r9', from: 'Apps2Samsung', at: '2026-11-24T10:00:00.000Z', summary: SUMMARY, otherTv: false } }; return { ok: true, restore: uploads.restore }; }
            if (path === '/backup/apply') { uploads = { ok: true, pending: null }; return { ok: true, applied: { certificates: 0, sources: 0, userSettings: 0 }, page: {} }; }
        } });
    p.settle(function () {
        var api = p.window.A2SStore;
        api.backup({ secrets: false }).then(function (r) {
            if (!r.ok || r.backup.format !== 'a2s-tvstore-backup' || made.length !== 1 || made[0].token !== 'token' || made[0].secrets !== false || made[0].page.pins.length !== 1) fail('A2SStore.backup: ' + JSON.stringify([r, made]));
            return api.restore('junk');
        }).then(function (r) {
            if (r.ok || !/not a TV-Store backup/.test(r.error)) fail('A2SStore.restore of junk: ' + JSON.stringify(r));
            var answered = null;
            api.restore({ format: 'a2s-tvstore-backup', version: 1 }).then(function (r) { answered = r; });
            p.settle(function () {
                if (answered) fail('the promise waits for the person at the TV');
                p.tick(function () {
                    has(p.html('sheet'), 'Sent from Apps2Samsung', 'the TV asks');
                    p.press('', { 'data-act': 'restoreyes' });
                    p.settle(function () {
                        if (!answered || !answered.ok || answered.restored !== true || !answered.applied) fail('the answer after a yes: ' + JSON.stringify(answered));
                        done();
                    });
                });
            });
        });
    });
});

(function next() {
    var t = tests.shift();
    if (!t) { clearTimeout(WD); console.log('PASS: the code sheet, the restore question and A2SStore.backup / restore'); process.exit(0); }
    t[1](function () { next(); });
})();
