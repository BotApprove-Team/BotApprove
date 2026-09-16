#!/usr/bin/env bash
#
# Push to the server without giving the integrity sweep a window to look.
#
#   deploy/push.sh            everything sealed
#   HOST=delta deploy/push.sh
#
# Copying with scp and sealing afterwards is a race, and it is not theoretical:
# the sweep runs every five minutes, a hand-rolled multi-file scp takes ten or
# twenty seconds, and when the two overlap the sweep sees a half-copied tree,
# calls it tampering and latches safe mode until a person clears it.
#
# So the service is stopped for the swap. The sweep cannot fire while it is
# down, which is the only way to be certain rather than lucky. That costs a few
# seconds more downtime than a plain restart, which the deploy was doing anyway.
#
# rsync --delete is the other half: it removes anything on the server that is
# not in this tree, so a file put there by a mistyped scp is taken out rather
# than sealed in and blessed.
set -euo pipefail

HOST="${HOST:-delta}"
ROOT="${ROOT:-/opt/botapprove}"
SERVICE="${SERVICE:-botapprove}"
SEAL="${SEAL:-scripts/seal.js}"
PATHS="${PATHS:-src scripts package.json package-lock.json}"

cd "$(dirname "$0")/.."

echo "packing: $PATHS"
tar -czf - $PATHS | ssh "$HOST" "
set -euo pipefail
STAGE=\$(mktemp -d)
trap 'rm -rf \"\$STAGE\"' EXIT
tar -xzf - -C \"\$STAGE\"

echo '--- stopping $SERVICE for the swap ---'
systemctl stop $SERVICE

for p in $PATHS; do
  if [ -d \"\$STAGE/\$p\" ]; then
    rsync -a --delete --itemize-changes \"\$STAGE/\$p/\" \"$ROOT/\$p/\" | grep -E '^\*deleting' || true
    rsync -a --delete \"\$STAGE/\$p/\" \"$ROOT/\$p/\"
  else
    cp \"\$STAGE/\$p\" \"$ROOT/\$p\"
  fi
  chown -R root:root \"$ROOT/\$p\"
done

cd $ROOT
echo '--- sealing before it is allowed to run again ---'
node $SEAL | tail -2

systemctl start $SERVICE
"

echo "--- waiting for it to come up ---"
sleep 6
ssh "$HOST" "
echo \"state: \$(systemctl is-active $SERVICE)\"
SINCE=\$(systemctl show -p ActiveEnterTimestamp --value $SERVICE)
journalctl -u $SERVICE --since \"\$SINCE\" --no-pager | grep -iE 'integrity|error|does not match' | tail -5 || echo '(nothing said about integrity yet)'
"
