import { describe, expect, it } from "vitest";
import { analyzeQuery, containsExactTarget, extractTechnicalTokens, matchesExactTarget } from "../../src/core/technical-tokens.js";

const texts = (input: string) => extractTechnicalTokens(input).map((token) => token.text);

describe("extractTechnicalTokens", () => {
  it.each([
    ["ECONNRESET", "Why does the importer fail with ECONNRESET?"],
    ["E-4012", "What is error code E-4012?"],
    ["HTTP_429", "What does HTTP_429 mean?"],
    ["useEffect", "useEffect cleanup function"],
    ["user_id", "What does the user_id column reference?"],
    ["v2.14.1", "What changed in v2.14.1?"],
    ["ABC-123", "Where is ticket ABC-123 described?"],
    ["SMTP_PASSWORD", "Which variable holds the SMTP_PASSWORD?"],
    ["config/settings.yaml", "What does config/settings.yaml contain?"],
    ["feed-ingest.service", "Where does feed-ingest.service write its logs?"],
    ["accounts.id", "What does accounts.id hold?"],
  ])("recognises %s", (token, question) => {
    expect(texts(question)).toContain(token);
  });

  it.each([
    "What is the capital of Australia?",
    "How can I get my money back for something I paid for?",
    "Tell me about Mercury",
    "How do I reset it?",
    "What is the well-known state-of-the-art approach?",
    "Is the Wi-Fi password the same in the office?",
    "Why was it 100% sure that e.g. the 2nd option wins in 2026?",
    "WHAT HAPPENED YESTERDAY",
    "The API returns JSON over HTTP and HTML over TLS",
    "Meet me at 10:30 on 15 April, 5pm",
    "What is the PostgreSQL pool size of the PurrFeed app, asked McDonald on YouTube?",
  ])("does not treat ordinary words as identifiers: %s", (question) => {
    expect(texts(question)).toEqual([]);
  });

  it("is Unicode safe: non-Latin words are not identifiers, non-Latin camelCase and digits mixes are", () => {
    expect(texts("Как настроить подключение к базе данных?")).toEqual([]);
    expect(texts("日本語のドキュメントはありますか")).toEqual([]);
    expect(texts("Что значит ошибка ОШИБКА_42?")).toContain("ОШИБКА_42");
    expect(texts("Wofür steht änderungsId?")).toContain("änderungsId");
  });

  it("still recognises an identifier that is the whole query", () => {
    expect(texts("ECONNRESET")).toEqual(["ECONNRESET"]);
    expect(texts("WHAT HAPPENED WITH ECONNRESET")).toEqual([]);
  });

  it("classifies versions, file names and identifiers", () => {
    const kinds = Object.fromEntries(
      extractTechnicalTokens("v2.14.1 of notes.md raised ECONNRESET and 3.10.2").map((token) => [token.text, token.kind]),
    );
    expect(kinds).toEqual({ "v2.14.1": "version", "notes.md": "filename", ECONNRESET: "identifier", "3.10.2": "version" });
  });

  it("lists every distinct token once, in order of appearance", () => {
    expect(texts("HTTP_429 then http_429 and E-4012, E-4012 again")).toEqual(["HTTP_429", "E-4012"]);
  });

  it("does not turn plain decimals or short ordinals into versions or identifiers", () => {
    expect(texts("It costs 4.5 euros, the 2.4 GHz band, 3rd floor, 24h")).toEqual([]);
  });
});

describe("analyzeQuery", () => {
  it("separates technical tokens from quoted phrases", () => {
    const features = analyzeQuery('Where does "ingest complete" appear for ECONNRESET?');

    expect(features.technicalTokens.map((token) => token.text)).toEqual(["ECONNRESET"]);
    expect(features.quotedPhrases).toEqual(["ingest complete"]);
    expect(features.exactTargets).toEqual(["ECONNRESET", "ingest complete"]);
  });

  it("accepts typographic quotes and ignores single quoted words", () => {
    expect(analyzeQuery("what is “refund policy” and 'x'?").quotedPhrases).toEqual(["refund policy"]);
    expect(analyzeQuery("what is “refund”?").quotedPhrases).toEqual([]);
  });

  it("has no targets for an ordinary natural-language question", () => {
    expect(analyzeQuery("How do I request vacation days?").exactTargets).toEqual([]);
  });
});

describe("matchesExactTarget", () => {
  const chunk = { fileName: "cat-feeder.md", content: "The battery is low." };

  it("finds a target in the text", () => {
    expect(matchesExactTarget({ ...chunk, content: "Error E-4012: battery" }, "E-4012")).toBe(true);
    expect(matchesExactTarget(chunk, "E-4012")).toBe(false);
  });

  it("lets a file name target match the document's name, ignoring case and folders", () => {
    expect(matchesExactTarget(chunk, "cat-feeder.md")).toBe(true);
    expect(matchesExactTarget(chunk, "Cat-Feeder.MD")).toBe(true);
    expect(matchesExactTarget({ ...chunk, fileName: "docs/cat-feeder.md" }, "cat-feeder.md")).toBe(true);
    expect(matchesExactTarget(chunk, "feeder.md")).toBe(false);
    expect(matchesExactTarget(chunk, "dog-feeder.md")).toBe(false);
  });
});

describe("containsExactTarget", () => {
  it("matches whole tokens only, ignoring case", () => {
    expect(containsExactTarget("E-4012 means the battery is low.", "E-4012")).toBe(true);
    expect(containsExactTarget("Error e-4012 occurred", "E-4012")).toBe(true);
    expect(containsExactTarget("see v2.14.1.", "v2.14.1")).toBe(true);
  });

  it("does not match inside a longer token", () => {
    expect(containsExactTarget("E-40120 and XE-4012", "E-4012")).toBe(false);
    expect(containsExactTarget("version v2.14.10 ships", "v2.14.1")).toBe(false);
    expect(containsExactTarget("MY_HTTP_429_HANDLER", "HTTP_429")).toBe(false);
  });

  it("matches a quoted phrase regardless of whitespace and case", () => {
    expect(containsExactTarget("ends with the line  \"Ingest\nComplete\" here", "ingest complete")).toBe(true);
    expect(containsExactTarget("ingest was not complete", "ingest complete")).toBe(false);
  });
});
