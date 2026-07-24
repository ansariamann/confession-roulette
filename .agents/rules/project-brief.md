---
trigger: always_on
---

# Project Brief — "Verdict" (working title)
Paste this into Antigravity FIRST, as project-level context/rules, before running any build prompts. Keep it pinned/available to the agent throughout the whole build — it encodes the constraints that must never be relaxed for convenience.

## What this app is
A confession app built around one ritual: post a short anonymous confession, it gets broadcast LIVE to exactly 100 randomly selected active users for exactly 10 seconds, you watch reactions climb in a live bar chart, then the post is permanently and irreversibly deleted server-side. No feed. No profile. No history. Nothing persists.

## Non-negotiable constraints (do not let the agent "simplify" these away)
1. **Fixed blast radius.** Every drop goes to exactly 100 randomly selected currently-active users (or 500 in "spicier" tier). Never more, never algorithmic amplification, never based on popularity.
2. **Fixed duration.** Confession is live for exactly 10 seconds from the moment of broadcast. Countdown must be server-authoritative, not client-side only (client desync must not extend visibility).
3. **True hard delete.** At T+10s the confession record is deleted from the database — not soft-deleted, not flagged hidden, not archived. If it needs to exist anywhere post-delete for abuse investigation, that's a separate moderation-log table (see 04_MODERATION_SPEC.md) with restricted access, not the live content table.
4. **Moderation happens BEFORE broadcast, not after.** A confession must pass an automated safety check before it enters a drop. There is no post-hoc moderation queue for live content, because live content won't exist after 10 seconds.
5. **No persistent identity tied to content.** Users are anonymous relative to each other. The app may still have accounts (for auth, rate-limiting, abuse tracking) but no confession is ever attributable to a public username in the UI.
6. **No ads inside the 10-second window.** Monetization is cosmetic/tier-based only (see 05_MONETIZATION.md).

## Tech stack (for Antigravity's default Google-stack bias — lean into it, don't fight it)
- **Frontend:** React (Antigravity default), mobile-first responsive layout
- **Auth:** Firebase Authentication (anonymous auth is fine as the default; optional real accounts later)
- **Database:** Cloud Firestore for user/session/moderation-log data
- **Realtime layer:** Firestore realtime listeners OR a WebSocket channel via Cloud Run — let the agent pick, but require it to justify the choice against "100 concurrent clients need synchronized sub-second updates for 10 seconds"
- **Scheduler:** Cloud Scheduler + Cloud Functions (or a Cloud Run background worker) for the 60-second drop batching cycle
- **Moderation:** Cloud Natural Language API / Perspective API for toxicity + a regex/PII-pattern layer for phone numbers, emails, addresses, full names in structured patterns (see 04_MODERATION_SPEC.md)

## Core data model (tell the agent this up front, don't let it invent its own schema first)
- `users`: uid, createdAt, deviceFingerprint/rateLimitState, reportCount, isFrozen, tier (free/spicier)
- `pendingConfessions`: id, text, submittedAt, moderationStatus (pending/passed/rejected), authorUid (never shown in UI)
- `drops`: id, scheduledAt, confessionId, recipientUids[100], status (broadcasting/expired/deleted)
- `reactions`: dropId, emojiType, count (aggregate only — never store which user reacted to what, to avoid rebuilding a profile of reactions)
- `moderationLog`: confessionId (hashed or truncated), reason, timestamp, reviewedBy (for the human-reportable freeze mechanism — access-restricted, not user-facing)
- `hallOfFameStats`: date, emojiTotals (aggregate counts only, never tied to a specific confession)

## What "done" looks like for a first working version
A user can submit a confession, it enters a queue, within ~60s it broadcasts to a room of (simulated, if testing solo) recipients, a live reaction bar animates for 10 seconds across all connected clients, at 10s the record is deleted and a verdict screen shows the aggregate result, and the confession cannot be retrieved by anyone afterward — including via browser devtools network tab replay, which is worth explicitly asking the agent to verify.