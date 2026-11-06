# Connecting a real Salesforce org to FundingEnvoy (read-only test)

This guide connects FundingEnvoy to a Salesforce org so you can see that the connection works. It is **read-only**:
FundingEnvoy signs in, reads which org it is, how many API calls are left today, and how the org's objects are built.
It writes nothing.

**Time:** about 30 minutes, most of it in Salesforce Setup.

**Use a test org, not your live one.** Either a free Salesforce Developer Edition, or a sandbox (a test copy) of your
company's org with your Salesforce admin's agreement.

## What you need

- A Salesforce org you can log in to as an administrator (for a company sandbox, ask your Salesforce admin to do
  part 2 with you).
- FundingEnvoy updated to the latest version on Azure (the "Get the latest version" line in `deploy/azure/GUIDE.md`).
- To sign in to FundingEnvoy as the funder's process owner.

## Part 1: Get a test org

Skip this part if your company gives you a sandbox.

1. Go to Salesforce's developer sign-up page (search for "Salesforce Developer Edition sign up").
2. Fill in the form. Use your real email address: Salesforce sends the login link there.
3. Open the email, set a password and log in.

## Part 2: Create the key FundingEnvoy will use (an "External Client App")

All of this is in Salesforce **Setup** (the gear icon at the top right, then **Setup**). Screen wording changes a little
between Salesforce releases; pick the closest match.

**Create the app**

1. In the **Quick Find** box on the left, type `External Client App` and open **External Client App Manager**.
2. Click **New External Client App**.
3. Fill in:
   - **External Client App Name:** `FundingEnvoy`
   - **Contact Email:** your email
   - **Distribution State:** `Local`
4. Open the **API (Enable OAuth Settings)** section and tick **Enable OAuth**.
5. **Callback URL:** type `https://login.salesforce.com/services/oauth2/callback`. FundingEnvoy doesn't use it for this
   test, but Salesforce requires one.
6. **OAuth Scopes:** add **Manage user data via APIs (api)**.
7. Under **Flow Enablement**, tick **Enable Client Credentials Flow**. If Salesforce asks you to confirm, confirm.
8. Click **Create**.

**Choose which user it acts as**

9. On the new app's page, open the **Policies** tab and click **Edit**.
10. Under **OAuth Policies**, tick **Enable Client Credentials Flow** (if it is there) and in **Run As (Username)** choose
    the user FundingEnvoy signs in as.
    - In a Developer Edition: your own user is fine for this read-only test.
    - In a company sandbox: ask your admin for an integration user with **API Enabled**, **View Setup and Configuration**
      (so FundingEnvoy can read the validation rules) and read access to the grants objects.
11. If your org restricts sign-ins by IP address, set **IP Relaxation** to **Relax IP restrictions** for this test.
12. Click **Save**.

**Copy the key and secret**

13. Open the **Settings** tab, then **OAuth Settings**, and click **Consumer Key and Secret**.
14. Salesforce emails you a verification code. Enter it.
15. Copy the **Consumer Key** and the **Consumer Secret** somewhere safe for a few minutes. Treat the secret like a
    password: don't email it or paste it into chat.
16. Find the org's address: in Quick Find, type `My Domain` and open **My Domain**. Copy the **Current My Domain URL**. It
    ends in `.my.salesforce.com`, for example `orgfarm-1234-dev-ed.develop.my.salesforce.com` or
    `yourcompany--test.sandbox.my.salesforce.com`.

Salesforce can take up to 10 minutes to apply a new app. If the test fails straight away, wait and try again.

## Part 3: Test it in FundingEnvoy

1. Sign in to FundingEnvoy as the funder's process owner.
2. Open **Studio**, then **Connections: Salesforce** on the left.
3. In **Connection**, choose **Your company's org**.
4. Paste the **My Domain address**, the **Consumer key** and the **Consumer secret**.
5. Click **Save and test connection**.

When it works you see the org's name and edition, whether it's a sandbox, the user FundingEnvoy signed in as, and how
many API calls the org has left today.

6. Click **Read the org**. FundingEnvoy lists the objects it read (organizations, files, Salesforce's Grants Management
   objects if the org has them, and custom objects whose names suggest grants), with their fields and the validation
   rules Salesforce runs on save.

The secret is stored encrypted and never shown again. **Change** replaces it; **Remove** deletes it. Every test and
reading is recorded in the audit trail.

## If the test fails

FundingEnvoy shows what Salesforce said, in plain words. The common ones:

| You see | What to do |
|---|---|
| Salesforce doesn't recognise that consumer key | Copy the key again (part 2, step 15). |
| The consumer key and secret don't match | Copy the secret again; it is case-sensitive. |
| The External Client App has no "Run As" user | Part 2, step 10. |
| The client credentials flow isn't switched on | Part 2, steps 7 and 10. |
| Use the org's own My Domain address | Use the address from part 2, step 16, not login.salesforce.com. |
| Refused because of IP restrictions | Part 2, step 11. |
| This edition or user doesn't have API access | Use a Developer, Enterprise or Unlimited edition org, and a Run As user with API Enabled. |
| That isn't a Salesforce My Domain address | Check the address ends in `.my.salesforce.com`. |
| Validation rules couldn't be read | The Run As user needs View Setup and Configuration. The rest of the reading still works. |

## What comes next

Once you know which object holds your grant requests, the next step is to match FundingEnvoy's fields to it and let it
write, as the simulated org already shows (choose **Simulated org** in the same screen to see the whole flow).
