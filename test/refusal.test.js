/* refusal.js turns the TV's "install failed[code], reason" into what the install screen says and
 * offers: another certificate on the installed copy (CERT_MISMATCH, removable), the certificate
 * itself rejected (CERT_REJECTED), a package that asks for a newer Tizen (#44, #47). */
'use strict';
var r = require('../tizen-app/service/refusal.js');
function fail(m) { console.error('FAIL: ' + m); process.exit(1); }
function check(code, reason, entry, wantCode, wantText) {
    var got = r.refusal(code, reason, entry);
    if (got.code !== wantCode) fail('[' + code + '] ' + JSON.stringify(reason) + ' ' + JSON.stringify(entry) + ': code ' + got.code + ', want ' + wantCode);
    if (wantText && got.message.indexOf(wantText) < 0) fail('[' + code + ']: message "' + got.message + '" lacks "' + wantText + '"');
}
// A newer set names the installed copy; a 2018 set gives six digits and no reason, so the page's
// word that the package is on the TV decides (#44, HackTV).
check('118, -12', 'Check certificate error : :Package with the same id and different certificate has been already installed.:<-12>', { name: 'HackTV' }, 'CERT_MISMATCH', 'HackTV is already on this TV');
check('118012', '', { file: 'HackTV.wgt', installed: true }, 'CERT_MISMATCH', 'HackTV is already on this TV');
check('118012', '', { file: 'HackTV.wgt', installed: false }, 'CERT_REJECTED', 'internet during the install');
// A 2022 Tizen 6.5 set words the mismatch as [118, -11] (#45, Moonfin from a PC).
check('118, -11', 'Author certificate not match :', { name: 'Moonfin', installed: true }, 'CERT_MISMATCH', 'Moonfin is already on this TV');
check('118011', '', { file: 'Moonfin.wgt', installed: true }, 'CERT_MISMATCH', 'Moonfin is already on this TV');
check('118, -12', 'Check certificate error : :Invalid format of certificate in signature.:<-2>', { installed: true }, 'CERT_REJECTED', 'internet during the install');
check('118, -12', 'Check certificate error : :Certificate in signature is not valid yet.:<-7>', { installed: true }, 'CERT_REJECTED', 'clock is behind');
check('118, -12', 'certificate has expired', {}, 'CERT_REJECTED', 'expired');
// The Tizen version the package asks for (#47).
check('118019', '', { requiredVersion: '6.0', tizen: '4.0' }, 'INSTALL_FAILED', 'asks for Tizen 6.0 or newer, and this TV runs Tizen 4.0');
check('118, -19', 'Parsing error', { requiredVersion: '6.0' }, 'INSTALL_FAILED', 'asks for Tizen 6.0 or newer.');
check('118, -4', 'Operation not allowed', {}, 'INSTALL_FAILED', 'could not read the package');
// Anything else is passed on as the TV said it.
check('118, -22', 'Security error : :Invalid function parameter was given:<2>', { installed: true }, 'INSTALL_FAILED', 'The TV refused the package [118, -22]: Security error');
check('116', '', {}, 'INSTALL_FAILED', '[116]');
if (r.tizenVersionOf({ tizen: '6.5.0' }) !== '6.5' || r.tizenVersionOf({ tizen: 'x' }) !== '' || r.tizenVersionOf(null) !== '') fail('tizenVersionOf');
console.log('PASS: refusals read as another certificate (removable), a rejected certificate, a Tizen version too low, or as the TV said');
