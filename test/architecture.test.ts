import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./eval/support.js";

const SRC = path.join(REPO_ROOT, "src");

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

/** Every project-internal import of a file, as a path relative to src/ (e.g. "infrastructure/sqlite/database"). */
function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, "utf-8");
  const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)].map((match) => match[1]);
  return specifiers.map((specifier) => path.relative(SRC, path.resolve(path.dirname(file), specifier)).replace(/\\/g, "/").replace(/\.js$/, ""));
}

const layerOf = (relative: string) => relative.split("/")[0];
const files = sourceFiles(SRC).map((file) => ({ file, layer: layerOf(path.relative(SRC, file).replace(/\\/g, "/")), imports: importsOf(file) }));

/** Which layers a layer may import from (itself is always allowed). Files directly under src/ count as their own layer. */
const ALLOWED: Record<string, string[]> = {
  core: ["shared"],
  application: ["core", "shared"],
  infrastructure: ["application", "core", "shared"],
  telegram: ["application", "core", "shared"],
  config: [],
  shared: [],
  // Tooling: evaluation reuses the application and the SQLite adapters to measure the real thing.
  eval: ["application", "core", "infrastructure", "shared"],
  // Entry points wire things up and may use anything except Telegram unless they are the bot itself.
  cli: ["application", "core", "infrastructure", "shared", "config", "eval", "composition-root"],
};

function violations(layer: string) {
  const allowed = new Set([layer, ...ALLOWED[layer]]);
  return files
    .filter((entry) => entry.layer === layer)
    .flatMap((entry) =>
      entry.imports
        .filter((imported) => !allowed.has(layerOf(imported)))
        .map((imported) => `${path.relative(SRC, entry.file).replace(/\\/g, "/")} imports ${imported}`),
    );
}

describe("architecture boundaries", () => {
  it.each(Object.keys(ALLOWED))("the %s layer only imports from the layers it may know", (layer) => {
    expect(violations(layer)).toEqual([]);
  });

  it("nothing in the bot's runtime imports evaluation code", () => {
    const leaks = files
      .filter((entry) => ["core", "application", "infrastructure", "telegram", "config", "shared"].includes(entry.layer) || /^(composition-root|index|lifecycle)\.ts$/.test(path.basename(entry.file)) && path.dirname(entry.file) === SRC)
      .filter((entry) => entry.imports.some((imported) => layerOf(imported) === "eval" || imported.startsWith("cli/")));

    expect(leaks.map((entry) => path.relative(SRC, entry.file))).toEqual([]);
  });

  it("no command-line tool depends on Telegram (so none needs TELEGRAM_BOT_TOKEN)", () => {
    const telegramUsers = files
      .filter((entry) => entry.layer === "cli" || entry.layer === "eval")
      .filter((entry) => entry.imports.some((imported) => layerOf(imported) === "telegram" || imported === "index"));

    expect(telegramUsers.map((entry) => path.relative(SRC, entry.file))).toEqual([]);
  });

  it("only the bot entry point loads the Telegram configuration section", () => {
    const users = files
      .filter((entry) => /telegramConfig|loadConfig\b/.test(fs.readFileSync(entry.file, "utf-8")))
      .map((entry) => path.relative(SRC, entry.file).replace(/\\/g, "/"));

    // config.ts defines them; index.ts (the bot) uses loadConfig. Tools use loadToolConfig + the section they need.
    expect(users.sort()).toEqual(["config/config.ts", "index.ts"]);
  });

  it("application code never imports SQLite, OpenAI or Telegram libraries directly", () => {
    const offenders = files
      .filter((entry) => entry.layer === "application" || entry.layer === "core")
      .filter((entry) => /from\s+["'](better-sqlite3|telegraf|openai|@langchain\/[^"']+|pdf-parse)["']/.test(fs.readFileSync(entry.file, "utf-8")));

    expect(offenders.map((entry) => path.relative(SRC, entry.file))).toEqual([]);
  });

  it("the integrity, repair, backup and startup-check code cannot reach a paid provider: nothing there imports embeddings, OpenAI or LangChain", () => {
    const free = files.filter((entry) => {
      const relative = path.relative(SRC, entry.file).replace(/\\/g, "/");
      return /^(application\/(use-cases\/(inspect|repair)-integrity|startup-check|ports\/integrity-store)|infrastructure\/(backup\/|sqlite\/sqlite-integrity-store)|cli\/(integrity|backup))/.test(relative);
    });

    expect(free.length).toBeGreaterThanOrEqual(8); // the pattern really matches the files it is meant to guard
    const offenders = free.filter(
      (entry) =>
        entry.imports.some((imported) => /embeddings|openai|chat-model|speech/.test(imported)) ||
        /from\s+["'](openai|@langchain\/[^"']+)["']|embedDocuments|embedQuery|OPENAI_API_KEY/.test(fs.readFileSync(entry.file, "utf-8")),
    );

    expect(offenders.map((entry) => path.relative(SRC, entry.file))).toEqual([]);
  });

  it("format-specific provenance (PDF pages and labels, Markdown sections) stays optional in the core model", () => {
    const provenance = fs.readFileSync(path.join(SRC, "core", "provenance.ts"), "utf-8");

    for (const field of ["pageStart", "pageEnd", "pageLabelStart", "pageLabelEnd", "sectionPath"]) {
      expect(provenance, `${field} must be optional`).toMatch(new RegExp(`${field}\\?:`));
      expect(provenance, `${field} must not be required`).not.toMatch(new RegExp(`\\b${field}:`));
    }
    // ChunkRecord, StoredChunk and Citation get them from the shared type instead of declaring their own required copies.
    for (const file of ["document.ts", "retrieval.ts"]) {
      expect(fs.readFileSync(path.join(SRC, "core", file), "utf-8")).not.toMatch(/\bpage(Start|End): number/);
    }
  });
});
