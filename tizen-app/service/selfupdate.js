/* TV-Store updating itself (#41, an experiment behind a Settings switch). 0.3.11 stopped offering
 * it on the theory that the installer stops every process of the package it replaces, including
 * the service that drives the install, so the install never lands. Apps2Samsung#1005 showed the
 * other side on a Tizen 5.0 set: an update of TV-Store through its own relay lost its connection
 * when the installer stopped the service, and the install still finished. To sdbd that is the same
 * as this service pushing its own package and sending 0 vd_appinstall: a client that sends the
 * command and then disappears. So the service may do it, when the user turned the switch on:
 * always through sdbd (wascmd is a child of this service and would go down with it), never with
 * "remove the old copy first" (that removes TV-Store before anything can install it), and with a
 * marker in the data folder (which an update keeps) written just before the command, so the next
 * start can tell whether the update landed and show the last log lines of the run that sent it.
 * Pure helpers here; the I/O is in index.js. ES5, Node 4: test/selfupdate.test.js. */
'use strict';

// Whether an install is TV-Store's own package: by package id, or by the package part of the
// application id when the page sent no package id.
function isOwn(entry, pkg) {
    if (!entry || !pkg) return false;
    var p = entry.packageId || String(entry.appId || '').split('.')[0];
    return p === pkg;
}

// Why an install of TV-Store's own package may not go ahead; null when it may.
function refusal(entry) {
    if (entry.selfUpdate !== true) return { code: 'SELF_UPDATE_OFF', message: 'TV-Store does not update itself unless "Let TV-Store update itself" is on in Settings. Update it from Apps2Samsung on a phone or PC (On the TV, Update).' };
    if (entry.replace) return { code: 'SELF_REPLACE', message: 'TV-Store cannot remove itself first and then install: nothing would be left running to install it. Update it from Apps2Samsung on a phone or PC.' };
    return null;
}

// The marker written just before vd_appinstall. Versions and names are the page's word and only
// shown; nothing here is acted on but the presence of the file.
function marker(entry, at) {
    return { from: String(entry.fromVersion || ''), to: String(entry.toVersion || ''), at: at, certificate: String(entry.selfCert || ''), file: String(entry.file || '') };
}

// The lines of a log (one "<ISO time> message" per line) written from `sinceIso` on, the last
// `max` of them: what the run that sent the update said before it was stopped.
function linesSince(text, sinceIso, max) {
    var since = Date.parse(sinceIso), out = [];
    String(text || '').split('\n').forEach(function (l) {
        var t = Date.parse(l.slice(0, 24));
        if (l && !isNaN(t) && !isNaN(since) && t >= since) out.push(l);
    });
    return out.slice(-(max || 40));
}

// What the next start makes of a marker, given the version that is running now: 'landed' when it
// is the version the update was for, 'not-landed' when it is still the one that sent it,
// 'unknown' when the marker does not say enough.
function outcome(mark, running) {
    if (!mark || !running) return 'unknown';
    if (mark.to && running === mark.to) return 'landed';
    if (mark.from && running === mark.from) return 'not-landed';
    return 'unknown';
}

module.exports = { isOwn: isOwn, refusal: refusal, marker: marker, linesSince: linesSince, outcome: outcome };
