import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAdapter } from "./adapter";
import type { FamilyResolver } from "./families";
import { OpenCodeAdapter, mainAuthPath } from "./opencode";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore } from "./state";

const AGENT = "agent-1";

let root: string;
let previousHome: string | undefined;
let previousDataHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-opencode-service-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root; // credentials and state land here, never in the real ~/.paseo
  previousDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(root, "data");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ usage: { rolling: { status: "ok", percent: 5 } } }), { status: 200 })),
  );
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

function stubAdapter(family: "claude" | "codex"): FamilyAdapter {
  return {
    family,
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async () => undefined,
    env: async () => ({}),
    identity: async () => ({ signedIn: false, email: null, plan: null, organization: null, identity: null }),
    usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
    login: async () => {
      throw new Error("not in tests");
    },
    logout: async () => undefined,
    detectLimit: () => null,
    detectSignOut: () => null,
  } as unknown as FamilyAdapter;
}

function fakePaseo() {
  const patches: unknown[] = [];
  const paseo = {
    config: {
      get: async () => ({ config: { providers: {} } }),
      patch: async (patch: unknown) => void patches.push(patch),
    },
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }) },
  };
  return { paseo, patches };
}

async function setUp() {
  const store = new StateStore(join(root, "state.json"));
  const fake = fakePaseo();
  const service = new Service(
    { claude: stubAdapter("claude"), codex: stubAdapter("codex"), opencode: new OpenCodeAdapter() },
    store,
    { resolve: async () => ({ opencode: "opencode" as const }) } as unknown as FamilyResolver,
    { locate: async () => "/usr/local/bin/paseo", reopen: async () => ({ ok: true as const }) } as unknown as Reopener,
  );
  return { service, store, fake };
}

describe("OpenCode accounts", () => {
  it("keeps the keys in the account's own home and runs sessions on them", async () => {
    const { service, store, fake } = await setUp();
    const accountId = await service.addOpenCodeAccount({ goKey: "sk-test-key", label: "Work" });

    const state = await store.read();
    const account = state.accounts.find((entry) => entry.id === accountId);
    expect(account?.family).toBe("opencode");
    expect(account?.label).toBe("Work");
    expect(account?.home).toBeTruthy();

    const stored = JSON.parse(await readFile(join(account?.home ?? "", "auth.json"), "utf8")) as Record<
      string,
      { key?: string }
    >;
    expect(stored["opencode-go"]?.key).toBe("sk-test-key");

    const request = await service.onSessionOpen(
      { agentId: AGENT, provider: "opencode", reason: "create", purpose: "interactive", env: {} } as never,
      { paseo: fake.paseo } as never,
    );
    const content = JSON.parse(String(request?.env?.OPENCODE_AUTH_CONTENT)) as Record<string, { key?: string }>;
    expect(content["opencode-go"]?.key).toBe("sk-test-key");
  });

  it("refuses a key that is already added", async () => {
    const { service } = await setUp();
    await service.addOpenCodeAccount({ goKey: "sk-test-key" });
    await expect(service.addOpenCodeAccount({ goKey: "sk-test-key" })).rejects.toThrow(/already added/i);
  });

  it("refuses an empty account", async () => {
    const { service } = await setUp();
    await expect(service.addOpenCodeAccount({})).rejects.toThrow(/at least one API key/i);
  });

  it("lists the account with its own usage windows", async () => {
    const { service, fake } = await setUp();
    await service.addOpenCodeAccount({ goKey: "sk-test-key" });
    const view = await service.view(fake.paseo as never);
    const account = view.accounts.find((entry) => entry.family === "opencode");
    expect(account?.status).toBe("ready");
    expect(account?.plan).toBe("Go");
  });

  it("replaces the key of the user's own OpenCode login, keeping their other keys", async () => {
    const { service, store } = await setUp();
    await mkdir(join(mainAuthPath(), ".."), { recursive: true });
    await writeFile(
      mainAuthPath(),
      JSON.stringify({ "opencode-go": { type: "api", key: "sk-old" }, anthropic: { type: "api", key: "sk-old" } }),
    );
    await store.update((draft) => {
      draft.accounts.push({
        id: MAIN_ACCOUNT_ID.opencode,
        family: "opencode",
        label: "OpenCode (CLI login)",
        autoLabel: false,
        kind: "main",
        home: null,
        email: null,
        plan: null,
        organization: null,
        identity: null,
        signedIn: false,
        disabled: false,
        limitedUntil: null,
        limitKind: null,
        limitedAt: null,
        vertex: null,
        createdAt: new Date().toISOString(),
      });
    });
    await service.addOpenCodeAccount({ goKey: "sk-new-key", accountId: MAIN_ACCOUNT_ID.opencode });

    const auth = JSON.parse(await readFile(mainAuthPath(), "utf8")) as Record<string, { key?: string }>;
    expect(auth["opencode-go"]?.key).toBe("sk-new-key");
    expect(auth.anthropic?.key).toBe("sk-old");
    const account = (await store.read()).accounts.find((entry) => entry.id === MAIN_ACCOUNT_ID.opencode);
    expect(account?.signedIn).toBe(true);
  });
});
