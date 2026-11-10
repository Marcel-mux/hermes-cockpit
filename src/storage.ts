import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { ConnectionProfile } from './types';

const KEY = 'hermes-mobile.connection-profiles.v1';

async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web' || (typeof window !== 'undefined' && window.localStorage)) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web' || (typeof window !== 'undefined' && window.localStorage)) {
    try {
      window.localStorage.setItem(key, value);
      return;
    } catch {}
  }
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {}
}

async function deleteItem(key: string): Promise<void> {
  if (Platform.OS === 'web' || (typeof window !== 'undefined' && window.localStorage)) {
    try {
      window.localStorage.removeItem(key);
      return;
    } catch {}
  }
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {}
}

export async function loadProfiles(): Promise<ConnectionProfile[]> {
  const raw = await getItem(KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as ConnectionProfile[]; } catch { return []; }
}

export async function saveProfiles(profiles: ConnectionProfile[]): Promise<void> {
  await setItem(KEY, JSON.stringify(profiles));
}

export async function upsertProfile(profile: ConnectionProfile): Promise<ConnectionProfile[]> {
  const profiles = await loadProfiles();
  const next = [profile, ...profiles.filter(p => p.id !== profile.id)].slice(0, 8);
  await saveProfiles(next);
  return next;
}

export async function deleteProfile(id: string): Promise<ConnectionProfile[]> {
  const profiles = (await loadProfiles()).filter(p => p.id !== id);
  await saveProfiles(profiles);
  return profiles;
}

const SESSION_KEY = 'hermes-mobile.last-session-id.v1';

export async function loadLastSessionId(): Promise<string | null> {
  return await getItem(SESSION_KEY);
}

export async function saveLastSessionId(id: string): Promise<void> {
  await setItem(SESSION_KEY, id);
}

export async function clearLastSessionId(): Promise<void> {
  await deleteItem(SESSION_KEY);
}

const THEME_KEY = 'hermes-mobile.theme-mode.v1';

export async function loadThemeMode(): Promise<'light' | 'dark' | null> {
  const raw = await getItem(THEME_KEY);
  return raw === 'dark' || raw === 'light' ? raw : null;
}

export async function saveThemeMode(mode: 'light' | 'dark'): Promise<void> {
  await setItem(THEME_KEY, mode);
}

const MSG_MODELS_KEY = 'hermes-mobile.message-models.v1';

export async function loadMessageModels(): Promise<Record<string, string>> {
  const raw = await getItem(MSG_MODELS_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export async function saveMessageModels(map: Record<string, string>): Promise<void> {
  await setItem(MSG_MODELS_KEY, JSON.stringify(map));
}

const HERMES_PROFILE_KEY = 'hermes-mobile.selected-hermes-profile.v1';

export async function loadSelectedHermesProfile(): Promise<string | null> {
  return await getItem(HERMES_PROFILE_KEY);
}

export async function saveSelectedHermesProfile(name: string): Promise<void> {
  await setItem(HERMES_PROFILE_KEY, name);
}

const SOUND_KEY = 'hermes-mobile.voice-alert-enabled.v1';

export async function loadSoundEnabled(): Promise<boolean> {
  const raw = await getItem(SOUND_KEY);
  return raw !== 'false';
}

export async function saveSoundEnabled(enabled: boolean): Promise<void> {
  await setItem(SOUND_KEY, enabled ? 'true' : 'false');
}

// Skala teks chat: 0.9 (kecil) / 1 (normal) / 1.15 (besar).
const TEXT_SCALE_KEY = 'hermes-mobile.text-scale.v1';
export const TEXT_SCALE_EVENT = 'hermes-text-scale-changed';

export async function loadTextScale(): Promise<number> {
  const raw = Number(await getItem(TEXT_SCALE_KEY));
  return [0.9, 1, 1.15].includes(raw) ? raw : 1;
}

export async function saveTextScale(scale: number): Promise<void> {
  await setItem(TEXT_SCALE_KEY, String(scale));
  // Chat screen mendengarkan event ini supaya perubahan langsung terlihat
  // tanpa perlu reload.
  if (typeof window !== 'undefined' && window.dispatchEvent) {
    window.dispatchEvent(new Event(TEXT_SCALE_EVENT));
  }
}
