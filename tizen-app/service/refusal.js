/* What the TV's install refusal means, and what TV-Store can do about it (#44). Pure, so
 * test/refusal.test.js covers every reading. ES5 for the TV's Node 4.4.3.
 *
 * sdbd answers "install failed[<code>]" and, on sets newer than Tizen 4, ", reason: <text>"; a 2018
 * set prints the code as six digits (118012 = [118, -12]) and no reason.
 *   [118, -12]  the certificate check: with "same id and different certificate" (or, without a
 *               reason, when the page says the package is on the TV) the app was installed with
 *               another author certificate (from a phone or PC, or one since renewed), and the TV
 *               only updates an app with the certificate it came with: TV-Store can remove that
 *               copy and install again (CERT_MISMATCH). Otherwise the TV rejects the certificate
 *               itself: a set without internet during the install (it verifies online), a clock
 *               that is off, or a certificate past its dates (CERT_REJECTED).
 *   [118, -19]  the installer's "parsing error" on the manifest: in practice a package that asks for
 *               a newer Tizen than the set runs (#44); [118, -4] is the newer sets' spelling of that,
 *               next to "load archive info fail" for a bad package id.
 */
'use strict';

// "4.0" out of what the page reports for this TV, '' when it reported nothing usable.
function tizenVersionOf(entry) { var m = /^\s*(\d+(?:\.\d+)?)/.exec(String((entry && entry.tizen) || '')); return m ? m[1] : ''; }

function appName(entry) { return (entry && (entry.name || (entry.file && String(entry.file).replace(/\.(wgt|tpk)$/i, '')))) || 'This app'; }

// -> { code, message }. code is CERT_MISMATCH, CERT_REJECTED or INSTALL_FAILED.
function refusal(code, reason, entry) {
    entry = entry || {};
    var c = String(code || '').replace(/\s/g, ''), why = String(reason || '').trim();
    var m = 'The TV refused the package [' + code + ']' + (why ? ': ' + why : '');
    var tv = tizenVersionOf(entry), req = entry.requiredVersion || '';
    if (/^(118,-19|118019|118,-4|118004)$/.test(c)) {
        if (req) return { code: 'INSTALL_FAILED', message: m + '. It asks for Tizen ' + req + ' or newer' + (tv ? ', and this TV runs Tizen ' + tv : '') + '.' };
        return { code: 'INSTALL_FAILED', message: m + '. The TV could not read the package, which usually means it asks for a newer Tizen than this set runs.' };
    }
    if (/^(118,-12|118012)$/.test(c)) {
        if (/same id and different certificate/i.test(why) || (!why && entry.installed))
            return { code: 'CERT_MISMATCH', message: appName(entry) + ' is already on this TV, signed with another certificate: it was installed from a phone or PC, or with a certificate that has since been renewed. The TV only updates an app with the certificate it came with. TV-Store can remove that copy and install again; the app’s settings and sign-ins on the TV go with it.' };
        if (/not yet valid|not valid yet/i.test(why))
            return { code: 'CERT_REJECTED', message: m + '. The TV says the certificate is not valid yet, so its clock is behind: set the TV’s date and time (Settings, General, System Manager, Time) or wait a few minutes, then try again.' };
        if (/expired/i.test(why))
            return { code: 'CERT_REJECTED', message: m + '. The TV says the certificate has expired: either its clock is ahead, or the certificate is past its end date and the phone or PC has to arm this TV again.' };
        return { code: 'CERT_REJECTED', message: m + '. The TV rejected the signing certificate. Make sure the TV has internet during the install (it checks the certificate online) and that its date and time are right, then try again; if it keeps failing, arm this TV again from Apps2Samsung.' };
    }
    return { code: 'INSTALL_FAILED', message: m };
}

module.exports = { refusal: refusal, tizenVersionOf: tizenVersionOf };
