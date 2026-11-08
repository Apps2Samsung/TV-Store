# Apps2Samsung TV-Store

The Apps2Samsung catalog on the TV itself. Browse with the remote, press OK, and the app installs
as a real Tizen package, straight into the Apps row. No PC or phone in the loop after a one-time
setup. Next to the official catalog, TV-Store also lists apps from signed
[independent repositories](#independent-repositories-sources) that you add in Apps2Samsung.

![Home](docs/design/C1-home.png)

## How it looks

The screens below are the design the app is built towards. Dark glass, the Apps2Samsung category
colours, big tiles for a couch.

| | |
|---|---|
| ![App sheet](docs/design/C2-app-sheet.png) The app, its variants, one button. | ![Installing](docs/design/C3-installing.png) Download, sign, install: four steps you can watch or walk away from. |
| ![Done](docs/design/C4-done.png) Done, with Open right there. | ![On the TV](docs/design/C6-on-the-tv.png) Your apps, updates first. |

![First run](docs/design/C5-first-run.png)

## Requirements

- **Apps2Samsung 3.0 or newer** on a phone or PC, for the one-time arming. Until 3.0 is the stable
  release that means the [3.0 beta](https://github.com/Apps2Samsung/Apps2Samsung/releases); 2.x has
  no Arm TV-Store button.
- A Samsung TV in Developer Mode. Tested on Tizen 5.0 (2019) and Tizen 10 (2025); TV-Store asks for Tizen 3.0
  (2017) or newer. Every app in the catalog asks for its own Tizen version; one this TV is too old for
  shows a "Needs Tizen X" badge and does not install from here (the TV would refuse it with
  `install failed[118, -19]`, #44). Where the app has a build for older sets, the sheet lands on that one.

## Setting it up

1. Install TV-Store from Apps2Samsung like any other app, with Developer Mode's **Host PC IP** set
   to your phone or PC as usual.
2. In Apps2Samsung, open the TV's **Toolbox** and press **Arm TV-Store**. That hands every signing
   certificate on that phone or PC to the TV once. The TV-Store screen turns green by itself.
3. On the TV, set Developer Mode's **Host PC IP** to the TV's own address (TV-Store shows it), or
   to `127.0.0.1`. Either one works; `127.0.0.1` is what a rooted TV is pinned to.
4. Pick an app in TV-Store and press OK. It installs into the Apps row; no phone or PC needed from
   here on. To keep using Apps2Samsung from a phone or PC as well, turn on **Connect from Apps2Samsung** under Settings (below) instead of setting Host PC IP back.

## Apps installed from a phone or PC

Every install is signed with an author certificate, and a Samsung TV only updates an app with the
same author certificate it was installed with. Arming hands this TV every signing profile the phone
or PC holds (Public and Partner, the one older sets get, imported ones), and arming from a second
device adds its profiles to those. TV-Store remembers which profile each package took and, when the
TV answers `install failed[118, -12]` ("same id and different certificate"; `118012` on a 2018
set), signs again with the next profile until the TV takes one (#44). So an app installed from a
phone updates from TV-Store once that phone has armed the TV. Only when none of the profiles on the
TV matches does TV-Store offer to remove the old copy and install again; the app's settings and
sign-ins on the TV go with the old copy, which is why it asks first.

### Signing certificates in Settings

Settings lists every profile on the TV, one row each (#78): the name the phone or PC gave it, its
level (Public, Partner, or unknown, which is used as Public), the author fingerprint (the first 12
characters of its SHA-256, the same value the Apps2Samsung debug log prints, so the two can be
matched), how long it is valid (with a warning when it has run out or runs out within 30 days), and
whether its distributor certificate lists this TV's DUID. A profile that does not list this TV
cannot install here. OK on a row offers:

- **Use as default**: the profile tried first for an app that has none of its own yet. An app
  installed before still takes the profile it was installed with first, and an app that needs
  Partner still only takes a Partner one. A default chosen here stays the default when a phone or
  PC arms the TV again; without one, arming makes that device's first choice the default.
- **Remove**, after a confirmation: for a stale or expired profile that keeps being tried. Apps
  installed with it cannot be updated from TV-Store until a device arms the TV with it again.

## Public or Partner certificate

Apps2Samsung signs with a Public certificate unless an app needs a Partner one (partner-level rights
a Public certificate does not cover: a VPN, Samsung partner sign-in, killing other apps; or a hook
into a Samsung native package, as in SushyDev's YouTube for Tizen). A TV armed from a
device that has both profiles holds both, and TV-Store tells them apart by the Samsung CA that
issued the distributor certificate (the chain the phone or PC hands over), so a TV armed before
0.3.13 knows its levels too; Settings lists each certificate with its level (#50).

- An app the catalog marks `cert_level: partner` carries a **Partner certificate** badge and is
  signed Partner by itself. When the TV holds no Partner certificate its Install button is off and
  the sheet says how to get one: in Apps2Samsung, set the signing certificate to Partner and
  install any app once, so it creates one, then press Arm TV-Store again.
- Any other package whose manifest asks for a partner-level privilege (a VPN, Samsung partner
  sign-in, killing other apps) is signed Partner when the TV holds one, Public otherwise (those parts
  of the app then do not work). A file sent in from a browser gets the same, and its sheet says so.
  DRM playback and external storage are Public-level on a TV (Samsung lists AVPlay's DRM call as
  Public), so apps that only use those stay Public; should DRM still fail for one, **Sign with**
  below lets you pick Partner for it.
- When the TV holds both, the app sheet has **Sign with**: Automatic, Public or Partner, remembered
  per package.
- A package the TV already has keeps the certificate it was installed with, as above. Switching it
  from Public to Partner is a certificate mismatch, and the install screen offers to remove the old
  copy and install it again.

## How it works

A Samsung TV only installs sideloaded packages through its developer connection (`sdbd`), the
same door Apps2Samsung uses from a PC. TV-Store is a web app with a small background service that
acts as the TV's own PC:

1. downloads the package from the catalog (or from an [independent repository](#independent-repositories-sources)
   you added) and checks it against the SHA-256 that catalog gives it,
2. signs it on the TV with your certificate (the same signatures Apps2Samsung makes),
3. pushes it to the TV's own `sdbd` and has that install it (or, with the Settings switch **Try
   the TV's own installer** on, hands it to `wascmd` on the TV itself first, #57 below).

The TVs cannot check today's HTTPS certificates (their certificate store is too old), so TV-Store
trusts the content instead: the catalog (`resolved.json.signed`) is signed by the Apps2Samsung
catalog workflow and checked against the key built into TV-Store, and a package installs only when
its hash matches that catalog.

App icons (#66) take the same road. The catalog names an icon per package file with its SHA-256
(`icon`, `icon_digest`, published by the Apps2Samsung catalog snapshot next to `resolved.json`),
the service fetches it, keeps it only when its bytes hash to that, caches it in its data folder and
serves it to the screen at `GET /icon/<sha256>`. The webview never fetches from apps2samsung.com
itself. An app without an icon in the catalog, or whose icon does not check out, keeps its letter
tile.

For the `sdbd` way, Developer Mode's **Host PC IP** on the TV must be set to the TV's own address
or to `127.0.0.1`. TV-Store tries both and uses whichever the TV lets in, so a rooted TV (pinned
at `127.0.0.1`) installs too.

**`wascmd` from the service (#57), off by default since 0.3.20.** `sdbd`'s `vd_appinstall` is itself a wrapper around
`/usr/bin/wascmd`, and TizenBrewInstaller runs that binary straight from its Node service, so the
Host PC IP never comes into it. From 0.3.16 to 0.3.19 TV-Store's service did the same first; since
0.3.20 only when the Settings switch **Try the TV's own installer (wascmd)** is on, because every
retail set tried so far has either refused the run or died starting it (next two paragraphs). With
the switch on: when
`/usr/bin/wascmd` is there and this Node can start a process (`child_process` on Tizen 3; the
binding it is built on, `process.binding('spawn_sync')`, on Tizen 4 and later, where the module is
stripped), the signed package goes to `wascmd -i <id> -p <file>` (arguments as a list, no shell)
and its reply is read exactly like `vd_appinstall`'s. When `wascmd` did not get to install (not
there, not allowed under the service's label, "cannot working in released image", nothing printed)
the install falls back to `sdbd` as before, and the log says so. The binding is synchronous, so
the service answers nothing while `wascmd` runs; the page's install call waits longer than that.
Right before the first install the log also gets what `wascmd` prints without arguments (its
flags; no document gives them, the uninstall one in particular), so a real set's log is where they
get read from. Until then, removing an old copy for a replace still goes over `sdbd`; when `sdbd`
cannot be reached while `wascmd` does the installs, the replace stops with `REPLACE_NEEDS_SDB` and
says what to do instead of running into the same certificate mismatch.

**What starting `wascmd` can cost (#67, #68).** On two Tizen 9 sets (2023 models on the 2025
firmware) 0.3.16 and 0.3.17 did not come up at all: the service ran `wascmd` without arguments at
start-up for its usage text, and that fork took the shared `wrt-service` process down on most
starts, before the service listened ("Launched, but nothing answers on port 8077"); on the starts
it survived, the TV refused the run with `EACCES`. So the service starts nothing before the first
install, and guards that in three ways. It asks the kernel first, without a fork, whether it may
run the binary at all (`access(2)` with `X_OK`, which the file's mode and the TV's Smack labels
both answer; the log says `this service may not run it: EACCES` and installs take `sdbd`). It
keeps a marker file (`.a2s-wascmd-running` in the data folder) from before the first process
starts until `wascmd` answered, so a service that finds it at the next start knows the last run
died inside that call, says so, keeps to `sdbd` and remembers that in `.a2s-installer.json`; a
spawn that fails outright (`EACCES`, `ENOENT`) is remembered the same way. And since 0.3.20 the
whole path is opt-in: the Settings switch **Try the TV's own installer (wascmd)** is off by default,
so every install goes through `sdbd` as before 0.3.16; turning it on hands installs to `wascmd`
first, and turning it off and on again forgets what the service learned, so `wascmd` gets one more
try. The choice is kept in `.a2s-installer.json` as `mode: 'auto'` with `optIn: true` (a file from
0.3.18 or 0.3.19 saying `auto` meant the default then and is not read as a choice).
`A2S_INSTALLER=sdb` or `auto` in the service's environment overrides it for a test. `/ping` reports it
(`installer: { mode, env, wascmd: { path, present, executable, denied, spawn, available }, off,
last }`), `POST /settings { installer: { mode: 'auto' | 'sdb' } }` flips it, and the log's second
line at start says which way installs will take.

**A Tizen 5.0 set (2019) says the same, one step further in (#57).** There `child_process` is present, `access(2)` allows the run, and the service hands the signed package to `wascmd`; that fork takes the service down before anything is installed, so no reply and no usage text ever reach the log. The next start finds the marker and keeps to `sdbd`. With that, every retail set tried (Tizen 5 and 9) has either refused `wascmd` or died starting it, which is why the switch above is off by default: `sdbd` over the TV's own address or `127.0.0.1` is the path that installs.

The screen talks to the service over HTTP on port 8077. Apps2Samsung writes the TV's own IP into
TV-Store when it installs it, because Tizen 10 may not let a page reach its service over
`127.0.0.1`; when that address stops answering, TV-Store tries the TV's current IP and loopback.
The service only answers the TV itself, except for its log.

## The log

The service keeps its log on the TV, with the previous run's next to it, so it survives a crash.
Open `http://<TV IP>:8077/log.txt` on a phone or PC in the same network, or scan the QR code under
**Settings** (also shown when the service does not start), and attach it to a bug report.
When a bug report asks for more detail, turn on **Verbose logging** in Settings first (see below).

Some catalog apps need settings written into the package before they install (a server address,
an API key). The TV cannot do that yet, so those are shown greyed with a "Phone or PC" badge and
install from Apps2Samsung on a phone or PC instead. The same goes for apps that need root, and for
any file the catalog has no hash for.

## Your own app (.wgt or .tpk)

Open `http://<TV IP>:8077/upload` on a phone or PC in the same network (Settings shows it as a QR
code), pick a `.wgt` or `.tpk` and send it. The TV keeps the file and TV-Store asks on screen:
who sent it, what the package calls itself, its hash, then **Install on this TV**, **Not now** or
**Discard**. Nothing installs until OK is pressed on the remote. The file is signed with your
certificate and installed like a catalog app, without the catalog's hash check (the file is yours).

One file waits at a time (a new one replaces it), at most 400 MB, and it must be a Tizen package
(a zip with `config.xml` or `tizen-manifest.xml` at its root). The upload page is open to the
network like the log; the install is not: only the TV-Store screen can start it, with a key the
service writes into the app's private data folder at every start, where no other app on the TV
can read it. The TV must be armed first.

If the TV already has a different app under the file's package id, the screen says so ("Already on
your TV: …"). A file sent this way has no catalog entry to derive another id from, so installing
it replaces that app.

## A fork that kept another app's package id

Forks often keep upstream's package id: tacplayer ships the official Jellyfin id `AprZAARz4r`.
Installing one used to replace the app with that id, and its data (#84). Now, before signing,
the service reads the package's `config.xml` id and `<name>`, and the page tells it which apps the
TV has (package id and names, from `tizen.application.getAppsInfo`):

- **Not on the TV, or the same name** (case and spaces aside): installs under its own id, as before.
  The same name means the same app, so updates and variants of one group are not renamed.
- **A different app has the id, `.wgt`:** installs as a separate app under an id of its own. The
  done screen says "Installed as a separate app, because Jellyfin already uses this id."
- **A different app has the id, `.tpk`:** native code can hardcode its own paths, so it is not
  renamed. The install stops with "Already on your TV: …", and the screen offers **Cancel** or
  **Replace it**.

**The new id is the same in every client** (Apps2Samsung#1028), so an app renamed by TV-Store is
found and updated by Apps2Samsung, and the other way round. It is the first 10 characters of
`base62(sha256("a2s-pkgid-v1:" + key))`, one character per byte (`byte % 62`, alphabet
`0-9A-Za-z`). The key names the catalog entry, so it does not change between versions:

| Where the file comes from | key |
|---|---|
| Official catalog, community package | the entry's `repo`, `/`, its `file`: `sfsdffesfsfg-cloud/tacplayer/tacplayer.wgt` → `ln9ooxgrYz` |
| Official catalog, provider of its own | `owner/name` from its GitHub releases URL, `/`, the asset's name: `jeppevinkel/jellyfin-tizen-builds/Jellyfin.wgt` → `NlEuwl5oL0` |
| Independent repository | the repository's URL (the `repository.json.signed` one it was added under), `/`, the asset's name |

The rewrite is what Apps2Samsung's `PackageIdRewriter` does. The old id is replaced as a whole
token in `config.xml` (the application id and package, and the service components' ids) and in
every text file of the package (`.js`, `.html`, `.json` and the like, for an app that launches its
own service by id). Signatures are dropped, and the package is then signed like every install.

Once renamed, updates land on that copy. The service finds it by the derived id, so a copy
Apps2Samsung renamed counts too, and another build of the same app goes to the same tile. Each
rename is kept in the data folder (`.a2s-package-renames.json`: original and new package and
application id, the key, the source). The page gets every catalog file's derived id from
`GET /pkgids`. With those, the Installed badge, the update check, Open and the certificate the app
was signed with all follow the renamed copy. The package's own id on the TV stays with the other app.

## Independent repositories (sources)

Developers can publish their own **signed repository** of Tizen apps, Cydia-style, without going
through the official catalog (#82, part of
[tizen-community-packages#208](https://github.com/Apps2Samsung/tizen-community-packages/issues/208)).
The format, the signature, the key fingerprint and the rules every client applies are specified in
[tizen-community-packages: docs/repositories.md](https://github.com/Apps2Samsung/tizen-community-packages/blob/main/docs/repositories.md),
with a ready-to-copy publisher template next to it. TV-Store lists those apps next to the official
catalog's and installs them the same way: downloaded, checked against their hash, signed with your
own certificate, installed.

### Adding one

You add a repository in **Apps2Samsung** on a phone or PC, which shows its name, address and key
fingerprint and asks you to approve them (Apps2Samsung#1018). Then, in the TV's **Toolbox**, **Send
sources to TV** hands the approved repositories to TV-Store, over the same connection arming uses.
TV-Store checks each one and asks on screen before it keeps it: name, maintainer, address, how many
apps, and the full key fingerprint (64 hex characters, compare it with what Apps2Samsung showed),
then **Add source** or **Don't add**. A source that does not check out is shown with why, and only
**Close** is offered.

There is no way to type a repository address on the TV. The TV cannot validate HTTPS, so it has no
safe way to decide on a key by itself: a key fetched over an unchecked connection could be anyone's.
So what the TV trusts is the **fingerprint**, and a fingerprint reaches the TV only from somewhere
that vouches for it: Apps2Samsung, where the user approved it, or the signed official catalog (a
moved app, below). The key itself may come along (`publicKeyPem`); when it does not, the service
fetches `repository.pem` next to the manifest and keeps it only when its SHA-256 is that
fingerprint, which no swapped file can be. Either way the key is pinned on the TV from then on.
Fetching is the normal path, since the official catalog's `moved_to` carries a fingerprint and no
key. A publisher
who changes keys needs a new approval in Apps2Samsung and a new **Send sources to TV**; until then
the source stops loading, because its signature no longer matches the pinned key, and Settings says
so.

### What the TV checks

Every time it loads a repository (cached for 10 minutes, like the official catalog), the service
refuses it whole when any rule of the spec fails, with the spec's reason code in the log and in
Settings: larger than 8 MiB (`size`); no signature line (`no-signature`); a key that is not RSA or
has fewer than 3072 bits (`key`); a key other than the approved one (`fingerprint`); a bad signature
(`signature`); not JSON (`json`); a `schemaVersion` this TV-Store does not know (`schema-version`);
anything the schema does not allow, such as an `http://` download, a bad `digest`, or an icon
without `icon_digest` (`schema`); a URL at an IP address, `localhost`, `*.local` or with a user
name in it (`url`); a manifest that calls itself another repository than the approved one
(`repository-id`); dated more than an hour ahead (`future`); more than 7 days old (`expired`);
older than the last one accepted from it (`rollback`); and two providers with the same id, or one
`package_id` and version from two providers (`duplicate`). The fetch itself gives up after 60
seconds, 5 redirects or 8 MiB. `test/repos.test.js` runs every test vector of the spec through
this.

A file installs only when its bytes hash to its `digest`, and an icon shows only when it hashes to
its `icon_digest`, exactly as for the official catalog. A repository's own signing certificate
plays no part: TV-Store signs every package with your certificate, as always.

### On the screen

- Once the TV has a source besides the official catalog, every card says where the app comes from
  (**Official** or the repository's name), the app sheet says "from …", and a **From** row of chips
  under the categories filters the store by source. Without sources nothing changes.
- An app from a repository says in its sheet that the repository's signature means the files come
  from its publisher, not that Apps2Samsung reviewed them.
- **An installed app belongs to the source it came from.** The service remembers that per package
  (`.a2s-source-by-package.json`; a package it has no record for counts as the official catalog's,
  as before). Its "Installed" and "Update" state, **On the TV** and **Update all** come only from
  that source. Updates never jump to whichever source has the newest version.
- **The same app from two sources** shows as two cards. The other source's card says the app on
  the TV came from elsewhere, and its button reads **Install from *repository* instead**: pressing
  it is the explicit choice that moves the app, and from then on its updates come from there. The
  service refuses such an install (`SOURCE_SWITCH`) without that choice, whatever asks for it.
- A source that does not load says why under **Settings, Sources** and drops out. The official
  catalog and the other sources carry on. Nothing installs from a source that did not verify.
- `required_version` and the "Needs Tizen X" badge, Partner certificates (`cert_level`), 18+
  (`adult`) and root apps (`flags: ["root"]`) work for repository apps as for official ones.

### Apps that moved out of the official catalog

When an app leaves the official catalog for its developer's own repository, its manifest in
tizen-community-packages gets `moved_to: { url, fingerprint }` for a notice period (see
[Moving an app out of the official catalog](https://github.com/Apps2Samsung/tizen-community-packages/blob/main/docs/repositories.md#moving-an-app-out-of-the-official-catalog)).
TV-Store reads it from the signed catalog:

- While such an app is on the TV and still updates from the official catalog, the store shows a
  banner: "*App* has moved to the developer's own repository at *domain*", with **Add source** and
  **Not now** (remembered per repository). The app sheet says the same with the same button, and On
  the TV points there.
- **Add source** opens the usual confirmation, marked "Named by the official catalog". The signed
  catalog vouches for the key here instead of an approval in Apps2Samsung, and the repository id is
  read from the manifest (`moved_to` carries none). The service checks that the URL and fingerprint
  are what the official catalog names for some package (`NOT_MOVED` otherwise).
- Once added, every installed app the official catalog says moved there, that the repository
  lists, and that came from the official catalog takes its updates from the repository from then
  on, without a reinstall. When the repository is on the TV already, the button reads **Take updates
  from there** and does only that.

### Settings, Sources

Settings lists **Official** (always there, cannot be removed) and every repository on the TV: its
name, maintainer, address, the start of its key fingerprint, and when it last verified (with its app
count) or why it does not load now. OK on a repository offers **Turn off** / **Turn on** (off: its
apps are not shown and nothing installs from it) and **Remove**, which asks first. A removed
repository's apps stay on the TV, but get no updates from anywhere until Apps2Samsung sends the
source again. Adding sources happens only through Apps2Samsung.

### For Apps2Samsung (Send sources to TV)

Over the web inspector, like arming (`A2SStore.setCertificate`):

```js
A2SStore.addSources([
  { url: 'https://owner.github.io/tizen/repository.json.signed',   // https, a public host name
    repositoryId: 'io.github.owner.tizen',                          // repository.id, pinned
    fingerprint: '<64 hex: SHA-256 of the DER public key>',         // as the user approved it
    name: "Owner's Tizen apps",                                     // optional, shown until checked
    publicKeyPem: '-----BEGIN PUBLIC KEY-----…' }                   // optional; must match the fingerprint (saves a fetch)
])
// -> Promise of { ok: true, results: [{ url, repositoryId, added: true|false, name?, error? }] }
```

The promise resolves once the person at the TV has answered every source (`added: false` with
`error: 'declined on the TV'`, or why the source did not check out). `A2SStore.status()` (the
service's `/ping`) lists the sources on the TV (`sources: [{ url, repositoryId, fingerprint, name,
maintainer, domain, enabled, lastGeneratedAt, lastOkAt, lastError, lastErrorReason, ok, apps }]`,
never the key) and where each installed package came from (`sourceOf: { packageId: 'official' |
repositoryId }`). Sending a source the TV already has again is fine: with the same key it is turned
on again and keeps its rollback state; with a new key the TV says the publisher changed keys.

The service's own routes, for this TV only: `GET /sources`, `GET /sources/catalog[?fresh=1]` (every
source with its verified manifest or its error), `POST /sources/check` (verify without keeping),
and `POST /sources/add`, `/sources/enable { repositoryId, enabled }`, `/sources/remove {
repositoryId }`, which need the page's token, like an upload, because every app on the TV can reach
port 8077. `POST /install` takes `source` (`official` when left out) and `switchSource: true`.
`POST /sources/check` and `/sources/add` take `{ url, fingerprint, moved: true }` without a
`repositoryId` for a source the official catalog names in `moved_to`; `/sources/add` then answers
which packages it moved over (`source.adopted`) and the new `sourceOf`. The
sources are kept in `.a2s-sources.json` in the service's data folder.

## Settings

Press **▲** at the top of the list to reach **Settings**. The switches are remembered on the TV:

- **Show adult (18+) apps**: off by default. Turning it on asks "I am 18 or older" first, as the
  phone app does; those apps then carry an 18+ badge.
- **Show apps that need a PC or phone**: on by default, so nobody thinks an app is missing; turn
  it off to keep the greyed "PC / phone" apps out of the list.
- **Verbose logging**: off by default. Adds much more detail to the log: the sdb traffic, HTTP
  requests, the TV's network addresses and how long each install step took. Turn it on for a bug
  report and off again afterwards.
- **Try the TV's own installer (wascmd)**: off by default (#57). On, an install is handed to
  `/usr/bin/wascmd` by the service itself before `sdbd` is tried; on every retail set so far that
  has taken the service down, so it is there for anyone who wants to report what their TV does.
- **Connect from Apps2Samsung (sdb relay)**: off by default (#52). The TV's `sdbd` lets a
  connection in only from the address Developer Mode's Host PC IP names, so with Host PC IP at
  `127.0.0.1` (what TV-Store and a rooted TV want) no phone or PC can reach it. With this on,
  TV-Store's service holds port 26201 open on the TV and hands every connection to `sdbd` over
  loopback; `sdbd` then sees `127.0.0.1` and accepts, whatever the client's address. Set Host PC
  IP to `127.0.0.1` once, restart the TV, and Apps2Samsung 3.2 or newer connects to the TV from
  any phone or PC by itself (it reads the Host PC IP from the TV and dials the relay instead of
  26101). The switch says the address. While it is on, any device in your network can install
  through that port; the service also takes a client allow list (`POST /settings { relay: { allow:
  [...] } }`), not yet on this screen. This switch lives in the service, not in the page's
  settings, so `/ping` reports it (`relay: { enabled, listening, port, sessions, allow, error,
  served, failures, lastFailure }`).

  Vetro (a TV manager) runs a background service that starts with the TV and restarts itself
  (`on-boot`, `auto-restart`), whether or not the Vetro app is open. That service keeps its own
  connection to `sdbd` open and shares it through an sdb tunnel on `127.0.0.1:26201`, the port
  this relay uses too (#90). `sdbd` takes one client at a time, so with Vetro on the TV every
  direct connection is turned away and this switch cannot start ("Another app on this TV already
  uses port 26201"); closing the Vetro app does not free it. TV-Store then installs
  through Vetro's tunnel: after the TV's own IP and `127.0.0.1:26101` it tries `127.0.0.1:26201`,
  and keeps to it for the next installs. A phone or PC reaches the TV through Vetro's own SDB
  access switch the same way.

  The sdb protocol cannot tell a phone or PC why its connection died, so through a relay every
  failure looks like "connection reset" (#58). The relay therefore works out what happened to each
  connection and keeps the last failure with a reason in words: `sdbd` not listening
  (`SDBD_DOWN`: Developer Mode off, or the TV needs a restart), `sdbd` taking the connection and
  closing it without a byte back (`SDBD_DROPPED`: Host PC IP is not `127.0.0.1`, or the TV was not
  restarted after setting it), `sdbd` never answering before the client gave up (`SDBD_SILENT`),
  another socket error (`SDBD_ERROR`), the allow list (`NOT_ALLOWED`) or the session cap (`BUSY`).
  It is in the log, under the switch on the Settings screen ("The last connection from 192.168.1.138
  at 10:32 failed: ..."), and any device in the network can read it at
  `http://<TV IP>:8077/relay` (`{ enabled, listening, port, sessions, served, failures,
  lastFailure: { at, client, code, reason } }`, no allow list), so Apps2Samsung can show the reason
  instead of the bare reset.

  The TV's `sdbd` takes one client at a time (seen on a 2019 Tizen 5.0 set, #73): while a phone or
  PC holds a session through the relay, an install started on the TV is dropped by `sdbd` the same
  silent way a wrong Host PC IP is. The service knows the relay's sessions, so that install stops
  with `SDB_BUSY` ("a phone or PC is connected to this TV through the relay") instead of blaming
  Host PC IP; close Apps2Samsung there, or wait, and install again.

  Updating TV-Store itself through the relay works, with one visible hiccup (Apps2Samsung#1005):
  the installer stops the running TV-Store to replace it, and the relay is TV-Store's own service,
  so the phone, PC or `sdb` session loses its connection the moment the install starts and never
  sees "install completed". The install still lands. Open TV-Store again (or wait for the head to
  relaunch it), and the new version is there with the relay back on its port. Apps2Samsung is to
  say so up front and read the version from the TV afterwards instead of reporting a failure.
- **Let TV-Store update itself (experiment)**: off by default (#41). Off, TV-Store sends you to
  Apps2Samsung on a phone or PC to update it, as since 0.3.11. On, a newer TV-Store in the catalog
  gets an **Update** button under On the TV like any other app. 0.3.11 dropped this on the theory
  that the installer stops the service driving the install so the update never lands, but nobody
  saw where it stopped (the log then lived in memory), and Apps2Samsung#1005 showed `sdbd`
  finishing an update of TV-Store after the service that sent it was stopped. The service installs
  its own package through `sdbd` only (never `wascmd`, which runs as its child) and never with
  "remove the old copy first". Just before `0 vd_appinstall` it writes a marker to its data
  folder, which an update keeps. TV-Store then closes; open it again after a minute. The next
  start finds the marker and shows whether the update landed, with the last log lines of the run
  that sent it on `/ping` (`selfUpdate: { from, to, at, certificate, lines }`) until **Got it**
  (`POST /selfupdate/ack`). It is never part of **Update all**, and not offered for a copy
  Apps2Samsung installed under another package id. Results on GitHub issue #41 help, above all
  from Tizen 9 sets, where 0.3.5 failed.

Below the switches, **Signing certificates** (above) and **Sources**
([independent repositories](#settings-sources)) list what the TV holds.

The header counts what the switches hide ("12 apps · 3 hidden").

## Pins, search by developer

- **Pin** in the app sheet pins that build of the app (the variant picked in the list) to a
  **Pinned** row at the top of the store, remembered on the TV. A pinned card shows that build's
  own state: its version, "Installed", or "Update to v…" when the catalog has a newer one; OK
  opens the sheet on that build. **Unpin** takes it off again.
- Apps whose builds share one package id (all Litefin builds are `LitefinApp`) cannot be told
  apart by the TV. TV-Store remembers which file it installed itself; for an app installed from
  a phone or PC, pin the build you have and TV-Store treats that as the installed one, on the
  On the TV page and for updates.
- The search box also matches the developer's name, and "by *developer*" in the app sheet is a
  link: OK shows every app by them (as Apps2Samsung does on the phone and PC).
- On the TV page, **▶** from an app in the list goes to its panel on the right (Details or
  Update, Open) and **◀** comes back to the list.

## Layout

- `tizen-app/`: the package: `config.xml`, `index.html`, `js/app.js`, `icon.png`, `service/`
- `tizen-app/service/index.js`: the service: catalog, certificate, install pipeline. The `.wgt` carries
  `service/` as one file, bundled by `scripts/bundle-service.js` (Tizen 10 runs services in an embedded
  Node 20 and does not start split ones)
- `tizen-app/service/sdb.js`: the SDB client (connect, push, install)
- `tizen-app/service/sdbhosts.js`: the order to try sdbd on, the TV's own IP and 127.0.0.1 (#52)
- `tizen-app/service/wascmd.js`: the TV's own installer run by the service, without sdbd (#57)
- `tizen-app/service/signer.js`: the package signer
- `tizen-app/service/catalog.js` + `catalog-key.js`: the signed catalog check and its public key
- `tizen-app/service/repos.js`: independent repositories (#82): every rule of the spec with its reason code, key size and fingerprint from the DER, the sources Apps2Samsung hands over
- `tizen-app/service/pkgid.js`: another app's package id (#84): the id derived from a catalog entry, when to rename, the rewrite of the package
- `tizen-app/service/icons.js`: app icons, fetched like a package, kept only with the catalog's hash, cached, served at `/icon/<sha256>` (#66)
- `tizen-app/service/compat.js`: buffers that work on the TV's Node 4.4.3
- `tizen-app/service/manifest.js`: the ids, the required Tizen version and the privileges a package carries in its own manifest
- `tizen-app/service/refusal.js`: what the TV's `install failed[...]` codes mean and what TV-Store offers for each
- `tizen-app/service/certs.js`: the signing profiles handed over, their Public or Partner level, which one each package took, the order to try
- `tizen-app/js/app.js`: the UI, and `window.A2SStore`, which Apps2Samsung calls to arm the TV
- `tizen-app/js/qrcode.js`: QR codes for the log address and the Ko-fi link ([qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4, MIT)
- `test/`: a fake `sdbd` plus signer and transport tests; `test/fixtures/repositories/` holds the spec's test vectors (copied from tizen-community-packages `spec/fixtures/`, test-only keys)
- `docs/design/`: the screens above

## Tizen 9 and 10

Since 0.3.9 TV-Store runs on 2025+ sets (Tizen 9 and 10). Those sets start a web service through
the `Service` class of the `wrt:service` module, so TV-Store starts its service that way there and
as before on older sets.

Set Host PC IP the same way as on any other TV: the TV's own address (shown in TV-Store) or
`127.0.0.1`. TV-Store tries both; only a Host PC IP pointing at a phone or PC turns the install
away, and TV-Store says so.

## Build, test, release

A `.wgt` is a zip of `tizen-app/`; no Tizen Studio needed.

```sh
scripts/build-wgt.sh        # -> dist/TV-Store.wgt
node test/run.js            # connect + push + install against a fake sdbd
node test/sign.test.js      # the signer, with a certificate chain
node --expose-gc test/stream-sign.test.js  # the file-to-file signer on a 24 MB package
node test/bundle.test.js    # the bundled service starts however the platform loads it
node test/catalog.test.js   # the signed catalog: signature, age, hashes, icons
node test/repos.test.js     # independent repositories (#82): every spec test vector for its reason, repository id, swapped key, URL rules
node test/sources.test.js   # sources in the service: check and add with the token, a broken source next to a working one, install per source, no silent switch, rollback, off and remove, moved_to vouched by the official catalog, kept across a restart
node test/icons.test.js     # app icons: served only with the catalog's hash, cached and hashed again, one download per hash, pruned
node test/manifest.test.js  # the ids and privileges of a .wgt / .tpk from its manifest
node test/upload.test.js    # send a file to the service, see it wait, token gate, discard
node test/certs.test.js     # the profiles handed over: merge, order per package, Public or Partner level
node test/install.test.js   # a certificate mismatch is retried with the next profile; replace
node test/certlevel.test.js # Public or Partner per install: refused up front, picked by privilege, chosen by hand
node test/sdbhosts.test.js  # the order of addresses to try sdbd on
node test/sdb-loopback.test.js  # install works whether Host PC IP is the TV's own IP or 127.0.0.1; SDB_BUSY while a PC holds the relay (#73)
node test/wascmd.test.js    # install through wascmd from the service (fake wascmd), its refusals, the sdbd fallback, over spawn_sync too; nothing started before the first install, the Settings switch, a run that died, EACCES without a fork (#67, #68)
node test/relay.test.js     # the on-TV sdb relay: a session survives the hop, allow list, cap, idle, stop; every failure told apart with a reason
node test/relay-settings.test.js  # relay settings over /settings: validation, restart only on change, status; GET /relay for the LAN
node test/certs.test.js     # signing profiles: payload shapes, merge, order, levels, expiry and DUIDs from the DER, default and remove on the TV (#78)
node test/selfupdate.test.js  # TV-Store updating itself (#41): refused without the switch, the marker, reported after the installer stops the service
node test/pkgid.test.js     # another app's package id (#84): the derived id against values computed apart, catalog keys, when to rename, whole-token rewrite
node test/rename.test.js    # a fork installed beside the app whose id it kept, its update on that copy, a .tpk refused until Replace, an older page as before
```

Install the `.wgt` with Apps2Samsung like any package. A `vX.Y.Z` tag (matching the version in
`config.xml`) publishes a GitHub release with `TV-Store.wgt` as its one asset. A release can also
start as a draft with the `.wgt` from the build workflow attached: publishing it creates the tag,
and the release workflow then replaces that asset with the one it builds from the tag.

## Status

| Piece | State |
|---|---|
| Install through the TV's own `sdbd` | proven on a retail set |
| Install through `wascmd` from the service, no Host PC IP (#57) | built against a fake `wascmd`, falls back to `sdbd` (0.3.16); its usage text in the log and a replace that stops with a reason when `sdbd` is out of reach (0.3.17); two Tizen 9 sets refuse the run with `EACCES` and the start-up probe took their service down (#67, #68), so nothing starts before the first install, the kernel is asked first, a run that died is remembered and Settings has a switch (0.3.18); a Tizen 5.0 set lets the service start it and the fork still takes the service down before anything is installed (0.3.19). Refused or fatal on every retail set tried, so off by default and opt-in through Settings (0.3.20); `sdbd` is the path that installs |
| Signing on the TV | done, identical output to the Apps2Samsung signer |
| Arming from Apps2Samsung (phone, PC, CLI) | done |
| The screens above | built (0.3.4); pins, developer search, your own .wgt or .tpk (0.3.10); finds itself under a renamed package id and sends you to Apps2Samsung to update it (0.3.11); Public or Partner certificate per app (0.3.13); the sdb relay switch (0.3.14); the relay's failure reasons under it (0.3.15); app icons from the signed catalog, hash-checked and cached by the service, once the Apps2Samsung snapshot publishes them (0.3.19, #66); Settings scrolls with the focus now that it is taller than the screen (0.3.20, #74); every signing certificate listed in Settings with its level, fingerprint, expiry and whether it covers this TV, a default to pick and a profile to remove (0.3.21, #78) |
| Independent repositories (#82) | built (0.3.21): verified per source against the spec's test vectors, sources from Apps2Samsung confirmed on the TV, every app labelled with its source, updates only from it; proven against local HTTPS stand-ins and a fake `sdbd`. Waits for Apps2Samsung's **Send sources to TV** (Apps2Samsung#1018) and a real repository for the test on a TV |
| A fork that kept another app's package id (#84) | built (0.3.22): a `.wgt` goes on beside the other app under the id derived from its catalog entry (the scheme of Apps2Samsung#1028), a `.tpk` asks before replacing; proven against local HTTPS stand-ins and a fake `sdbd`, untested on a TV |
| Apps removed from the community catalog (#87) | built (0.3.23): an installed copy that no catalog app claims gets a row under "Removed from the catalog" on the On the TV page with the reason, and search answers with "No longer in the catalog"; matched by the entry's own package ids (with its app ids or name) and by the rename id of each file; waits on Apps2Samsung carrying `catalog.removed` into `resolved.json`; untested on a TV |
| TV-Store updating itself (#41) | dropped in 0.3.11; back as an experiment behind a Settings switch, off by default, through `sdbd` with a marker that tells the next start whether it landed (0.3.21). Apps2Samsung#1005 saw an update of TV-Store land on a Tizen 5.0 set after the service that sent it was stopped; untested from the TV itself, Tizen 9 above all |
| First real install from the TV | done, 2019 Tizen 5.0 set (0.3.4) |
| Tizen 3.0 and 4.0 sets (2017, 2018) | untested |
| Tizen 10 sets (2025) | done, retail set (0.3.9) |
| Host PC IP `127.0.0.1`: TV-Store installs over loopback, Apps2Samsung through the relay | built and proven against a fake `sdbd` (0.3.14); the relay says why a connection failed and `GET /relay` tells Apps2Samsung (0.3.15, #58); proven on a 2019 Tizen 5.0 set: a catalog install over `127.0.0.1:26101` and `sdb` from a PC through port 26201 (0.3.19). That set's `sdbd` takes one client at a time, so an install while a PC holds a relay session stops with `SDB_BUSY` instead of blaming Host PC IP (0.3.20, #73). With Vetro holding `sdbd`, installs go through its sdb tunnel on `127.0.0.1:26201` (#90); proven against a fake `sdbd` and Vetro's own tunnel code, untested on a TV |
