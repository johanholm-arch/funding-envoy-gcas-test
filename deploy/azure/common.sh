# Shared by the FundingEnvoy Azure scripts. Not run on its own.
set -euo pipefail
SETTINGS="$HOME/fundingenvoy-azure.env"
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
save_settings() {
  umask 077
  cat > "$SETTINGS" <<SETTINGS_EOF
# FundingEnvoy on Azure: names and passwords. Keep this file private.
REGION=$REGION
RG=$RG
SUFFIX=$SUFFIX
PG=$PG
ACR=$ACR
SA=$SA
ENVNAME=$ENVNAME
APP=$APP
DB_ADMIN=$DB_ADMIN
DB_ADMIN_PW=$DB_ADMIN_PW
DB_APP_PW=$DB_APP_PW
COOKIE_SECRET=$COOKIE_SECRET
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
ANTHROPIC_SET=1
SETTINGS_EOF
}

# Cloud Shell without a storage account forgets files between sessions. If the settings file is gone but
# FundingEnvoy exists in Azure, rebuild the settings from Azure itself (names from the resource group, passwords
# from the app's own secrets). Returns non-zero when there is no FundingEnvoy to find.
recover_settings() {
  RG=${RG:-fundingenvoy-demo}
  APP=${APP:-fundingenvoy}
  az containerapp show --name "$APP" --resource-group "$RG" --only-show-errors >/dev/null 2>&1 || return 1
  secret() { az containerapp secret show --name "$APP" --resource-group "$RG" --secret-name "$1" --query value -o tsv --only-show-errors 2>/dev/null || true; }
  ACR=$(az acr list --resource-group "$RG" --query "[0].name" -o tsv --only-show-errors)
  PG=$(az postgres flexible-server list --resource-group "$RG" --query "[0].name" -o tsv --only-show-errors)
  SA=$(az storage account list --resource-group "$RG" --query "[?starts_with(name, 'fefiles')].name | [0]" -o tsv --only-show-errors)
  ENVNAME=$(az containerapp env list --resource-group "$RG" --query "[0].name" -o tsv --only-show-errors)
  REGION=$(az containerapp env show --name "$ENVNAME" --resource-group "$RG" --query location -o tsv --only-show-errors | tr -d ' ' | tr '[:upper:]' '[:lower:]')
  SUFFIX=${ACR#fereg}
  DB_ADMIN=feadmin
  DB_ADMIN_PW=$(secret db-admin-password)
  DB_APP_PW=$(secret db-app-password)
  COOKIE_SECRET=$(secret cookie-secret)
  ANTHROPIC_API_KEY=$(secret anthropic-api-key)
  export ANTHROPIC_SET=1
  [ -n "$ACR" ] && [ -n "$DB_ADMIN_PW" ] || return 1
  save_settings
}

need_settings() {
  if [ -f "$SETTINGS" ]; then
    # shellcheck disable=SC1090
    source "$SETTINGS"
  else
    note "Looking up your FundingEnvoy in Azure..."
    recover_settings || fail "I can't find FundingEnvoy in your Azure subscription. Run the setup first: bash deploy/azure/deploy.sh"
  fi
}
image_tag() { echo "$(git rev-parse --short HEAD 2>/dev/null || echo build)-$(date +%Y%m%d%H%M%S)"; }
app_url() { echo "https://$(az containerapp show -n "$APP" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv --only-show-errors)"; }
# Random letters and digits. (head closes the pipe early, which is expected, so its status is ignored.)
rand() { LC_ALL=C tr -dc "$1" </dev/urandom 2>/dev/null | head -c "$2" || true; }
