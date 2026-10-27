/* Bundles tizen-app/service/*.js into one file: node scripts/bundle-service.js <out.js>
 *
 * Tizen 10 runs a web service in an embedded Node 20 (Electron, inside Chromium) instead of the
 * Node 4 of older sets, and services split over several files with require('./x.js') do not
 * come up there (TV-Store, Vetro), while TizenBrew's, one bundled file wrapped in a function,
 * does. So the .wgt carries the service the same way: every module wrapped in a function, the
 * relative requires resolved here, nothing declared at the top level, and only Node's built-in
 * modules left for the platform's require. ES5, so the bundle runs on Node 4.4.3 as well.
 */
'use strict';
var fs = require('fs'), path = require('path');

var DIR = path.join(__dirname, '..', 'tizen-app', 'service');
var ENTRY = './index.js';
var REQ = /require\('(\.\/[A-Za-z0-9_.-]+\.js)'\)/g;

var order = [], seen = {};
(function visit(id) {
    if (seen[id]) return;
    seen[id] = true;
    var src = fs.readFileSync(path.join(DIR, id), 'utf8'), m;
    REQ.lastIndex = 0;
    while ((m = REQ.exec(src)) !== null) visit(m[1]);
    order.push({ id: id, src: src });
})(ENTRY);

var out = [];
out.push('/* TV-Store service, bundled by scripts/bundle-service.js from tizen-app/service/. Do not edit. */');
out.push('(function (nodeRequire, hostModule) {');
out.push('\'use strict\';');
out.push('var defs = {}, cache = {};');
out.push('function load(id) {');
out.push('    if (cache[id]) return cache[id].exports;');
out.push('    if (!defs[id]) return nodeRequire(id);');
out.push('    var m = cache[id] = { exports: {} };');
out.push('    defs[id].call(m.exports, m, m.exports, load);');
out.push('    return m.exports;');
out.push('}');
order.forEach(function (f) {
    out.push('defs[' + JSON.stringify(f.id) + '] = function (module, exports, require) {');
    out.push(f.src);
    out.push('};');
});
out.push('var api = load(' + JSON.stringify(ENTRY) + ');');
// The platform calls the lifecycle hooks on the service file's own exports, when it has them.
out.push('if (hostModule && hostModule.exports) for (var k in api) hostModule.exports[k] = api[k];');
out.push('})(typeof require === \'function\' ? require : null, typeof module === \'object\' ? module : null);');

var target = process.argv[2];
if (!target) { console.error('usage: node scripts/bundle-service.js <out.js>'); process.exit(2); }
fs.writeFileSync(target, out.join('\n') + '\n');
console.log('bundled ' + order.map(function (f) { return f.id; }).join(', ') + ' -> ' + target);
