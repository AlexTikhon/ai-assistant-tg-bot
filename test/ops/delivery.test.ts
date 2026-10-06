import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * Static checks of everything that is delivered with the code: package.json, the Dockerfile and its build context, compose, the CI workflow,
 * Dependabot and the documentation's references. They cannot run Docker or GitHub Actions - CI does that - but they keep these files honest
 * and consistent with each other, and make a regression in any of the safety properties fail here, locally, in seconds.
 */
const ROOT = path.join(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf-8").replace(/\r\n/g, "\n");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; engines: { node: string }; dependencies: Record<string, string> };
const workflow = parse(read(".github/workflows/ci.yml")) as {
  on: { push: { branches: string[] }; pull_request: unknown };
  permissions: Record<string, string>;
  jobs: Record<string, { strategy?: { matrix: { node: number[] } }; steps: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown>; "continue-on-error"?: boolean }>; needs?: string | string[] }>;
};
const dockerfile = read("Dockerfile");

const supportedMajors = [...pkg.engines.node.matchAll(/\^(\d+)\./g)].map((match) => Number(match[1]));
const stepsOf = (job: string) => workflow.jobs[job].steps;
const commandsOf = (job: string) => stepsOf(job).map((step) => step.run ?? "");

describe("runtime contract", () => {
  it("package.json declares exactly the Node versions CI tests, and .nvmrc and the Dockerfile use the newest of them", () => {
    expect(supportedMajors).toEqual([22, 24]);
    expect([...workflow.jobs.verify.strategy!.matrix.node].sort()).toEqual([...supportedMajors].sort());
    expect(read(".nvmrc").trim()).toBe(String(Math.max(...supportedMajors)));
    expect(dockerfile).toMatch(new RegExp(`^FROM node:${Math.max(...supportedMajors)}-bookworm-slim AS (build|runtime)$`, "gm"));
  });

  it("production start runs compiled JavaScript, never tsx or ts-node", () => {
    expect(pkg.scripts.start).toBe("node --enable-source-maps dist/index.js"); // stack traces point at the TypeScript source
    expect(pkg.scripts.start).not.toMatch(/tsx|ts-node/);
    expect(dockerfile).toMatch(/^CMD \["node", "--enable-source-maps", "dist\/index\.js"\]$/m);
    expect(pkg.dependencies).not.toHaveProperty("tsx");
  });

  it("every operational command runs compiled code from dist; only development-only tooling (watch mode, evaluation, benchmark) uses tsx", () => {
    for (const name of ["smoke", "smoke:cli", "reindex", "integrity", "backup", "backup:verify", "restore", "diagnostics", "db:maintenance"]) {
      expect(pkg.scripts[name], name).toMatch(/^node dist\/cli\/[\w-]+\.js$/);
    }
    for (const name of ["dev", "eval:retrieval", "eval:confidence", "eval:retrieval:live", "eval:diff", "bench:retrieval", "test:retrieval"]) {
      expect(pkg.scripts[name], name).toMatch(/tsx/);
    }
  });

  it("the scripts that distinguish the lifecycle exist: dev, lint, typecheck, test, build, start, smoke", () => {
    for (const name of ["dev", "lint", "typecheck", "test", "build", "start", "smoke"]) expect(pkg.scripts).toHaveProperty(name);
  });

  it("`npm run check` is the pre-push command (static checks first, then tests, build and smoke); the release check adds the retrieval regression and the audit", () => {
    expect(pkg.scripts.check).toBe("npm run lint && npm run typecheck && npm test && npm run build && npm run smoke && npm run smoke:cli");
    expect(pkg.scripts["check:release"]).toMatch(/^npm run check && npm run test:retrieval && npm run eval:retrieval && npm run eval:confidence && npm audit --omit=dev$/);
  });

  it("every compiled command file the scripts point to is a source file of the build", () => {
    for (const script of Object.values(pkg.scripts)) {
      const target = /node (?:--\S+ )*dist\/(.+)\.js/.exec(script)?.[1];
      if (target) expect(fs.existsSync(path.join(ROOT, "src", `${target}.ts`)), script).toBe(true);
    }
  });
});

describe("Dockerfile", () => {
  const lines = dockerfile.split("\n").filter((line) => !line.trim().startsWith("#"));
  const instructions = (name: string) => lines.filter((line) => line.startsWith(`${name} `) || line === name);

  it("is a multi-stage build: dependencies and the compiler are in a build stage, the final image has the compiled code and production dependencies", () => {
    expect(instructions("FROM")).toHaveLength(2);
    expect(dockerfile).toMatch(/^FROM node:\d+-bookworm-slim AS build$/m);
    expect(dockerfile).toMatch(/^FROM node:\d+-bookworm-slim AS runtime$/m);
    expect(dockerfile).toMatch(/npm ci\b/);
    expect(dockerfile).toMatch(/npm run build/);
    expect(dockerfile).toMatch(/npm prune --omit=dev/);
    expect(dockerfile).toMatch(/COPY --from=build \/app\/dist \.\/dist/);
    expect(dockerfile).toMatch(/COPY --from=build \/app\/node_modules \.\/node_modules/);
  });

  it("runs as a non-root user: the last USER instruction is the unprivileged 'node' user, and the process never runs as root", () => {
    const users = instructions("USER");
    expect(users.length).toBeGreaterThan(0);
    expect(users.at(-1)).toBe("USER node");
    expect(users.some((line) => /USER\s+(root|0)\b/.test(line))).toBe(false);
    // The USER comes before the command that starts the process.
    expect(lines.findIndex((line) => line.startsWith("USER node"))).toBeLessThan(lines.findIndex((line) => line.startsWith("CMD")));
  });

  it("has one data root, a volume for it, owned by the runtime user, and no secret anywhere", () => {
    expect(dockerfile).toMatch(/DATA_DIR=\/data/);
    expect(dockerfile).toMatch(/VOLUME \["\/data"\]/);
    expect(dockerfile).toMatch(/chown node:node \/data/);
    expect(instructions("ENV").concat(instructions("ARG")).join("\n")).not.toMatch(/TOKEN|API_KEY|SECRET|PASSWORD/i);
    expect(dockerfile).not.toMatch(/COPY\s+\.\s+\.|COPY\s+\.env/);
  });

  it("stops on SIGTERM, is based on Debian slim (not Alpine/musl) because of the native SQLite module, and has no fake HEALTHCHECK", () => {
    expect(dockerfile).toMatch(/^STOPSIGNAL SIGTERM$/m);
    expect(lines.join("\n")).not.toMatch(/alpine|apk add/i);
    expect(instructions("HEALTHCHECK")).toEqual([]);
  });

  it("copies only what the build needs from the build context", () => {
    const copied = instructions("COPY").filter((line) => !line.includes("--from"));
    expect(copied.join("\n")).toBe(["COPY package.json package-lock.json ./", "COPY tsconfig.json tsconfig.build.json ./", "COPY src ./src", "COPY package.json ./"].join("\n"));
  });
});

describe(".dockerignore: the build context", () => {
  /** A small implementation of the .dockerignore rules this file uses: "**\/" any depth, "*" within a name, a directory excludes everything below it. */
  const patterns = read(".dockerignore").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  const regexFor = (pattern: string) =>
  // eslint-disable-next-line no-control-regex -- the NUL placeholder is deliberate: it can never occur in a pattern
    new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?")}$`);
  const ignored = (file: string) => {
    const parts = file.split("/");
    return parts.some((_, index) => patterns.some((pattern) => regexFor(pattern).test(parts.slice(0, index + 1).join("/"))));
  };

  it("keeps everything the image build reads", () => {
    for (const file of ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "src/index.ts", "src/cli/smoke.ts", "src/infrastructure/sqlite/migrations.ts", "src/shared/version.ts"]) {
      expect(ignored(file), file).toBe(false);
    }
  });

  it("keeps secrets, user data, backups, logs, dependencies and VCS data out, at any depth", () => {
    for (const file of [".env", ".env.local", ".env.production", "src/.env", ".env.example", "data/app.db", "data/files/a.pdf", "backups/b1/app.db", ".git/config", "node_modules/pino/index.js", "src/node_modules/x/y.js", "coverage/lcov.info", "server.log", "logs/app.log", "src/nested/debug.log", "certs/key.pem", "dist/index.js", ".vscode/settings.json"]) {
      expect(ignored(file), file).toBe(true);
    }
  });

  it("every file the build context would contain is either needed or harmless: no env file, database, log or key is part of it", () => {
    const all: string[] = [];
    const walk = (directory: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true })) {
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        if (["node_modules", ".git", "dist", "data", "coverage", "backups"].includes(entry.name) && !directory) continue;
        if (entry.isDirectory()) walk(relative);
        else all.push(relative);
      }
    };
    walk("");

    const context = all.filter((file) => !ignored(file));

    expect(context.filter((file) => /(^|\/)\.env|\.db(-wal|-shm)?$|\.log$|\.pem$|\.key$/.test(file))).toEqual([]);
    expect(context.sort()).toEqual(expect.arrayContaining(["package.json", "package-lock.json", "src/index.ts"]));
    expect(context.filter((file) => !/^(src\/|package(-lock)?\.json$|tsconfig(\.build)?\.json$|vitest\.config\.ts$|\.nvmrc$|LICENSE)/.test(file))).toEqual([]);
  });
});

describe("compose.yaml", () => {
  const compose = parse(read("compose.yaml")) as { services: Record<string, { env_file?: string; environment?: Record<string, string>; volumes?: string[]; restart?: string; init?: boolean; ports?: unknown }>; volumes: Record<string, unknown> };

  it("is one service with a named data volume, the env file, a restart policy - and no ports or invented services", () => {
    expect(Object.keys(compose.services)).toEqual(["bot"]);
    expect(compose.services.bot).toMatchObject({ env_file: ".env", restart: "unless-stopped", init: true, volumes: ["bot-data:/data"] });
    expect(compose.services.bot.ports).toBeUndefined();
    expect(Object.keys(compose.volumes)).toEqual(["bot-data"]);
  });

  it("pins DATA_DIR to the volume after the env file, so a development DATA_DIR in .env cannot move the data out of it", () => {
    expect(compose.services.bot.environment?.DATA_DIR).toBe("/data");
  });
});

describe("CI workflow", () => {
  const everyRun = Object.keys(workflow.jobs).flatMap((job) => commandsOf(job));
  const text = read(".github/workflows/ci.yml");

  it("runs on pull requests and on pushes to main only", () => {
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on).toHaveProperty("pull_request");
  });

  it("needs no secrets at all and gets read-only repository access", () => {
    expect(text).not.toMatch(/\$\{\{\s*secrets\./);
    expect(text).not.toMatch(/OPENAI|TELEGRAM|API_KEY|BOT_TOKEN/);
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("installs from the lockfile, with the npm cache keyed to it", () => {
    const verify = stepsOf("verify");
    expect(verify.some((step) => step.run === "npm ci")).toBe(true);
    const setupNode = verify.find((step) => step.uses?.startsWith("actions/setup-node"));
    expect(setupNode?.with).toMatchObject({ cache: "npm", "cache-dependency-path": "package-lock.json" });
    expect(everyRun.some((command) => /npm install\b/.test(command))).toBe(false);
  });

  it("runs the deterministic checks, in full, on every supported Node version", () => {
    const commands = commandsOf("verify");
    for (const command of ["npm run lint", "npm run typecheck", "npm run test", "npm run build", "npm run smoke", "npm run smoke:cli", "npm run test:retrieval", "npm run eval:retrieval", "npm run eval:confidence"]) {
      expect(commands, command).toContain(command);
    }
  });

  it("never runs the paid or credentialed commands", () => {
    expect(everyRun.join("\n")).not.toMatch(/eval:retrieval:live|--live|confirm-spend|npm run reindex(?! -- --dry-run)|start\b.*index/);
  });

  it("every npm script it invokes exists", () => {
    const names = [...everyRun.join("\n").matchAll(/npm run ([\w:-]+)/g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(8);
    for (const name of names) expect(pkg.scripts, name).toHaveProperty(name);
  });

  it("the audit policy: runtime dependencies fail the build, the full audit only reports, and `audit fix` is never run", () => {
    const security = stepsOf("security");
    expect(security.find((step) => step.run === "npm audit --omit=dev")?.["continue-on-error"]).toBeUndefined();
    expect(security.find((step) => step.run === "npm audit")?.["continue-on-error"]).toBe(true);
    expect(text).not.toMatch(/audit fix/);
  });

  it("coverage is a diagnostic: it is generated and published, never a gate", () => {
    expect(commandsOf("coverage")).toContain("npm run test:coverage");
    expect(read("vitest.config.ts")).not.toMatch(/thresholds\s*:/);
  });

  it("checks the Docker image: build, unprivileged user, writable data volume, no secrets in the image, container smoke tests", () => {
    const commands = commandsOf("docker").join("\n");
    expect(commands).toMatch(/docker build -t telegram-rag-bot:ci \./);
    expect(commands).toMatch(/id -u/);
    expect(commands).toMatch(/test "\$uid" != "0"/);
    expect(commands).toMatch(/-v ci-data:\/data/);
    expect(commands).toMatch(/node dist\/cli\/smoke\.js/);
    expect(commands).toMatch(/node dist\/cli\/smoke-cli\.js/);
    expect(commands).toMatch(/Invalid configuration/);
  });

  it("the artifact contains the compiled code and manifests - never .env, data, backups or coverage", () => {
    const assemble = commandsOf("package").join("\n");
    expect(assemble).toMatch(/cp -r dist package\.json package-lock\.json README\.md docs bundle\//);
    expect(assemble).not.toMatch(/\.env|data|backups|coverage/);
  });

  it("every action is pinned to a major version", () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) if (step.uses) expect(step.uses, step.uses).toMatch(/@v\d+$/);
    }
  });
});

describe("Dependabot", () => {
  const dependabot = parse(read(".github/dependabot.yml")) as { updates: Array<{ "package-ecosystem": string; schedule: { interval: string } }> };

  it("watches npm, GitHub Actions and the base image weekly, and merges nothing by itself", () => {
    expect(dependabot.updates.map((update) => update["package-ecosystem"]).sort()).toEqual(["docker", "github-actions", "npm"]);
    for (const update of dependabot.updates) expect(update.schedule.interval).toBe("weekly");
    expect(read(".github/dependabot.yml")).not.toMatch(/auto-?merge/i);
  });
});

describe("documentation names real commands", () => {
  const documents = ["README.md", "docs/operations.md", "docs/security.md", "docs/architecture.md", "docs/rag.md", "docs/evaluation.md", ".env.example"].filter((file) => fs.existsSync(path.join(ROOT, file)));

  it.each(documents)("%s only refers to npm scripts that exist", (file) => {
    const names = [...read(file).matchAll(/npm run ([\w:-]+)/g)].map((match) => match[1]);

    for (const name of names) expect(pkg.scripts, `${file}: npm run ${name}`).toHaveProperty(name);
  });

  it("the .gitignore keeps secrets, data, backups, coverage and build output out of the repository", () => {
    const ignore = read(".gitignore").split("\n").map((line) => line.trim());

    for (const entry of [".env", "/data", "/backups", "/coverage", "/dist", "/node_modules"]) expect(ignore, entry).toContain(entry);
  });
});
