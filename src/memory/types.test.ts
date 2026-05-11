import { describe, test, expect } from "bun:test";
import {
  MemoryFrontmatterSchema,
  MemoryIndexLineSchema,
  MemoryTopicTypeSchema,
  MEMORY_TOPIC_VALUES,
  MemoryExtractionResultSchema,
  MemoryConsolidationResultSchema,
  TitleGenerationResultSchema,
} from "./schemas";

// ---------------------------------------------------------------------------
// MemoryFrontmatterSchema
// ---------------------------------------------------------------------------

describe("MemoryFrontmatterSchema", () => {
  test("accepts valid frontmatter", () => {
    const input = {
      name: "Debugging",
      description: "Common debugging patterns and techniques",
      type: "project" as const,
    };
    const result = MemoryFrontmatterSchema.parse(input);
    expect(result.name).toBe("Debugging");
    expect(result.description).toBe("Common debugging patterns and techniques");
    expect(result.type).toBe("project");
  });

  test("accepts all valid topic types", () => {
    for (const type of MEMORY_TOPIC_VALUES) {
      const result = MemoryFrontmatterSchema.parse({
        name: "Test",
        description: "Test",
        type,
      });
      expect(result.type).toBe(type);
    }
  });

  test("rejects unknown fields", () => {
    expect(() =>
      MemoryFrontmatterSchema.parse({
        name: "Debugging",
        description: "Common patterns",
        type: "project",
        extraField: "should be rejected",
      }),
    ).toThrow();
  });

  test("rejects invalid topic type", () => {
    expect(() =>
      MemoryFrontmatterSchema.parse({
        name: "Debugging",
        description: "Common patterns",
        type: "invalid",
      }),
    ).toThrow();
  });

  test("rejects missing required fields", () => {
    expect(() =>
      MemoryFrontmatterSchema.parse({ name: "Debugging" }),
    ).toThrow();
    expect(() =>
      MemoryFrontmatterSchema.parse({ description: "test" }),
    ).toThrow();
    expect(() => MemoryFrontmatterSchema.parse({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// MemoryIndexLineSchema
// ---------------------------------------------------------------------------

describe("MemoryIndexLineSchema", () => {
  const VALID_LINE = "- [Debugging](debugging) — Common patterns";

  test("accepts valid index line format", () => {
    const result = MemoryIndexLineSchema.parse(VALID_LINE);
    expect(result).toBe(VALID_LINE);
  });

  test("rejects line without leading dash", () => {
    expect(() => MemoryIndexLineSchema.parse("[Debugging](path) — text")).toThrow();
  });

  test("rejects line without brackets", () => {
    expect(() => MemoryIndexLineSchema.parse("- Debugging(path) — text")).toThrow();
  });

  test("rejects line without parentheses", () => {
    expect(() => MemoryIndexLineSchema.parse("- [Debugging]path — text")).toThrow();
  });

  test("rejects line without em-dash separator", () => {
    expect(() => MemoryIndexLineSchema.parse("- [Debugging](path) text")).toThrow();
  });

  test("rejects empty string", () => {
    expect(() => MemoryIndexLineSchema.parse("")).toThrow();
  });

  test("parsing roundtrip produces identical string", () => {
    // Parse via regex
    const match = /^- \[(.+?)\]\((.+?)\) — (.+)$/.exec(VALID_LINE);
    expect(match).not.toBeNull();

    const [, title, name, summary] = match!;
    expect(title).toBe("Debugging");
    expect(name).toBe("debugging");
    expect(summary).toBe("Common patterns");

    // Reconstruct and validate
    const reconstructed = `- [${title}](${name}) — ${summary}`;
    expect(reconstructed).toBe(VALID_LINE);

    // Re-parsed line passes schema
    const result = MemoryIndexLineSchema.parse(reconstructed);
    expect(result).toBe(VALID_LINE);
  });

  test("roundtrip with multiple realistic entries", () => {
    const lines = [
      "- [Testing](testing) — Testing strategies and patterns",
      "- [Architecture](architecture) — System design decisions",
      "- [User Prefs](user_prefs) — User preference for concise answers",
    ];

    for (const original of lines) {
      const match = /^- \[(.+?)\]\((.+?)\) — (.+)$/.exec(original);
      expect(match).not.toBeNull();

      const [, title, name, summary] = match!;
      const reconstructed = `- [${title}](${name}) — ${summary}`;
      expect(reconstructed).toBe(original);
      expect(() => MemoryIndexLineSchema.parse(reconstructed)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// MemoryTopicType
// ---------------------------------------------------------------------------

describe("MemoryTopicType", () => {
  test("has exactly 4 values", () => {
    expect(MEMORY_TOPIC_VALUES.length).toBe(4);
    expect(MEMORY_TOPIC_VALUES).toEqual([
      "user",
      "feedback",
      "project",
      "reference",
    ]);
  });

  test("schema accepts all valid values", () => {
    for (const value of MEMORY_TOPIC_VALUES) {
      const result = MemoryTopicTypeSchema.safeParse(value);
      expect(result.success).toBe(true);
    }
  });

  test("schema rejects invalid values", () => {
    const invalid = MemoryTopicTypeSchema.safeParse("invalid");
    expect(invalid.success).toBe(false);

    const number = MemoryTopicTypeSchema.safeParse(42);
    expect(number.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MemoryExtractionResultSchema
// ---------------------------------------------------------------------------

describe("MemoryExtractionResultSchema", () => {
  test("accepts valid extraction result", () => {
    const input = {
      memories: [
        {
          title: "Debugging Tips",
          name: "debugging_tips",
          description: "Common debugging patterns",
          type: "project" as const,
          content: "When debugging, start by reproducing the issue.",
          shouldCreate: true,
        },
      ],
    };
    const result = MemoryExtractionResultSchema.parse(input);
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0].title).toBe("Debugging Tips");
  });

  test("rejects memories over max 10", () => {
    const input = {
      memories: Array.from({ length: 11 }, (_, i) => ({
        title: `Memory ${i}`,
        name: `memory_${i}`,
        description: `Description ${i}`,
        type: "project" as const,
        content: "Content here",
        shouldCreate: true,
      })),
    };
    expect(() => MemoryExtractionResultSchema.parse(input)).toThrow();
  });

  test("accepts empty memories array", () => {
    const result = MemoryExtractionResultSchema.parse({ memories: [] });
    expect(result.memories).toEqual([]);
  });

  test("rejects unknown fields in extraction result", () => {
    expect(() =>
      MemoryExtractionResultSchema.parse({
        memories: [],
        extra: "field",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// MemoryConsolidationResultSchema
// ---------------------------------------------------------------------------

describe("MemoryConsolidationResultSchema", () => {
  test("accepts valid consolidation result", () => {
    const input = {
      entries: [
        {
          title: "Debugging",
          name: "debugging",
          summary: "Common patterns",
        },
      ],
    };
    const result = MemoryConsolidationResultSchema.parse(input);
    expect(result.entries).toHaveLength(1);
  });

  test("accepts empty entries array", () => {
    const result = MemoryConsolidationResultSchema.parse({ entries: [] });
    expect(result.entries).toEqual([]);
  });

  test("rejects entries over max 200", () => {
    const input = {
      entries: Array.from({ length: 201 }, (_, i) => ({
        title: `Entry ${i}`,
        name: `entry_${i}`,
        summary: `Summary ${i}`,
      })),
    };
    expect(() => MemoryConsolidationResultSchema.parse(input)).toThrow();
  });

  test("rejects unknown fields", () => {
    expect(() =>
      MemoryConsolidationResultSchema.parse({
        entries: [],
        extra: true,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TitleGenerationResultSchema
// ---------------------------------------------------------------------------

describe("TitleGenerationResultSchema", () => {
  test("accepts valid title", () => {
    const result = TitleGenerationResultSchema.parse({ title: "Debug React auth" });
    expect(result.title).toBe("Debug React auth");
  });

  test("rejects title over 200 chars", () => {
    expect(() =>
      TitleGenerationResultSchema.parse({ title: "x".repeat(201) }),
    ).toThrow();
  });

  test("accepts title at exactly 200 chars", () => {
    const result = TitleGenerationResultSchema.parse({ title: "x".repeat(200) });
    expect(result.title.length).toBe(200);
  });

  test("rejects missing title", () => {
    expect(() => TitleGenerationResultSchema.parse({})).toThrow();
  });

  test("rejects unknown fields", () => {
    expect(() =>
      TitleGenerationResultSchema.parse({ title: "test", extra: true }),
    ).toThrow();
  });
});
