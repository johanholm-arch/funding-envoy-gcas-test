#!/usr/bin/env bash
# Rebuilds FundingEnvoy from the latest code in GitHub and switches the running app to it. Demo data is kept.
cd "$(dirname "$0")/../.." || exit 1
source deploy/azure/common.sh
need_settings
say "Getting the latest code"
git pull --ff-only
say "Building (about 5 minutes)"
TAG=$(image_tag)
az acr build --registry "$ACR" --image "fundingenvoy:$TAG" --file Dockerfile . --only-show-errors >/dev/null || fail "The build failed."
say "Switching the app to the new version"
az containerapp update --name "$APP" --resource-group "$RG" --image "$ACR.azurecr.io/fundingenvoy:$TAG" --only-show-errors >/dev/null
say "Done. It takes a minute or two to restart: $(app_url)"
