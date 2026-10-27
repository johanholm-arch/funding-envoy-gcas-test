#!/usr/bin/env bash
# Puts the demo back to its starting point: everyone's demo requests, uploads and actions are replaced.
cd "$(dirname "$0")/../.." || exit 1
source deploy/azure/common.sh
need_settings
read -r -p "This erases everything people have done in the demo and loads it fresh. Type reset to continue: " ok
[ "$ok" = "reset" ] || fail "Nothing changed."
az containerapp update --name "$APP" --resource-group "$RG" --set-env-vars "FE_RESEED_TOKEN=reset-$(date +%Y%m%d%H%M%S)" --only-show-errors >/dev/null
say "Resetting. The app restarts and reloads the demo; allow 3 to 5 minutes: $(app_url)"
