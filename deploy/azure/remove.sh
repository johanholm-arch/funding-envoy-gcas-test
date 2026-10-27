#!/usr/bin/env bash
# Deletes the whole FundingEnvoy demo from Azure (app, database, files, registry). Costs stop once it's gone.
cd "$(dirname "$0")/../.." || exit 1
source deploy/azure/common.sh
need_settings
read -r -p "This permanently deletes the resource group $RG and everything in it. Type delete to continue: " ok
[ "$ok" = "delete" ] || fail "Nothing deleted."
az group delete --name "$RG" --yes --no-wait
mv "$SETTINGS" "$SETTINGS.removed"
say "Deleting in the background; it takes about 10 minutes. Settings moved to $SETTINGS.removed."
