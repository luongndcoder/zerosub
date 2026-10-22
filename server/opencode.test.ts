import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTimelineItem } from "./adapter";
import {
  OpenCodeAdapter,
  accountAuthPath,
  credentialFingerprint,
  mainAuthPath,
  parseAuth,
  parseGoUsage,
  planOf,
  writeCredentials,
} from "./opencode";

let root: string;
let dataHome: string;
let previousDataHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-opencode-"));
  dataHome = join(root, "data");
  previousDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dataHome;
});

afterEach(async () => {
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  await rm(root, { recursive: true, force: true });
});

async function writeMainAuth(value: unknown): Promise<void> {
  const path = mainAuthPath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}

describe("parseAuth", () => {
  it("keeps credentials and drops anything else", () => {
    expect(
      parseAuth({
        "opencode-go": { type: "api", key: "sk-go" },
        "opencode": { type: "oauth", refresh: "r", access: "a" },
        broken: { type: "api" },
        other: "nope",
      }),
    ).toEqual({
      "opencode-go": { type: "api", key: "sk-go" },
      opencode: { type: "oauth", refresh: "r", access: "a" },
    });
    expect(parseAuth(null)).toEqual({});
  });
});

describe("credentialFingerprint", () => {
  it("is the same for the same keys and different for other keys", () => {
    const a = { "opencode-go": { type: "api", key: "sk-one" } };
    expect(credentialFingerprint(a)).toBe(credentialFingerprint({ "opencode-go": { type: "api", key: "sk-one" } }));
    expect(credentialFingerprint(a)).not.toBe(credentialFingerprint({ "opencode-go": { type: "api", key: "sk-two" } }));
    expect(credentialFingerprint(a)).not.toContain("sk-one");
  });
});

describe("planOf", () => {
  it("calls a Go key Go and a Zen key Zen", () => {
    expect(planOf({ "opencode-go": { type: "api", key: "sk" } })).toBe("Go");
    expect(planOf({ opencode: { type: "api", key: "sk" } })).toBe("Zen");
    expect(planOf({ anthropic: { type: "api", key: "sk" } })).toBeNull();
  });
});

describe("parseGoUsage", () => {
  it("turns the three windows into usage windows", () => {
    const usage = parseGoUsage({
      usage: {
        rolling: { status: "ok", percent: 12, resetsAt: "2026-10-01T00:00:00.000Z" },
        weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-10-05T00:00:00.000Z" },
      },
    });
    expect(usage.windows.map((window) => window.id)).toEqual(["rolling", "weekly"]);
    expect(usage.windows[0]?.usedPercent).toBe(12);
    expect(usage.rateLimited).toBe(true);
  });
});

describe("OpenCodeAdapter.env", () => {
  it("leaves the user's own login alone", async () => {
    const adapter = new OpenCodeAdapter();
    expect(await adapter.env(null)).toEqual({});
  });

  it("runs the session on the account's keys, and keeps the user's other providers", async () => {
    await writeMainAuth({ "opencode-go": { type: "api", key: "sk-main" }, anthropic: { type: "api", key: "sk-ant" } });
    const home = join(root, "home");
    await writeCredentials(home, { "opencode-go": { type: "api", key: "sk-account" } });
    const patch = await new OpenCodeAdapter().env(home);
    const content = JSON.parse(String(patch.OPENCODE_AUTH_CONTENT)) as Record<string, { key?: string }>;
    expect(content["opencode-go"]?.key).toBe("sk-account");
    expect(content.anthropic?.key).toBe("sk-ant");
  });

  it("keeps the account's keys in the account's own home", async () => {
    const home = join(root, "home");
    await writeCredentials(home, { "opencode-go": { type: "api", key: "sk-account" } });
    const stored = JSON.parse(await readFile(accountAuthPath(home), "utf8")) as Record<string, { key?: string }>;
    expect(stored["opencode-go"]?.key).toBe("sk-account");
  });
});

describe("OpenCodeAdapter.usage", () => {
  it("reads the OpenCode Go windows", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          usage: {
            rolling: { status: "ok", percent: 30, resetsAt: "2026-10-01T00:00:00.000Z" },
            weekly: { status: "ok", percent: 55, resetsAt: "2026-10-05T00:00:00.000Z" },
            monthly: { status: "ok", percent: 70, resetsAt: "2026-11-01T00:00:00.000Z" },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const home = join(root, "home");
    await writeCredentials(home, { "opencode-go": { type: "api", key: "sk-account" } });
    const usage = await new OpenCodeAdapter().usage(home);
    expect(usage.windows.map((window) => window.id)).toEqual(["rolling", "weekly", "monthly"]);
    expect(usage.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it("says so when the account has no OpenCode Go key", async () => {
    const home = join(root, "home");
    await writeCredentials(home, { anthropic: { type: "api", key: "sk-ant" } });
    const usage = await new OpenCodeAdapter().usage(home);
    expect(usage.windows).toEqual([]);
    expect(usage.error).toMatch(/no OpenCode Go key/i);
  });
});

describe("OpenCodeAdapter.identity", () => {
  it("reads the account as signed out when it has no keys", async () => {
    const identity = await new OpenCodeAdapter().identity(join(root, "missing"));
    expect(identity.signedIn).toBe(false);
  });

  it("reads a Go key as signed out when OpenCode Go rejects it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const home = join(root, "home");
    await writeCredentials(home, { "opencode-go": { type: "api", key: "sk-bad" } });
    const identity = await new OpenCodeAdapter().identity(home);
    expect(identity.signedIn).toBe(false);
    vi.unstubAllGlobals();
  });

  it("reads a Go key as signed in when OpenCode Go accepts it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ usage: {} }), { status: 200 })),
    );
    const home = join(root, "home");
    await writeCredentials(home, { "opencode-go": { type: "api", key: "sk-good" } });
    const identity = await new OpenCodeAdapter().identity(home);
    expect(identity.signedIn).toBe(true);
    expect(identity.plan).toBe("Go");
    vi.unstubAllGlobals();
  });
});

describe("OpenCode limit detection", () => {
  const error = (message: string): AgentTimelineItem => ({ type: "error", message });

  it("spots a rate limit in a failed turn", async () => {
    const { detectOpenCodeLimit } = await import("./limits");
    const hit = detectOpenCodeLimit({
      outcome: { kind: "failed", error: { message: "Request failed with status 429" } },
      timeline: [],
    });
    expect(hit?.kind).toBe("window");
  });

  it("spots a rejected key", async () => {
    const { detectOpenCodeSignOut } = await import("./limits");
    const message = detectOpenCodeSignOut({
      outcome: { kind: "failed", error: { message: "Authentication error: invalid_api_key" } },
      timeline: [error("401 unauthorized")],
    });
    expect(message).toBeTruthy();
  });

  it("spots the credential error OpenCode reports", async () => {
    const { detectOpenCodeSignOut } = await import("./limits");
    const message = detectOpenCodeSignOut({
      outcome: { kind: "failed", error: { message: "Upstream request failed: Invalid credential" } },
      timeline: [],
    });
    expect(message).toBe("Upstream request failed: Invalid credential");
  });

  it("leaves ordinary replies alone", async () => {
    const { detectOpenCodeLimit } = await import("./limits");
    const hit = detectOpenCodeLimit({
      outcome: { kind: "completed" },
      timeline: [{ type: "assistant_message", text: "The API returned 429 last time, so I retried." }],
    });
    expect(hit).toBeNull();
  });
});
