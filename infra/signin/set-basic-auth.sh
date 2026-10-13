#!/usr/bin/env bash
# Turns the HTTP Basic gate in front of Google sign-in on or off, without redeploying code.
# Edge functions re-read the config secret within ~5 minutes (cache TTL); an edge that cannot reach
# Secrets Manager keeps its cached value for up to 1 hour.
#   infra/signin/set-basic-auth.sh on
#   infra/signin/set-basic-auth.sh off         # asks you to type "off" again
#   infra/signin/set-basic-auth.sh off --yes   # no prompt (only after Google sign-in was tested with real accounts)
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-opstream-deploy}"
export AWS_PAGER=""
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCOUNT=080403790510
usage() { echo "usage: $0 on|off [--yes]" >&2; exit 2; }
[ $# -ge 1 ] && [ $# -le 2 ] || usage
case "$1" in
  on) V=true ;; off) V=false ;;
  *) usage ;;
esac
YES=0
if [ $# -eq 2 ]; then [ "$2" = --yes ] || usage; YES=1; fi

if [ "$V" = false ] && [ "$YES" = 0 ]; then
  [ -t 0 ] || { echo "refusing: 'off' needs --yes when not run from a terminal" >&2; exit 1; }
  echo "This removes the HTTP Basic gate: Google sign-in becomes the only access control on the GTM preview."
  read -r -p 'Type "off" to confirm: ' CONFIRM
  [ "$CONFIRM" = off ] || { echo "not confirmed; nothing changed" >&2; exit 1; }
fi

[ "$(aws sts get-caller-identity --query Account --output text)" = "$ACCOUNT" ] || { echo "wrong AWS account" >&2; exit 1; }
python3 "$HERE/secret.py" set-flag --region us-east-1 --name opstream-gtm/preview-edge-config --key basic_auth_required --value "$V"
echo "Edges may keep the previous value for up to ~5 min (up to 1 h at an edge that cannot reach Secrets Manager)."
