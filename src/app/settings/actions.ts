"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  MODEL_PROVIDERS,
  SEARCH_PROVIDERS,
  clearModelKey,
  getKeyStatus,
  saveModelKey,
  setSearchProvider,
  type ModelProviderId,
} from "@/lib/settings";
import { getOrCreateDefaultWorkspace, setLocales } from "@/lib/workspace";

export type ActionState = {
  ok: boolean;
  message: string;
  /** Set only on a successful save, to prove the value round tripped. */
  verified?: { masked: string; matchedInput: boolean };
} | null;

const saveSchema = z.object({
  provider: z.enum(["groq", "anthropic"]),
  key: z.string().trim().min(8, "That key looks too short to be real"),
});

export async function saveModelKeyAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = saveSchema.safeParse({
    provider: formData.get("provider"),
    key: formData.get("key"),
  });
  if (!parsed.success) {
    // Never echo the submitted key back, even in an error.
    return { ok: false, message: parsed.error.issues[0].message };
  }
  const { provider, key } = parsed.data;

  try {
    const ws = await getOrCreateDefaultWorkspace();
    await saveModelKey(ws.id, key, provider as ModelProviderId);

    // Read back through the same path the app will use, so the UI reports an
    // actual decrypt from Postgres rather than echoing what was submitted.
    const status = await getKeyStatus(ws.id);
    if (status.state !== "stored") {
      return {
        ok: false,
        message: "Key was written but could not be decrypted on read back",
      };
    }

    const expectedTail = key.slice(-4);
    const matched = status.masked.endsWith(expectedTail);

    const expectedPrefix = MODEL_PROVIDERS.find((p) => p.id === provider)?.keyPrefix;
    const prefixNote =
      expectedPrefix && !key.startsWith(expectedPrefix)
        ? ` Note: ${provider} keys usually start with "${expectedPrefix}" — double check this is the right provider.`
        : "";

    revalidatePath("/settings");
    revalidatePath("/");
    return {
      ok: true,
      message: `Key encrypted and stored. Read back from Postgres and decrypted successfully.${prefixNote}`,
      verified: { masked: status.masked, matchedInput: matched },
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Failed to save key",
    };
  }
}

export async function clearModelKeyAction(): Promise<void> {
  const ws = await getOrCreateDefaultWorkspace();
  await clearModelKey(ws.id);
  revalidatePath("/settings");
  revalidatePath("/");
}

export async function setLocalesAction(formData: FormData): Promise<void> {
  const raw = String(formData.get("locales") ?? "");
  const locales = raw
    .split(/[,\s]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (locales.length === 0) return;
  const ws = await getOrCreateDefaultWorkspace();
  await setLocales(ws.id, locales);
  revalidatePath("/settings");
}

export async function setSearchProviderAction(formData: FormData): Promise<void> {
  const provider = z
    .enum(SEARCH_PROVIDERS)
    .safeParse(formData.get("searchProvider"));
  if (!provider.success) return;
  const ws = await getOrCreateDefaultWorkspace();
  await setSearchProvider(ws.id, provider.data);
  revalidatePath("/settings");
}
