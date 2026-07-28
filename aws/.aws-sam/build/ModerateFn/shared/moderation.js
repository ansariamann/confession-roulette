// ─── Moderation Logic — Shared Module ────────────────────────────────────────
// Extracted from server/index.js lines 59–235. Contains PII detection,
// AWS Comprehend toxicity checks, local fallback safety patterns, and
// moderationLog helpers.
//
// No behavior changes from the original — just modularized.
// ─────────────────────────────────────────────────────────────────────────────

const { createHash } = require("crypto");
const {
  ComprehendClient,
  DetectToxicContentCommand,
} = require("@aws-sdk/client-comprehend");

// ─── AWS Comprehend Client ───────────────────────────────────────────────────
// Initialized once per Lambda cold start. Credentials come from the Lambda
// execution role (IAM), so no hardcoded keys needed.
const comprehendClient = new ComprehendClient({
  region: process.env.AWS_REGION || "us-east-1",
});

// ─── Moderation Thresholds ───────────────────────────────────────────────────
// Conservative by default — over-reject is the acceptable failure mode.
// These can be loosened later based on false-positive data.
const THRESHOLDS = {
  HATE_SPEECH:          0.5,
  HARASSMENT_OR_ABUSE:  0.5,
  SEXUAL:               0.5,   // HIGH priority — covers CSAM direction
  VIOLENCE_OR_THREAT:   0.5,   // CRITICAL priority — covers self-harm, threats
  GRAPHIC:              0.5,
  INSULT:               0.7,
  PROFANITY:            0.7,
};

// Overall toxicity threshold
const OVERALL_TOXICITY_THRESHOLD = 0.5;

// Priority mapping for moderationLog
const PRIORITY_MAP = {
  SEXUAL:             "HIGH",
  VIOLENCE_OR_THREAT: "CRITICAL",
};

// ─── PII Regex Patterns ─────────────────────────────────────────────────────
const PII_PATTERNS = [
  {
    name: "PII_PHONE",
    // US: (555) 123-4567, 555-123-4567, +1 555 123 4567
    // International: +91 98765 43210, +44 20 7946 0958
    pattern: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,5}\)?[-.\s]?\d{3,5}[-.\s]?\d{3,5}\b/,
    description: "Phone number pattern detected",
  },
  {
    name: "PII_EMAIL",
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
    description: "Email address detected",
  },
  {
    name: "PII_ADDRESS",
    // Street addresses: "123 Main St", "456 Oak Avenue"
    pattern: /\b\d{1,5}\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Rd|Road|Way|Ct|Court|Pl(?:ace)?|Cir(?:cle)?|Terr(?:ace)?|Pike|Hwy|Highway)\b/i,
    description: "Street address pattern detected",
  },
  {
    name: "PII_ADDRESS_UNIT",
    pattern: /\b(?:Apt|Apartment|Suite|Ste|Unit|Bldg|Building|Fl(?:oor)?|Rm|Room)\s*[#.]?\s*\d+\b/i,
    description: "Address unit pattern detected",
  },
  {
    name: "PII_SOCIAL",
    // Social media handles: @username (not email-like)
    pattern: /(?:^|\s)@[a-zA-Z_]\w{2,29}(?!\.\w)/m,
    description: "Social media handle detected",
  },
];

// ─── Local Fallback Safety Patterns ─────────────────────────────────────────
// Used if AWS Comprehend API is unreachable or unsubscribed.
const LOCAL_SAFETY_PATTERNS = [
  { reason: "SELF_HARM", pattern: /\b(?:suicide|kill\s+myself|end\s+my\s+life|self-harm|want\s+to\s+die)\b/i, priority: "CRITICAL" },
  { reason: "VIOLENCE_OR_THREAT", pattern: /\b(?:bomb|shoot\s+up|kill\s+everyone|massacre|terrorist)\b/i, priority: "CRITICAL" },
  { reason: "HATE_SPEECH", pattern: /\b(?:nigger|faggot|retard|chink|kike|spic)\b/i, priority: "HIGH" },
  { reason: "SEXUAL", pattern: /\b(?:child\s+porn|cp\b|explicit\s+nude)\b/i, priority: "HIGH" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

function truncateText(text) {
  if (text.length <= 20) return text;
  return text.slice(0, 20) + "…";
}

/**
 * Run PII regex checks. Returns first match or null.
 */
function checkPII(text) {
  for (const { name, pattern, description } of PII_PATTERNS) {
    if (pattern.test(text)) {
      return { reason: name, description };
    }
  }
  return null;
}

/**
 * Local fallback safety check (used if AWS Comprehend API is unreachable).
 */
function checkLocalSafety(text) {
  for (const { reason, pattern, priority } of LOCAL_SAFETY_PATTERNS) {
    if (pattern.test(text)) {
      return {
        passed: false,
        reason,
        description: `Local fallback safety rule triggered: ${reason}`,
        scores: { _fallback: 1.0 },
        priority,
      };
    }
  }
  return { passed: true, scores: { _fallback: 0 }, priority: "NORMAL" };
}

/**
 * Call AWS Comprehend DetectToxicContent with local fallback.
 * Returns { passed, reason, description, scores, priority }.
 */
async function checkContentSafety(text) {
  try {
    const command = new DetectToxicContentCommand({
      LanguageCode: "en",
      TextSegments: [{ Text: text }],
    });

    const response = await comprehendClient.send(command);
    const result = response.ResultList?.[0];

    if (!result) {
      return checkLocalSafety(text);
    }

    // Build scores map for logging
    const scores = {};
    for (const label of result.Labels || []) {
      scores[label.Name] = label.Score;
    }
    scores._overallToxicity = result.Toxicity;

    // Check overall toxicity first
    if (result.Toxicity >= OVERALL_TOXICITY_THRESHOLD) {
      return {
        passed: false,
        reason: "TOXICITY",
        description: `Overall toxicity ${result.Toxicity.toFixed(2)} >= ${OVERALL_TOXICITY_THRESHOLD}`,
        scores,
        priority: "NORMAL",
      };
    }

    // Check each label against its threshold
    for (const label of result.Labels || []) {
      const threshold = THRESHOLDS[label.Name];
      if (threshold !== undefined && label.Score >= threshold) {
        const priority = PRIORITY_MAP[label.Name] || "NORMAL";
        return {
          passed: false,
          reason: label.Name,
          description: `${label.Name} score ${label.Score.toFixed(2)} >= threshold ${threshold}`,
          scores,
          priority,
        };
      }
    }

    return { passed: true, scores, priority: "NORMAL" };
  } catch (err) {
    console.warn(`  ⚠️  AWS Comprehend API notice (${err.message}) — using local safety fallback.`);
    return checkLocalSafety(text);
  }
}

/**
 * Write a rejection entry to the moderationLog collection.
 * Stores hashed + truncated text — never full plaintext.
 */
async function logRejection(db, FieldValue, confessionId, text, reason, description, scores, priority) {
  await db.collection("moderationLog").add({
    confessionId,
    reason,
    description,
    textHash: hashText(text),
    textPreview: truncateText(text),
    scores: scores || {},
    priority,
    timestamp: FieldValue.serverTimestamp(),
  });
}

module.exports = {
  checkPII,
  checkContentSafety,
  checkLocalSafety,
  hashText,
  truncateText,
  logRejection,
  THRESHOLDS,
  OVERALL_TOXICITY_THRESHOLD,
  PRIORITY_MAP,
  PII_PATTERNS,
  LOCAL_SAFETY_PATTERNS,
};
