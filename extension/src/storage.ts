/**
 * Persisted birth details (per the project owner: "it should remember your
 * birth details"). `chrome.storage.local` keeps this on-device only -- never
 * synced, never sent anywhere except as the natal-chart input to the same
 * Worker the main app already uses, matching the project's "nothing about
 * the user is stored server-side" rule (this isn't server-side storage at
 * all, just this browser's local extension storage).
 */
import type { BirthInput } from "../../src/natal";

const STORAGE_KEY = "cosmicJevBirthInput";

export async function loadBirthInput(): Promise<BirthInput | undefined> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] as BirthInput | undefined;
}

export async function saveBirthInput(birthInput: BirthInput): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: birthInput });
}
