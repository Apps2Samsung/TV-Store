/* An app's user settings (usersettings.js), rule for rule against Apps2Samsung's UserSettingsPatcher /
 * UserSettingsStore, on specs as the live catalog has them (Baobab: single quotes and a required URL;
 * Vetro: a port with min, max, disallow, a default and five targets in three files; TizenAmbilight:
 * numbers in a JSON file): normalize, validate, escape, resolve (typed over stored over default, only
 * typed values kept), the edits, and the patch on a real package (every occurrence, signature files
 * dropped, a missing text or file refused with SETTINGS_PATCH). Pure; no service. */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path');
var us = require('../tizen-app/service/usersettings.js');
var zip = require('../tizen-app/service/zip.js');
var Buf = require('../tizen-app/service/compat.js');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) fail(what + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }

var BAOBAB = { help_url: 'https://github.com/Gonqas/baobab#readme', file: 'js/config.js', fields: [
    { key: 'api_base_url', label: 'Baobab server URL', type: 'text', required: true, pattern: '^https?://[^\\s\'\\"\\\\]+$', find: 'API_BASE_URL: \'\',', replace: 'API_BASE_URL: \'{value}\',', isNumber: false },
    { key: 'screen_key', label: 'Screen key', type: 'text', required: true, pattern: '^[A-Za-z0-9._-]+$', find: 'SCREEN_KEY: \'\',', replace: 'SCREEN_KEY: \'{value}\',', isNumber: false }] };
var VETRO = { help_url: 'https://x.test', file: '', fields: [{ key: 'port', label: 'Dashboard port', type: 'number', required: false, find: '', replace: '', default: '8099', min: 1024, max: 65535, disallow: [8001, 8002, 26101], isNumber: true,
    targets: [{ file: 'config.xml', find: '<access origin="http://127.0.0.1:8099" subdomains="false"/>', replace: '<access origin="http://127.0.0.1:{value}" subdomains="false"/>' },
              { file: 'index.html', find: 'var BASE = \'http://127.0.0.1:8099\';', replace: 'var BASE = \'http://127.0.0.1:{value}\';' },
              { file: 'service/main.js', find: '|| buildInfo.port || 8099;', replace: '|| buildInfo.port || {value};' }] }] };
var KEYS = { file: 'js/keys.local.js', fields: [{ key: 'tmdb', label: 'TMDB API key (v3), for the live Top Shelf; optional', type: 'text', required: false, pattern: '^[A-Za-z0-9]+$', find: 'tmdb: "",', replace: 'tmdb: "{value}",' }] };

// normalize / publicSpec
var b = us.normalize(BAOBAB), v = us.normalize(VETRO), k = us.normalize(KEYS);
if (!b || b.fields.length !== 2 || b.file !== 'js/config.js' || b.help !== 'https://github.com/Gonqas/baobab#readme') fail('normalize Baobab: ' + JSON.stringify(b));
if (!v || v.fields[0].targets.length !== 3 || v.fields[0].default !== '8099' || !v.fields[0].isNumber) fail('normalize Vetro: ' + JSON.stringify(v));
if (us.normalize({ file: 'x', fields: [{ key: 'a' }] }) !== null) fail('a field without find or targets is dropped');
if (us.normalize(null) !== null || us.normalize({ fields: 'x' }) !== null) fail('no spec');
if (us.normalize({ help_url: 'javascript:alert(1)', file: 'a', fields: [{ key: 'a', find: 'x', replace: 'y' }] }).help !== '') fail('only an https help link');
var pub = us.publicSpec(b);
if (JSON.stringify(pub).indexOf('API_BASE_URL') >= 0 || pub.fields[0].key !== 'api_base_url') fail('publicSpec must not carry find / replace: ' + JSON.stringify(pub));

// validate (Apps2Samsung's Validate)
var port = v.fields[0];
eq(us.validate(b.fields[0], ''), 'Fill this in.', 'required');
eq(us.validate(k.fields[0], '  '), null, 'optional empty');
eq(us.validate(port, '80a'), 'Digits only.', 'digits');
eq(us.validate(port, '80'), 'A number from 1024 to 65535.', 'range low');
eq(us.validate(port, '99999999999999999999'), 'A number from 1024 to 65535.', 'range huge');
eq(us.validate(port, '8001'), '8001 is not allowed here.', 'disallow');
eq(us.validate(port, '9000'), null, 'port ok');
eq(us.validate(b.fields[0], 'ftp://x'), 'That does not look right for this field.', 'pattern');
eq(us.validate(b.fields[0], 'http://192.168.1.10:4000'), null, 'pattern ok');
eq(us.validate({ key: 'x', required: false, isNumber: false, pattern: '([', disallow: [], min: null, max: null }, 'any'), null, 'a broken pattern is skipped');

// escape (Apps2Samsung's Escape)
eq(us.escape('text', "a: '{value}'", "it's\\"), "it\\'s\\\\", 'single quotes');
eq(us.escape('text', 'a: "{value}"', 'say "hi"'), 'say \\"hi\\"', 'double quotes');
eq(us.escape('text', 'a: {value}', "it's"), "it's", 'not in quotes');
eq(us.escape('number', '"{value}"', '12'), '12', 'number as is');

// resolve: typed over stored over default; only typed kept
var r = us.resolve(v, null, null);
eq([r.errors, r.keep, r.values], [null, {}, { port: '8099' }], 'Vetro defaults');
r = us.resolve(v, { port: ' 9000 ' }, null);
eq([r.keep, r.values], [{ port: '9000' }, { port: '9000' }], 'Vetro typed');
r = us.resolve(v, { port: '' }, { port: '9100' });
eq([r.keep, r.values], [{ port: '9100' }, { port: '9100' }], 'empty keeps the stored value');
r = us.resolve(b, { api_base_url: 'http://srv:4000' }, null);
eq(Object.keys(r.errors), ['screen_key'], 'Baobab misses a required field');
r = us.resolve(k, {}, null);
eq([r.errors, r.values], [null, {}], 'optional and empty: nothing written');

// edits
var ed = us.edits(v, { port: '9000' });
eq(ed.map(function (e) { return e.file; }), ['config.xml', 'index.html', 'service/main.js'], 'targets in order');
eq(ed[1].text, "var BASE = 'http://127.0.0.1:9000';", 'target text');
ed = us.edits(b, { api_base_url: "http://a'b", screen_key: 'tv-1' });
eq(ed[0].text, "API_BASE_URL: 'http://a\\'b',", 'escaped into single quotes');

// patch on a real package
var dir = path.join(os.tmpdir(), 'a2s-us-' + process.pid + '-' + Date.now()); fs.mkdirSync(dir);
var inFile = path.join(dir, 'in.wgt'), outFile = path.join(dir, 'out.wgt');
fs.writeFileSync(inFile, zip.write([
    { name: 'config.xml', data: Buf.from('<widget><access origin="http://127.0.0.1:8099" subdomains="false"/></widget>') },
    { name: 'index.html', data: Buf.from("<script>var BASE = 'http://127.0.0.1:8099';</script> again: var BASE = 'http://127.0.0.1:8099';") },
    { name: 'service/main.js', data: Buf.from('var p = env.port || buildInfo.port || 8099;') },
    { name: 'img/logo.png', data: Buf.from([137, 80, 78, 71]) },
    { name: 'author-signature.xml', data: Buf.from('<old/>') }, { name: 'signature1.xml', data: Buf.from('<old/>') }]));
us.patch(inFile, outFile, us.edits(v, { port: '9000' }), function (err, out) {
    if (err) fail('patch: ' + err.message);
    eq(out.keys, ['port'], 'keys written');
    var got = {}; zip.readEntries(fs.readFileSync(outFile)).forEach(function (e) { got[e.name] = e.data.toString('utf8'); });
    if (got['config.xml'].indexOf('127.0.0.1:9000') < 0 || got['index.html'].indexOf('8099') >= 0 || got['index.html'].split('127.0.0.1:9000').length !== 3) fail('every occurrence replaced: ' + JSON.stringify(got));
    if (got['service/main.js'] !== 'var p = env.port || buildInfo.port || 9000;') fail('main.js: ' + got['service/main.js']);
    if (got['author-signature.xml'] || got['signature1.xml']) fail('the old signatures must go: it is signed again');
    if (!got['img/logo.png']) fail('other files stay');
    us.patch(inFile, outFile, us.edits(b, { api_base_url: 'http://s', screen_key: 'k' }), function (err) {
        if (!err || err.code !== 'SETTINGS_PATCH' || err.file !== 'js/config.js' || err.find !== null) fail('a missing file must be SETTINGS_PATCH: ' + (err && err.message));
        us.patch(inFile, outFile, [{ key: 'port', file: 'index.html', find: 'not there', text: 'x' }], function (err) {
            if (!err || err.code !== 'SETTINGS_PATCH' || err.find !== 'not there') fail('a missing text must be SETTINGS_PATCH: ' + (err && err.message));
            try { fs.unlinkSync(inFile); fs.unlinkSync(outFile); fs.rmdirSync(dir); } catch (e) {}
            console.log('PASS: user settings as Apps2Samsung writes them: normalize, checks (required, digits, range, disallow, pattern), escaping in quotes, typed over saved over default, targets, every occurrence, signatures dropped, a changed package refused');
        });
    });
});
