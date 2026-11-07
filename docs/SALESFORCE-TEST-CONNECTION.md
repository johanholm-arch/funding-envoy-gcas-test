# Connecting your Salesforce test environment to FundingEnvoy

A step-by-step guide for doing this on your own, in the order it has to happen. It takes about an hour, including a
10-minute wait.

**What you are doing, in one sentence:** you create a key in Salesforce that lets FundingEnvoy sign in, then paste
that key into FundingEnvoy and check that FundingEnvoy can read your Salesforce. FundingEnvoy only **reads**; it changes
nothing in Salesforce.

## The order, at a glance

| Part | Where | What | Time |
|---|---|---|---|
| A | Azure (Cloud Shell) | Make sure FundingEnvoy is up to date | 10 min |
| B | Salesforce | Log in to the test environment and copy its address | 5 min |
| C | Salesforce | Create the key for FundingEnvoy (an "External Client App") | 15 min |
| D | Salesforce | Choose which Salesforce user the key acts as | 5 min |
| E | Salesforce | Copy the key and its secret, then wait 10 minutes | 15 min |
| F | FundingEnvoy | Paste them in and test the connection | 5 min |
| G | FundingEnvoy and Salesforce | Read the org, and find where your grant requests are kept | 15 min |
| H | Both | How to switch it off again | when you want |

Before you start, have two windows open: your FundingEnvoy site and your Salesforce test environment. Keep a
temporary note (for example Notepad) for the three things you will copy in parts B and E.

**Screens change.** Salesforce updates its screens three times a year, so a label can move or be worded slightly
differently. Pick the closest match. Where an option is known to move, this guide says where else to look.

---

## Part A: Make sure FundingEnvoy is up to date (Azure)

1. Go to https://portal.azure.com and sign in.
2. Click the `>_` icon at the top (Cloud Shell). Choose **Bash** if it asks.
3. Paste this line and press **Enter**:

   ```
   cd ~ && (test -d funding-envoy-gcas-test || git clone https://github.com/johanholm-arch/funding-envoy-gcas-test.git) && cd funding-envoy-gcas-test && git pull && bash deploy/azure/update.sh
   ```

4. Wait until it says it's done (about 10 minutes).

**Check:** open FundingEnvoy, sign in as **Jane Whitfield** (Halden Pharma, the process owner), go to **Studio**, and
click **Salesforce** under **Connections** on the left. Click the **Your company's org** box. If you see boxes for
**My Domain address**, **Consumer key** and **Consumer secret**, you're up to date. If it says "Not available yet",
run step 3 again.

---

## Part B: Log in to Salesforce and copy its address (Salesforce)

1. Log in to your Salesforce **test environment** (a "sandbox"). A sandbox is usually reached through
   https://test.salesforce.com, and its username often ends in an extra word, like `you@company.com.uat`.
2. **Check you're in the test environment, not the live one.** A sandbox shows a banner or label with the sandbox's
   name at the top of the screen. If you're not sure, ask before going further.
3. Click the **gear icon** at the top right, then **Setup**.
4. In the **Quick Find** box at the top left, type `My Domain` and click **My Domain**.
5. Copy the **Current My Domain URL** into your note. It ends in `.my.salesforce.com`, for example
   `yourcompany--uat.sandbox.my.salesforce.com`. If it starts with `https://`, that's fine; FundingEnvoy removes it.

---

## Part C: Create the key for FundingEnvoy (Salesforce)

The key is called an **External Client App**. It's the official way to let another system sign in to Salesforce.

1. Still in **Setup**, type `External Client App` in **Quick Find** and click **External Client App Manager**.
   - Don't use "App Manager" or "New Connected App": Salesforce no longer lets new connections be made that way.
2. Click **New External Client App**.
3. In the first section (basic information), fill in:
   - **External Client App Name:** `FundingEnvoy`
   - **API Name:** fills itself in; leave it.
   - **Contact Email:** your email address.
   - **Distribution State:** `Local`
   - Leave everything else in this section as it is.
4. Open the section called **API (Enable OAuth Settings)** and tick **Enable OAuth**. More options appear:
   - **Callback URL:** type `https://login.salesforce.com/services/oauth2/callback`. FundingEnvoy doesn't use it,
     but Salesforce requires one.
   - **OAuth Scopes:** in the list of available scopes, click **Manage user data via APIs (api)** and move it to
     **Selected OAuth Scopes** with the arrow button.
   - **Flow Enablement:** tick **Enable Client Credentials Flow**. A message asks you to confirm; click **OK**.
   - **Security:** leave the boxes that are already ticked as they are.
5. Click **Create** at the bottom.

You now see the app's own page, with tabs such as **Settings** and **Policies**.

---

## Part D: Choose which Salesforce user the key acts as (Salesforce)

FundingEnvoy doesn't sign in with anyone's password. The key acts as one Salesforce user that you choose, and
FundingEnvoy can then **read** what that user can see. In a test environment, your own admin user is fine.

1. On the app's page, click the **Policies** tab, then **Edit**.
2. Find the section **OAuth Policies**, and in it **OAuth Flows and External Client App Enhancements**:
   - Tick **Enable Client Credentials Flow** if it's there and not ticked.
   - In **Run As (Username)**, search for your own name or username and choose it.
3. Still under **OAuth Policies**, find **IP Relaxation** and choose **Relax IP restrictions**. This stops Salesforce
   refusing FundingEnvoy because the Azure server's address isn't on an approved list. It's fine for a test.
4. Click **Save**.

**If you can't find "Run As":** look on the **Settings** tab under **OAuth Settings**, and tick **Enable Client
Credentials Flow** wherever you see it; then go back to **Policies**, **Edit**, and look again.

---

## Part E: Copy the key and its secret, then wait (Salesforce)

1. On the app's page, click the **Settings** tab.
2. Open **OAuth Settings** and click **Consumer Key and Secret**.
3. Salesforce emails you a **verification code**. Type it in.
4. Copy the **Consumer Key** into your note, then the **Consumer Secret**.
   - The secret works like a password. Don't email it, don't put it in a chat (including with Claude), and delete your
     note once FundingEnvoy has it.
5. **Wait 10 minutes.** Salesforce can take that long to switch a new app on. Get a coffee.

Your note now holds three things: the **address** (part B), the **consumer key** and the **consumer secret**.

---

## Part F: Connect and test (FundingEnvoy)

1. In FundingEnvoy, sign in as **Jane Whitfield** (Halden Pharma).
2. Go to **Studio**, and click **Salesforce** under **Connections** on the left.
3. Under **1 Connection**, click the box **Your company's org**.
4. Paste:
   - the address into **My Domain address**
   - the key into **Consumer key**
   - the secret into **Consumer secret**
5. Click **Save and test connection**.

**What success looks like:** under the buttons you see your org's **name and edition**, the word **sandbox**, the
user it **signed in as** (the one you chose in part D), and **API calls left today**.

6. **Delete your note** with the secret. FundingEnvoy stores it encrypted and never shows it again.

**If you see a red message instead,** look it up in "If something goes wrong" below. Fix it, then click **Test
connection** again. You don't need to paste everything again; **Change** lets you replace just the part that was
wrong.

---

## Part G: Read the org, and find where grant requests are kept

**In FundingEnvoy**

1. Under **2 Read the org**, click **Read the org**.
2. FundingEnvoy lists what it read: organizations (**Account**), files (**ContentVersion**), Salesforce's own Grants
   Management objects if your org has them, and objects whose names suggest grants, with how many fields each has. It
   also lists the checks Salesforce runs when a record is saved.
3. Take a **screenshot** of the list.

**In Salesforce** (this tells us exactly which object to connect to next)

4. In **Setup**, click **Object Manager** at the top.
5. In its search box, try `grant`, then `request`, then `application`, then `funding`. For each object that looks like
   it holds grant requests, organizations, payees (bank details) or documents, write down its **Label** and its
   **API Name** (for example `Grant Request` and `vendor__Grant_Request__c`).
6. In **Quick Find**, type `Installed Packages` and click it. Write down the name of anything that looks like the
   grants application, and its **Publisher**. That tells us which vendor's app it is.

**Send these back** (to the Claude Code session, or the "Salesforce connector" chat in your Claude project): the
screenshot from step 3, the object names from step 5, and the package name from step 6. Never the secret.

---

## Part H: Switching it off again

- **In FundingEnvoy:** Studio, Connections: Salesforce, **Your company's org**, **Remove**. The saved key and secret
  are deleted.
- **In Salesforce:** Setup, **External Client App Manager**, open **FundingEnvoy**, and delete it (or untick **Enable
  Client Credentials Flow** in its Policies). After that, the key no longer works anywhere.

FundingEnvoy changed nothing in Salesforce: the only thing added there is the app you created in part C.

---

## If something goes wrong

| FundingEnvoy says | What to do |
|---|---|
| That isn't a Salesforce My Domain address | Copy the address again (part B, step 5). It must end in `.my.salesforce.com`. |
| Salesforce doesn't recognise that consumer key | Copy the key again (part E). Make sure you copied the key, not the secret, into that box. |
| The consumer key and secret don't match | Copy the secret again; it is case-sensitive. Use **Change** and paste only the secret. |
| The External Client App has no "Run As" user | Part D, step 2. |
| The client credentials flow isn't switched on | Part C, step 4 ("Flow Enablement") and part D, step 2. Tick it in both places if both exist. |
| Use the org's own My Domain address | You used login.salesforce.com or test.salesforce.com. Use the address from part B. |
| Refused because of IP restrictions | Part D, step 3. |
| The Run As user isn't allowed to use this app | In the app's **Policies**, make sure your user is permitted, then save. |
| This edition or user doesn't have API access | Ask whoever gave you access to make sure your user has "API Enabled". |
| Validation rules couldn't be read | Not a problem for the test. Your user needs "View Setup and Configuration" for that part. |
| FundingEnvoy couldn't reach that address | Check the address for typos. If it's right, try again in a few minutes. |
| Any message, straight after part E | Wait the full 10 minutes, then click **Test connection** again. |

If none of these fit, take a screenshot of the message (it never shows the secret) and send it.

## Later, for real use

For this test, the key acts as your own admin user. For real use, your Salesforce admin should create a separate
**integration user** (Salesforce includes a few free with most company editions) with only the access FundingEnvoy
needs: "API Enabled", "View Setup and Configuration", and read access to the grants objects. Then choose that user in
part D instead.
