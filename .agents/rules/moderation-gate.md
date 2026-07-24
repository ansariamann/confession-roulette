---
trigger: always_on
---

# Moderation Spec — paste this alongside Phase 2 for more detail if the agent's first pass is too shallow

This is the single highest-risk part of the app. Ephemeral + anonymous + no post-hoc record means the ONLY line of defense is the pre-broadcast check. Give the agent this level of specificity if its first attempt just calls a generic "is this toxic" API and stops.

## What the gate must check, in order
1. **Automated toxicity/harassment/threat classification** — reject if score exceeds a conservative threshold. Start strict; you can loosen later based on false-positive rate, not the other way around.
2. **PII pattern detection** — regex or NER-based checks for: phone number formats, email addresses, street-address-like patterns, full-name-plus-location combinations, social media handles. Reject or hold for extra review, don't just warn.
3. **CSAM / minor-endangerment classification** — treat any hit as an automatic reject + immediate flag to the moderationLog with highest priority, never a soft warning. This should never rely solely on generic toxicity scoring; use a dedicated classifier if the platform offers one.
4. **Self-harm / suicide content** — this one should NOT be a hard reject-and-forget. Route it to a distinct path: block the broadcast (don't send self-harm content live to 100 strangers for entertainment reactions — that's a harm vector, not a moderation nicety), but surface an in-app message to the author pointing to crisis resources, rather than just silently rejecting like spam.
5. **Illegal content / doxxing / credible threats** — automatic reject, flag to moderationLog, and this is the category where the user's reportCount / freeze mechanism matters most for repeat offenders who reword to slip past the classifier.

## Design requirements to give the agent explicitly
- The moderation check must be a **blocking step before the drop scheduler ever sees the confession** — not a parallel/async check that might finish after broadcast has already started. Ask the agent to show you the control flow to confirm sequencing.
- Log rejections with a **truncated or hashed** version of the text, not full plaintext, to limit what's sitting in the moderation log even though it's restricted-access.
- moderationLog must be **inaccessible via normal Firestore security rules** — verify this by asking the agent to show you the rules file, not just trust a verbal confirmation.
- False positives are expected and are the acceptable failure mode — tell the agent explicitly you'd rather over-reject honest confessions early on than under-reject harmful ones. You can tune thresholds down later once you see real rejection data.
- The "spicier mode" (500-recipient tier) should use a **stricter** threshold than default, not the same one — bigger blast radius, smaller risk tolerance.

## What NOT to ask the agent for
Don't ask Antigravity (or any tool) to explain how classifiers can be evaded, what phrasing gets past toxicity filters, or to generate example harmful confessions "for testing the filter." Test the moderation gate with obviously benign and obviously egregious examples you write yourself in small number, and rely on the classifier's published accuracy stats rather than trying to red-team it into a bypass map — that just produces a how-to-evade document sitting in your repo.