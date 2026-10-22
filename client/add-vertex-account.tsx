import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { addVertexAccount } from "../shared/rpc";
import { describe, type ZeroSubStore } from "./store";
import { Button, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

/** Adds Claude on Google Vertex AI as the pay-per-use fallback for when every subscription is out. */
export function AddVertexAccountModal({
  theme,
  host,
  multiHost,
  store,
  onClose,
}: {
  theme: Theme;
  host: PluginSurfaceProps["host"];
  multiHost: boolean;
  store: ZeroSubStore;
  onClose(): void;
}) {
  const text = useText(theme);
  const [projectId, setProjectId] = useState("");
  const [region, setRegion] = useState("global");
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

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await store.rpc(addVertexAccount, { projectId, region, label: label.trim() || undefined });
      onClose();
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setBusy(false);
    }
  }, [store, projectId, region, label, onClose]);

  return (
    <Modal title="Add Vertex AI fallback" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <View style={{ gap: 10 }}>
          <Text style={text.body}>
            Claude agents move here only when every Claude subscription account is out, and move back as soon as one has
            room again. Vertex AI bills your Google Cloud project per use.
          </Text>
          {multiHost ? <Text style={text.small}>Adds the fallback on {host.label} only.</Text> : null}
          <Field theme={theme} label="Google Cloud project ID">
            <TextInput
              value={projectId}
              onChangeText={setProjectId}
              placeholder="my-project-123"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={inputStyle}
              accessibilityLabel="Google Cloud project ID"
            />
          </Field>
          <Field theme={theme} label="Region">
            <TextInput
              value={region}
              onChangeText={setRegion}
              placeholder="global, us-east5, europe-west1…"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={inputStyle}
              accessibilityLabel="Vertex AI region"
            />
          </Field>
          <Field theme={theme} label="Name (optional)">
            <TextInput
              value={label}
              onChangeText={setLabel}
              placeholder={projectId ? `Vertex · ${projectId}` : "Vertex · my-project"}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={inputStyle}
              accessibilityLabel="Account name"
            />
          </Field>
          <Text style={text.small}>
            On the daemon host, run gcloud auth application-default login and enable the Claude models in Vertex AI Model
            Garden for this project. Until then the account shows as signed out.
          </Text>
          {error ? <Text style={text.danger}>{error}</Text> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
            <Button theme={theme} label="Cancel" tooltip="Close without adding" tooltipAlign="end" onPress={onClose} />
            <Button
              theme={theme}
              tone="primary"
              icon="Plus"
              label="Add"
              tooltip="Add Vertex AI as the pay-per-use fallback"
              tooltipAlign="end"
              busy={busy}
              disabled={busy || !projectId.trim() || !region.trim()}
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
