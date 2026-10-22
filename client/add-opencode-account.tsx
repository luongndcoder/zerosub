import { openExternalUrl, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { addOpenCodeAccount } from "../shared/rpc";
import { describe, type ZeroSubStore } from "./store";
import { Button, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

/**
 * Adds an OpenCode account from its API keys, or replaces the keys of one that is already added.
 * OpenCode signs in with API keys, so there is no browser flow to wait for.
 */
export function AddOpenCodeAccountModal({
  theme,
  host,
  multiHost,
  store,
  accountId,
  accountLabel,
  main,
  onClose,
}: {
  theme: Theme;
  host: PluginSurfaceProps["host"];
  /** The app knows several hosts, so say which one gets the account. */
  multiHost: boolean;
  store: ZeroSubStore;
  /** Set when an account that is signed out gets new keys. */
  accountId?: string;
  accountLabel?: string;
  /** The user's own OpenCode login: the keys replace the ones it already has. */
  main?: boolean;
  onClose(): void;
}) {
  const text = useText(theme);
  const toast = useToast();
  const [goKey, setGoKey] = useState("");
  const [zenKey, setZenKey] = useState("");
  const [otherProvider, setOtherProvider] = useState("");
  const [otherKey, setOtherKey] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputStyle = useMemo(
    () => ({
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
    }),
    [theme],
  );

  const open = useCallback(
    (url: string) => {
      void openExternalUrl(url).catch((failure: unknown) => toast.error(describe(failure)));
    },
    [toast],
  );

  const hasKey = Boolean(goKey.trim() || zenKey.trim() || (otherProvider.trim() && otherKey.trim()));
  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await store.rpc(addOpenCodeAccount, {
        goKey: goKey.trim() || undefined,
        zenKey: zenKey.trim() || undefined,
        otherProvider: otherProvider.trim() || undefined,
        otherKey: otherKey.trim() || undefined,
        label: label.trim() || undefined,
        accountId,
      });
      toast.show(accountId ? "The keys were saved" : "The OpenCode account was added", { variant: "success" });
      onClose();
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setBusy(false);
    }
  }, [store, goKey, zenKey, otherProvider, otherKey, label, accountId, onClose, toast]);

  return (
    <Modal
      title={main ? "New keys for your OpenCode login" : accountId ? `New keys for ${accountLabel ?? "this account"}` : "Add OpenCode account"}
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
    >
      <Modal.Content>
        <View style={{ gap: 10 }}>
          <Text style={text.body}>
            {main
              ? "Paste the key of your OpenCode account. It replaces the old key in the OpenCode login on this machine, so the OpenCode CLI uses it too."
              : "Paste the API keys of the OpenCode account you want to add. Agents run on one account at a time, and move to another one when a key runs out of room."}
          </Text>
          {multiHost && !accountId ? (
            <Text style={text.small}>Adds the account on {host.label} only. Other hosts need their own keys.</Text>
          ) : null}
          <Field theme={theme} label="OpenCode Go key">
            <TextInput
              value={goKey}
              onChangeText={setGoKey}
              placeholder="sk-…"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={inputStyle}
              accessibilityLabel="OpenCode Go API key"
            />
            <Button
              theme={theme}
              size="small"
              icon="ExternalLink"
              label="Get a Go key"
              tooltip="Open opencode.ai/go to get an OpenCode Go key"
              tooltipAlign="start"
              onPress={() => open("https://opencode.ai/go")}
            />
          </Field>
          <Field theme={theme} label="OpenCode Zen key (optional)">
            <TextInput
              value={zenKey}
              onChangeText={setZenKey}
              placeholder="sk-…"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={inputStyle}
              accessibilityLabel="OpenCode Zen API key"
            />
            <Button
              theme={theme}
              size="small"
              icon="ExternalLink"
              label="Get a Zen key"
              tooltip="Open opencode.ai/zen to get an OpenCode Zen key"
              tooltipAlign="start"
              onPress={() => open("https://opencode.ai/zen")}
            />
          </Field>
          <Field theme={theme} label="Another provider (optional)">
            <TextInput
              value={otherProvider}
              onChangeText={setOtherProvider}
              placeholder="anthropic, openai, google…"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={inputStyle}
              accessibilityLabel="Other provider name"
            />
            <TextInput
              value={otherKey}
              onChangeText={setOtherKey}
              placeholder="API key"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={inputStyle}
              accessibilityLabel="Other provider API key"
            />
          </Field>
          <Field theme={theme} label="Name (optional)">
            <TextInput
              value={label}
              onChangeText={setLabel}
              placeholder="Work, Personal…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={inputStyle}
              accessibilityLabel="Account name"
            />
          </Field>
          <Text style={text.small}>
            {main
              ? "The key is stored by OpenCode itself, in its own credentials file on this machine. The other keys you already have keep working."
              : "The keys are kept on the daemon host, in this account's own folder, and handed to OpenCode when a session starts. Your other OpenCode keys keep working."}
          </Text>
          {error ? <Text style={text.danger}>{error}</Text> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
            <Button theme={theme} label="Cancel" tooltip="Close without adding an account" tooltipAlign="end" onPress={onClose} />
            <Button
              theme={theme}
              tone="primary"
              icon="Plus"
              label={accountId ? "Save keys" : "Add account"}
              tooltip={accountId ? "Save these keys" : "Add this OpenCode account"}              tooltipAlign="end"
              busy={busy}
              disabled={busy || !hasKey}
              onPress={() => void submit()}
            />
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}

function Field({ theme, label, children }: { theme: Theme; label: string; children: React.ReactNode }) {
  const text = useText(theme);
  return (
    <View style={{ gap: 4 }}>
      <Text style={text.small}>{label}</Text>
      {children}
    </View>
  );
}
