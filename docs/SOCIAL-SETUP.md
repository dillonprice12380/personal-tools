# Connecting social accounts

Helm posts to eleven targets. They fall into three groups, and it is worth
knowing which group you are in before you start — the effort is very different.

| Network | How you connect | Reality check |
|---|---|---|
| **X (Twitter)** | Paste 4 keys you issue yourself | Free tier caps posts per month |
| **LinkedIn** | Click Connect (OAuth) | Personal profile only; Pages need partner access |
| **Facebook** | Click Connect (OAuth) | **Pages only** — personal profiles are not postable |
| **Instagram** | Click Connect (OAuth) | Business/Creator only; **every post needs media at a public URL** |
| **TikTok** | Click Connect (OAuth) | **Video only**; direct posting needs app review |
| Mastodon, Bluesky, Discord, Telegram, webhook | Paste a token or URL | No review, works immediately |
| Manual | Nothing | Schedules and reminds; you paste it over |

Bluesky and Mastodon take about two minutes and have no gatekeeping. If you
just want to see scheduling work, start there.

---

## Before the OAuth networks: set your public URL

LinkedIn, Facebook, Instagram and TikTok send you back to Helm after login, so
they need a redirect URI that matches **exactly**.

Go to **Settings → Social network apps** and set **Public URL**:

- Running locally: `http://localhost:4000`
- Behind a Tailscale/Cloudflare tunnel: your `https://…` URL

Each network's row then shows the exact redirect URI to register. Copy it
character for character — a trailing slash difference is enough to fail.

> Facebook, Instagram and TikTok require **HTTPS** redirect URIs. `localhost` is
> usually accepted for development, but if a network rejects it, set up the
> tunnel first ([REMOTE-ACCESS.md](REMOTE-ACCESS.md)) and use that HTTPS URL.

---

## Google Search Console

Powers the SEO module rather than posting anywhere. Read-only.

1. Go to <https://console.cloud.google.com> and create a project (or pick one)
2. **APIs & Services → Library** → search **"Google Search Console API"** →
   **Enable**. Skipping this is why a connection that looked fine returns 403
   on the first sync.
3. **APIs & Services → OAuth consent screen**
   - User type **External**, fill in the app name and your email
   - Under **Test users**, **add your own Google address**. While the app is in
     Testing mode, only listed test users can authorise it — otherwise you get
     "access blocked: app has not completed verification"
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Under **Authorised redirect URIs**, add exactly what Helm shows, e.g.
     `http://localhost:4000/api/oauth/google/callback`
   - Google permits plain `http` for `localhost`, so a tunnel is not required
5. Copy the **Client ID** and **Client secret**
6. In Helm: **Settings → Connected apps → Google Search Console → Add keys**,
   then **Connect**
7. Open **SEO & AEO → Search Console**, choose your property, and **Sync**

### If Google rejects the sign-in

| What Google says | What it means |
|---|---|
| **"The OAuth client was not found" / `invalid_client`** | The client id is not one Google knows. Usually an API key, a project number, or a client that was never created. A valid one ends in `.apps.googleusercontent.com` — Helm now refuses anything else at save time. |
| `redirect_uri_mismatch` | The Authorised redirect URI does not match byte for byte. Check the port, and that there is no trailing slash. Your **Public URL** in Helm must match too. |
| "App has not completed verification" | Add your own email under **Test users** on the consent screen. |
| Connects, then 403 on sync | The **Google Search Console API** is not enabled for the project (step 2). |
| "Property not found" or an empty list | The Google account you authorised is not verified on that property in Search Console. |

Two things about the data itself: Search Console reports on a **2–3 day lag**,
and it only holds data from when the property was verified — it does not
backfill history from before that.

## X (Twitter)

The only one with no browser flow — you issue tokens for your own account
directly.

1. Go to <https://developer.x.com> and sign in
2. Create a **Project** and an **App** inside it
3. In the app's **Settings → User authentication settings**, set app permissions
   to **Read and write** (posting fails silently as read-only otherwise)
4. Go to **Keys and tokens** and generate:
   - **API Key** and **API Key Secret** (the consumer pair)
   - **Access Token** and **Access Token Secret** — make sure these are
     generated *after* setting Read and write, or they carry read-only scope
5. In Helm: **Social → Accounts → + Add account → X (Twitter)**, and paste:

| Helm field | X calls it |
|---|---|
| `consumer_key` | API Key |
| `consumer_secret` | API Key Secret |
| `access_token` | Access Token |
| `access_token_secret` | Access Token Secret |

Set **Handle** to your @name so Helm can build post links.

**Limits:** the free tier allows a few hundred posts per month. Exceeding it
returns a 429 and Helm shows the error on the post.

---

## LinkedIn

Posts to **your personal profile**. Posting as a Company Page needs the
Community Management API, which requires LinkedIn partner approval.

1. Go to <https://www.linkedin.com/developers/apps> → **Create app**
2. Associate it with a Company Page (LinkedIn requires one even for personal
   posting — you can create a throwaway page for this)
3. On the **Products** tab, request:
   - **Sign In with LinkedIn using OpenID Connect**
   - **Share on LinkedIn**

   Both are self-serve and usually granted immediately.
4. On the **Auth** tab, add the redirect URI Helm shows you
5. Copy the **Client ID** and **Client Secret**
6. In Helm: **Settings → Social network apps → LinkedIn → Add keys**, paste
   both, then click **Connect**

**Token life:** access tokens last about 60 days. Helm refreshes automatically
where LinkedIn issues a refresh token; otherwise click **Connect** again.

---

## Facebook (Pages)

Meta removed personal-profile posting from the API years ago. This posts to a
**Page you administer**.

1. Go to <https://developers.facebook.com/apps> → **Create app** → choose
   **Business**
2. Add the **Facebook Login** product
3. Under **Facebook Login → Settings**, add the redirect URI Helm shows you to
   **Valid OAuth Redirect URIs**
4. From **App settings → Basic**, copy the **App ID** and **App Secret**
5. In Helm: **Settings → Social network apps → Facebook Page → Add keys**, then
   **Connect**

Helm asks for `pages_show_list`, `pages_manage_posts` and
`pages_read_engagement`, then finds your Page and stores its Page token.

**While your app is in Development mode**, this works for Pages *you* admin —
which is all a personal tool needs. Publishing the app for other users requires
Meta App Review.

---

## Instagram

Builds on the Facebook setup — Instagram's publishing API runs through Meta.

**Prerequisites, all three required:**
1. Your Instagram account is a **Business** or **Creator** account
   (Instagram app → Settings → Account type)
2. It is **linked to a Facebook Page** you administer
3. That Page is on the same Meta app as above

Then in Helm: **Settings → Social network apps → Instagram → Add keys** (same
App ID/Secret as Facebook), then **Connect**.

**The important constraint:** Instagram cannot accept a file upload. Every post
must reference media at a **public `https://` URL** that Meta's servers can
fetch. In the composer, put that URL in **Media URLs**. A text-only post to
Instagram will fail with a clear message rather than silently doing nothing.

Images post immediately; videos are uploaded as Reels and Helm waits for
transcoding before publishing.

---

## TikTok

The most restricted of the five.

1. Go to <https://developers.tiktok.com> → **Manage apps** → create an app
2. Add the **Content Posting API** product
3. Add the redirect URI Helm shows you
4. Copy the **Client Key** and **Client Secret** (TikTok says "key", not "id")
5. In Helm: **Settings → Social network apps → TikTok → Add keys**, then
   **Connect**

**Two things to know:**

- **Video only.** There is no text post on TikTok. Put a public `https://` video
  URL in **Media URLs**.
- **Direct publishing requires app audit.** Until TikTok audits your app, posts
  go to your **TikTok inbox as a draft** — you open the app and tap publish.
  Helm says which happened in the post's status note. Once audited, set
  `direct_post` to `true` in the account's config to publish straight out.

---

## Testing a connection

Compose a short post, select **one** account, and hit **Publish now**. The chip
under the post shows:

- green **published** with a link — it worked
- red with the API's actual error text — the message is passed through verbatim,
  so it usually tells you exactly what is wrong
- amber **post by hand** — that's the Manual provider working as intended

## When something fails

| Error | Usually means |
|---|---|
| `401` / `Unauthorized` | Token expired or revoked — click **Connect** again |
| X: `403` | App permissions are read-only, or tokens predate the Read-and-write change |
| `redirect_uri` mismatch | Public URL in Helm differs from the portal, often a trailing slash |
| Instagram: "requires an image or video" | Add a public media URL |
| Facebook: "No Facebook Pages found" | The account admins no Page, or `pages_show_list` was not granted |
| Instagram: "No Instagram Business account linked" | Convert to Business/Creator and link it to the Page |

## Where your tokens live

Every token is encrypted with AES-256-GCM under `HELM_SECRET` before it touches
the database, and the API only ever reports *which* fields exist, never their
values. To revoke access, delete the account in Helm **and** revoke the token in
the network's own settings — deleting locally does not tell them to forget it.
