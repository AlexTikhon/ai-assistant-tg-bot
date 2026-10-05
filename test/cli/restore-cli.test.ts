import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatRestoreError, formatRestoreReport, parseRestoreArgs, RESTORE_USAGE, targetFor } from "../../src/cli/restore-cli.js";
import { RestoreError } from "../../src/infrastructure/backup/restore-backup.js";
import type { RestoreReport } from "../../src/infrastructure/backup/restore-backup.js";

describe("parseRestoreArgs", () => {
  it("requires explicit opt-in to restore an incomplete backup", () => {
    expect(parseRestoreArgs(["--from", "b", "--allow-incomplete"])).toMatchObject({ kind: "run", from: "b", allowIncomplete: true });
  });

  it("requires --from and is not destructive by default", () => {
    expect(parseRestoreArgs(["--from", "backups/b1"])).toEqual({ kind: "run", from: "backups/b1", target: undefined, replaceExisting: false, discardPrevious: false, dryRun: false });
  });

  it("reads every option", () => {
    expect(parseRestoreArgs(["--from", "b", "--target", "other", "--replace-existing", "--discard-previous", "--dry-run"])).toEqual({
      kind: "run",
      from: "b",
      target: "other",
      replaceExisting: true,
      discardPrevious: true,
      dryRun: true,
    });
  });

  it("refuses to run without --from, and does not guess a positional argument", () => {
    expect(parseRestoreArgs([])).toMatchObject({ kind: "error", message: expect.stringMatching(/--from/) });
    expect(parseRestoreArgs(["backups/b1"])).toMatchObject({ kind: "error", message: expect.stringMatching(/--from/) });
  });

  it("--discard-previous alone is an error: deleting the replaced installation needs the replacement to be intended", () => {
    expect(parseRestoreArgs(["--from", "b", "--discard-previous"])).toMatchObject({ kind: "error" });
  });

  it("rejects unknown options and answers --help", () => {
    expect(parseRestoreArgs(["--from", "b", "--force"]).kind).toBe("error");
    expect(parseRestoreArgs(["--help"]).kind).toBe("help");
  });

  it("the usage explains the safety rules", () => {
    expect(RESTORE_USAGE).toMatch(/--replace-existing/);
    expect(RESTORE_USAGE).toMatch(/KEPT/);
    expect(RESTORE_USAGE).toMatch(/Stop the bot/);
  });
});

describe("formatting", () => {
  const report: RestoreReport = { outcome: "restored", schema: { backup: 8, restored: 9 }, documents: 2, chunks: 7, files: 2, warnings: ["something to know"], live: "populated", requiresReplaceExisting: true, previousInstallation: ".restore-previous-1" };

  it("summarises a restore, the migration, the kept installation and warnings", () => {
    const text = formatRestoreReport(report);

    expect(text).toContain("Restored 2 documents, 7 chunks, 2 original files.");
    expect(text).toContain("migrated from version 8 to 9");
    expect(text).toContain(".restore-previous-1");
    expect(text).toContain("something to know");
  });

  it("a dry run says nothing was changed and whether the flag would be needed", () => {
    expect(formatRestoreReport({ ...report, outcome: "rehearsed" })).toMatch(/Dry run.*Nothing was changed[\s\S]*needs --replace-existing/);
  });

  it("an error lists every problem", () => {
    const text = formatRestoreError(new RestoreError("verify", "The backup did not pass verification; nothing was changed.", ["File hash mismatch: a", "Missing: b"]));

    expect(text).toContain("Restore stopped (verify)");
    expect(text).toContain("- File hash mismatch: a");
    expect(text).toContain("- Missing: b");
  });

  it("--target uses the same layout as DATA_DIR", () => {
    const target = targetFor("somewhere/data");

    expect(target.sqlitePath).toBe(path.join(path.resolve("somewhere/data"), "app.db"));
    expect(target.filesDir).toBe(path.join(path.resolve("somewhere/data"), "files"));
  });
});
