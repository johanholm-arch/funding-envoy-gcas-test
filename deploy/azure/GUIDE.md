# Putting the FundingEnvoy demo on Azure

This guide puts the FundingEnvoy demo on the internet in your company's Azure account, so people on your team can open
it in a browser. You don't need to install anything or know how to program. You will copy a few lines into a box in
the Azure website, answer three questions, and wait.

**Time:** about 45 minutes, most of it waiting.

**What you end up with:**
- One web address for FundingEnvoy.
- Your team signs in with their normal work Microsoft account.
- After signing in, they choose which demo person to be: a requestor, a coordinator, the committee chair and so on.

## Before you start

- **An Azure subscription you're allowed to create things in.** Your role there needs to be "Contributor" or
  "Owner". If you're not sure, ask your IT team for "a subscription where I can create a resource group".
- **Someone who can approve a sign-in app, for step 4.** Limiting the demo to your team creates a small sign-in
  registration in Microsoft Entra ID (formerly Azure Active Directory). Some companies only let IT do this. If that's
  you, send IT step 4 of this guide.
- **A budget.** For light demo use, expect very roughly 50 to 100 US dollars a month. The price depends on your region
  and contract, so check it in the Azure pricing calculator. Most of the cost is the small database and one copy of
  the app kept running. Deleting the demo stops all charges (see "Everyday tasks" below).

## Step 1: Open the command box in Azure (Cloud Shell)

1. Go to https://portal.azure.com and sign in.
2. In the bar at the very top, click the icon that looks like `>_`. Its name is "Cloud Shell". A panel opens at the
   bottom of the page.
3. If it asks **Bash or PowerShell**, choose **Bash**.
4. If it asks about storage, choose the option that **mounts a storage account** and let it create one. Cloud Shell
   then remembers files between visits, and the later steps rely on a file the setup saves there. Don't choose "No
   storage account required".

You now have a box where you can paste text and press Enter.

## Step 2: Copy FundingEnvoy into Cloud Shell and start the setup

Paste these three lines into Cloud Shell and press Enter:

```
git clone https://github.com/johanholm-arch/funding-envoy-gcas-test.git
cd funding-envoy-gcas-test
bash deploy/azure/deploy.sh
```

**If the code is private on GitHub:** Cloud Shell asks for a GitHub username and password. GitHub no longer accepts
your normal password here. Use a "token" instead:

1. On github.com, open Settings, then Developer settings, then Personal access tokens, then Fine-grained tokens.
2. Make a token that can read this one repository's contents.
3. Paste the token where Cloud Shell asks for the password.

## Step 3: Answer three questions, then wait

The setup asks:

1. **"Is that right?"** It is checking the subscription name it shows you. Type `y` and press Enter.
2. **"Which Azure region?"** Press Enter to use West Europe, or type a region close to your team, such as `uksouth`
   or `eastus`.
3. **"Optional: paste an Anthropic API key".** Press Enter to use the built-in demo assistant. To use Claude instead,
   paste a key; nothing shows as you paste, which is normal.

The setup then works through seven steps and tells you what it's doing. The database and the build take the longest.
At the end it prints a line like this:

```
Done. FundingEnvoy is running at:
    https://fundingenvoy.<some-words>.<region>.azurecontainerapps.io
```

Open that address. You should see the FundingEnvoy sign-in page with demo people to choose from.

**Don't share the address yet.** Until you finish step 4, anyone who has the address can open the demo.

The setup saved its names and passwords in a private file called `fundingenvoy-azure.env` in your Cloud Shell. The
update, reset and delete commands below need it, so leave it there.

## Step 4: Let only your team in

This puts Microsoft sign-in in front of the demo, so only people in your company can open it. Optionally, it limits
access to named people.

**Turn on Microsoft sign-in:**

1. In the Azure portal, search for **Container Apps** in the top search box and open **fundingenvoy**.
2. In the menu on the left, open **Settings**, then **Authentication**.
3. Click **Add identity provider** and choose **Microsoft**.
4. Choose your company's directory ("Workforce configuration", "current tenant").
5. Choose **Create new app registration** and name it `fundingenvoy-demo`.
6. For who can sign in, choose **Current tenant – Single tenant**.
7. Under access, choose **Require authentication**. For people who aren't signed in, choose **HTTP 302 Found
   redirect**.
8. Click **Add**.

The wording on these screens can differ slightly from this list; pick the closest match. Now open the address again:
it asks you to sign in with your work account first. Anyone in your company can get in.

**Optional: allow only named people.**

1. In the portal search box, search for **Enterprise applications** and open **fundingenvoy-demo**.
2. Open **Properties**, set **Assignment required?** to **Yes**, and click **Save**.
3. Open **Users and groups**, click **Add user/group**, pick the people or a team group, and click **Assign**.

From now on only those people can open the demo. To let someone new in later, repeat step 3 for them.

## Using the demo with your team

- **Choose a demo person.** After signing in, people choose who to be. Dr. Elena Marsh is the requestor for the
  showcase request. Kwame Osei is the coordinator, Marisol Alvarez chairs the committee, and Jane Whitfield owns the
  configuration and analytics. The README in the repository has the full tour.
- **Everyone shares one demo world.** If a colleague submits Dr. Marsh's request, you will see it too. Agree who
  runs the demo, or reset it before an important session.
- **The assistant is labelled.** Without an Anthropic key it says "Demo assistant: no AI model is called". With a
  key it says Claude.

## Everyday tasks

Open Cloud Shell (step 1) and paste the line for what you want to do. Each line first fetches the latest copy of
FundingEnvoy from GitHub, so it works even when Cloud Shell has forgotten everything since last time (it says "Your
Cloud Shell session will be ephemeral" when that happens). The scripts then look up your FundingEnvoy in Azure.

**Start the demo again from the beginning.** This erases what people have done in it.

```
cd ~ && (test -d funding-envoy-gcas-test || git clone https://github.com/johanholm-arch/funding-envoy-gcas-test.git) && cd funding-envoy-gcas-test && git pull && bash deploy/azure/reset-demo.sh
```

**Get the latest version.** Use this after new work has been added to GitHub. Demo data is kept.

```
cd ~ && (test -d funding-envoy-gcas-test || git clone https://github.com/johanholm-arch/funding-envoy-gcas-test.git) && cd funding-envoy-gcas-test && git pull && bash deploy/azure/update.sh
```

**Delete everything and stop all charges.** This can't be undone, but you can run step 2 again later to set it up
fresh.

```
cd ~ && (test -d funding-envoy-gcas-test || git clone https://github.com/johanholm-arch/funding-envoy-gcas-test.git) && cd funding-envoy-gcas-test && git pull && bash deploy/azure/remove.sh
```

## If something goes wrong

- **"You don't have permission" or "AuthorizationFailed".** Your account can't create things in that subscription.
  Ask IT for Contributor access to a subscription, or ask them to run step 2 for you.
- **"TasksOperationsNotAllowed", or the build step fails straight away.** Some free-trial and sponsored subscriptions
  can't build apps inside Azure. Use a pay-as-you-go or company subscription.
- **The database step says the size or version isn't available in your region.** Paste
  `rm ~/fundingenvoy-azure.env`, then run step 2 again and choose another region, such as `northeurope`, `uksouth` or
  `eastus`.
- **The address doesn't load after 10 minutes.**
  1. In the portal, open the **fundingenvoy** container app, then **Monitoring**, then **Log stream**.
  2. Look for lines starting with `[start]`.
  3. Copy those lines and send them to whoever is helping you. They show which start-up step stopped.
- **Step 4 won't let you create the app registration.** That needs rights in Microsoft Entra ID. Send step 4 to your
  IT team.

## What the setup creates

Everything goes into one resource group called `fundingenvoy-demo`, so it's easy to find and to delete.

| Piece | What it's for |
|---|---|
| Container app `fundingenvoy` | The website and the system behind it |
| Container Apps environment `fundingenvoy-env` | The space the app runs in, with its logs |
| PostgreSQL flexible server `fe-pg-…` | The database: requests, people, the audit trail |
| Storage account `fefiles…` | Uploaded documents |
| Container registry `fereg…` | Where the built app is kept so Azure can run it |

Passwords are generated for you. They are kept as secrets in the container app and in your private settings file.
The database only accepts connections from inside Azure.
