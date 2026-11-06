# Connecting a Salesforce test org: short guide

## Before you start

Three things have to happen before the test:

1. **Get a Salesforce test org.** Use a free Salesforce Developer Edition, or a test copy ("sandbox") of your
   company's org. Don't use your live org.
2. **Create a key for FundingEnvoy in that org (about 10 minutes).** Someone with admin rights in that org does this
   in Salesforce. It produces a consumer key and a consumer secret.
3. **Update FundingEnvoy on Azure (about 10 minutes).** Paste this into Cloud Shell and press Enter:

   ```
   cd ~ && (test -d funding-envoy-gcas-test || git clone https://github.com/johanholm-arch/funding-envoy-gcas-test.git) && cd funding-envoy-gcas-test && git pull && bash deploy/azure/update.sh
   ```

The test itself takes 2 minutes. It only reads from Salesforce and changes nothing there.

## Creating the key (step 2)

In Salesforce, click the gear icon, then **Setup**. The wording on screen may differ slightly; pick the closest match.

1. In the search box on the left, type **External Client App** and open **External Client App Manager**. Click
   **New External Client App**.
2. Name it **FundingEnvoy**, enter your email, and set Distribution State to **Local**.
3. Tick **Enable OAuth**.
   - Callback URL: `https://login.salesforce.com/services/oauth2/callback`
   - Scope: **Manage user data via APIs (api)**
   - Tick **Enable Client Credentials Flow**.
   - Click **Create**.
4. Open the **Policies** tab and click **Edit**. Tick **Enable Client Credentials Flow** and choose a **Run As** user (in
   a free test org, your own user is fine). Click **Save**.
5. Open the **Settings** tab and click **Consumer Key and Secret**. Enter the code Salesforce emails you, then copy the
   **key** and the **secret**.
6. In the Setup search box, type **My Domain** and copy the address. It ends in `.my.salesforce.com`.

## The test

1. Sign in to FundingEnvoy as the funder's process owner.
2. Go to **Studio**, then **Connections: Salesforce**, then choose **Your company's org**.
3. Paste the address, the key and the secret. Click **Save and test connection**.
4. Click **Read the org**.

If it works, you'll see the org's name, the user FundingEnvoy signed in as, and a list of the org's objects.

**If it fails:** the screen says what to fix. A brand-new key can take up to 10 minutes to start working, so wait and
try again. If it still fails, send the message on screen to whoever is helping you. Never send the secret.
