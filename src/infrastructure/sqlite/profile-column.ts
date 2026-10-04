import { z } from "zod";
import { indexFingerprint } from "../../core/index-profile.js";
import type { StoredIndexProfile } from "../../core/index-profile.js";

const profileSchema = z.object({
  embeddingModel: z.string(),
  embeddingDimension: z.number().int().nonnegative(),
  chunkSize: z.number().int().positive().nullable(),
  chunkOverlap: z.number().int().nonnegative().nullable(),
  chunkingVersion: z.number().int(),
  extractorVersion: z.string(),
});

/** SQL parameters for the two profile columns of `documents`. */
export function profileColumns(profile: StoredIndexProfile | null | undefined) {
  return profile
    ? { indexProfile: JSON.stringify(profile), indexFingerprint: indexFingerprint(profile) }
    : { indexProfile: null, indexFingerprint: null };
}

/** The recorded profile, or null when the column is empty or unreadable (treated as "not recorded"). */
export function parseProfileColumn(json: string | null): StoredIndexProfile | null {
  if (json === null) {
    return null;
  }
  try {
    const parsed = profileSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
