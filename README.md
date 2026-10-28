# Apps2Samsung TV-Store

The Apps2Samsung catalog on the TV itself. Browse with the remote, press OK, and the app installs
as a real Tizen package, straight into the Apps row. No PC or phone in the loop after a one-time
setup.

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
- A Samsung TV in Developer Mode. Tested on Tizen 5.0 (2019); TV-Store asks for Tizen 3.0 (2017) or newer.

## Setting it up

1. Install TV-Store from Apps2Samsung like any other app, with Developer Mode's **Host PC IP** set
   to your phone or PC as usual.
2. In Apps2Samsung, open the TV's **Toolbox** and press **Arm TV-Store**. That hands your signing
   certificate to the TV once. The TV-Store screen turns green by itself.
3. On the TV, set Developer Mode's **Host PC IP** to the TV's own address (TV-Store shows it).
4. Pick an app in TV-Store and press OK. It installs into the Apps row; no phone or PC needed from
   here on. Set Host PC IP back to your phone or PC whenever you want to use Apps2Samsung again.

## How it works

A Samsung TV only installs sideloaded packages through its developer connection (`sdbd`), the
same door Apps2Samsung uses from a PC. TV-Store is a web app with a small background service that
acts as the TV's own PC:

1. downloads the package from the catalog and checks it against the SHA-256 the catalog gives it,
2. signs it on the TV with your certificate (the same signatures Apps2Samsung makes),
3. pushes it to the TV's own `sdbd` and installs it.

The TVs cannot check today's HTTPS certificates (their certificate store is too old), so TV-Store
trusts the content instead: the catalog (`resolved.json.signed`) is signed by the Apps2Samsung
catalog workflow and checked against the key built into TV-Store, and a package installs only when
its hash matches that catalog.

For that, Developer Mode's **Host PC IP** on the TV must be set to the TV's own address.

The screen talks to the service over HTTP on port 8077. Apps2Samsung writes the TV's own IP into
TV-Store when it installs it, because Tizen 10 may not let a page reach its service over
`127.0.0.1`; when that address stops answering, TV-Store tries the TV's current IP and loopback.
The service only answers the TV itself, except for its log.

## The log

The service keeps its log on the TV, with the previous run's next to it, so it survives a crash.
Open `http://<TV IP>:8077/log.txt` on a phone or PC in the same network, or scan the QR code under
**Settings** (also shown when the service does not start), and attach it to a bug report.

Some catalog apps need settings written into the package before they install (a server address,
an API key). The TV cannot do that yet, so those are shown greyed with a "Phone or PC" badge and
install from Apps2Samsung on a phone or PC instead. The same goes for apps that need root, and for
any file the catalog has no hash for.

## Settings

Press **▲** at the top of the list to reach **Settings**. Both switches are remembered on the TV:

- **Show adult (18+) apps**: off by default. Turning it on asks "I am 18 or older" first, as the
  phone app does; those apps then carry an 18+ badge.
- **Show apps that need a PC or phone**: on by default, so nobody thinks an app is missing; turn
  it off to keep the greyed "PC / phone" apps out of the list.

The header counts what the switches hide ("12 apps · 3 hidden").

## Layout

- `tizen-app/` – the package: `config.xml`, `index.html`, `js/app.js`, `icon.png`, `service/`
- `tizen-app/service/index.js` – the service: catalog, certificate, install pipeline. The `.wgt` carries
  `service/` as one file, bundled by `scripts/bundle-service.js` (Tizen 10 runs services in an embedded
  Node 20 and does not start split ones)
- `tizen-app/service/sdb.js` – the SDB client (connect, push, install)
- `tizen-app/service/signer.js` – the package signer
- `tizen-app/service/catalog.js` + `catalog-key.js` – the signed catalog check and its public key
- `tizen-app/service/compat.js` – buffers that work on the TV's Node 4.4.3
- `tizen-app/js/app.js` – the UI, and `window.A2SStore`, which Apps2Samsung calls to arm the TV
- `tizen-app/js/qrcode.js` – QR codes for the log address and the Ko-fi link ([qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4, MIT)
- `test/` – a fake `sdbd` plus signer and transport tests
- `docs/design/` – the screens above

## Tizen 9 and 10: help us test

On Tizen 9 and 10 the old way of starting TV-Store's background service does nothing; those sets
start a web service through the `Service` class of the `wrt:service` module. TV-Store 0.3.9 starts
it that way there (and as before on older sets). A user tracked down the cause; the test build
below checks it on more TVs before it becomes the regular release.

1. Uninstall TV-Store, then power the TV off at the wall for about 30 seconds.
2. Install `TV-Store.wgt` from the
   [tizen10-test-2 pre-release](https://github.com/Apps2Samsung/TV-Store/releases/tag/tizen10-test-2)
   with Apps2Samsung, as for any install.
3. Open TV-Store and wait up to 30 seconds.
4. Open `http://<TV IP>:8077/log.txt`; it should contain `TV-Store service on port 8077`.
5. Reply in [issue 26](https://github.com/Apps2Samsung/TV-Store/issues/26) with your TV model and
   Tizen version, whether the store opened, and the error text on screen if it did not.

Reports from older sets (Tizen 3 to 8) help too: they confirm nothing changed there.

## Build, test, release

A `.wgt` is a zip of `tizen-app/`; no Tizen Studio needed.

```sh
scripts/build-wgt.sh        # -> dist/TV-Store.wgt
node test/run.js            # connect + push + install against a fake sdbd
node test/sign.test.js      # the signer, with a certificate chain
node --expose-gc test/stream-sign.test.js  # the file-to-file signer on a 24 MB package
node test/bundle.test.js    # the bundled service starts however the platform loads it
node test/catalog.test.js   # the signed catalog: signature, age, hashes
```

Install the `.wgt` with Apps2Samsung like any package. A `vX.Y.Z` tag (matching the version in
`config.xml`) publishes a GitHub release with `TV-Store.wgt` as its one asset.

## Status

| Piece | State |
|---|---|
| Install through the TV's own `sdbd` | proven on a retail set |
| Signing on the TV | done, identical output to the Apps2Samsung signer |
| Arming from Apps2Samsung (phone, PC, CLI) | done |
| The screens above | built (0.3.4) |
| First real install from the TV | done, 2019 Tizen 5.0 set (0.3.4) |
| Tizen 3.0 and 4.0 sets (2017, 2018) | untested |
