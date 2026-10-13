import { describe, expect, it } from "vitest";
import { APP_ERROR_CODES, OverloadedError } from "../../src/shared/errors.js";
import { toSafeError } from "../../src/shared/safe-error.js";

describe("the overload error in log serialization", () => {
  it("is a registered application code", () => {
    expect(APP_ERROR_CODES).toContain("OVERLOADED");
  });

  it("is logged by its class name and code only, as an application rejection", () => {
    expect(toSafeError(new OverloadedError())).toEqual({ category: "application", type: "OverloadedError", code: "OVERLOADED" });
  });
});
