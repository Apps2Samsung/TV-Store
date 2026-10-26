'use strict';
// Tizen rejects a package id that isn't exactly 10 alphanumerics with "[118, -4] Load archive info
// fail", before it even looks at the signature. The app and service ids must sit under that package.
var fs = require('fs'), path = require('path');
var xml = fs.readFileSync(path.join(__dirname, '../tizen-app/config.xml'), 'utf8');

function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
function attr(tag, name) {
    var m = new RegExp('<' + tag + '\\b[^>]*\\s' + name + '="([^"]*)"').exec(xml);
    if (!m) fail('no ' + name + ' on <' + tag + '>');
    return m[1];
}

var pkg = attr('tizen:application', 'package');
if (!/^[0-9A-Za-z]{10}$/.test(pkg)) fail('package id "' + pkg + '" must be exactly 10 letters or digits');
var appId = attr('tizen:application', 'id');
if (appId.indexOf(pkg + '.') !== 0) fail('application id "' + appId + '" is not under package "' + pkg + '"');
var serviceId = attr('tizen:service', 'id');
if (serviceId.indexOf(pkg + '.') !== 0) fail('service id "' + serviceId + '" is not under package "' + pkg + '"');

console.log('PASS');
console.log('  package    :', pkg);
console.log('  application:', appId);
console.log('  service    :', serviceId);
