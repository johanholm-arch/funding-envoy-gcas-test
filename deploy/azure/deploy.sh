#!/usr/bin/env bash
# Puts the FundingEnvoy demo on Azure Container Apps. Run it in Azure Cloud Shell (Bash).
# Plain-language instructions: deploy/azure/GUIDE.md. Safe to run again: it reuses what already exists.
cd "$(dirname "$0")/../.." || exit 1
source deploy/azure/common.sh

if [ -f "$SETTINGS" ]; then
  # shellcheck disable=SC1090
  source "$SETTINGS"
  say "Continuing with the settings saved in $SETTINGS."
fi

say "Step 1 of 7: checking your Azure subscription"
SUB_NAME=$(az account show --query name -o tsv) || fail "You don't seem to be signed in to Azure. In Cloud Shell this is automatic; elsewhere run: az login"
note "FundingEnvoy will be created in the subscription: $SUB_NAME"
read -r -p "  Is that right? Type y and press Enter to continue: " ok
[ "$ok" = "y" ] || fail "Stopped. To use another subscription: az account set --subscription \"<its name>\", then run this again."

if [ -z "${REGION:-}" ]; then
  read -r -p "  Which Azure region? Press Enter for westeurope, or type another (for example uksouth or eastus): " REGION
  REGION=${REGION:-westeurope}
fi
if [ -z "${ANTHROPIC_SET:-}" ]; then
  read -r -s -p "  Optional: paste an Anthropic API key to use Claude, or just press Enter for the demo assistant: " ANTHROPIC_API_KEY; echo
  ANTHROPIC_SET=1
fi

RG=${RG:-fundingenvoy-demo}
SUFFIX=${SUFFIX:-$(rand a-z0-9 6)}
PG=${PG:-fe-pg-$SUFFIX}
ACR=${ACR:-fereg$SUFFIX}
SA=${SA:-fefiles$SUFFIX}
ENVNAME=${ENVNAME:-fundingenvoy-env}
APP=${APP:-fundingenvoy}
DB_ADMIN=${DB_ADMIN:-feadmin}
DB_ADMIN_PW=${DB_ADMIN_PW:-Fe-$(rand A-Za-z0-9 24)-9a}
DB_APP_PW=${DB_APP_PW:-Ap-$(rand A-Za-z0-9 24)-7b}
COOKIE_SECRET=${COOKIE_SECRET:-$(rand A-Za-z0-9 48)}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}

umask 077
cat > "$SETTINGS" <<SETTINGS_EOF
# FundingEnvoy on Azure: names and passwords created by deploy.sh. Keep this file private.
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
note "Names and passwords are saved in $SETTINGS (only you can read it)."

say "Step 2 of 7: preparing the subscription (a minute or two the first time)"
az extension add --name containerapp --upgrade --only-show-errors >/dev/null 2>&1 || true
for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL Microsoft.Storage; do
  az provider register --namespace "$ns" --wait --only-show-errors >/dev/null
done
# The resource group is only a folder; if it already exists (perhaps from a run in another region), keep it.
az group show --name "$RG" >/dev/null 2>&1 || az group create --name "$RG" --location "$REGION" --only-show-errors >/dev/null
note "Everything goes into one resource group: $RG (region $REGION)."

say "Step 3 of 7: the database (about 5 to 10 minutes)"
if az postgres flexible-server show --name "$PG" --resource-group "$RG" >/dev/null 2>&1; then
  note "Database server $PG already exists."
else
  if ! out=$(az postgres flexible-server create --name "$PG" --resource-group "$RG" --location "$REGION" \
      --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 16 \
      --admin-user "$DB_ADMIN" --admin-password "$DB_ADMIN_PW" --public-access 0.0.0.0 --yes --only-show-errors 2>&1); then
    if grep -qiE "restricted|not available|quota|SkuNotAvailable|NoRegisteredProviderFound" <<<"$out"; then
      rm -f "$SETTINGS"
      fail "Azure won't create this database in $REGION for your subscription. Nothing has been built yet.
Run the setup again and choose a different region when asked:
    bash deploy/azure/deploy.sh
In the US try centralus, westus3 or eastus2; in Europe try northeurope, swedencentral or uksouth.
(Azure's message was: $(head -c 300 <<<"$out"))"
    fi
    fail "Creating the database failed. Azure's message was:
$out"
  fi
  note "Database server $PG created. Only services inside Azure can reach it."
fi

say "Step 4 of 7: file storage for uploaded documents"
if ! az storage account show --name "$SA" --resource-group "$RG" >/dev/null 2>&1; then
  az storage account create --name "$SA" --resource-group "$RG" --location "$REGION" --sku Standard_LRS --kind StorageV2 --https-only true --min-tls-version TLS1_2 --only-show-errors >/dev/null
fi
az storage share-rm create --resource-group "$RG" --storage-account "$SA" --name fundingenvoy-data --quota 5 --only-show-errors >/dev/null 2>&1 || true
SA_KEY=$(az storage account keys list --account-name "$SA" --resource-group "$RG" --query "[0].value" -o tsv)
note "Storage account $SA ready."

say "Step 5 of 7: building the app (about 5 minutes)"
if ! az acr show --name "$ACR" --resource-group "$RG" >/dev/null 2>&1; then
  az acr create --name "$ACR" --resource-group "$RG" --location "$REGION" --sku Basic --admin-enabled true --only-show-errors >/dev/null
fi
TAG=$(image_tag)
az acr build --registry "$ACR" --image "fundingenvoy:$TAG" --file Dockerfile . --only-show-errors >/dev/null \
  || fail "The build in Azure failed. See 'If something goes wrong' in deploy/azure/GUIDE.md."
ACR_USER=$(az acr credential show --name "$ACR" --query username -o tsv --only-show-errors)
ACR_PW=$(az acr credential show --name "$ACR" --query "passwords[0].value" -o tsv --only-show-errors)
note "Built image fundingenvoy:$TAG."

say "Step 6 of 7: the app's home in Azure"
if ! az containerapp env show --name "$ENVNAME" --resource-group "$RG" --only-show-errors >/dev/null 2>&1; then
  az containerapp env create --name "$ENVNAME" --resource-group "$RG" --location "$REGION" --only-show-errors >/dev/null
fi
az containerapp env storage set --name "$ENVNAME" --resource-group "$RG" --storage-name fedata \
  --azure-file-account-name "$SA" --azure-file-account-key "$SA_KEY" --azure-file-share-name fundingenvoy-data \
  --access-mode ReadWrite --only-show-errors >/dev/null
ENV_ID=$(az containerapp env show --name "$ENVNAME" --resource-group "$RG" --query id -o tsv --only-show-errors)

say "Step 7 of 7: starting FundingEnvoy (the first start loads the demo; allow 3 to 5 minutes)"
YAML=$(mktemp --suffix .yaml)
{
cat <<YAML_EOF
location: $REGION
name: $APP
type: Microsoft.App/containerApps
properties:
  managedEnvironmentId: $ENV_ID
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: true
      targetPort: 8787
      transport: auto
      allowInsecure: false
    registries:
      - server: $ACR.azurecr.io
        username: $ACR_USER
        passwordSecretRef: registry-password
    secrets:
      - name: registry-password
        value: '$ACR_PW'
      - name: db-admin-password
        value: '$DB_ADMIN_PW'
      - name: db-app-password
        value: '$DB_APP_PW'
      - name: cookie-secret
        value: '$COOKIE_SECRET'
YAML_EOF
if [ -n "$ANTHROPIC_API_KEY" ]; then cat <<YAML_EOF
      - name: anthropic-api-key
        value: '$ANTHROPIC_API_KEY'
YAML_EOF
fi
cat <<YAML_EOF
  template:
    containers:
      - name: fundingenvoy
        image: $ACR.azurecr.io/fundingenvoy:$TAG
        resources:
          cpu: 1.0
          memory: 2Gi
        env:
          - name: FE_DB_HOST
            value: $PG.postgres.database.azure.com
          - name: FE_DB_ADMIN_USER
            value: $DB_ADMIN
          - name: FE_DB_ADMIN_PASSWORD
            secretRef: db-admin-password
          - name: FE_DB_APP_PASSWORD
            secretRef: db-app-password
          - name: FE_COOKIE_SECRET
            secretRef: cookie-secret
YAML_EOF
if [ -n "$ANTHROPIC_API_KEY" ]; then cat <<YAML_EOF
          - name: ANTHROPIC_API_KEY
            secretRef: anthropic-api-key
YAML_EOF
fi
cat <<YAML_EOF
        volumeMounts:
          - volumeName: data
            mountPath: /data
        probes:
          - type: Startup
            httpGet:
              path: /api/health
              port: 8787
            initialDelaySeconds: 60
            periodSeconds: 60
            failureThreshold: 10
          - type: Liveness
            httpGet:
              path: /api/health
              port: 8787
            periodSeconds: 30
            failureThreshold: 3
    scale:
      minReplicas: 1
      maxReplicas: 1
    volumes:
      - name: data
        storageType: AzureFile
        storageName: fedata
YAML_EOF
} > "$YAML"
if az containerapp show --name "$APP" --resource-group "$RG" --only-show-errors >/dev/null 2>&1; then
  az containerapp update --name "$APP" --resource-group "$RG" --yaml "$YAML" --only-show-errors >/dev/null
else
  az containerapp create --name "$APP" --resource-group "$RG" --yaml "$YAML" --only-show-errors >/dev/null
fi
rm -f "$YAML"

URL=$(app_url)
note "Waiting for the first start to finish..."
for _ in $(seq 1 60); do
  if curl -fsS "$URL/api/health" >/dev/null 2>&1; then break; fi
  sleep 10
done
if curl -fsS "$URL/api/health" >/dev/null 2>&1; then
  say "Done. FundingEnvoy is running at:"
  printf '\n    %s\n\n' "$URL"
  note "Before you share the link, do step 4 of the guide so only your team can open it."
else
  say "Azure has the app, but it hasn't answered yet. Give it a few more minutes, then open:"
  printf '\n    %s\n\n' "$URL"
  note "If it still doesn't load, see 'If something goes wrong' in deploy/azure/GUIDE.md."
fi
