#!/usr/bin/env bash
# Turns the HTTP Basic gate in front of Google sign-in on or off, without redeploying code.
# Edge functions re-read the config secret within ~5 minutes (cache TTL).
#   infra/signin/set-basic-auth.sh off   # after Google sign-in has been tested with real accounts
#   infra/signin/set-basic-auth.sh on
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-opstream-deploy}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-}" in
  on) V=true ;; off) V=false ;;
  *) echo "usage: $0 on|off" >&2; exit 2 ;;
esac
python3 "$HERE/secret.py" set-flag --region us-east-1 --name opstream-gtm/preview-edge-config --key basic_auth_required --value "$V"
