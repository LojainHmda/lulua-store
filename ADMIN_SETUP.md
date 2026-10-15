# Admin Dashboard setup

The admin dashboard lives at `/admin` and is a separate, code-split part of the
app with its own layout, auth, and design system. It needs a Firebase project
for authentication, the database, and file storage — the storefront itself
still works without one (it falls back to its built-in sample catalog).

## 1. Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and create a project (the free Spark plan is enough — nothing here requires Cloud Functions or a paid plan).
2. In **Build → Authentication**, click **Get started** and enable the **Email/Password** sign-in provider.
3. In **Build → Firestore Database**, click **Create database**. Start in **production mode** (the security rules in this repo replace the defaults).
4. In **Build → Storage**, click **Get started** to create the default bucket.

## 2. Get your web app config

1. In **Project settings → General**, scroll to **Your apps** and click the web icon (`</>`) to register a new web app.
2. Copy the config values shown (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`).
3. Copy `.env.example` to `.env.local` in the project root and fill them in:

   ```
   VITE_FIREBASE_API_KEY=...
   VITE_FIREBASE_AUTH_DOMAIN=...
   VITE_FIREBASE_PROJECT_ID=...
   VITE_FIREBASE_STORAGE_BUCKET=...
   VITE_FIREBASE_MESSAGING_SENDER_ID=...
   VITE_FIREBASE_APP_ID=...
   ```

4. Restart `npm run dev` after saving `.env.local`.

These values aren't secret — they're meant to be visible in client code. Real
security comes from the rules files below, which are enforced by Firebase's
servers, not by hiding this config.

## 3. Publish the security rules

The repo includes `firestore.rules` and `storage.rules` at the project root.
Publish them from the Firebase console (simplest, no extra tooling):

1. **Firestore Database → Rules** — paste the contents of `firestore.rules`, click **Publish**.
2. **Storage → Rules** — paste the contents of `storage.rules`, click **Publish**.

(If you'd rather use the CLI: `npm i -g firebase-tools`, `firebase login`, `firebase use --add` your project, then `firebase deploy --only firestore:rules,storage:rules` — `firebase.json` is already set up for this.)

## 4. Create your first admin account

1. Visit `/admin` on your running site.
2. Since no admin exists yet, you'll see **"Create the first admin account"** instead of a login form. Fill it in and submit.
3. This makes you the **owner** — the only role that can manage other admin accounts. Do this step promptly after publishing the rules in step 3; the bootstrap form only works once, for whoever gets there first.

From then on, `/admin` shows a normal sign-in form. Owners can add more
admins from **Team & Roles**, choosing a role for each:

- **Owner** — full access, including managing the team.
- **Admin** — full access except managing other admins.
- **Editor** — catalog, homepage content, media, discounts, reviews. No settings, orders, customers, or team access.
- **Viewer** — read-only.

## 5. Load some starter data

The storefront ships with a built-in sample catalog (27 products, 6
categories) so it never looks empty, even with no Firebase project connected.
Once you're signed in to `/admin`, go to **Products** and click **Import
starter catalog** to copy that same sample data into Firestore as real,
editable records — the storefront automatically switches to the live data
as soon as any products exist there.

## What's connected end-to-end vs. what's a data model waiting on a storefront feature

Wired live to the storefront: products, categories, homepage hero
slides/banners/featured picks, and contact/social links in the footer.

Real, admin-manageable data with no storefront-side feature to consume it
yet (since the site has no checkout or customer accounts): orders (create
them manually to test), customers, discount codes, and review moderation
(seed a few manually to have something to moderate). Shipping/payment/SEO
settings are stored and editable but not yet read by any storefront page.
Wiring these up is a natural next step once checkout exists.

## Roles and where they're enforced

Role checks happen in two places:

- **UI** — the sidebar and pages hide what a role can't use, and buttons are disabled.
- **Firestore/Storage rules** — the real enforcement. Every write is checked server-side against the requester's role in the `admins` collection, so hiding a button is a UX nicety, not the security boundary.
