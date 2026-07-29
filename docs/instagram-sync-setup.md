# Instagram Live Sync — Setup Guide

This connects Pulse to the **Instagram Graph API (Meta)** so the **Sync now** button on
the Integrations page pulls real views / reach / likes / comments / shares / saves onto
your posts. It matches each Pulse post to its real Instagram post by the **Link** you
paste in, so **always fill the Link field** when you log a post.

You do the Meta-portal steps below **once**. Nothing here needs the Pulse codebase — it's
all account setup plus four environment variables.

---

## 0. Prerequisites (must be true first)

- Each Instagram account you want to sync is a **Business or Creator** account
  (Instagram app → Settings → *Account type* → switch to Professional).
- That Instagram account is **linked to a Facebook Page** you manage
  (Facebook Page → Settings → *Linked accounts* → Instagram).
- You can log into **https://developers.facebook.com** with the Facebook account that
  manages those Pages.

> Personal Instagram accounts cannot be synced — the API only returns insights for
> Business/Creator accounts linked to a Page.

---

## 1. Create a Meta app

1. Go to **https://developers.facebook.com/apps** → **Create app**.
2. Use case: choose **Other** → app type **Business** → Next.
3. Name it e.g. `Media House Pulse`, add your email, create.

## 2. Add the products

In the app dashboard (left sidebar → **Add product**):

1. **Facebook Login** → *Set up*.
2. **Instagram Graph API** (a.k.a. *Instagram → API setup with Facebook login*) → *Set up*.

## 3. Configure the OAuth redirect

Facebook Login → **Settings**:

- **Valid OAuth Redirect URIs** → add exactly (replace with your Render URL):

  ```
  https://YOUR-APP.onrender.com/api/integrations/instagram/callback
  ```

- **Client OAuth login** and **Web OAuth login**: ON.
- Save changes.

> The path must be `/api/integrations/instagram/callback` — that's the endpoint Pulse
> listens on. It must be **https** and match `APP_BASE_URL` below.

## 4. Grab your credentials

App → **Settings → Basic**:

- **App ID**  → this is `META_APP_ID`
- **App Secret** (click *Show*) → this is `META_APP_SECRET` — keep it secret.

## 5. Set the environment variables (on Render)

Render dashboard → your service → **Environment** → add these four, then **Save**
(the service redeploys automatically):

| Key | Value |
|-----|-------|
| `META_APP_ID` | *(App ID from step 4)* |
| `META_APP_SECRET` | *(App Secret from step 4)* |
| `APP_BASE_URL` | `https://YOUR-APP.onrender.com`  *(no trailing slash, no /api)* |
| `APP_ENCRYPTION_KEY` | a 32-byte key — see below |

**Encryption key** (used to encrypt stored access tokens) — generate a fresh one and paste
the output as `APP_ENCRYPTION_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> ⚠️ Don't paste these secrets into chat, commit them, or share them. They live only in
> Render's Environment settings. If `APP_ENCRYPTION_KEY` ever changes, existing
> connections must be reconnected (old tokens can't be decrypted).

## 6. App mode & access

While the app is in **Development mode** (top toggle), it works immediately for people who
have a **role** on the app:

- App → **App roles / Roles** → add your Facebook account as **Admin** or **Tester** if it
  isn't already (the creator is Admin by default).

This is enough to sync **your own** accounts. You only need Meta **App Review + Business
Verification** later if you want to sync accounts owned by people outside your app roles.

The permissions Pulse requests (granted automatically for admins/testers in Dev mode):
`instagram_basic`, `instagram_manage_insights`, `pages_show_list`,
`pages_read_engagement`, `business_management`.

---

## 7. Connect & sync inside Pulse

1. Reload Pulse → **Integrations**. The yellow "not switched on" banner should be gone and
   show **app keys ✅ · encryption ✅**.
2. In **Channels**, make sure each Instagram account's **handle** matches the real IG
   username (e.g. `@doctorfarmer`). This is how Pulse picks the right account if your
   Facebook login manages several.
3. On **Integrations**, click **Connect Instagram** on a channel → approve the Facebook
   dialog (select the Page + Instagram account) → you're returned to Pulse showing
   **● Connected**.
4. Click **🔄 Sync now**. Pulse matches every post that has a **Link** to its Instagram
   media and refreshes the metrics. The toast reports how many were updated / not matched.

## Notes

- **Only posts with a Link** get synced. Posts without a Link, or whose Link isn't on the
  connected account, are skipped (reported as "not matched").
- Access tokens are long-lived (~60 days). If a sync starts failing with an auth error,
  click **Connect Instagram** again to refresh it.
- Facebook Pages and YouTube are the next providers — the same connection framework
  already supports them.
