# TV-Store start at boot

Turns the start-at-boot flag of the [TV-Store](https://github.com/Apps2Samsung/TV-Store) service
on again, on TVs whose firmware registers it as off at install. With the flag on, the TV starts
TV-Store's service when it starts, and TV-Store can update apps without being opened (its switch
"Update while TV-Store is closed").

It changes that one value for that one app. It does not download, sign or install anything, and it
does not touch the flag that restarts a service.

It looks 20 seconds after Vetro starts (Vetro starts with the TV) and once an hour after that:
every update of TV-Store registers the service again, and the flag is off again. A flag that is on
is left as it is; nothing is written then. A flag that was turned on counts from the next start of
the TV.

Whether it worked shows in two places: this Shard's detail in the Vetro dashboard, and in
TV-Store under Settings, where the line under "Update while TV-Store is closed" says when the TV
last started TV-Store by itself.

## Permissions

`exec`: the TV's list of registered apps can only be read and changed through the TV's root agent.

## Commands it runs

One script, `tv.sh`, sent to the TV as `sh -c "$(echo <tv.sh in base64> | base64 -d)" tvstore-onboot set`,
with a 20 second timeout. After three tries in which the flag would not turn on, it is sent with
`check` instead of `set` until Vetro starts again, and then only reads. Inside the script:

| Command | Why |
| --- | --- |
| `stat -c %u /opt/usr/home/owner` | the number of the TV's user, to find that user's own list of apps |
| `sqlite3 -readonly -cmd ".timeout 5000" <db> "SELECT app_onboot FROM package_app_info WHERE app_id='A2STVStore.sdbservice';"` | reads the flag, before and after |
| `sqlite3 -bail -cmd ".timeout 5000" <db> "BEGIN IMMEDIATE; UPDATE package_app_info SET app_onboot='true' WHERE app_id='A2STVStore.sdbservice'; COMMIT;"` | turns the flag on, only when it was read as off |

`<db>` is `/opt/dbspace/.pkgmgr_parser.db` and `/opt/dbspace/user/<user>/.pkgmgr_parser.db`, each
only when it exists and lists TV-Store's service.

## Network

None.

## Data it keeps

None. It does not use `ctx.config`. To undo what it did, switch the Shard off and turn the startup
switch of TV-Store's service off in Vetro's Task manager, or install TV-Store again.

## Tried on

Not tried on a TV. The same write is what Vetro does for its own service.
