# Shared by the FundingEnvoy Azure scripts. Not run on its own.
set -euo pipefail
SETTINGS="$HOME/fundingenvoy-azure.env"
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
need_settings() {
  [ -f "$SETTINGS" ] || fail "I can't find $SETTINGS. Run deploy/azure/deploy.sh first."
  # shellcheck disable=SC1090
  source "$SETTINGS"
}
image_tag() { echo "$(git rev-parse --short HEAD 2>/dev/null || echo build)-$(date +%Y%m%d%H%M%S)"; }
app_url() { echo "https://$(az containerapp show -n "$APP" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)"; }
# Random letters and digits. (head closes the pipe early, which is expected, so its status is ignored.)
rand() { LC_ALL=C tr -dc "$1" </dev/urandom 2>/dev/null | head -c "$2" || true; }
