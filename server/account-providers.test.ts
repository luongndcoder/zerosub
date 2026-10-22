import { describe, expect, it } from "vitest";
import { accountForProvider, desiredAccountProviders, planAccountProviders } from "./account-providers";
import { emptyState, type StoredState } from "./state";

const state: StoredState = {
  ...emptyState(),
  accounts: [
    { id: "claude-main", family: "claude", label: "me", kind: "main", home: null } as never,
    { id: "codex-main", family: "codex", label: "team", kind: "main", home: null } as never,
  ],
};

describe("account providers", () => {
  it("maps a ZeroSub provider ID back to its account", () => {
    expect(accountForProvider(state, "zs-codex-main")?.id).toBe("codex-main");
    expect(accountForProvider(state, "claude")).toBeUndefined();
    expect(accountForProvider(state, "zs-claude-gone")).toBeUndefined();
  });

  it("only adds what's missing or changed, and only removes its own stale profiles", () => {
    const desired = desiredAccountProviders(state, true);
    const current = {
      "zs-claude-main": desired["zs-claude-main"],
      "zs-claude-removed": { extends: "claude", label: "Claude · old" },
      "be-claude-worker": { extends: "claude", label: "BE Worker · Claude" },
    };
    expect(planAccountProviders(current, desired)).toEqual({
      upsert: { "zs-codex-main": desired["zs-codex-main"] },
      remove: ["zs-claude-removed"],
    });
  });

  it("removes every ZeroSub profile when turned off", () => {
    expect(planAccountProviders({ "zs-claude-main": {}, codex: {} }, desiredAccountProviders(state, false))).toEqual({
      upsert: {},
      remove: ["zs-claude-main"],
    });
  });
});
