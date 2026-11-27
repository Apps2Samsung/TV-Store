#!/bin/sh
# TV-Store start at boot: the start-at-boot flag of TV-Store's service, read and, with "set", put back.
# The TV keeps what it registered of an app in a database. Some firmware writes "false" there for a
# service whose package asks to be started with the TV. This script changes that one value for that
# one app and nothing else. It prints one line: result=<kept|set|off|absent|failed>.
#   kept    the flag was on already; nothing was written
#   set     the flag was off and is on now (it counts from the next start of the TV)
#   off     the flag is off (mode "check" only reads)
#   absent  TV-Store is not on this TV, or not in a database this script knows
#   failed  the flag is off and could not be turned on
# A2S_DBS is for the test of this script: the databases to look in.
MODE="${1:-check}"
APP='A2STVStore.sdbservice'
uid=$(stat -c %u /opt/usr/home/owner 2>/dev/null)
[ -n "$uid" ] || uid=5001
DBS="${A2S_DBS:-/opt/dbspace/.pkgmgr_parser.db /opt/dbspace/user/$uid/.pkgmgr_parser.db}"
result=absent
for db in $DBS; do
    [ -f "$db" ] || continue
    was=$(sqlite3 -readonly -cmd ".timeout 5000" "$db" "SELECT app_onboot FROM package_app_info WHERE app_id='$APP';" 2>/dev/null)
    [ -n "$was" ] || continue
    if [ "$was" = "true" ]; then
        [ "$result" = absent ] && result=kept
        continue
    fi
    if [ "$MODE" != set ]; then
        [ "$result" = failed ] || result=off
        continue
    fi
    sqlite3 -bail -cmd ".timeout 5000" "$db" "BEGIN IMMEDIATE; UPDATE package_app_info SET app_onboot='true' WHERE app_id='$APP'; COMMIT;" >/dev/null 2>&1
    now=$(sqlite3 -readonly -cmd ".timeout 5000" "$db" "SELECT app_onboot FROM package_app_info WHERE app_id='$APP';" 2>/dev/null)
    if [ "$now" = "true" ]; then
        [ "$result" = failed ] || result=set
    else
        result=failed
    fi
done
echo "result=$result"
exit 0
