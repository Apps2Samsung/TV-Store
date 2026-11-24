/* The apps on this TV as the TV lists them, and its answer to a removal (#142). Pure, so
 * test/tvapps.test.js covers every reading. ES5 for the TV's Node 4.4.3.
 *
 * sdbd's `0 vd_applist` prints one block per app between rules of dashes, each line
 * `--------------<key>   =<value>-------------`: app_id (the Samsung store's number, empty for a
 * sideloaded app), app_title, app_version, install_date, app_tizen_id (what the TV calls the app:
 * `9Ur5IzDKqV.TizenYouTube`, or `org.tizen.netflix-app` for one that came with the TV), app_size
 * in bytes, and is_removable: 1 when the TV's own Apps menu offers Delete for it. Apps2Samsung
 * reads the same listing (TizenInstalledApps.cs).
 *
 * `0 vd_appuninstall <app_tizen_id>` removes one. Its answer has "fail" or "error" in it when the
 * TV did not; "failed[132]" means the app was not there. What counts in the end is the listing
 * read again: an app that is gone from it is removed, whatever the words were.
 */
'use strict';

var FIELD = /^\s*-{3,}\s*([^\s=]+)\s*=\s*(.*?)\s*-{3,}\s*$/;
// An id as it goes into the command: sdbd splits the line on whitespace, so nothing else gets in.
var SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isRule(line) { return line.indexOf('=') < 0 && line.indexOf('----') >= 0 && line.replace(/-/g, '').trim() === ''; }

// -> [{ id, title, storeId, version, installed, size, removable }], one per app_tizen_id, in the
// TV's order. Lines that are not part of a block (the count, the timing) are skipped.
function parse(text) {
    var apps = [], seen = {}, cur = {};
    function flush() {
        var id = String(cur.app_tizen_id || '').trim();
        if (id && !seen.hasOwnProperty(id)) {
            seen[id] = true;
            var size = parseInt(cur.app_size, 10);
            apps.push({ id: id, title: cur.app_title || '', storeId: cur.app_id || '', version: cur.app_version || '', installed: cur.install_date || '',
                        size: size > 0 ? size : 0, removable: cur.is_removable === '1' });
        }
        cur = {};
    }
    String(text || '').replace(/\r/g, '').split('\n').forEach(function (line) {
        if (isRule(line)) return flush();
        var m = FIELD.exec(line);
        if (m) cur[m[1]] = m[2].trim();
    });
    flush();
    return apps;
}

// Whether the text is a listing at all: one that lists nothing still says "apps count: 0", which
// is an answer; a dead link or a verb the TV does not know is not.
function isListing(text) { return /apps count:\s*\d+/i.test(String(text || '')) || parse(text).length > 0; }

// Whether the app `id` is (part of) the package `pkg`: `AbCdEfGhIj.App` belongs to `AbCdEfGhIj`,
// and an app that came with the TV is its own package (`org.tizen.netflix-app`, which is no part
// of a package `org.tizen`: a package id that is a prefix has no dot in it).
function belongs(id, pkg) { return !!pkg && (id === pkg || (pkg.indexOf('.') < 0 && String(id).indexOf(pkg + '.') === 0)); }

// The app the page means: by the TV's own id, or by its package id.
function find(apps, want) {
    var i;
    for (i = 0; i < apps.length; i++) if (apps[i].id === want) return apps[i];
    for (i = 0; i < apps.length; i++) if (belongs(apps[i].id, want)) return apps[i];
    return null;
}

// The package an app is in, for what TV-Store remembers per package.
function packageOf(id) { var m = /^([A-Za-z0-9]{10})\.[^.]+$/.exec(id); return m ? m[1] : id; }

// What the TV answered to a removal -> { ok, gone, text }: gone when it says the app was not there.
function verdict(reply) {
    var text = String(reply || '').replace(/\s+/g, ' ').trim();
    if (/failed\s*\[\s*132\s*\]/i.test(text)) return { ok: true, gone: true, text: text };
    return { ok: !/fail|error/i.test(text), gone: false, text: text };
}

module.exports = { parse: parse, isListing: isListing, belongs: belongs, find: find, packageOf: packageOf, verdict: verdict, SAFE_ID: SAFE_ID };
