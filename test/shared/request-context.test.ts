import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/shared/logger.js";
import { currentRequestId, newRequestId, runWithRequestId } from "../../src/shared/request-context.js";

function capture() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({ write: (line: string) => void lines.push(JSON.parse(line)) }, "info");
  return { logger, lines };
}

describe("request ids", () => {
  it("are short, opaque and different every time", () => {
    const ids = new Set(Array.from({ length: 200 }, newRequestId));

    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("are available to everything running inside the operation, across awaits", async () => {
    await runWithRequestId("aaaa1111", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(currentRequestId()).toBe("aaaa1111");
    });
    expect(currentRequestId()).toBeUndefined();
  });

  it("do not leak between concurrent operations", async () => {
    const seen: string[] = [];
    const operation = (id: string, delay: number) =>
      runWithRequestId(id, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        seen.push(`${id}:${currentRequestId()}`);
      });

    await Promise.all([operation("11111111", 20), operation("22222222", 1)]);

    expect(seen.sort()).toEqual(["11111111:11111111", "22222222:22222222"]);
  });
});

describe("logger correlation", () => {
  it("adds the request id to every line logged inside an operation, including child loggers", () => {
    const { logger, lines } = capture();

    runWithRequestId("abcd1234", () => {
      logger.info("first");
      logger.child({ operation: "ingestDocument" }).info("second");
    });
    logger.info("outside");

    expect(lines.map((line) => line.requestId)).toEqual(["abcd1234", "abcd1234", undefined]);
  });

  it("still scrubs secrets from errors", () => {
    const { logger, lines } = capture();

    runWithRequestId("abcd1234", () => logger.error({ err: new Error("failed with key sk-abcdefghijklmnopqrstuvwx") }, "boom"));

    expect(JSON.stringify(lines[0])).not.toContain("sk-abcdefghijklmnop");
  });
});
