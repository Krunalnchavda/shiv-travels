# Turning on real-time sync

The app already has all the sync code in it. It is dormant until you paste your
Firebase settings into `firebase-config.js`. Until then it keeps working exactly
as it does today, storing data in one browser only.

I cannot create the Firebase account for you — it needs your Google login. These
are the steps. Budget about 15 minutes.

---

## 1. Create the project

1. Go to https://console.firebase.google.com and sign in with your Google account
2. **Add project** → name it `shiv-travels` → Continue
3. Google Analytics: **turn it off**, you do not need it → Create project

> **Console navigation.** Newer Firebase consoles have no "Build" menu — the
> left sidebar lists **Product categories** instead. Both namings are given
> below; use whichever your console shows.

## 2. Create the database

1. Left menu → **Databases & Storage → Firestore Database**
   (older consoles: **Build → Firestore Database**) → **Create database**
2. Location: **asia-south1 (Mumbai)** — closest to you, so it is fastest.
   **This cannot be changed later.**
3. Start in **production mode** (we paste proper rules in step 5)

## 3. Turn on logins

1. Left menu → **Security → Authentication**
   (older consoles: **Build → Authentication**) → **Get started**
2. Choose **Email/Password** → enable the first toggle → **Save**
3. Go to the **Users** tab → **Add user**, twice:

   | Email | Password |
   |---|---|
   | `admin@shivtravels.app` | pick a strong one |
   | `guest@shivtravels.app` | pick a different one |

   > The `@shivtravels.app` part is not a real email domain and does not need to
   > be. It only has to match `LOGIN_DOMAIN` in `firebase-config.js`. You will
   > still sign in by typing just `admin` or `guest`.

4. **Copy each user's UID** from the list — you need them in the next step.

## 4. Give the two accounts their roles

Firestore Database → **Start collection**:

- Collection ID: `users`
- Document ID: **paste the admin UID**
- Add fields: `role` = `admin` (string), `name` = `Administrator` (string)
- Save, then **Add document** in the same collection:
  - Document ID: **paste the guest UID**
  - `role` = `guest` (string), `name` = `Guest` (string)

This is what makes the roles real. The app reads the role from here, and the
rules in the next step trust only this — nobody can promote themselves.

## 5. Paste the security rules

Firestore Database → **Rules** tab → replace everything with the contents of
[`firestore.rules`](firestore.rules) → **Publish**.

**Do not skip this.** Without it your business data is either wide open or
completely blocked. These rules are what actually stop the guest account from
writing — the hidden buttons in the app are only cosmetic.

## 6. Connect the app

1. Project settings (⚙ top left) → scroll to **Your apps** → click the web icon `</>`
2. Nickname `shiv-travels-web` → **Register app** (do not tick Firebase Hosting)
3. Copy the `firebaseConfig` values shown
4. Paste them into `firebase-config.js` in this folder
5. Deploy: `netlify deploy --prod --dir=.`

## 7. First run

Open the live site and sign in as `admin`. Because the cloud is empty and your
browser has data, it will offer to upload what you already have. Say yes — that
seeds the shared database.

Then open the site on your phone, sign in with the same `admin` account, and
your trips will be there. Add a trip on one device and watch it appear on the
other within a second.

---

## How the two databases work

Same Firebase project, two separate datasets:

| Where you run it | Dataset used |
|---|---|
| `shiv-urbania.netlify.app` (deployed) | `envs/prod` — the real business data |
| `localhost` or opening the file directly | `envs/dev` — a scratch copy |

This is automatic, based on the address in the browser. Testing on your laptop
can never damage real trips. When the app is on the test database the sync badge
in the header reads **TEST**.

## The sync badge

| Badge | Meaning |
|---|---|
| 💾 | Cloud not configured — this device only |
| 🔄 | Connecting, or saving right now |
| ☁️ | Synced, all devices up to date |
| ⚠️ | Sync problem — hover for the reason |

## Things worth knowing

- **Offline still works.** Firestore keeps a local cache. Enter trips with no
  signal and they upload when you are back online.
- **Guest is enforced by the server now.** A guest cannot write even by editing
  the page or calling the API — Firestore rejects it.
- **Password changes apply everywhere**, because the account lives in Firebase.
  Settings → Change Password changes your own; the guest password is reset from
  the Firebase console.
- **The config values are not secrets.** Firebase web config is public by
  design; the security rules are what protect the data. That is why step 5
  matters so much.
- **Free tier is far more than you need** — 50,000 reads and 20,000 writes a
  day. A busy month of trips is a rounding error against that.
