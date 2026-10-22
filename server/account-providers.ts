import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { FAMILY_LABEL, type Family } from "../shared/model";
import { findAccount, type StoredAccount, type StoredState } from "./state";

type PaseoApi = PluginHandlerContext["paseo"];

/**
 * Every account also shows up as its own provider in Paseo's new-agent picker ("Claude · work"), so
 * a session can start on a chosen account. Profiles ZeroSub owns carry this prefix; it never touches
 * provider entries without it.
 */
export const ACCOUNT_PROVIDER_PREFIX = "zs-";

export interface AccountProviderProfile {
  extends: Family;
  label: string;
  description: string;
}

export function accountProviderId(account: Pick<StoredAccount, "id">): string {
  return `${ACCOUNT_PROVIDER_PREFIX}${account.id}`;
}

/** The account a ZeroSub provider profile stands for, if `provider` is one. */
export function accountForProvider(state: StoredState, provider: string): StoredAccount | undefined {
  if (!provider.startsWith(ACCOUNT_PROVIDER_PREFIX)) return undefined;
  return findAccount(state, provider.slice(ACCOUNT_PROVIDER_PREFIX.length));
}

export function desiredAccountProviders(state: StoredState, enabled: boolean): Record<string, AccountProviderProfile> {
  if (!enabled) return {};
  const profiles: Record<string, AccountProviderProfile> = {};
  for (const account of state.accounts) {
    profiles[accountProviderId(account)] = {
      extends: account.family,
      label: `${FAMILY_LABEL[account.family]} · ${account.label}`,
      description: `ZeroSub: new agents start on ${account.label}`,
    };
  }
  return profiles;
}

/** What to add or update and what to remove so the config matches `desired`. */
export function planAccountProviders(
  current: Record<string, unknown> | undefined,
  desired: Record<string, AccountProviderProfile>,
): { upsert: Record<string, AccountProviderProfile>; remove: string[] } {
  const existing = current ?? {};
  const upsert: Record<string, AccountProviderProfile> = {};
  for (const [id, profile] of Object.entries(desired)) {
    const entry = existing[id] as Partial<AccountProviderProfile> | undefined;
    if (!entry || entry.extends !== profile.extends || entry.label !== profile.label || entry.description !== profile.description) {
      upsert[id] = profile;
    }
  }
  const remove = Object.keys(existing).filter((id) => id.startsWith(ACCOUNT_PROVIDER_PREFIX) && !(id in desired));
  return { upsert, remove };
}

/** Brings the daemon's provider profiles in line with the accounts. True when it changed anything. */
export async function syncAccountProviders(paseo: PaseoApi, state: StoredState, enabled: boolean): Promise<boolean> {
  const { config } = await paseo.config.get();
  const current = config.providers as Record<string, unknown> | undefined;
  const { upsert, remove } = planAccountProviders(current, desiredAccountProviders(state, enabled));
  if (Object.keys(upsert).length === 0 && remove.length === 0) return false;
  await paseo.config.patch({
    ...(Object.keys(upsert).length > 0 ? { providers: upsert } : {}),
    ...(remove.length > 0 ? { removeProviders: remove } : {}),
  } as never);
  return true;
}
