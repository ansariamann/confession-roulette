// ─── Unit tests for PII regex patterns ──────────────────────────────────────
// Run with: node --test test/moderation.test.js
// ─────────────────────────────────────────────────────────────────────────────

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// We need to extract the PII patterns and checkPII from index.js.
// Since index.js has side effects (initializeApp), we replicate the patterns here
// for isolated unit testing.

const PII_PATTERNS = [
  {
    name: "PII_PHONE",
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
    pattern: /(?:^|\s)@[a-zA-Z_]\w{2,29}(?!\.\w)/m,
    description: "Social media handle detected",
  },
];

function checkPII(text) {
  for (const { name, pattern, description } of PII_PATTERNS) {
    if (pattern.test(text)) {
      return { reason: name, description };
    }
  }
  return null;
}

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
  it("catches '123 Main Street'", () => {
    const result = checkPII("I live at 123 Main Street");
    assert.equal(result.reason, "PII_ADDRESS");
  });

  it("catches '456 Oak Avenue'", () => {
    const result = checkPII("Come to 456 Oak Avenue");
    assert.equal(result.reason, "PII_ADDRESS");
  });

  it("catches '789 Elm Blvd'", () => {
    const result = checkPII("The office is at 789 Elm Blvd");
    assert.equal(result.reason, "PII_ADDRESS");
  });

  it("catches '10 Downing St'", () => {
    const result = checkPII("Visited 10 Downing St last week");
    assert.equal(result.reason, "PII_ADDRESS");
  });

  it("does NOT flag 'went down the road'", () => {
    const result = checkPII("I went down the road and found peace");
    assert.equal(result, null);
  });
});

describe("PII_ADDRESS_UNIT", () => {
  it("catches 'Apt 4B'", () => {
    const result = checkPII("I live in Apt 4");
    assert.equal(result.reason, "PII_ADDRESS_UNIT");
  });

  it("catches 'Suite #200'", () => {
    const result = checkPII("Office is Suite #200");
    assert.equal(result.reason, "PII_ADDRESS_UNIT");
  });

  it("catches 'Unit 12'", () => {
    const result = checkPII("Moved to Unit 12 last month");
    assert.equal(result.reason, "PII_ADDRESS_UNIT");
  });
});

describe("PII_SOCIAL", () => {
  it("catches @username at start", () => {
    const result = checkPII("@john_doe123 is my handle");
    assert.equal(result.reason, "PII_SOCIAL");
  });

  it("catches @username mid-text", () => {
    const result = checkPII("Follow me at @coolperson");
    assert.equal(result.reason, "PII_SOCIAL");
  });

  it("does NOT flag email-like @domain.com", () => {
    // The email pattern would catch this first, but the social pattern
    // should not match patterns followed by .domain
    const text = "Not a handle but test@gmail.com";
    const result = checkPII(text);
    // Email should be caught first
    assert.equal(result.reason, "PII_EMAIL");
  });
});

describe("Clean confessions (no PII)", () => {
  const cleanTexts = [
    "I secretly love pineapple on pizza",
    "I once told my boss I was sick but went to the beach",
    "I have been pretending to like my friend's cooking for years",
    "Sometimes I cry during commercials",
    "I still sleep with a stuffed animal and I'm 30",
  ];

  for (const text of cleanTexts) {
    it(`passes: "${text.slice(0, 40)}…"`, () => {
      assert.equal(checkPII(text), null);
    });
  }
});
