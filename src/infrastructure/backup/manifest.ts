import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { z } from "zod";

/** Layout of a backup directory: `manifest.json`, `app.db` and `files/<storedName>`. Nothing else, ever. */
export const MANIFEST_FILE = "manifest.json";
export const DATABASE_FILE = "app.db";
export const FILES_DIRECTORY = "files";

/** The `application.name` every backup of this application carries; a backup of something else is refused. */
export const APPLICATION_NAME = "telegram-rag-bot";

/**
 * The backup format version (`formatVersion` in the manifest): the layout of the directory and the meaning of the manifest.
 * Bump it when either changes incompatibly. It is NOT the database schema: the schema version inside the manifest
 * (`schemaVersion`) says how the database inside is shaped, and an older schema is migrated on restore.
 */
export const BACKUP_FORMAT_VERSION = 1;

/** The oldest format this version can still read. Formats from here up to BACKUP_FORMAT_VERSION are supported. */
const MIN_SUPPORTED_BACKUP_FORMAT = 1;

export type BackupFormatSupport =
  /** Readable. (An older database schema inside is a separate matter: it is migrated on the restore candidate.) */
  | { kind: "supported" }
  /** Written by a newer application: its layout may mean something this version does not know. Never guessed at. */
  | { kind: "newer"; message: string }
  /** Older than the oldest layout this version reads. */
  | { kind: "too-old"; message: string };

export function classifyBackupFormat(formatVersion: number): BackupFormatSupport {
  if (formatVersion > BACKUP_FORMAT_VERSION) {
    return { kind: "newer", message: `The backup format version ${formatVersion} is newer than this application understands (${BACKUP_FORMAT_VERSION}). Use the version of the application that made it, or a newer one.` };
  }
  if (formatVersion < MIN_SUPPORTED_BACKUP_FORMAT) {
    return { kind: "too-old", message: `The backup format version ${formatVersion} is older than the oldest this application can read (${MIN_SUPPORTED_BACKUP_FORMAT}).` };
  }
  return { kind: "supported" };
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "must be a SHA-256 hex digest");
const count = z.number().int().nonnegative();

const manifestSchema = z.object({
  formatVersion: z.number().int().positive(),
  createdAt: z.string(),
  application: z.object({ name: z.string(), version: z.string() }),
  /** `PRAGMA user_version` of the snapshot. */
  schemaVersion: count,
  database: z.object({ file: z.literal(DATABASE_FILE), bytes: count, sha256 }),
  counts: z.object({ documents: count, chunks: count, files: count }),
  /** Every original file included in the backup. */
  files: z.array(z.object({ storedName: z.string().min(1), bytes: count, sha256 })),
  /** Files the snapshot refers to that were already gone from storage when the backup was made. */
  missingFiles: z.array(z.string()),
  /** The index recipes in use, with how many documents each. fingerprint null: indexed before recipes were recorded. */
  indexProfiles: z.array(z.object({ fingerprint: z.string().nullable(), profile: z.unknown().nullable(), documents: count })),
});

export type BackupManifest = z.infer<typeof manifestSchema>;

/** Parses and validates manifest text; the error says what is wrong. */
export function parseManifest(text: string): BackupManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("the manifest is not valid JSON");
  }

  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`the manifest is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** SHA-256 of a file, streamed (a backup can contain large files). */
export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}
