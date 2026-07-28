// ─── Unit tests for PII regex patterns ──────────────────────────────────────
// Run with: node --test aws/test/moderation.test.js
// ─────────────────────────────────────────────────────────────────────────────

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { checkPII, checkLocalSafety } = require("../shared/moderation");

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PII_PHONE", () => {
  it("catches US format (555) 123-4567", () => {
    const result = checkPII("Call me at (555) 123-4567 please");
    assert.equal(result.reason, "PII_PHONE");
  });

  it("catches US format 555-123-4567", () => {
    const result = checkPII("My number is 555-123-4567");
    assert.equal(result.reason, "PII_PHONE");
  });

  it("catches international +1 555 123 4567", () => {
    const result = checkPII("Reach me at +1 555 123 4567");
    assert.equal(result.reason, "PII_PHONE");
  });

  it("catches Indian +91 98765 43210", () => {
    const result = checkPII("WhatsApp me +91 98765 43210");
    assert.equal(result.reason, "PII_PHONE");
  });

  it("does NOT flag short numbers like years (2024)", () => {
    const result = checkPII("Back in 2024 things were different");
    assert.equal(result, null);
  });

  it("does NOT flag clean confessions", () => {
    const result = checkPII("I once ate an entire cake by myself");
    assert.equal(result, null);
  });
});

describe("PII_EMAIL", () => {
  it("catches standard email", () => {
    const result = checkPII("Email me at john@example.com");
    assert.equal(result.reason, "PII_EMAIL");
  });

  it("catches email with dots and plus", () => {
    const result = checkPII("Send to j.doe+test@gmail.com");
    assert.equal(result.reason, "PII_EMAIL");
  });

  it("does NOT flag @ in normal text without domain", () => {
    const result = checkPII("I was @ the store yesterday");
    assert.equal(result, null);
  });
});

describe("PII_ADDRESS", () => {
  it("catches street address", () => {
    const result = checkPII("I live at 123 Main Street");
    assert.equal(result.reason, "PII_ADDRESS");
  });

  it("catches address with abbreviations", () => {
    const result = checkPII("Meet me at 456 Oak Ave");
    assert.equal(result.reason, "PII_ADDRESS");
  });

  it("does NOT flag just numbers", () => {
    const result = checkPII("I have 123 apples");
    assert.equal(result, null);
  });

  it("does NOT flag normal capitalized words", () => {
    const result = checkPII("I went to Central Park");
    assert.equal(result, null);
  });
});

describe("PII_ADDRESS_UNIT", () => {
  it("catches apartment numbers", () => {
    const result = checkPII("I'm in Apt 4");
    assert.equal(result.reason, "PII_ADDRESS_UNIT");
  });

  it("catches suite numbers", () => {
    const result = checkPII("Suite 100");
    assert.equal(result.reason, "PII_ADDRESS_UNIT");
  });
});

describe("PII_SOCIAL", () => {
  it("catches Twitter/Instagram style handles", () => {
    const result = checkPII("Follow me @cooluser123");
    assert.equal(result.reason, "PII_SOCIAL");
  });

  it("flags emails as emails, not handles", () => {
    const result = checkPII("Email me@test.com");
    // Handled by email regex, shouldn't trigger social regex alone
    assert.equal(result.reason, "PII_EMAIL");
  });

  it("does NOT flag short @ mentions", () => {
    const result = checkPII("I was @ school");
    assert.equal(result, null);
  });
});

describe("LOCAL_SAFETY_FALLBACK", () => {
  it("catches self harm", () => {
    const result = checkLocalSafety("I want to kill myself");
    assert.equal(result.passed, false);
    assert.equal(result.reason, "SELF_HARM");
  });

  it("catches violence", () => {
    const result = checkLocalSafety("I will bomb the place");
    assert.equal(result.passed, false);
    assert.equal(result.reason, "VIOLENCE_OR_THREAT");
  });

  it("allows clean text", () => {
    const result = checkLocalSafety("I ate a sandwich");
    assert.equal(result.passed, true);
  });
});
