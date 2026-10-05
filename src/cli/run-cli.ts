import { classifyDatabaseError } from "../infrastructure/sqlite/database.js";
import { describeErrorSafely } from "../shared/scrub.js";

/** What a command-line tool prints when it fails: one scrubbed line, and - for a damaged database - what to do about it. Never a stack trace. */
export function formatCliFailure(error: unknown) {
  const advice = classifyDatabaseError(error).advice;
  return advice ? `${describeErrorSafely(error)}\n${advice}` : describeErrorSafely(error);
}

/**
 * The shared end of every operational command: the exit code is the command's result, and an unexpected failure is printed
 * scrubbed (tokens and keys removed) with exit code 1.
 */
export function runCli(main: () => Promise<number>) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(formatCliFailure(error));
      process.exitCode = 1;
    },
  );
}
