# Auth setup — external configuration

Code in this branch ships the UI and client wiring for **password reset, Google Sign-In, and Apple Sign-In**. The features won't work until you finish three pieces of dashboard setup.

Total time: ~30 minutes. Do all three sections, in order.

---

## 1. Supabase — redirect URLs (~2 min)

Required for password reset and Google OAuth callbacks to deep-link back into the app.

1. Open Supabase Dashboard → **Authentication → URL Configuration**
2. Under **Redirect URLs**, add (one per line):
   ```
   clippar://reset-password
   clippar://auth-callback
   clippar-dev://reset-password
   clippar-dev://auth-callback
   clippar-staging://reset-password
   clippar-staging://auth-callback
   ```
3. Save.

Test: password reset will work after this step alone, even before sections 2 and 3.

---

## 2. Apple Sign-In setup (~10 min)

Requires your Apple Developer account (Team ID `LBJUXXPJ6H`).

### 2a. Enable Sign In with Apple capability on each bundle ID

In **developer.apple.com → Certificates, Identifiers & Profiles → Identifiers**, find each App ID and enable "Sign In with Apple":
- `com.clippar.app` (production)
- `com.clippar.app.dev` (development)
- `com.clippar.app.staging` (staging)

For each: edit → check "Sign In with Apple" → Save. EAS Build will pick up the entitlement automatically (it's already wired in `app.config.js` via `usesAppleSignIn: true` and the `expo-apple-authentication` plugin).

### 2b. Create a Services ID (used by Supabase as the OAuth client)

1. **Identifiers → "+" → Services IDs → Continue**
2. Description: `Clippar Sign In with Apple`
3. Identifier: `com.clippar.app.signin` (this is what you'll paste into Supabase)
4. Enable "Sign In with Apple", click **Configure**:
   - Primary App ID: `com.clippar.app`
   - Domains: `<your-project>.supabase.co`
   - Return URLs: `https://<your-project>.supabase.co/auth/v1/callback`
5. Save.

### 2c. Create a private key for Apple Sign-In

1. **Keys → "+"**
2. Name: `Clippar Apple Sign-In Key`
3. Check "Sign In with Apple", click **Configure**:
   - Primary App ID: `com.clippar.app`
4. Save → **Download** the `.p8` file. **You can only download this once — store it safely.**
5. Note the **Key ID** (10 chars shown next to the key).

### 2d. Paste into Supabase

Supabase Dashboard → **Authentication → Providers → Apple**:
- Enable Apple
- **Services ID**: `com.clippar.app.signin`
- **Team ID**: `LBJUXXPJ6H`
- **Key ID**: from step 2c
- **Secret Key (for OAuth)**: paste the full contents of the `.p8` file (including the `-----BEGIN PRIVATE KEY-----` lines)
- Save

---

## 3. Google Sign-In setup (~10 min)

Uses Supabase's hosted OAuth callback — the browser-based flow, not the native Google SDK. This is why we don't need separate OAuth client IDs per platform.

### 3a. Create OAuth credentials in Google Cloud Console

1. Open **console.cloud.google.com → APIs & Services → Credentials**
2. If you don't have a project for Clippar yet, create one first.
3. Click **"+ CREATE CREDENTIALS" → OAuth client ID**
4. Application type: **Web application** (yes, web — the callback runs on Supabase, not on-device)
5. Name: `Clippar Supabase`
6. **Authorized redirect URIs**: add
   ```
   https://<your-project>.supabase.co/auth/v1/callback
   ```
7. Create → copy the **Client ID** and **Client secret**.

### 3b. Paste into Supabase

Supabase Dashboard → **Authentication → Providers → Google**:
- Enable Google
- **Client ID**: from step 3a
- **Client Secret**: from step 3a
- Save

### 3c. (Optional) OAuth consent screen

If this is a fresh Google Cloud project, Google will require you to configure the consent screen before OAuth works:
1. **APIs & Services → OAuth consent screen**
2. User type: **External**
3. App name: `Clippar`
4. Support email: your email
5. App logo: upload `clippar_logo_square.png` from the repo root
6. Add scopes: `userinfo.email`, `userinfo.profile`, `openid`
7. Add yourself as a test user while the app is in "Testing" mode
8. Save

While in Testing mode, only listed test users can sign in. Publish the app for general availability when you're ready to ship.

---

## 4. Verify

After all three sections are done:

1. **Password reset**: Run app, tap "Forgot password?", enter email, check inbox. Tap the link — it should open the app and let you set a new password.
2. **Apple Sign-In**: From login screen, tap "Continue with Apple" → goes through native iOS sheet → returns to home tab signed in.
3. **Google Sign-In**: Tap "Continue with Google" → opens browser → Google login → redirects back to app signed in.

### Common gotchas

- **"Link invalid or expired"** on the reset screen: the redirect URLs in Supabase (section 1) don't include the scheme you're using. The dev client uses `clippar-dev://` — make sure that one is in the list.
- **Apple button missing on iOS**: dev client must be rebuilt after merging this PR. `expo-apple-authentication` is a native module; the plugin only takes effect during prebuild. Run `eas build --profile development --platform ios` to ship a fresh dev client.
- **Google "redirect_uri_mismatch"**: the redirect URI in Google Cloud Console must match `https://<your-project>.supabase.co/auth/v1/callback` exactly, with no trailing slash.
- **Apple "invalid_client"**: Services ID, Team ID, or Key ID is wrong in Supabase, or the .p8 was pasted without the BEGIN/END lines.
