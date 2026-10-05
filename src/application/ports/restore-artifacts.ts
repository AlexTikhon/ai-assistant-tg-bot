/**
 * What `npm run restore` leaves in the data directory while it works, or after it stopped half way.
 *
 * - staging: the candidate being prepared. It exists only while a restore runs; one that is old was interrupted (a crash, a kill).
 * - previous-installation: the installation a successful restore replaced, kept so the operator can go back. Removing it is
 *   always the operator's decision.
 */
export type RestoreArtifact = {
  name: string;
  kind: "staging" | "previous-installation";
  modifiedAtMs: number;
};

export interface RestoreArtifacts {
  list(): Promise<RestoreArtifact[]>;
  /** Removes one artifact (and only an artifact) by the name `list` returned. */
  remove(name: string): Promise<void>;
}
