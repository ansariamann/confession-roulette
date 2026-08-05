// ─── Content Moderation Helper ────────────────────────────────────────────────
// Blocking pre-broadcast safety gate.
// Runs in order: PII regex → Perspective API toxicity → local fallback patterns.
//
// Returns: { passed: true } or { passed: false, reason, selfHarm, description }
//
// Design constraints (from project spec):
//  - Must complete BEFORE the drop scheduler sees the confession
//  - False positives are the acceptable failure mode (over-reject, not under-reject)
//  - Self-harm is NOT a silent reject — returns selfHarm:true for client UX handling
//  - CSAM/child-endangerment is auto-reject + flag, never a soft warning
//  - "Spicier" tier (500-recipient) uses a stricter threshold
// ─────────────────────────────────────────────────────────────────────────────

// ── PII Patterns ──────────────────────────────────────────────────────────────
const PII_PATTERNS = [
  {
    name: "PII_PHONE",
    pattern:
      /(?:\+?\d{1,3}[-.s]?)?\(?\d{2,5}\)?[-.\s]?\d{3,5}[-.\s]?\d{3,5}\b/,
    description: "Phone number pattern detected",
  },
  {
    name: "PII_EMAIL",
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
    description: "Email address detected",
  },
  {
    name: "PII_ADDRESS",
    pattern:
      /\b\d{1,5}\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Rd|Road|Way|Ct|Court|Pl(?:ace)?|Cir(?:cle)?|Terr(?:ace)?|Pike|Hwy|Highway)\b/i,
    description: "Street address pattern detected",
  },
  {
    name: "PII_SOCIAL",
    pattern: /(?:^|\s)@[a-zA-Z_]\w{2,29}(?!\.\w)/m,
    description: "Social media handle detected",
  },
];

// ── Local Safety Fallback Patterns ────────────────────────────────────────────
// Used when Perspective API is unavailable or not configured.
// Conservative — catches the most obvious egregious content.
const LOCAL_SAFETY_PATTERNS = [
  {
    reason: "SELF_HARM",
    pattern:
      /\b(?:suicide|kill\s+myself|end\s+my\s+life|self[-\s]harm|want\s+to\s+die|cutting\s+myself)\b/i,
    selfHarm: true,
    priority: "CRITICAL",
  },
  {
    reason: "VIOLENCE_OR_THREAT",
    pattern:
      /\b(?:bomb|shoot\s+up|kill\s+everyone|massacre|terrorist|i\s+will\s+kill)\b/i,
    selfHarm: false,
    priority: "CRITICAL",
  },
  {
    reason: "CSAM",
    // CSAM/minor-endangerment: treat as auto-reject + highest priority flag
    pattern:
      /\b(?:child\s+porn|cp\b|underage\s+nude|minor\s+sex|loli(?:ta)?)\b/i,
    selfHarm: false,
    priority: "CSAM",
  },
  {
    reason: "HATE_SPEECH",
    pattern: /\b(?:nigger|faggot|retard|chink|kike|spic|tranny)\b/i,
    selfHarm: false,
    priority: "HIGH",
  },
];

/**
 * PII check — runs first, cheapest.
 * Returns { reason, description } on match, or null if clean.
 */
export function checkPII(text) {
  for (const { name, pattern, description } of PII_PATTERNS) {
    if (pattern.test(text)) {
      return { reason: name, description };
    }
  }
  return null;
}

/**
 * Local safety fallback — used when Perspective API is unavailable.
 * Returns { passed, reason, selfHarm, description, priority }.
 */
function checkLocalSafety(text) {
  for (const { reason, pattern, selfHarm, priority } of LOCAL_SAFETY_PATTERNS) {
    if (pattern.test(text)) {
      return {
        passed: false,
        reason,
        selfHarm: selfHarm === true,
        description: `Local safety pattern triggered: ${reason}`,
        priority,
      };
    }
  }
  return { passed: true, selfHarm: false, priority: "NORMAL" };
}

/**
 * Call Google Perspective API.
 * Docs: https://developers.perspectiveapi.com/s/docs-reference-scoring
 *
 * Threshold design:
 *   - Default tier: 0.7 overall toxicity
 *   - Spicier tier (500 recipients): 0.5 (stricter — bigger blast radius)
 *   - THREAT / SEXUALLY_EXPLICIT always at 0.5 regardless of tier
 */
async function checkPerspectiveAPI(text, isSpicier = false) {
  const apiKey = process.env.PERSPECTIVE_API_KEY;
  if (!apiKey) return null; // Not configured — fall through to local check

  const overallThreshold = isSpicier ? 0.5 : 0.7;

  try {
    const res = await fetch(
      `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          comment: { text },
          languages: ["en"],
          requestedAttributes: {
            TOXICITY: {},
            SEVERE_TOXICITY: {},
            THREAT: {},
            SEXUALLY_EXPLICIT: {},
            IDENTITY_ATTACK: {},
          },
        }),
      }
    );

    if (!res.ok) {
      console.warn(`Perspective API error ${res.status} — using local fallback`);
      return null;
    }

    const data = await res.json();
    const scores = data.attributeScores || {};

    const toxicity =
      scores.TOXICITY?.summaryScore?.value ?? 0;
    const severeToxicity =
      scores.SEVERE_TOXICITY?.summaryScore?.value ?? 0;
    const threat =
      scores.THREAT?.summaryScore?.value ?? 0;
    const sexuallyExplicit =
      scores.SEXUALLY_EXPLICIT?.summaryScore?.value ?? 0;
    const identityAttack =
      scores.IDENTITY_ATTACK?.summaryScore?.value ?? 0;

    // THREAT and SEXUALLY_EXPLICIT are always strict (0.5) — bigger harm potential
    if (threat >= 0.5) {
      return {
        passed: false,
        reason: "THREAT",
        selfHarm: false,
        description: `Threat score ${threat.toFixed(2)} >= 0.5`,
        priority: "CRITICAL",
      };
    }

    if (sexuallyExplicit >= 0.5) {
      return {
        passed: false,
        reason: "SEXUALLY_EXPLICIT",
        selfHarm: false,
        description: `Sexually explicit score ${sexuallyExplicit.toFixed(2)} >= 0.5`,
        priority: "HIGH",
      };
    }

    if (severeToxicity >= 0.5 || toxicity >= overallThreshold) {
      return {
        passed: false,
        reason: "TOXICITY",
        selfHarm: false,
        description: `Toxicity ${toxicity.toFixed(2)} or severe ${severeToxicity.toFixed(2)}`,
        priority: "NORMAL",
      };
    }

    if (identityAttack >= overallThreshold) {
      return {
        passed: false,
        reason: "IDENTITY_ATTACK",
        selfHarm: false,
        description: `Identity attack score ${identityAttack.toFixed(2)}`,
        priority: "HIGH",
      };
    }

    return { passed: true, selfHarm: false, priority: "NORMAL" };
  } catch (err) {
    console.warn(`Perspective API fetch failed: ${err.message} — using local fallback`);
    return null;
  }
}

/**
 * Main moderation gate — runs ALL checks in order.
 *
 * @param {string} text - The confession text to check
 * @param {boolean} isSpicier - Whether this is a 500-recipient "spicier" tier drop
 * @returns {{ passed: boolean, reason?: string, selfHarm?: boolean, description?: string, priority?: string }}
 */
export async function moderateText(text, isSpicier = false) {
  // ── Step 1: PII regex (cheapest, runs first) ────────────────────────────
  const piiResult = checkPII(text);
  if (piiResult) {
    return {
      passed: false,
      reason: piiResult.reason,
      selfHarm: false,
      description: piiResult.description,
      priority: "NORMAL",
    };
  }

  // ── Step 2: Perspective API toxicity check ──────────────────────────────
  const perspectiveResult = await checkPerspectiveAPI(text, isSpicier);

  if (perspectiveResult !== null) {
    // Perspective API responded — trust it
    return perspectiveResult;
  }

  // ── Step 3: Local safety fallback (if Perspective unavailable) ──────────
  return checkLocalSafety(text);
}
