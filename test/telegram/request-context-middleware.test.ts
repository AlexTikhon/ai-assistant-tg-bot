import type { Context } from "telegraf";
import { describe, expect, it } from "vitest";
import { currentRequestId } from "../../src/shared/request-context.js";
import { requestContext } from "../../src/telegram/middleware.js";

describe("requestContext middleware", () => {
  it("gives each update its own id for as long as the handler runs", async () => {
    const seen: Array<string | undefined> = [];
    const handler = async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      seen.push(currentRequestId());
    };

    await Promise.all([requestContext({} as Context, handler), requestContext({} as Context, handler)]);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^[0-9a-f]{8}$/);
    expect(seen[0]).not.toBe(seen[1]);
    expect(currentRequestId()).toBeUndefined();
  });
});
