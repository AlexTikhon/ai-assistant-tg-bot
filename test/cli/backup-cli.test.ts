import { describe, expect, it } from "vitest";
import { BACKUP_USAGE, defaultBackupDirectory, formatBackupSummary, formatVerification, parseBackupArgs, parseVerifyArgs, VERIFY_USAGE } from "../../src/cli/backup-cli.js";

describe("parseBackupArgs", () => {
  it("--output sets the directory", () => {
    expect(parseBackupArgs(["--output", "./b/one"])).toEqual({ kind: "run", output: "./b/one" });
  });

  it("without --output a timestamped directory under ./backups is used", () => {
    const command = parseBackupArgs([]);

    expect(command).toEqual({ kind: "run", output: undefined });
    expect(defaultBackupDirectory(new Date("2026-03-10T12:34:56.000Z"))).toMatch(/backups[\\/]bot-backup-20260310-123456$/);
  });

  it("help and unknown options", () => {
    expect(parseBackupArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseBackupArgs(["--nope"]).kind).toBe("error");
    expect(parseBackupArgs(["--output"]).kind).toBe("error");
    expect(BACKUP_USAGE).toMatch(/never includes/i);
    expect(BACKUP_USAGE).toMatch(/\.env/);
  });
});

describe("parseVerifyArgs", () => {
  it("takes the backup directory as the only argument", () => {
    expect(parseVerifyArgs(["./backups/one"])).toEqual({ kind: "run", directory: "./backups/one" });
    expect(parseVerifyArgs([]).kind).toBe("error");
    expect(parseVerifyArgs(["a", "b"]).kind).toBe("error");
    expect(parseVerifyArgs(["--help"])).toEqual({ kind: "help" });
    expect(VERIFY_USAGE).toMatch(/read-only|does not modify/i);
  });
});

describe("formatting", () => {
  const manifest = {
    formatVersion: 1,
    createdAt: "2026-03-10T12:00:00.000Z",
    application: { name: "telegram-rag-bot", version: "1.0.0" },
    schemaVersion: 7,
    database: { file: "app.db" as const, bytes: 4096, sha256: "a".repeat(64) },
    counts: { documents: 2, chunks: 30, files: 2 },
    files: [],
    missingFiles: ["gone.txt"],
    indexProfiles: [],
  };

  it("summarises a created backup, including originals that were already missing", () => {
    const text = formatBackupSummary("./out", manifest);

    expect(text).toContain("./out");
    expect(text).toContain("2 documents");
    expect(text).toContain("1 original file was already missing");
    expect(text).toMatch(/npm run backup:verify/);
  });

  it("prints problems first and a clear verdict", () => {
    const bad = formatVerification({ ok: false, problems: ["File hash mismatch: x"], warnings: ["w"], manifest, checked: { documents: 2, files: 2 } });
    const good = formatVerification({ ok: true, problems: [], warnings: [], manifest, checked: { documents: 2, files: 2 } });

    expect(bad).toContain("PROBLEMS");
    expect(bad).toContain("File hash mismatch: x");
    expect(bad).toContain("NOT OK");
    expect(good).toContain("Backup OK");
  });
});
