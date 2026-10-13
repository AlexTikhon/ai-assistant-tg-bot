import { describe, expect, it } from "vitest";
import { loadConfig, loadCoreConfig, loadToolConfig } from "../../src/config/config.js";

const required = { TELEGRAM_BOT_TOKEN: "123456:ABCDEF", OPENAI_API_KEY: "sk-test" };

describe("expensive request admission settings", () => {
  it("defaults to 8 active requests overall and 2 per user", () => {
    expect(loadConfig(required).workload).toEqual({ maxActive: 8, maxPerUser: 2 });
  });

  it("reads both maxima", () => {
    const config = loadConfig({ ...required, MAX_ACTIVE_EXPENSIVE_REQUESTS: "20", MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER: "3" });

    expect(config.workload).toEqual({ maxActive: 20, maxPerUser: 3 });
  });

  it("accepts a per-user maximum equal to the global maximum", () => {
    const config = loadConfig({ ...required, MAX_ACTIVE_EXPENSIVE_REQUESTS: "1", MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER: "1" });

    expect(config.workload).toEqual({ maxActive: 1, maxPerUser: 1 });
  });

  it.each([
    ["MAX_ACTIVE_EXPENSIVE_REQUESTS", "0"],
    ["MAX_ACTIVE_EXPENSIVE_REQUESTS", "-1"],
    ["MAX_ACTIVE_EXPENSIVE_REQUESTS", "2.5"],
    ["MAX_ACTIVE_EXPENSIVE_REQUESTS", "many"],
    ["MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER", "0"],
    ["MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER", "-3"],
    ["MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER", "1.5"],
    ["MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER", "few"],
  ])("rejects %s=%s and names the variable", (name, value) => {
    expect(() => loadConfig({ ...required, [name]: value })).toThrow(new RegExp(name));
  });

  it("rejects a per-user maximum above the global maximum", () => {
    expect(() => loadConfig({ ...required, MAX_ACTIVE_EXPENSIVE_REQUESTS: "2", MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER: "3" })).toThrow(
      /MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER/,
    );
  });

  it("rejects a per-user maximum above the default global maximum", () => {
    expect(() => loadConfig({ ...required, MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER: "9" })).toThrow(/MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER/);
  });

  it("is a bot-only setting: tools and the core neither read nor validate it", () => {
    const invalid = { MAX_ACTIVE_EXPENSIVE_REQUESTS: "0", MAX_ACTIVE_EXPENSIVE_REQUESTS_PER_USER: "nope" };

    expect(() => loadToolConfig(invalid)).not.toThrow();
    expect(() => loadCoreConfig(invalid)).not.toThrow();
    expect(loadCoreConfig({})).not.toHaveProperty("workload");
    expect(loadToolConfig({})).not.toHaveProperty("workload");
  });
});
