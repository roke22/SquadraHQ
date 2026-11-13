#!/bin/bash
# The demo itself, as the folder's user: the dashboard, and pisha-host as
# this container's machine, enrolled with the dashboard the first time.
#
#   /pisha/data       the dashboard's data (server token, sessions, messages)
#   /pisha/home       the home folder: Claude Code's login and settings,
#                       the plugin, pisha-host's credential and settings
#   /pisha/projects   where sessions can be opened (an example in demo/)
set -euo pipefail
D="${PISHA_DIR:-/pisha}"
mkdir -p "$D/data" "$D/home" "$D/projects"
chmod 700 "$D/data" "$D/home"
export HOME="$D/home" DATA_DIR="$D/data" HOST=0.0.0.0 PORT=7787
# The dashboard as this container reaches it (and as the published port
# shows it on the computer, unless you changed the port).
URL=http://localhost:7787
host() { node /app/pisha-host.mjs "$@"; }

# An example project with three personas, the first time.
if [ -z "$(ls -A "$D/projects")" ]; then cp -r /opt/pisha-example "$D/projects/demo"; fi

# The plugin from this image, installed again whenever the image changed.
build=$(cat /opt/pisha/build-id)
if [ "$(cat "$HOME/.pisha-demo-plugin" 2>/dev/null)" != "$build" ]; then
  echo "pisha-demo: installing the Pisha plugin in Claude Code…"
  claude plugin uninstall pisha@pisha >/dev/null 2>&1 || true
  claude plugin marketplace remove pisha >/dev/null 2>&1 || true
  claude plugin marketplace add /opt/pisha >/dev/null
  claude plugin install pisha@pisha >/dev/null
  echo "$build" > "$HOME/.pisha-demo-plugin"
fi

node /app/server.js &
server=$!
for i in $(seq 60); do
  node -e "fetch('$URL/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" && break
  [ "$i" = 60 ] && { echo "pisha-demo: the dashboard did not start"; exit 1; }
  sleep 0.5
done

if [ -f "$HOME/.config/pisha-host/credentials.json" ]; then
  host &
else
  # First start: this container becomes a machine of its own dashboard,
  # allowed to open sessions in the projects folder.
  host folders add "$D/projects" >/dev/null
  code=$(node -e "
    const token = require('fs').readFileSync('$DATA_DIR/server-token', 'utf8').trim()
    fetch('$URL/api/hosts/enroll', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'demo' }) })
      .then(r => r.json()).then(j => { if (!j.ok) throw new Error(j.description); console.log(j.result.code) })
      .catch(err => { console.error('pisha-demo: enrollment failed: ' + err.message); process.exit(1) })")
  host enroll "$URL" "$code" --no-plugin --no-service &
fi
machine=$!

token=$(cat "$DATA_DIR/server-token" 2>/dev/null || echo "(the one in PISHA_SERVER_TOKEN)")
cat <<EOF

  ┌─ Pisha demo ───────────────────────────────────────────────
  │ Open http://localhost:7787 and, the first time, create the owner
  │ with this token (then you sign in with your email and password):
  │   $token
  │ Then: + New session, folder $D/projects/demo,
  │ and log in to Claude in its terminal the first time (/login).
  │ (Published as in docker-compose.yml, only this computer reaches
  │ it: the warning about plain HTTP above is about the network.)
  └──────────────────────────────────────────────────────────────

EOF

# If either stops, the container stops (and Docker starts it again).
trap 'kill $server $machine 2>/dev/null' TERM INT
set +e
wait -n $server $machine
status=$?
kill $server $machine 2>/dev/null
exit $status
