# Clippar Production Setup Guide — Step by Step

Do these in order. Each section builds on the previous one.

---

## 1. NEON POSTGRES (Database)

### 1.1 Create Account
1. Open browser → go to **https://neon.tech**
2. Click the green **"Sign Up"** button (top-right corner)
3. Choose **"Continue with GitHub"** (easiest if you have a GitHub account) or use email
4. If GitHub: authorize Neon to access your GitHub account
5. You'll land on the Neon dashboard

### 1.2 Create Project
1. You should see a **"Create a project"** button in the center of the screen (or top-right if you already have projects)
2. Click **"Create a project"**
3. Fill in:
   - **Project name**: `clippar-prod`
   - **Postgres version**: Leave default (16)
   - **Region**: Choose **Australia (Sydney)** if available, otherwise **US East (N. Virginia)** — pick whatever is closest to your users
   - **Compute size**: Leave on **0.25 CU** (free tier)
4. Click **"Create project"** (green button, bottom-right)

### 1.3 Get Your Connection String
1. After creation, you'll see a **"Connection Details"** panel
2. There's a dropdown at the top that says **"Connection string"** — make sure it's selected
3. Below that, there's another dropdown for the driver — select **"psycopg2"**
4. You'll see a string like:
   ```
   postgresql://neondb_owner:AbCdEfGh123@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
5. Click the **copy icon** (little clipboard) to the right of the string
6. **SAVE THIS SOMEWHERE SAFE** — this is your `DATABASE_URL`. You'll need it for both Vercel and Railway

### 1.4 Verify Connection (Optional)
1. In the left sidebar, click **"SQL Editor"** (looks like a terminal icon)
2. Paste this and click **"Run"** (green play button):
   ```sql
   CREATE TABLE IF NOT EXISTS waitlist (
       id          SERIAL PRIMARY KEY,
       name        TEXT NOT NULL,
       email       TEXT NOT NULL UNIQUE,
       frequency   TEXT,
       created_at  TIMESTAMPTZ DEFAULT NOW()
   );

   CREATE TABLE IF NOT EXISTS jobs (
       id              TEXT PRIMARY KEY,
       name            TEXT NOT NULL,
       email           TEXT NOT NULL,
       frequency       TEXT,
       drive_link      TEXT,
       status          TEXT DEFAULT 'pending',
       error_message   TEXT,
       admin_note      TEXT,
       result_drive_link TEXT,
       clip_count      INTEGER,
       created_at      TIMESTAMPTZ,
       updated_at      TIMESTAMPTZ
   );
   ```
3. You should see **"CREATE TABLE"** confirmation messages

---

## 2. CLOUDFLARE ACCOUNT + DNS

### 2.1 Create Cloudflare Account
1. Go to **https://dash.cloudflare.com/sign-up**
2. Enter your **email** and **password**
3. Click **"Sign up"**
4. Verify your email (check inbox, click the link)

### 2.2 Add Your Domain
1. On the Cloudflare dashboard, click **"+ Add a site"** (blue button, top area)
2. Type **clippargolf.com** in the text field
3. Click **"Continue"**
4. Select the **"Free"** plan (scroll down, it's the leftmost option at $0/month)
5. Click **"Continue"**
6. Cloudflare will scan your existing DNS records — click **"Continue"** (don't worry about existing records right now)

### 2.3 Get Cloudflare Nameservers
1. After the scan, Cloudflare shows you **two nameservers**, something like:
   ```
   aria.ns.cloudflare.com
   duke.ns.cloudflare.com
   ```
2. **WRITE THESE DOWN** — you need them for the next step
3. **Don't close this tab** — you'll come back to click "Done, check nameservers"

### 2.4 Update Nameservers at OnlyDomains
1. Open a new tab → go to **https://www.onlydomains.com**
2. Click **"Login"** (top-right)
3. Enter your OnlyDomains username/email and password
4. After login, go to **"My Domains"** or **"Domain Manager"** (in the navigation menu or dashboard)
5. Find **clippargolf.com** in your domain list
6. Click on it (or click **"Manage"** next to it)
7. Look for **"Nameservers"** or **"DNS Settings"** — it might be in a tab or sidebar
8. You'll see your current nameservers (probably OnlyDomains defaults)
9. Click **"Change Nameservers"** or **"Edit"**
10. **Delete** all existing nameservers
11. Add the two Cloudflare nameservers:
    - Nameserver 1: `aria.ns.cloudflare.com` (use YOUR actual ones from step 2.3)
    - Nameserver 2: `duke.ns.cloudflare.com` (use YOUR actual ones from step 2.3)
12. Click **"Save"** or **"Update"**
13. Go back to the Cloudflare tab and click **"Done, check nameservers"**
14. Cloudflare will say "Pending verification" — this can take **5 minutes to 24 hours** (usually under 1 hour)
15. You'll get an email from Cloudflare when it's active

---

## 3. CLOUDFLARE R2 (File Storage)

### 3.1 Enable R2
1. In the Cloudflare dashboard (https://dash.cloudflare.com)
2. Look at the **left sidebar** — scroll down to find **"R2 Object Storage"** and click it
3. If this is your first time, you may need to enter payment details (credit card) — **you won't be charged** on the free tier, but Cloudflare requires a card on file for R2
4. Click **"Create bucket"**

### 3.2 Create the Bucket
1. **Bucket name**: type `clippar`
2. **Location**: Choose **Automatic** (or pick a region close to you)
3. **Storage class**: Leave as **Standard**
4. Click **"Create bucket"** (bottom-right)

### 3.3 Create API Credentials
1. After the bucket is created, go back to the R2 main page (click **"R2 Object Storage"** in left sidebar)
2. Click **"Manage R2 API Tokens"** (top-right area, or there's a link in the overview page)
3. Click **"Create API token"**
4. Fill in:
   - **Token name**: `clippar-app`
   - **Permissions**: Select **"Object Read & Write"**
   - **Specify bucket(s)**: Select **"Apply to specific buckets only"** → select **"clippar"**
5. Click **"Create API Token"**
6. You'll now see THREE values — **SAVE ALL THREE IMMEDIATELY** (they're shown only once):
   - **Access Key ID** → this is your `R2_ACCESS_KEY`
   - **Secret Access Key** → this is your `R2_SECRET_KEY`
   - **Endpoint URL** → something like `https://abc123def456.r2.cloudflarestorage.com` → this is your `R2_ENDPOINT`

**Write these down now:**
```
R2_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
R2_ACCESS_KEY=your_access_key_here
R2_SECRET_KEY=your_secret_key_here
R2_BUCKET=clippar
```

---

## 4. MAILCHIMP (Email Marketing)

### 4.1 Create Account
1. Go to **https://mailchimp.com**
2. Click **"Sign Up Free"** (top-right)
3. Enter your **email**, **username**, and **password**
4. Click **"Sign Up"**
5. Check your email for a verification link → click it
6. Go through the onboarding wizard:
   - **Your info**: Enter your name, business name ("Clippar"), website (clippargolf.com)
   - **Address**: Enter your business address (required by anti-spam law — your home address works)
   - **Goals**: Select whatever, doesn't matter
   - **Plan**: Select **"Continue with Free"** (bottom option)

### 4.2 Create Your Audience
1. After onboarding, you'll be on the Mailchimp dashboard
2. In the **left sidebar**, click **"Audience"** (person icon)
3. If you don't see an audience yet, click **"Create Audience"**
4. If there's already a default audience, click on it → click **"Settings"** (gear icon) → **"Audience name and defaults"**
5. Set:
   - **Audience name**: `Clippar Waitlist`
   - **Default From email**: your email (e.g., henryjohncoward@gmail.com)
   - **Default From name**: `Clippar`
6. Click **"Save"**

### 4.3 Add Custom Merge Fields
1. While in Audience settings, click **"Audience fields and *|MERGE|* tags"** (or Settings → Audience fields)
2. You'll see default fields like FNAME, LNAME, EMAIL
3. Click **"Add A Field"** (bottom of the list)
4. Select **"Text"**
5. Set:
   - **Field label**: `Frequency`
   - **Put this tag in your content**: it will auto-generate something like `FREQUENCY`
6. Click **"Save Changes"**

### 4.4 Get Your Audience (List) ID
1. Go to **Audience** → **Settings** (gear icon) → **"Audience name and defaults"**
2. Scroll down — you'll see **"Audience ID"** at the bottom
3. It looks like: `abc1234def`
4. **SAVE THIS** → this is your `MAILCHIMP_LIST_ID`

### 4.5 Generate API Key
1. Click your **profile icon** (bottom-left of sidebar, or top-right)
2. Click **"Account & billing"** (or **"Account"**)
3. In the dropdown/navigation, click **"Extras"** → **"API keys"**
4. Scroll down to **"Your API keys"**
5. Click **"Create A Key"**
6. Give it a label: `clippar-vercel`
7. Click **"Generate Key"**
8. You'll see your API key — it looks like: `abc123def456-us21`
9. **COPY AND SAVE IT** — shown only once. This is your `MAILCHIMP_API_KEY`

**Write these down:**
```
MAILCHIMP_API_KEY=abc123def456-us21
MAILCHIMP_LIST_ID=abc1234def
```

---

## 5. VERCEL (Landing Page Hosting)

### 5.1 Create Account
1. Go to **https://vercel.com**
2. Click **"Sign Up"** (top-right)
3. Choose **"Continue with GitHub"** (recommended — enables auto-deploy)
4. Authorize Vercel to access your GitHub

### 5.2 Push clippar-web to GitHub
First, you need the `clippar-web/` folder in a GitHub repo. Open your terminal:

```bash
cd /Users/hendacow/projects/final_shipment/clippar-web
git init
git add -A
git commit -m "Initial Vercel landing page with waitlist signup"
```

Then create a new repo on GitHub:
1. Go to **https://github.com/new**
2. **Repository name**: `clippar-web`
3. **Visibility**: Private
4. **DON'T** check "Add a README" (you already have code)
5. Click **"Create repository"**
6. Back in terminal, push:
```bash
git remote add origin https://github.com/YOUR_USERNAME/clippar-web.git
git branch -M main
git push -u origin main
```

### 5.3 Deploy on Vercel
1. Go to **https://vercel.com/dashboard**
2. Click **"Add New..."** → **"Project"** (top-right area)
3. You'll see a list of your GitHub repos
4. Find **"clippar-web"** and click **"Import"** next to it
5. On the configure page:
   - **Framework Preset**: Select **"Other"** (it's not a Next.js/React app)
   - **Root Directory**: Leave as `.` (the default)
   - **Build Command**: Leave empty (it's a static site)
   - **Output Directory**: Type `public`
6. Click **"Deploy"** (blue button)
7. Wait 30-60 seconds — you'll see a success screen with a preview URL like `clippar-web-xyz.vercel.app`

### 5.4 Add Environment Variables
1. On the project page, click **"Settings"** (tab at the top)
2. In the left sidebar, click **"Environment Variables"**
3. Add these one by one (type the name in "Key", paste the value in "Value", click "Add"):

   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | Your Neon connection string from Step 1.3 |
   | `MAILCHIMP_API_KEY` | Your Mailchimp API key from Step 4.5 |
   | `MAILCHIMP_LIST_ID` | Your Mailchimp audience ID from Step 4.4 |

4. After adding all three, click **"Deployments"** tab (top)
5. Find the latest deployment → click the **three dots (...)** on the right → click **"Redeploy"**
6. Confirm by clicking **"Redeploy"** in the popup

### 5.5 Connect Your Domain
1. Go to **"Settings"** → **"Domains"** (left sidebar)
2. Type `clippargolf.com` in the text field
3. Click **"Add"**
4. Vercel will show you it needs a CNAME record
5. Also add `www.clippargolf.com` the same way

Now set up the DNS records in Cloudflare:
1. Go to **https://dash.cloudflare.com**
2. Click on **clippargolf.com** in your sites list
3. Click **"DNS"** in the left sidebar → **"Records"**
4. Click **"Add record"**
5. For the root domain:
   - **Type**: `CNAME`
   - **Name**: `@`
   - **Target**: `cname.vercel-dns.com`
   - **Proxy status**: Click the orange cloud to turn it **GREY** (DNS only) — this is important!
   - Click **"Save"**
6. Click **"Add record"** again for www:
   - **Type**: `CNAME`
   - **Name**: `www`
   - **Target**: `cname.vercel-dns.com`
   - **Proxy status**: **GREY cloud** (DNS only)
   - Click **"Save"**

7. Go back to Vercel → Settings → Domains
8. Wait a few minutes, then refresh — both domains should show a green **"Valid Configuration"** checkmark
9. HTTPS is automatic — Vercel handles SSL certificates

### 5.6 Test It
1. Open **https://clippargolf.com** in your browser
2. You should see the Clippar landing page
3. Fill in a test name/email/frequency and submit
4. Check your Neon database (SQL Editor → `SELECT * FROM waitlist;`) to verify the entry
5. Check Mailchimp audience to verify the subscriber appeared

---

## 6. RAILWAY (Processing Backend)

### 6.1 Create Account
1. Go to **https://railway.app**
2. Click **"Login"** (top-right) → **"Login with GitHub"**
3. Authorize Railway

### 6.2 Push Main Project to GitHub
Your main project needs to be in a GitHub repo. In terminal:

```bash
cd /Users/hendacow/projects/final_shipment

# Make sure .gitignore excludes secrets
# Check: .env, service_account.json, oauth_credentials.json, drive_token.json should all be listed

git add Dockerfile .dockerignore storage.py db.py app.py run_pipeline.py worker.py drive_utils.py requirements.txt
git add config.yaml merge_clips.py shot_detector.py email_utils.py
git add templates/ static/
git add models/  # if your YOLO models are in a models/ directory

git commit -m "Production deployment: Postgres, R2 storage, Docker, gunicorn"
git push origin main
```

**IMPORTANT**: Before pushing, verify secrets aren't in the repo:
```bash
git log --all -- .env service_account.json oauth_credentials.json drive_token.json
```
If any results appear, those files were committed before. You'll need to rotate ALL credentials after deployment.

### 6.3 Create Railway Project
1. On Railway dashboard, click **"New Project"** (purple button, top-right)
2. Click **"Deploy from GitHub Repo"**
3. Find your repo (e.g., `hendacow/final_shipment` or whatever it's called) and click it
4. If you don't see your repo, click **"Configure GitHub App"** → give Railway access to the repo
5. Railway will detect the `Dockerfile` and start building automatically
6. **The build will fail** at first because environment variables aren't set yet — that's OK

### 6.4 Set Environment Variables
1. Click on your service (the purple block in the project canvas)
2. Click the **"Variables"** tab (in the right panel, or it might be a tab at the top)
3. Click **"+ New Variable"** or **"RAW Editor"** (RAW Editor is faster — lets you paste multiple at once)
4. If using RAW Editor, paste all of these (fill in YOUR actual values):

```
DATABASE_URL=postgresql://neondb_owner:YOUR_PASSWORD@ep-YOUR-ENDPOINT.us-east-2.aws.neon.tech/neondb?sslmode=require
SECRET_KEY=GENERATE_A_RANDOM_STRING_SEE_BELOW
ADMIN_PASSWORD=PICK_A_STRONG_PASSWORD
GMAIL_USER=henryjohncoward@gmail.com
GMAIL_APP_PASSWORD=your_gmail_app_password
DRIVE_OUTPUT_FOLDER_ID=1I-csycxDf3iUehJY1ZRR770tUGsUo6LE
R2_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
R2_ACCESS_KEY=your_r2_access_key
R2_SECRET_KEY=your_r2_secret_key
R2_BUCKET=clippar
PORT=5050
```

5. If using individual fields, add each one by clicking **"+ New Variable"**, typing the key name, pasting the value

**To generate SECRET_KEY**, run this in your terminal:
```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```
Copy the output (a long random string like `a7f3b2c1d4e5f6...`) and use it as the SECRET_KEY value.

6. After adding all variables, Railway will automatically redeploy

### 6.5 Wait for Build
1. Click on **"Deployments"** tab (or look at the deployment indicator)
2. The build takes **5-15 minutes** the first time (downloading torch, ultralytics, etc. is ~1.5GB)
3. Watch the build logs — click on the deployment to see live logs
4. When you see **"Deploy succeeded"** and the logs show `[Worker] Background worker started`, it's running

### 6.6 Get Your Railway URL
1. Click on your service
2. Click **"Settings"** tab
3. Scroll to **"Networking"** section
4. Under **"Public Networking"**, click **"Generate Domain"**
5. You'll get a URL like `clippar-production.up.railway.app`
6. **SAVE THIS** — this is where your admin dashboard lives

### 6.7 Test Admin Dashboard
1. Open `https://YOUR-RAILWAY-URL.up.railway.app/admin/login` in your browser
2. Enter the `ADMIN_PASSWORD` you set
3. You should see the admin dashboard (empty, no jobs yet)

### 6.8 (Optional) Add Admin Subdomain
If you want `admin.clippargolf.com` instead of the Railway URL:
1. In Railway: Settings → Networking → Custom Domain → type `admin.clippargolf.com`
2. Railway gives you a CNAME target
3. Go to Cloudflare DNS:
   - **Type**: `CNAME`
   - **Name**: `admin`
   - **Target**: the Railway CNAME target
   - **Proxy status**: **GREY cloud**
   - Click **"Save"**

---

## 7. GOOGLE DRIVE TOKEN (for video delivery)

### 7.1 Run the OAuth Flow Locally
1. Open terminal
2. Make sure you have `oauth_credentials.json` in your project folder (you should already have this from your local setup)
3. Run:
```bash
cd /Users/hendacow/projects/final_shipment
source .venv/bin/activate
python drive_utils.py --auth
```
4. A browser window will open
5. Sign in with your Google account
6. Click **"Continue"** (or "Allow") on the consent screen
7. Allow access to Google Drive
8. You'll see: `Token saved to /Users/hendacow/projects/final_shipment/drive_token.json`
9. The browser tab will say "The authentication flow has completed"

### 7.2 Copy Token to Railway
1. In your terminal, print the token:
```bash
cat /Users/hendacow/projects/final_shipment/drive_token.json
```
2. **Select and copy the ENTIRE JSON output** (it starts with `{` and ends with `}`)
3. Go to Railway dashboard → click your service → **Variables** tab
4. Click **"+ New Variable"**
5. **Key**: `DRIVE_TOKEN_JSON`
6. **Value**: Paste the entire JSON blob you copied
7. Click the **checkmark** or press Enter to save
8. Railway will redeploy automatically

### 7.3 Verify Drive Upload Works
1. Go to your Railway admin dashboard
2. If you have a test job in "ready_for_review" status, try approving it
3. Check that the video appears in your Google Drive output folder

---

## 8. FINAL VERIFICATION CHECKLIST

Open each of these and verify:

### Landing Page
- [ ] Visit **https://clippargolf.com** — page loads with all videos and animations
- [ ] Visit **https://www.clippargolf.com** — redirects to or shows the same page
- [ ] Fill in test name/email → click "SECURE MY SPOT" → see success message
- [ ] Check Neon SQL Editor: `SELECT * FROM waitlist;` — your test entry is there
- [ ] Check Mailchimp Audience → Contacts → your test email appeared

### Admin Dashboard
- [ ] Visit **https://YOUR-RAILWAY-URL.up.railway.app/admin/login** — login page loads
- [ ] Enter your admin password → dashboard loads
- [ ] Dashboard shows status filters and is functional

### Full Pipeline (once you have a pilot user)
- [ ] Submit a job through the Railway backend with a Google Drive link
- [ ] Worker picks it up (check Railway logs: "Picked up job...")
- [ ] Shot detection runs
- [ ] Clips merge into highlight reel
- [ ] Video uploads to Google Drive
- [ ] Customer gets email with Drive link
- [ ] Job status shows "delivered" in admin dashboard

---

## QUICK REFERENCE: All Your Credentials

Keep this somewhere secure (password manager, not a text file):

```
# Database
DATABASE_URL=postgresql://...your neon connection string...

# Cloudflare R2
R2_ENDPOINT=https://...your account....r2.cloudflarestorage.com
R2_ACCESS_KEY=...
R2_SECRET_KEY=...
R2_BUCKET=clippar

# Mailchimp
MAILCHIMP_API_KEY=...your key...-us21
MAILCHIMP_LIST_ID=...your audience id...

# Railway / Flask
SECRET_KEY=...your generated random string...
ADMIN_PASSWORD=...your strong password...

# Google
GMAIL_USER=henryjohncoward@gmail.com
GMAIL_APP_PASSWORD=...your app password...
DRIVE_OUTPUT_FOLDER_ID=...your folder id...
DRIVE_TOKEN_JSON=...the entire JSON from drive_token.json...
```

---

## COST SUMMARY

| Service | Monthly Cost |
|---------|-------------|
| Vercel (landing page) | FREE |
| Neon Postgres | FREE |
| Cloudflare R2 | FREE (under 10GB) |
| Cloudflare DNS | FREE |
| Mailchimp | FREE (under 500 contacts) |
| Railway (processing) | ~$5-7/month |
| clippargolf.com domain | ~$10-15/year (existing) |
| **TOTAL** | **~$5-7/month** |
