# Confi — Anonymous Confession App

> Post a short anonymous confession. It broadcasts **live** to exactly 100 randomly selected users for **60 seconds**. Watch reactions roll in on a live chart. Then it's **gone forever**.
 
 Here is the live link: https://confession-roulette.iamamanansari786a.workers.dev/
---

## What It Does

Confi is a one-ritual confession app. Every drop follows the same irreversible sequence:

1. **Write** — compose an anonymous confession (max 280 characters)
2. **Moderate** — your confession passes a blocking safety gate before anything else happens
3. **Broadcast** — it goes live to exactly 100 randomly selected active users in your community
4. **React** — recipients have 30 seconds to react with 5 emojis (😂 💀 😬 ❤️ 😳) and leave anonymous comments
5. **Expire** — at 60 seconds the record is hard-deleted from the database, permanently and irreversibly
6. **Verdict** — you see the final reaction tally; recipients see a frozen snapshot

No feed. No profile. No history. Nothing persists.

---

## Key Features

| Feature | Detail |
|---|---|
| **Fixed blast radius** | Always exactly 100 randomly selected users (never algorithmic, never popularity-based) |
| **Hard delete** | Server-side deletion at T+60s via QStash — not soft-delete, not archival |
| **Pre-broadcast moderation** | PII regex → Perspective API toxicity → local fallback. Blocking, not async |
| **Server-authoritative timer** | Countdown is anchored to `broadcastStartedAt` in Firestore — client desync cannot extend visibility |
| **Anonymous by design** | No confession is ever attributable to a public username in the UI |
| **Community scoping** | Confessions are broadcast within a community; the audience sampler scales to millions of users |
| **Mobile-first PWA + Android** | Built with Next.js, deployed to Cloudflare Workers, wrapped in Capacitor for native Android |
| **Crisis routing** | Self-harm content is never silently rejected — the author sees crisis resources instead |
| **Push notifications** | FCM push alerts notify the 100 recipients on native Android |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  React (Next.js 16) — Cloudflare Workers (OpenNext)     │
│                                                          │
│  /            ComposeScreen    (write + submit)         │
│  /live        LiveDropScreen   (recipient view)         │
│  /verdict/:id VerdictScreen    (author + recipient)     │
│  /fame        HallOfFameScreen (aggregate emoji stats)  │
│  /settings    SettingsScreen                            │
└──────────────────────┬──────────────────────────────────┘
                       │ POST /api/confess
                       ▼
┌─────────────────────────────────────────────────────────┐
│  API Routes (Next.js Route Handlers on Cloudflare)      │
│                                                          │
│  /api/confess   — auth → moderate → select → drop       │
│  /api/expire    — hard-delete drop + write verdict       │
│  /api/react     — increment emoji count (server-side)   │
│  /api/report    — user report → moderationLog           │
│  /api/community — join / create community               │
└──────────────────────┬──────────────────────────────────┘
                       │
              ┌────────┴────────┐
              ▼                 ▼
     Cloud Firestore      Upstash QStash
   (realtime listeners)  (T+60s expiry job)
```

**Realtime layer:** Firestore `onSnapshot` listeners — each recipient subscribes to the drop's `reactions/` subcollection directly. No WebSocket server needed; Firestore handles fan-out to 100 concurrent clients within the 60-second window.

**Audience selection:** Scale-safe pivot sampling — each presence document has a random `sortKey` float. Two Firestore range queries wrap around the [0, 1) circle to give a uniform random sample in O(1) queries regardless of pool size.

---

## Data Model

```
users/{uid}
  communityId, createdAt, isFrozen, reportCount, tier, fcmTokens[]

presence/{uid}
  lastSeen, communityId, sortKey   ← heartbeat; used for audience sampling

drops/{dropId}
  text, authorUid, communityId, recipientUids[], status, broadcastStartedAt
  └── reactions/{emoji}   count
  └── voters/{uid}        voted (bool)
  └── comments/{id}       text, createdAt  (no uid stored — anonymous)

verdicts/{dropId}
  text, authorUid, recipientUids[], reactions{}, createdAt
  (created at expiry; readable by author + recipients only)

moderationLog/{id}
  confessionIdHash, reason, timestamp   ← server-only; no client access

hallOfFameStats/{date}
  emojiTotals{}   ← aggregate counts only, never tied to a specific confession

communities/{communityId}
  name, createdAt, memberCount
```

---

## Getting Started

### Prerequisites

- **Node.js 20+**
- **npm**
- A **Firebase project** with Firestore, Authentication, and Cloud Messaging enabled
- A **Cloudflare account** with Workers enabled
- An **Upstash** account (for QStash — drop expiry scheduling)
- *(Optional)* A **Google Perspective API** key for enhanced toxicity scoring

### 1. Clone and install

```bash
git clone <repo-url>
cd confession-roulette
npm install
```

### 2. Configure environment variables

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `VITE_FIREBASE_API_KEY` | Firebase client config |
| `VITE_FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Full service account JSON (server-side admin auth) |
| `QSTASH_TOKEN` | Upstash QStash token for scheduling drop expiry |
| `NEXT_PUBLIC_SITE_URL` | Public URL of your deployed worker (used by QStash callbacks) |
| `PERSPECTIVE_API_KEY` | *(Optional)* Google Perspective API key — falls back to local regex patterns if absent |

> **⚠️ Warning:** Never commit `.env` or your service account JSON to version control. The `.gitignore` already excludes `.env`. For production, add secrets via Cloudflare Workers secrets or GitHub Actions secrets.

### 3. Deploy Firestore rules and indexes

```bash
# Install Firebase CLI if needed
npm install -g firebase-tools
firebase login

# Deploy security rules and composite indexes
firebase deploy --only firestore:rules,firestore:indexes
```

### 4. Run locally

```bash
npm run dev
```

The app will be available at `http://localhost:3000`. The Cloudflare OpenNext adapter initialises automatically in dev mode.

> **ℹ️ Note:** In local dev, QStash scheduling will fail unless `NEXT_PUBLIC_SITE_URL` points to a publicly reachable URL (e.g. via `ngrok`). Drops will still be created — they just won't auto-expire. Use `simulate-drop.mjs` to manually trigger expiry during testing.

### 5. Deploy to Cloudflare Workers

```bash
npm run deploy
```

Or push to the `main` branch — the GitHub Actions workflow at `.github/workflows/deploy.yml` will build and deploy automatically.

---

## Project Structure

```
confession-roulette/
├── app/                          # Next.js App Router
│   ├── api/
│   │   ├── _lib/
│   │   │   ├── adminToken.js     # Firebase Admin token helper
│   │   │   └── moderation.js     # Pre-broadcast safety gate
│   │   ├── confess/route.js      # Main confession submission endpoint
│   │   ├── expire/route.js       # Drop expiry + hard delete + verdict creation
│   │   ├── react/route.js        # Emoji reaction handler
│   │   ├── report/route.js       # User report handler
│   │   └── community/            # Community join/create endpoints
│   ├── ClientShell.jsx           # Client-side shell wrapper
│   └── layout.jsx
├── src/
│   ├── screens/
│   │   ├── ComposeScreen.jsx     # Write + submit confessions
│   │   ├── LiveDropScreen.jsx    # Recipient live view (reactions + comments)
│   │   ├── VerdictScreen.jsx     # Post-expiry results for author + recipients
│   │   ├── HallOfFameScreen.jsx  # Aggregate emoji stats (no confession content)
│   │   ├── LoginScreen.jsx       # Auth + community selection
│   │   └── SettingsScreen.jsx
│   ├── context/
│   │   ├── AuthProvider.jsx      # Firebase auth state
│   │   └── DropContext.jsx       # Realtime drop listener + auto-navigation
│   ├── components/
│   │   └── CommunityPicker.jsx
│   ├── hooks/useFeedback.js      # Haptic + sound feedback
│   ├── firebase.js               # Firebase client initialisation
│   └── constants.js              # Shared timing constants
├── firestore.rules               # Security rules
├── firestore.indexes.json        # Composite index definitions
├── capacitor.config.json         # Android app config
├── next.config.mjs
├── wrangler.jsonc                # Cloudflare Worker config
└── .env.example
```

---

## Moderation Gate

Every confession passes through a **blocking** pre-broadcast safety check in `app/api/_lib/moderation.js` before a drop document is ever created:

1. **PII regex** — rejects phone numbers, email addresses, street addresses, social handles
2. **Perspective API** — toxicity, threats, sexually explicit content, identity attacks (configurable thresholds)
3. **Local fallback** — keyword patterns for self-harm, violence, CSAM, hate speech (used when Perspective API is unavailable)

Self-harm detections are never silently rejected — the client receives a `422 SELF_HARM` response and surfaces crisis resources (988 Lifeline, Crisis Text Line) to the author.

The `moderationLog` collection is **inaccessible to all clients** via Firestore security rules. Only the server writes to it via Admin token.

---

## Testing Utilities

Several helper scripts are included for local development and integration testing:

| Script | Purpose |
|---|---|
| `simulate-drop.mjs` | Creates a test drop and immediately triggers expiry |
| `test-drops.js` / `test-drops.mjs` | Validates drop creation flow |
| `test-presence.mjs` | Tests presence heartbeat and sortKey sampling |
| `test-push-direct.mjs` | Sends a direct FCM push to a test token |
| `test-fcm-tokens.mjs` | Lists FCM tokens for a given user |

Run any script with:

```bash
node simulate-drop.mjs
```

---

## CI/CD

Deployments are automated via GitHub Actions (`.github/workflows/deploy.yml`):

- **Trigger:** push to `main`
- **Runner:** `ubuntu-latest`, Node 20
- **Deploy target:** Cloudflare Workers via `wrangler-action`

Required GitHub Secrets:

```
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET
VITE_FIREBASE_MESSAGING_SENDER_ID
VITE_FIREBASE_APP_ID
FIREBASE_SERVICE_ACCOUNT_JSON
PERSPECTIVE_API_KEY
QSTASH_TOKEN
```

---

## Android (Capacitor)

The web app is wrapped with Capacitor for a native Android build. Capacitor handles push notification registration (FCM) and Google Sign-In via the native layer.

```bash
# Sync web build to Android project
npx cap sync android

# Open in Android Studio
npx cap open android
```

The Capacitor config points to the production Cloudflare Worker URL as its server — the Android APK is a thin native shell over the deployed web app.

---

## Security Design Notes

- **No client writes** to `drops`, `reactions`, `verdicts`, `moderationLog`, or `reports` — all are server-only via Admin token
- **Presence reads are blocked** client-side — the server samples presence for audience selection, clients never see who's online
- **Drop content is not retrievable** after deletion via browser devtools replay — the Firestore document is hard-deleted and not cached anywhere accessible to clients
- **Rate limiting** is enforced server-side: max 3 confessions per 5-minute window per user
- **Frozen accounts** are blocked from submitting at the API layer, not just the UI

---

## Getting Help

- **Issues:** Open a GitHub issue for bugs or feature requests
- **Firebase Docs:** [firebase.google.com/docs](https://firebase.google.com/docs)
- **Cloudflare Workers Docs:** [developers.cloudflare.com/workers](https://developers.cloudflare.com/workers)
- **Upstash QStash Docs:** [upstash.com/docs/qstash](https://upstash.com/docs/qstash)
- **Perspective API:** [developers.perspectiveapi.com](https://developers.perspectiveapi.com)

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes and test locally with `npm run dev`
4. Ensure Firestore rules and indexes are updated if your changes affect the data model
5. Open a pull request against `main`

> **⚠️ Important:** Any changes to the moderation gate, expiry flow, or Firestore security rules require extra scrutiny. The core invariants — hard delete at T+60s, blocking moderation, no persistent identity tied to content — must not be relaxed.

---

## Maintainer

Built and maintained by [@ansariamann](https://github.com/ansariamann).

---

## License

See [LICENSE](LICENSE) for details.
