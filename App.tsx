import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, AppState, Easing, Image, Keyboard, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';

import { HermesRestClient, HermesRpcClient, normalizeBaseUrl, prepareConnectionProfile } from './src/api/hermes';
import { deleteProfile, loadProfiles, upsertProfile, loadLastSessionId, saveLastSessionId, clearLastSessionId, loadThemeMode, saveThemeMode, loadMessageModels, saveMessageModels, loadSelectedHermesProfile, saveSelectedHermesProfile, loadSoundEnabled, saveSoundEnabled, loadTextScale, saveTextScale, TEXT_SCALE_EVENT } from './src/storage';
import { lightColors, darkColors, createStyles, ThemeColors, radius, shadow } from './src/theme';
import { MarkdownView } from './src/MarkdownView';

const ThemeContext = React.createContext<{
  colors: ThemeColors;
  styles: ReturnType<typeof createStyles>;
  isDark: boolean;
  toggleTheme: () => void;
}>({
  colors: darkColors,
  styles: createStyles(darkColors, true),
  isDark: true,
  toggleTheme: () => {},
});

export const useTheme = () => React.useContext(ThemeContext);

const fallbackColors = darkColors;
const fallbackStyles = createStyles(darkColors, true);

import type { ConnectionProfile, CronJob, HermesEvent, McpCatalogEntry, McpServer, SessionSummary, SkillInfo, ToolsetInfo } from './src/types';
import { deriveTurnState } from './src/turnState';

// 'auto' = kosongkan agent.reasoning_effort di config, jadi provider/rute yang
// nentuin effort-nya sendiri (bukan "none"/off — backend memetakan string kosong
// ke reasoning_config=None, lihat hermes_constants.parse_reasoning_effort).
const REASONING_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Maks' }
];
const REASONING_AUTO = 'auto';

// Command yang ada di katalog backend tapi butuh surface lain (terminal, editor,
// clipboard, settings). Kalau diteruskan dari chat hasilnya error atau nggak jelas,
// jadi lebih baik tetap munculin pesan "belum didukung" daripada gagal diam-diam.
const SLASH_LOCAL_ONLY = new Set([
  '/redraw', '/history', '/prompt', '/handoff', '/worktree', '/snapshot', '/export',
  '/import', '/journey', '/config', '/statusbar', '/battery', '/timestamps', '/verbose',
  '/focus', '/sethome', '/footer', '/browser', '/plugins', '/palette', '/subscription',
  '/platforms', '/copy', '/paste', '/image', '/quit', '/login', '/update', '/restart'
]);
// Identitas stabil: dipakai sebagai default prop `extraToolParts` supaya memo() di
// MessageBubble nggak batal gara-gara array kosong baru tiap render.
const NO_TOOL_PARTS: NonTextPart[] = [];

type ComposerAttachmentItem = {
  id: string;
  name: string;
  size: number;
  type: 'image' | 'file';
  mime: string;
  dataUrl: string;
  base64: string;
};

type Tab = 'home' | 'chat' | 'logs' | 'pulse' | 'settings' | 'approvals' | 'artifacts' | 'ops';
type SettingsSubScreen = 'main' | 'skills' | 'artifacts' | 'mcp' | 'cron';
type OpsScreen = 'hub' | 'skills' | 'mcp' | 'cron' | 'logs';
type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
type ToolStatus = 'running' | 'done' | 'error';
type NonTextPart = { kind: 'tool' | 'skill' | 'thought'; name: string; status: ToolStatus; summary: string; detail?: string };
type MessagePart =
  | { kind: 'text'; text: string }
  | NonTextPart;
type Message = { id: string; role: MessageRole; text: string; at: number; parts?: MessagePart[]; tokenCount?: number; model?: string; reasoning?: string; failed?: boolean };
type ArtifactKind = 'image' | 'file' | 'link';
type ArtifactOrigin = 'given' | 'produced';
type ArtifactItem = { session: string; kind: ArtifactKind; label: string; value: string; href: string; canOpen: boolean; at: number; origin: ArtifactOrigin };
type PulseStatus = 'attention' | 'working' | 'delivered';
type PulseFilter = 'latest' | 'attention' | 'working' | 'history';
type PulseItem = { id: string; status: PulseStatus; title: string; meta: string; summary: string; at: number; sourceId?: string; text?: string; event?: HermesEvent };
type Status = 'idle' | 'testing' | 'connected' | 'error';

const tabs: { id: 'chat' | 'logs' | 'pulse' | 'settings'; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { id: 'chat', label: 'Chat', icon: 'chatbubble-ellipses-outline' },
  { id: 'logs', label: 'Log', icon: 'terminal-outline' },
  { id: 'pulse', label: 'Pulse', icon: 'pulse-outline' },
  { id: 'settings', label: 'Settings', icon: 'settings-outline' }
];

function makeId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function sessionId(s: SessionSummary): string { return String(s.session_id || s.id || s.stored_session_id || ''); }
function titleOf(s: SessionSummary): string { return safeText(s.title || s.name || sessionId(s).slice(0, 8) || 'Untitled'); }
function shortId(id: string) { return id ? id.slice(0, 10) : 'new'; }
function sessionTime(s: SessionSummary): number {
  const raw = safeText(s.updated_at || s.created_at || (s as any).last_message_at || (s as any).last_updated || (s as any).timestamp);
  const parsed = raw ? Date.parse(raw) : 0;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const compactDate = `${sessionId(s)} ${titleOf(s)}`.match(/(20\d{2})(\d{2})(\d{2})(?:[_-](\d+))?/);
  if (compactDate) return Date.parse(`${compactDate[1]}-${compactDate[2]}-${compactDate[3]}T00:00:00Z`) + Number(compactDate[4] || 0);
  return 0;
}
function messageTime(raw: any, sessionFallback = 0): number {
  const direct = raw?.timestamp ?? raw?.created_at ?? raw?.at ?? raw?.time;
  if (typeof direct === 'number') return direct > 1e12 ? direct : direct * 1000;
  const parsed = direct ? Date.parse(safeText(direct)) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : sessionFallback || Date.now();
}
function formatArtifactTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return 'unknown time';
  return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function formatCompactNumber(num: number): string {
  if (!num) return '0';
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(1) + 'k';
  return String(num);
}
function formatRelativeTime(ts: string | number): string {
  if (!ts) return '';
  const at = typeof ts === 'number' ? ts : new Date(ts).getTime();
  if (!Number.isFinite(at) || at <= 0) return '';
  const diff = Math.max(0, Date.now() - at);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
function formatResetCountdown(resetAt?: string | null, prefix = 'in '): string {
  if (!resetAt) return '';
  const target = new Date(resetAt).getTime();
  if (!Number.isFinite(target)) return '';
  const diffMs = target - Date.now();
  if (diffMs <= 0) return 'resetting';
  const sec = Math.floor(diffMs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  if (day >= 1) {
    const remHr = hr % 24;
    return remHr > 0 && day < 3 ? `${prefix}${day}d ${remHr}h` : `${prefix}${day}d`;
  }
  if (hr >= 1) {
    const remMin = min % 60;
    return remMin > 0 ? `${prefix}${hr}h ${remMin}m` : `${prefix}${hr}h`;
  }
  if (min >= 1) return `${prefix}${min}m`;
  return `${prefix}${sec}s`;
}
function sessionMessageCount(s: SessionSummary): number { return Number(s.message_count ?? (s as any).messages_count ?? 0) || 0; }
function isEmptySession(s: SessionSummary): boolean { return sessionMessageCount(s) <= 0; }
function isCronSession(s: SessionSummary): boolean {
  const haystack = `${titleOf(s)} ${sessionId(s)} ${safeText(s.source)}`.toLowerCase();
  return /(^|\s|_)cron[_\s-]/.test(haystack) || haystack.includes(' cron_') || haystack.startsWith('cron_') || safeText(s.source).toLowerCase() === 'cron';
}
function isInternalAutomationSession(s: SessionSummary): boolean {
  const source = safeText(s.source).toLowerCase();
  const title = safeText(s.title || s.name).trim();
  const id = sessionId(s).toLowerCase();
  if (isEmptySession(s)) return true;
  if ((source === 'cli' || source === 'system') && !title) return true;
  if (/slack[-_\s]*(coordination|gate|classifier)/i.test(`${title} ${id}`)) return true;
  return false;
}
function isUserFacingSession(s: SessionSummary): boolean { return !isInternalAutomationSession(s); }

function safeText(value: any, fallback = ''): string {
  if (value == null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(v => safeText(v)).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    for (const key of ['display', 'text', 'content', 'message', 'delta', 'summary', 'name', 'id']) {
      const candidate = value[key];
      if (candidate != null && candidate !== value) {
        const rendered = safeText(candidate);
        if (rendered) return rendered;
      }
    }
    try { return JSON.stringify(value, null, 2); } catch { return fallback; }
  }
  return String(value);
}

const SESSION_PAGE_SIZE = 50;
const ARTIFACT_SESSION_PAGE_SIZE = 20;
const PULSE_SESSION_PAGE_SIZE = 20;
const DRAWER_MIN_VISIBLE_SESSIONS = 14;

function isNearScrollEnd(event: any): boolean {
  const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
  return layoutMeasurement.height + contentOffset.y >= contentSize.height - 160;
}

function appendUniqueSessions(existing: SessionSummary[], incoming: SessionSummary[]): SessionSummary[] {
  const seen = new Set(existing.map(sessionId).filter(Boolean));
  const next = [...existing];
  for (const s of incoming) {
    const id = sessionId(s);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    next.push(s);
  }
  return next;
}

function visibleSessionCount(rows: SessionSummary[], mode: 'chats' | 'cron'): number {
  return rows.filter(s => {
    if (!isUserFacingSession(s)) return false;
    return mode === 'cron' ? isCronSession(s) : !isCronSession(s);
  }).length;
}

function compactJson(value: any, max = 140): string {
  const text = safeText(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolKind(name: string): 'tool' | 'skill' {
  return /^skill_|^skills?|skill_view|skill_manage|skills_list/i.test(name) ? 'skill' : 'tool';
}

const KAWAII_SPINNER_RE = /(?:\([^)\n]{1,48}\)\s*)?(?:processing|thinking|reasoning|analyzing|pondering|contemplating|musing|cogitating|ruminating|deliberating|mulling|reflecting|computing|synthesizing|formulating|brainstorming)\.\.\./i;

function cleanReasoningText(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/(?:\([^)\n]{1,48}\)\s*)?(?:processing|thinking|reasoning|analyzing|pondering|contemplating|musing|cogitating|ruminating|deliberating|mulling|reflecting|computing|synthesizing|formulating|brainstorming)\.\.\./gi, '')
    .replace(/\([^\w\s\n]{1,16}[^)\n]{0,16}\)/g, '')
    .trim();
}

function parseReasoningLines(text: string): string[] {
  const cleaned = cleanReasoningText(text);
  if (!cleaned) return [];
  const rawLines = cleaned.split(/\r?\n/);
  const result: string[] = [];
  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.length > 120 && trimmed.includes('. ')) {
      const sentences = trimmed.split(/(?<=\.)\s+/);
      for (const s of sentences) {
        if (s.trim()) result.push(s.trim());
      }
    } else {
      result.push(trimmed);
    }
  }
  return result;
}

// This dashboard build does not emit per-tool `status.update` events, so the
// freshest activity is read from the newest rows of the session transcript.
function toolTitle(name: string) {
  return name.replace(/^functions\./, '').replace(/_/g, ' ');
}

function toolSummary(name: string, args: any, result: any): string {
  if (name === 'terminal') return compactJson(args?.command || result?.command || 'shell command');
  if (name === 'browser_exec' || name === 'browser_use') {
    const code = String(args?.code || args?.action || '').split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).join(' ');
    return compactJson(code || 'browser step', 70);
  }
  if (name === 'delegate_task') return compactJson(Array.isArray(args?.tasks) ? `${args.tasks.length} task(s)` : 'delegate', 70);
  if (name === 'todo_list' || name === 'todo') return compactJson(args?.action || 'update task list', 70);
  if (name === 'read_file') return compactJson(args?.path || 'read file');
  if (name === 'write_file') return compactJson(args?.path || 'write file');
  if (name === 'patch') return compactJson(args?.path || args?.mode || 'patch');
  if (name === 'web_search') return compactJson(args?.query || 'web search');
  if (name === 'web_extract') return compactJson(args?.urls || 'web extract');
  if (name === 'skill_view') return compactJson(args?.name || 'load skill');
  if (name === 'skill_manage') return compactJson(`${args?.action || 'update'} ${args?.name || 'skill'}`);
  if (name === 'todo') return 'Update task list';
  return compactJson(args) || compactJson(result) || 'Running';
}

function parseMessageParts(content: any, role: MessageRole): MessagePart[] {
  const parts: MessagePart[] = [];
  const pushText = (value: any) => {
    const text = safeText(value).trim();
    if (text) parts.push({ kind: 'text', text });
  };

  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') { pushText(part); continue; }
      const type = safeText(part.type).toLowerCase();
      const name = safeText(part.toolName || part.tool_name || part.name || part.function?.name || part.recipient_name);
      if (type.includes('tool') || name) {
        const status: ToolStatus = part.isError || part.error ? 'error' : part.result === undefined ? 'running' : 'done';
        const resultPreview = status === 'error' ? safeText(part.error || part.result).slice(0, 700) : undefined;
        parts.push({ kind: toolKind(name), name: name || 'tool call', status, summary: toolSummary(name, part.args || part.input || part.function?.arguments, part.result), detail: resultPreview });
        continue;
      }
      pushText(part.text ?? part.content ?? part.message ?? part.delta ?? part);
    }
    return parts;
  }

  if (role === 'tool' && content && typeof content === 'object') {
    const name = safeText(content.toolName || content.name || content.tool_name || 'tool result');
    parts.push({ kind: toolKind(name), name, status: content.error ? 'error' : 'done', summary: toolSummary(name, content.args, content.result || content), detail: content.error ? safeText(content.error) : undefined });
    return parts;
  }

  if (role === 'tool') {
    const text = safeText(content).trim();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch {}
    const name = safeText(parsed?.toolName || parsed?.tool_name || parsed?.name || parsed?.recipient_name || 'tool result');
    parts.push({ kind: toolKind(name), name, status: parsed?.error ? 'error' : 'done', summary: toolSummary(name, parsed?.args || parsed?.input, parsed || text), detail: parsed?.error ? safeText(parsed.error).slice(0, 700) : undefined });
    return parts;
  }

  pushText(content);
  return parts;
}

function isInternalContextBlob(text: string): boolean {
  const normalized = text.trim().replace(/^\uFEFF/, '');
  return /^\[CONTEXT COMPACTION\s+[—-]\s+REFERENCE ONLY\]/i.test(normalized)
    || /^Earlier turns were compacted into the summary below\./i.test(normalized)
    || /^--- END OF CONTEXT SUMMARY/i.test(normalized)
    || /You are Hermes's live Slack coordination gate/i.test(normalized)
    || (/Return ONLY valid compact JSON/i.test(normalized) && /Allowed actions:\s*ignore,\s*store_context,\s*reply/i.test(normalized))
    || /^\{\s*"action"\s*:\s*"(?:ignore|store_context|reply|act_locally|create_task|escalate_to_coop)"\s*,\s*"should_reply"/i.test(normalized);
}

function isVisibleMessage(message: Message): boolean {
  const text = message.text || message.parts?.filter(p => p.kind === 'text').map(p => (p as any).text).join('\n') || '';
  if (isInternalContextBlob(text)) return false;
  return !!(text.trim() || message.parts?.some(p => p.kind !== 'text'));
}

function messageFromRaw(raw: any, index: number, defaultModel?: string, store?: Record<string, string>): Message {
  const role = (['user', 'assistant', 'system', 'tool'].includes(raw?.role) ? raw.role : 'system') as MessageRole;
  const content = raw?.content ?? raw?.text ?? raw?.message ?? raw;
  const parts = parseMessageParts(content, role);
  const text = parts.filter(p => p.kind === 'text').map(p => (p as any).text).join('\n');
  const tokenCount = Number(raw?.token_count ?? raw?.tokens ?? raw?.usage?.total_tokens ?? 0) || undefined;
  const id = String(raw?.id ?? raw?.row_id ?? `${index}-${makeId()}`);
  let model = safeText(raw?.model || raw?.model_name || raw?.model_id) || undefined;
  if (!model && store && store[id]) {
    model = store[id];
  } else if (!model && defaultModel && role === 'assistant') {
    model = defaultModel;
    if (store) store[id] = defaultModel;
  }
  const reasoning = safeText(raw?.reasoning_content || raw?.reasoning) || undefined;
  return { id, role, text, parts, at: messageTime(raw, Date.now()), tokenCount, model, reasoning };
}

// Transkrip penuh satu sesi bisa ~250 KB. Buka app memicu beberapa jalur sekaligus
// (instant load saat buka sesi, syncMessages dari event focus/WS, sync setelah turn),
// dan sebelumnya tiap jalur narik ulang transkrip yang sama. Satu fetch di-share:
// TTL pendek buat request beruntun + dedupe request yang masih jalan.
const TRANSCRIPT_TTL_MS = 1500;
const transcriptCache = new Map<string, { at: number; data: any }>();
const transcriptPending = new Map<string, Promise<any>>();

async function fetchTranscript(rest: any, sid: string, maxAgeMs: number = TRANSCRIPT_TTL_MS) {
  const hit = transcriptCache.get(sid);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.data;
  const pending = transcriptPending.get(sid);
  if (pending) return pending;
  const job = (async () => {
    try {
      const data = await rest.sessionMessages(sid);
      transcriptCache.set(sid, { at: Date.now(), data });
      return data;
    } finally {
      transcriptPending.delete(sid);
    }
  })();
  transcriptPending.set(sid, job);
  return job;
}

function normalizeMessages(data: any, defaultModel?: string, store?: Record<string, string>): Message[] {
  const rows = Array.isArray(data) ? data : data?.messages || [];
  return rows.map((m: any, i: number) => messageFromRaw(m, i, defaultModel, store)).filter(isVisibleMessage);
}

function nonTextParts(message: Message): NonTextPart[] {
  const parts = message.parts?.length ? message.parts : parseMessageParts(message.text, message.role);
  return parts.filter(p => p.kind !== 'text') as NonTextPart[];
}

function isToolOnlyMessage(message: Message): boolean {
  const parts = message.parts?.length ? message.parts : parseMessageParts(message.text, message.role);
  const text = parts.filter(p => p.kind === 'text').map(p => (p as any).text).join('').trim();
  return !!parts.length && !text && parts.some(p => p.kind !== 'text');
}

function briefTitle(text: string, fallback: string): string {
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading.replace(/[*_`]/g, '').slice(0, 90);
  const first = text.split('\n').map(line => line.replace(/^[-*]\s+/, '').trim()).find(Boolean);
  return (first || fallback).replace(/[*_`]/g, '').slice(0, 90);
}
function briefPreview(text: string): string { return text.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 220); }
function isUserFacingBriefMessage(message: Message): boolean {
  if (message.role !== 'assistant' || isToolOnlyMessage(message)) return false;
  const text = message.text.trim();
  if (text.length < 180 || isInternalContextBlob(text)) return false;
  return /^#\s+/m.test(text) || /\n[-*]\s+/.test(text) || /brief|digest|report|summary|generated|what moved|status|update/i.test(text);
}

export default function App() {
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    loadThemeMode().then(saved => {
      if (saved) setIsDark(saved === 'dark');
    });
  }, []);

  // Keep the browser/PWA chrome in step with the in-app theme: the static shell
  // is dark-only, so without this the status bar and overscroll stay dark when
  // the user switches to the light palette.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const bg = isDark ? '#0a0b0e' : '#f8fafd';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', bg);
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
    document.body.style.backgroundColor = bg;
  }, [isDark]);

  const toggleTheme = useCallback(() => {
    setIsDark(prev => {
      const next = !prev;
      saveThemeMode(next ? 'dark' : 'light').catch(() => undefined);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      return next;
    });
  }, []);

  const currentColors = isDark ? darkColors : lightColors;
  const currentStyles = useMemo(() => createStyles(currentColors, isDark), [currentColors, isDark]);
  const styles = currentStyles;
  const colors = currentColors;

  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [profile, setProfile] = useState<ConnectionProfile | null>(null);
  const [tab, setTab] = useState<Tab>('chat');
  const [settingsSubScreen, setSettingsSubScreen] = useState<SettingsSubScreen>('main');
  const [opsScreen, setOpsScreen] = useState<OpsScreen>('hub');
  const [status, setStatus] = useState<Status>('idle');
  const [statusPayload, setStatusPayload] = useState<any>(null);
  const [error, setError] = useState('');
  const [events, setEvents] = useState<HermesEvent[]>([]);
  // `session.resume` mengembalikan `prompts` = approval/clarify yang MASIH ditahan
  // gateway. Buffer event cuma 80 item, jadi setelah pindah sesi kartu persetujuan
  // bisa hilang walau gateway masih menunggu jawaban. Hidrasi ulang dari snapshot.
  const hydratePendingPrompts = useCallback((sid: string, prompts: any[]) => {
    if (!sid || !Array.isArray(prompts) || !prompts.length) return;
    setEvents(prev => {
      const seen = new Set(prev.map((e: HermesEvent) => `${e.type}:${e.payload?.prompt_id}`));
      const synth: HermesEvent[] = [];
      for (const p of prompts) {
        if (!p?.prompt_id) continue;
        const type = p.kind === 'clarify' ? 'clarify.request' : 'approval.request';
        if (seen.has(`${type}:${p.prompt_id}`)) continue;
        synth.push({ type, session_id: sid, payload: p, receivedAt: Date.now() });
      }
      return synth.length ? [...synth, ...prev].slice(0, 120) : prev;
    });
  }, []);
  const resumeSessionHydrated = useCallback(async (sid: string) => {
    const client = rpcRef.current;
    if (!client) throw new Error('Hermes WebSocket is not connected');
    const r: any = await client.resumeSession(sid);
    hydratePendingPrompts(sid, r?.prompts);
    return r;
  }, [hydratePendingPrompts]);
  const [activeSession, setActiveSession] = useState('');
  const [activeRuntimeSession, setActiveRuntimeSession] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const rpcRef = useRef<HermesRpcClient | null>(null);
  const profileRef = useRef<ConnectionProfile | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const bootstrappedRef = useRef(false);
  const [wsOpen, setWsOpen] = useState(false);
  const reconnectTimerRef = useRef<any>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectRef = useRef<() => void>(() => {});

  const [currentProfileName, setCurrentProfileName] = useState('hermes-cockpit');
  const currentProfileNameRef = useRef('hermes-cockpit');
  useEffect(() => { currentProfileNameRef.current = currentProfileName; }, [currentProfileName]);
  const [availableProfiles, setAvailableProfiles] = useState<any[]>([]);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [newProfileModalOpen, setNewProfileModalOpen] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [creatingProfile, setCreatingProfile] = useState(false);

  const [modelInfo, setModelInfo] = useState<any>(null);
  // Model MILIK SESI yang lagi dibuka (dari info session.resume). `modelInfo` itu level
  // profil/default, jadi pill-nya salah nampilin begitu pindah sesi.
  const [sessionModelInfo, setSessionModelInfo] = useState<any>(null);
  const [modelOptions, setModelOptions] = useState<any>(null);
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<string>(REASONING_AUTO);
  const [streamingReasoning, setStreamingReasoning] = useState('');
  const sessionReasoningMapRef = useRef<Record<string, string>>({});
  // Buffer reasoning.delta: provider bisa nembak 30-100 delta/detik, dan tiap delta
  // sebelumnya = 1 re-render penuh ChatScreen + restart animasi scroll. Sekarang
  // di-flush max 10x/detik (~100ms) — teks tetap kelihatan streaming, render turun ~10x.
  const reasoningBufferRef = useRef('');
  const reasoningFlushTimerRef = useRef<any>(null);
  const flushReasoningBuffer = useCallback((mode: 'flush' | 'clear' = 'flush') => {
    if (reasoningFlushTimerRef.current) {
      clearTimeout(reasoningFlushTimerRef.current);
      reasoningFlushTimerRef.current = null;
    }
    const pending = reasoningBufferRef.current;
    reasoningBufferRef.current = '';
    if (mode === 'clear' || !pending) return;
    setStreamingReasoning(prev => {
      const next = (prev + pending).slice(-8000);
      const sid = activeSessionRef.current;
      if (sid) sessionReasoningMapRef.current[sid] = next;
      return next;
    });
  }, []);
  const activeSessionRef = useRef(activeSession);
  useEffect(() => { activeSessionRef.current = activeSession; }, [activeSession]);
  const activeRuntimeSessionRef = useRef(activeRuntimeSession);
  useEffect(() => { activeRuntimeSessionRef.current = activeRuntimeSession; }, [activeRuntimeSession]);
  const [updatingReasoning, setUpdatingReasoning] = useState(false);
  const modelInfoRef = useRef<any>(null);
  useEffect(() => { modelInfoRef.current = modelInfo; }, [modelInfo]);
  const sessionModelInfoRef = useRef<any>(null);
  useEffect(() => { sessionModelInfoRef.current = sessionModelInfo; }, [sessionModelInfo]);

  const rest = useMemo(() => profile ? new HermesRestClient(profile, currentProfileName) : null, [profile, currentProfileName]);

  const loadModel = useCallback(async () => {
    if (!rest) return;
    try {
      const [info, cfg] = await Promise.all([
        rest.modelInfo().catch(() => null),
        rest.config().catch(() => null),
      ]);
      if (info) setModelInfo(info);
      const effortRaw = cfg?.agent?.reasoning_effort;
      // Kosong/absen di config = "auto" (provider yang nentuin), bukan 'off'.
      setReasoningEffort(typeof effortRaw === 'string' && effortRaw.trim() ? effortRaw.trim() : REASONING_AUTO);
    } catch {}
  }, [rest]);

  const loadProfilesList = useCallback(async () => {
    if (!rest) return;
    try {
      const raw: any = await rest.profiles();
      const list = Array.isArray(raw) ? raw : (raw?.profiles || []);
      setAvailableProfiles(list);
    } catch {}
  }, [rest]);

  useEffect(() => {
    if (status === 'connected') {
      loadModel();
      loadProfilesList();
    }
  }, [status, rest, loadModel, loadProfilesList]);

  const openModelPicker = async () => {
    setModelModalOpen(true);
    if (!rest) return;
    try {
      const opts = await rest.modelOptions();
      setModelOptions(opts);
    } catch (e: any) { setError(e.message); }
  };

  const selectModel = async (providerSlug: string, modelId: string) => {
    if (!rest) return;
    setSwitchingModel(true);
    try {
      const rpc = rpcRef.current;
      let sid = activeRuntimeSession;
      if (rpc && !sid && activeSession) {
        try {
          const r: any = await resumeSessionHydrated(activeSession);
          sid = safeText(r?.session_id || r?.runtime_session_id || r?.id);
          if (sid) setActiveRuntimeSession(sid);
        } catch {}
      }
      if (rpc && sid) {
        const res: any = await rpc.slashExec(sid, `/model ${modelId}`);
        const out = safeText(res && (res.output || res.notice));
        if (!/Model switched/i.test(out)) {
          throw new Error(out || 'Gagal mengganti model sesi ini.');
        }
      } else {
        await rest.setModel(providerSlug, modelId);
      }
      setSessionModelInfo({ model: modelId, provider: providerSlug });
      setModelInfo((prev: any) => ({ ...prev, model: modelId, provider: providerSlug }));
      setModelModalOpen(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSwitchingModel(false);
    }
  };

  const selectReasoning = async (effort: string) => {
    if (!rest) return;
    setUpdatingReasoning(true);
    try {
      // 'auto' dikirim sebagai string kosong: backend menganggapnya "not set"
      // lalu provider/rute yang nentuin effort-nya. Kalau dikirim literal "auto",
      // backend cuma warning "Unknown reasoning_effort" lalu jatuh ke medium.
      await rest.updateConfig({ agent: { reasoning_effort: effort === REASONING_AUTO ? '' : effort } });
      setReasoningEffort(effort);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUpdatingReasoning(false);
    }
  };

  const switchProfile = async (pName: string) => {
    if (pName === currentProfileName) {
      setProfileModalOpen(false);
      return;
    }
    setCurrentProfileName(pName);
    currentProfileNameRef.current = pName;
    setProfileModalOpen(false);
    saveSelectedHermesProfile(pName).catch(() => undefined);
    setActiveSession('');
    setActiveRuntimeSession('');
    setMessages([]);
    setStreamingReasoning?.('');
    flushReasoningBuffer?.('clear');
    clearLastSessionId().catch(() => undefined);

    try {
      await reconnectNow(false, pName);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const createProfile = async () => {
    const name = newProfileName.trim();
    if (!name || !rest) return;
    setCreatingProfile(true);
    try {
      await rest.createProfile({ name, clone_from: 'default', description: `Created via Hermes Cockpit` });
      setNewProfileName('');
      setNewProfileModalOpen(false);
      await loadProfilesList();
      setCurrentProfileName(name);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreatingProfile(false);
    }
  };

  // ---- WebSocket lifecycle -------------------------------------------------
  // `connect` used to close over `profile`, so every profile update produced a
  // new callback, re-fired the bootstrap effect and looped forever. Everything
  // below is ref-driven and stable, plus the socket now has an explicit
  // reconnect path: a Hermes WS ticket is single-use with a ~30s TTL, so after
  // a drop (phone sleep, network switch, backend restart) the old URL is dead
  // and a fresh ticket has to be minted.
  const scheduleReconnect = useCallback((reason?: string) => {
    if (reconnectTimerRef.current) return;
    const isBackground = Platform.OS === 'web' && typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const attempt = reconnectAttemptRef.current++;
    // Continuous persistent reconnect with bounded backoff (max 20s), never give up permanently
    const delay = Math.min(20000, 1000 * Math.pow(1.4, Math.min(attempt, 8)));
    // Only surface error status if in foreground and repeatedly failing, never alarm user on simple tab sleep
    if (!isBackground && attempt >= 3) {
      setStatus('error');
      setError(`WebSocket terputus${reason ? ` (${reason})` : ''} · mencoba menyambung ulang…`);
    }
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      reconnectRef.current();
    }, delay);
  }, []);

  const attachRpcEvents = useCallback((rpc: HermesRpcClient) => {
    rpc.onEvent((event: HermesEvent) => {
      setEvents(prev => [{ ...event, receivedAt: Date.now() }, ...prev].slice(0, 80));

      const evSid = event.session_id;
      const curStored = activeSessionRef.current;
      const curRuntime = activeRuntimeSessionRef.current;
      const isForActiveSession = !evSid || evSid === curStored || evSid === curRuntime;

      if (event.type === 'reasoning.delta') {
        const text = safeText(event.payload?.text ?? event.payload);
        if (text && !KAWAII_SPINNER_RE.test(text)) {
          if (evSid && !isForActiveSession) {
            sessionReasoningMapRef.current[evSid] = ((sessionReasoningMapRef.current[evSid] || '') + text).slice(-8000);
            return;
          }
          if (isForActiveSession) {
            reasoningBufferRef.current = (reasoningBufferRef.current + text).slice(-8000);
            if (!reasoningFlushTimerRef.current) {
              reasoningFlushTimerRef.current = setTimeout(() => flushReasoningBuffer('flush'), 100);
            }
          }
        }
      }

      // STRICT SESSION ISOLATION: Never let messages or tool execution leak into another session
      if (!isForActiveSession) return;

      if (event.type === 'message.delta') {
        const text = safeText(event.payload);
        if (isInternalContextBlob(text)) return;
        if (!hasStreamedThisTurn) {
          hasStreamedThisTurn = true;
          playVoiceAlert('streaming');
        }
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant' && !last.parts?.some(p => p.kind !== 'text')) return [...prev.slice(0, -1), { ...last, text: last.text + text, parts: [{ kind: 'text', text: last.text + text }] }];
          return [...prev, { id: makeId(), role: 'assistant', text, parts: [{ kind: 'text', text }], at: Date.now() }];
        });
      }
      if (event.type === 'message.complete') {
        hasStreamedThisTurn = false;
        flushReasoningBuffer('flush'); // jangan sampai sisa buffer nyangkut ke turn berikutnya
        setStreamingReasoning?.('');
        const rawContent = safeText(event.payload?.text ?? event.payload?.message?.content ?? event.payload?.content ?? event.payload?.message ?? event.payload).trim();
        const currentModel = sessionModelInfoRef.current?.model || modelInfoRef.current?.model || '';
        setMessages(prev => {
          const last = prev[prev.length - 1];
          const finalText = rawContent || (last?.role === 'assistant' ? last.text : '');
          if (!finalText.trim()) return prev;

          const parts = parseMessageParts(finalText, 'assistant');
          const completed: Message = {
            id: (last?.role === 'assistant' && last.id) ? last.id : makeId(),
            role: 'assistant',
            text: finalText,
            parts,
            at: (last?.role === 'assistant' && last.at) ? last.at : Date.now(),
            model: currentModel
          };

          if (last?.role === 'assistant') {
            return [...prev.slice(0, -1), completed];
          }
          return [...prev, completed];
        });
      }
      if (event.type === 'status.update') {
        const kind = safeText(event.payload?.kind);
        const text = safeText(event.payload?.text);
        if (/tool|skill/i.test(kind) && text) {
          const name = text.split(/\s+/)[0] || kind;
          const part: NonTextPart = { kind: toolKind(name), name, status: 'running', summary: text };
          const nextMessage: Message = { id: makeId(), role: 'tool', text: '', parts: [part], at: Date.now() };
          setMessages(prev => [...prev, nextMessage]);
        } else if (text) {
          const part: NonTextPart = { kind: 'thought', name: 'thought', status: 'running', summary: text };
          const nextMessage: Message = { id: makeId(), role: 'system', text: '', parts: [part], at: Date.now() };
          setMessages(prev => [...prev, nextMessage]);
        }
      }
      if (event.type === 'review.summary') {
        const text = safeText(event.payload?.text ?? event.payload?.summary ?? event.payload).trim();
        if (text) {
          const sysMsg: Message = {
            id: makeId(),
            role: 'system',
            text: text,
            at: Date.now()
          };
          setMessages(prev => [...prev, sysMsg]);
        }
      }
    });
  }, [flushReasoningBuffer]);

  // Opens one socket for an already-authenticated profile (wsTicket or token).
  const openRpc = useCallback(async (runtimeProfile: ConnectionProfile, profName?: string) => {
    rpcRef.current?.close();
    setActiveRuntimeSession('');
    const activeProf = profName || currentProfileNameRef.current;
    const rpc = new HermesRpcClient(runtimeProfile, activeProf);
    attachRpcEvents(rpc);
    let opened = false;
    rpc.onClose(info => {
      if (rpcRef.current === rpc) setWsOpen(false);
      if (info.byClient) return; // deliberate close (new connect / unmount)
      if (!opened) return; // never established: let connect() surface the error
      scheduleReconnect(`code ${info.code}${info.reason ? ` ${info.reason}` : ''}`);
    });
    await rpc.connect();
    opened = true;
    rpcRef.current = rpc;
    setWsOpen(true);
    reconnectAttemptRef.current = 0;
  }, [attachRpcEvents, scheduleReconnect]);

  // Full connect: probe the dashboard, authenticate, open the socket.
  const connect = useCallback((target?: ConnectionProfile | null) => {
    const targetProfile = target ?? profileRef.current;
    if (!targetProfile) return Promise.resolve();
    if (inFlightRef.current) return inFlightRef.current;
    const run = (async () => {
      setStatus('testing'); setError('');
      try {
        const prepared = await prepareConnectionProfile(targetProfile);
        setStatusPayload({ ...prepared.status, mobile_message: prepared.message });
        await openRpc(prepared.profile);
        setStatus('connected');
        const updated = { ...prepared.profile, wsTicket: undefined, lastUsedAt: Date.now() };
        profileRef.current = updated;
        setProfile(updated);
        setProfiles(await upsertProfile(updated));
        setTab('chat');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      } catch (e: any) {
        setWsOpen(false);
        setStatus('error'); setError(e?.message || String(e));
        setTab('home');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      }
    })();
    inFlightRef.current = run;
    run.finally(() => { inFlightRef.current = null; });
    return run;
  }, [openRpc]);

  // Reconnect: mint a fresh single-use ticket on the existing cookie session and
  // only fall back to a full password login when that session is gone.
  const reconnectNow = useCallback((silent = true, profName?: string) => {
    const target = profileRef.current;
    if (!target) return Promise.resolve();
    if (inFlightRef.current) return inFlightRef.current;
    const activeProf = profName || currentProfileNameRef.current;
    const run = (async () => {
      if (!silent) setStatus('testing');
      try {
        let runtime: ConnectionProfile | null = null;
        try {
          const restClient = new HermesRestClient(target, activeProf);
          const fresh = await restClient.wsTicket();
          if (fresh?.ticket) runtime = { ...target, token: '', authMode: 'password', wsTicket: fresh.ticket, activeProfileName: activeProf };
        } catch {}
        if (!runtime) {
          const prepared = await prepareConnectionProfile(target);
          setStatusPayload({ ...prepared.status, mobile_message: prepared.message });
          runtime = { ...prepared.profile, activeProfileName: activeProf };
        }
        await openRpc(runtime, activeProf);
        setStatus('connected');
        setError('');
      } catch (e: any) {
        setWsOpen(false);
        scheduleReconnect(e?.message);
      }
    })();
    inFlightRef.current = run;
    run.finally(() => { inFlightRef.current = null; });
    return run;
  }, [openRpc, scheduleReconnect]);

  useEffect(() => { reconnectRef.current = () => { void reconnectNow(false); }; }, [reconnectNow]);

  // Coming back to the foreground (phone unlocked / tab focused) with a dead
  // socket should reconnect silently without resetting UI state or dropping tabs.
  useEffect(() => {
    const kick = () => {
      if (!profileRef.current) return;
      reconnectAttemptRef.current = 0;
      if (rpcRef.current?.connected) {
        rpcRef.current.ping().catch(() => undefined);
        return;
      }
      void reconnectNow(true);
    };
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const onVisible = () => { if (document.visibilityState === 'visible') kick(); };
      document.addEventListener('visibilitychange', onVisible);
      return () => document.removeEventListener('visibilitychange', onVisible);
    }
    const sub = AppState.addEventListener('change', s => { if (s === 'active') kick(); });
    return () => sub.remove();
  }, [reconnectNow]);

  useEffect(() => { profileRef.current = profile; }, [profile]);

  useEffect(() => {
    // Bootstrap exactly once: load saved profiles, fall back to the default
    // backend, then run a single connect attempt.
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    let unmounted = false;
    loadProfiles().then(async (p) => {
      if (unmounted) return;
      setProfiles(p);
      const savedHermesProf = await loadSelectedHermesProfile();
      if (savedHermesProf) {
        setCurrentProfileName(savedHermesProf);
        currentProfileNameRef.current = savedHermesProf;
      }
      let targetProfile = p[0];
      if (!targetProfile) {
        targetProfile = {
          id: 'primary-profile',
          name: 'Hermes Agent',
          // Automatically use current origin when served as PWA
          baseUrl: typeof window !== 'undefined' && window.location?.origin?.startsWith('http')
            ? window.location.origin
            : '',
          token: '',
          username: '',
          password: '',
          authMode: 'password',
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
        };
        const saved = await upsertProfile(targetProfile);
        if (unmounted) return;
        setProfiles(saved);
      }
      profileRef.current = targetProfile;
      setProfile(targetProfile);
      await connect(targetProfile);
    }).catch(() => {
      if (!unmounted) setTab('home');
    });
    return () => {
      unmounted = true;
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      rpcRef.current?.close();
    };
  }, [connect]);

  return (
    <ThemeContext.Provider value={{ colors: currentColors, styles: currentStyles, isDark, toggleTheme }}>
      <SafeAreaProvider>
        <SafeAreaView style={currentStyles.safe} edges={['top', 'bottom', 'left', 'right']}>
          <LinearGradient colors={currentColors.bgGradient} style={StyleSheet.absoluteFill} />
          <View style={currentStyles.root}>
          {tab !== 'home' ? (
            <Header
              profile={profile}
              status={wsOpen ? 'connected' : status === 'connected' ? 'error' : status}
              active={tab}
              opsScreen={opsScreen}
              modelInfo={modelInfo}
              reasoningEffort={reasoningEffort}
              onModelPress={openModelPicker}
              onStatusPress={() => { setTab('settings'); setSettingsSubScreen('main'); }}
              onBack={
                tab === 'settings' && settingsSubScreen !== 'main' ? () => setSettingsSubScreen('main') :
                tab === 'ops' && opsScreen !== 'hub' ? () => setOpsScreen('hub') :
                undefined
              }
            />
          ) : null}
          <View style={styles.body}>
            {tab === 'home' && <ConnectScreen profiles={profiles} active={profile} status={status} error={error} statusPayload={statusPayload} onSelect={setProfile} onSave={async (p: ConnectionProfile) => { setProfile(p); setProfiles(await upsertProfile(p)); await connect(p); }} onDelete={async (id: string) => { setProfiles(await deleteProfile(id)); if (profile?.id === id) setProfile(null); }} />}

            {/* Chat stays mounted so typed prompt text, attachments, and scroll position are fully preserved across tab switches */}
            <View style={[{ flex: 1 }, tab !== 'chat' && { display: 'none' }]}>
              <ChatScreen
                rest={rest}
                rpc={rpcRef.current}
                events={events}
                setEvents={setEvents}
                currentProfileName={currentProfileName}
                onProfilePress={() => setProfileModalOpen(true)}
                onNewProfilePress={() => setNewProfileModalOpen(true)}
                onNavigate={(nextTab: Tab, nextOps?: OpsScreen) => { setTab(nextTab); if (nextOps) setOpsScreen(nextOps); }}
                connected={status === 'connected' && wsOpen}
                status={status}
                activeSession={activeSession}
                setActiveSession={setActiveSession}
                activeRuntimeSession={activeRuntimeSession}
                setActiveRuntimeSession={setActiveRuntimeSession}
                messages={messages}
                setMessages={setMessages}
                modelInfo={modelInfo}
                sessionModelInfo={sessionModelInfo}
                setSessionModelInfo={setSessionModelInfo}
                reasoningEffort={reasoningEffort}
                onModelPress={openModelPicker}
                streamingReasoning={streamingReasoning}
                setStreamingReasoning={setStreamingReasoning}
                flushReasoningBuffer={flushReasoningBuffer}
                sessionReasoningMapRef={sessionReasoningMapRef}
                activeSessionRef={activeSessionRef}
                messagesRef={messagesRef}
                onReconnect={() => reconnectNow(false)}
                onPendingPrompts={hydratePendingPrompts}
              />
            </View>

            {tab === 'logs' && <LogsScreen rest={rest} />}
            {tab === 'pulse' && (
              <PulseScreen rest={rest} rpc={rpcRef.current} events={events} activeSession={activeSession} setActiveSession={setActiveSession} setActiveRuntimeSession={setActiveRuntimeSession} setMessages={setMessages} setTab={setTab} setOpsScreen={setOpsScreen} />
            )}
            {tab === 'settings' && settingsSubScreen === 'main' && (
              <SettingsScreen
                rest={rest}
                profile={profile}
                statusPayload={statusPayload}
                onOpenSubScreen={setSettingsSubScreen}
                onDisconnect={async () => {
                  if (profile?.id) await deleteProfile(profile.id);
                  setProfile(null);
                  setTab('home');
                }}
              />
            )}
            {tab === 'settings' && settingsSubScreen === 'skills' && (
              <SkillsScreen rest={rest} onBack={() => setSettingsSubScreen('main')} />
            )}
            {tab === 'settings' && settingsSubScreen === 'artifacts' && (
              <ArtifactsScreen rest={rest} onBack={() => setSettingsSubScreen('main')} />
            )}
            {tab === 'settings' && settingsSubScreen === 'mcp' && (
              <McpScreen rest={rest} onBack={() => setSettingsSubScreen('main')} />
            )}
            {tab === 'settings' && settingsSubScreen === 'cron' && (
              <CronScreen rest={rest} onBack={() => setSettingsSubScreen('main')} />
            )}
            {tab === 'approvals' && <PulseScreen rest={rest} rpc={rpcRef.current} events={events} activeSession={activeSession} setActiveSession={setActiveSession} setActiveRuntimeSession={setActiveRuntimeSession} setMessages={setMessages} setTab={setTab} setOpsScreen={setOpsScreen} onBack={() => setTab('settings')} />}
            {tab === 'artifacts' && <ArtifactsScreen rest={rest} onBack={() => setTab('settings')} />}
          </View>
          {status === 'connected' ? (
            <TabBar
              active={tab === 'logs' || tab === 'pulse' || tab === 'settings' ? tab : 'chat'}
              setActive={(next) => { setTab(next); setSettingsSubScreen('main'); }}
            />
          ) : null}

          {/* Model Selection Bottom Sheet */}
          <Modal visible={modelModalOpen} transparent animationType="slide" onRequestClose={() => setModelModalOpen(false)}>
            <Pressable style={styles.modelModalScrim} onPress={() => setModelModalOpen(false)} />
            <View style={styles.modelBottomSheet}>
              <View style={styles.sheetDragHandle} />
              <View style={styles.rowBetween}>
                <Text style={styles.sectionTitle}>Select AI Model</Text>
                <Pressable onPress={() => setModelModalOpen(false)} style={styles.iconButton}>
                  <Ionicons name="close-outline" size={22} color={colors.text} />
                </Pressable>
              </View>
              <Text style={styles.muted}>Active: {sessionModelInfo?.model || modelInfo?.model || 'Loading…'} ({sessionModelInfo?.provider || modelInfo?.provider || ''})</Text>

              {/* Reasoning Effort Section */}
              <View style={styles.reasoningSection}>
                <View style={styles.rowBetween}>
                  <Text style={styles.reasoningLabel}>TINGKAT REASONING</Text>
                  {updatingReasoning ? <ActivityIndicator size="small" color={colors.primary} /> : null}
                </View>
                <View style={styles.reasoningRow}>
                  {REASONING_OPTIONS.map(opt => {
                    const active = (reasoningEffort || REASONING_AUTO) === opt.value;
                    return (
                      <Pressable
                        key={opt.value}
                        onPress={() => selectReasoning(opt.value)}
                        style={[styles.reasoningPill, active && styles.reasoningPillActive]}
                      >
                        <Text style={[styles.reasoningPillText, active && styles.reasoningPillTextActive]}>
                          {opt.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                {reasoningEffort === REASONING_AUTO ? (
                  <Text style={styles.muted}>Auto: effort is decided by the model/provider, not forced here.</Text>
                ) : null}
              </View>

              {switchingModel ? <LoadingBlock label="Mengganti model…" compact /> : (
                <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 24 }}>
                  {modelOptions?.providers?.filter((p: any) => p.models?.length).map((prov: any) => (
                    <View key={prov.slug} style={styles.providerGroup}>
                      <Text style={styles.providerHeader}>{prov.name}</Text>
                      {prov.models.map((m: string) => {
                        const isCur = m === (sessionModelInfo?.model || modelInfo?.model);
                        return (
                          <Pressable
                            key={m}
                            style={[styles.modelOptionItem, isCur && styles.modelOptionSelected]}
                            onPress={() => selectModel(prov.slug, m)}
                          >
                            <View style={{ flex: 1 }}>
                              <Text style={[styles.modelOptionTitle, isCur && { color: colors.primary }]}>{m}</Text>
                              <Text style={styles.modelOptionSub}>{prov.slug}</Text>
                            </View>
                            {isCur ? <Ionicons name="checkmark-circle" size={18} color={colors.primary} /> : <Ionicons name="chevron-forward" size={16} color={colors.faint} />}
                          </Pressable>
                        );
                      })}
                    </View>
                  ))}
                </ScrollView>
              )}
            </View>
          </Modal>

          {/* Profile Switcher Modal */}
          <Modal visible={profileModalOpen} transparent animationType="fade" onRequestClose={() => setProfileModalOpen(false)}>
            <Pressable style={styles.modelModalScrim} onPress={() => setProfileModalOpen(false)} />
            <View style={[styles.modelModal, { maxHeight: 420 }]}>
              <View style={styles.rowBetween}>
                <Text style={styles.sectionTitle}>Switch Profile</Text>
                <Pressable onPress={() => setProfileModalOpen(false)} style={styles.iconButton}>
                  <Ionicons name="close-outline" size={24} color={colors.text} />
                </Pressable>
              </View>
              <Text style={styles.muted}>Pick the active profile for your working session.</Text>
              <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 16 }}>
                {availableProfiles.map((p: any) => {
                  const isCur = p.name === currentProfileName;
                  return (
                    <Pressable
                      key={p.name}
                      style={[styles.modelOptionItem, isCur && styles.modelOptionSelected]}
                      onPress={() => switchProfile(p.name)}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.modelOptionTitle, isCur && { color: colors.primary }]}>👤 {p.name}</Text>
                        <Text style={styles.modelOptionSub}>{p.model || 'Model bawaan'} {p.is_default ? '· Primary' : ''}</Text>
                      </View>
                      {isCur ? <Ionicons name="checkmark-circle" size={18} color={colors.primary} /> : <Ionicons name="chevron-forward" size={16} color={colors.faint} />}
                    </Pressable>
                  );
                })}
              </ScrollView>
              <Button icon="add-outline" text="Create New Profile" secondary onPress={() => { setProfileModalOpen(false); setNewProfileModalOpen(true); }} />
            </View>
          </Modal>

          {/* New Profile Modal */}
          <Modal visible={newProfileModalOpen} transparent animationType="fade" onRequestClose={() => setNewProfileModalOpen(false)}>
            <Pressable style={styles.modelModalScrim} onPress={() => setNewProfileModalOpen(false)} />
            <View style={[styles.modelModal, { maxHeight: 340 }]}>
              <View style={styles.rowBetween}>
                <Text style={styles.sectionTitle}>New Profile</Text>
                <Pressable onPress={() => setNewProfileModalOpen(false)} style={styles.iconButton}>
                  <Ionicons name="close-outline" size={24} color={colors.text} />
                </Pressable>
              </View>
              <Text style={styles.muted}>Create a new profile with its own memory, skills, and config.</Text>
              <Label text="Profile Name" />
              <Input value={newProfileName} onChangeText={setNewProfileName} placeholder="misal: coder / bot" autoCapitalize="none" />
              <Button icon="add" text={creatingProfile ? "Creating..." : "Create Profile"} onPress={createProfile} />
            </View>
          </Modal>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
    </ThemeContext.Provider>
  );
}

function Header({
  profile,
  status,
  active,
  opsScreen,
  modelInfo,
  reasoningEffort,
  onModelPress,
  onStatusPress,
  onBack,
}: {
  profile: ConnectionProfile | null;
  status: Status;
  active: Tab;
  opsScreen: OpsScreen;
  modelInfo?: any;
  reasoningEffort?: string;
  onModelPress?: () => void;
  onStatusPress: () => void;
  onBack?: () => void;
}) {
  const { colors, styles, isDark, toggleTheme } = useTheme();

  return (
    <View style={styles.headerCompact}>
      {/* Left side: Back button (if any) + Logo */}
      <View style={styles.headerLeftRow}>
        {onBack ? (
          <Pressable onPress={onBack} style={styles.headerBack}>
            <Ionicons name="chevron-back" size={20} color={colors.text} />
          </Pressable>
        ) : null}
        <View style={styles.logoRow}>
          <Text style={styles.logoText}>HERMES COCKPIT</Text>
        </View>
      </View>

      {/* Right side: Switch night/light mode */}
      <View style={styles.headerRightRow}>
        <Pressable onPress={toggleTheme} style={styles.themeToggleBtn}>
          <Ionicons name={isDark ? "sunny-outline" : "moon-outline"} size={17} color={isDark ? colors.warn : colors.primary} />
        </Pressable>
      </View>
    </View>
  );
}

function TabBar({ active, setActive }: { active: 'chat' | 'logs' | 'pulse' | 'settings'; setActive: (t: 'chat' | 'logs' | 'pulse' | 'settings') => void }) {
  const { colors, styles } = useTheme();
  return <View style={styles.tabs} nativeID="cockpit-bottom-tabbar">
    {tabs.map(t => <Pressable key={t.id} onPress={() => setActive(t.id)} style={[styles.tab, active === t.id && styles.tabActive]}>
      <Ionicons name={t.icon} size={18} color={active === t.id ? colors.primary : colors.muted} />
      <Text style={[styles.tabText, active === t.id && { color: colors.text }]} numberOfLines={1}>{t.label}</Text>
    </Pressable>)}
  </View>;
}

function ConnectScreen({ profiles, active, status, error, statusPayload, onSelect, onSave, onDelete }: any) {
  const { colors, styles } = useTheme();
  const [name, setName] = useState(active?.name || 'Hermes Agent');
  const [baseUrl, setBaseUrl] = useState(active?.baseUrl || '');
  const [token, setToken] = useState(active?.token || '');
  const [username, setUsername] = useState(active?.username || '');
  const [password, setPassword] = useState(active?.password || '');
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => {
    if (active) {
      setName(active.name);
      setBaseUrl(active.baseUrl);
      setToken(active.token || '');
      setUsername(active.username || '');
      setPassword(active.password || '');
    }
  }, [active]);
  const save = () => onSave({
    id: active?.id || makeId(),
    name: name.trim() || 'Hermes Agent',
    baseUrl: normalizeBaseUrl(baseUrl),
    token: token.trim(),
    username: username.trim(),
    password,
    authMode: 'password',
    createdAt: active?.createdAt || Date.now(),
    lastUsedAt: Date.now()
  });

  return <ScrollView contentContainerStyle={styles.onboardingScreen}>
    <View style={styles.hero}>
      <Text style={styles.eyebrow}>Hermes Cockpit</Text>
      <Text style={styles.heroTitle}>Pocket cockpit</Text>
      <View style={styles.orbital}><View style={styles.orbitalRing} /><View style={[styles.orbitalRing, styles.orbitalRingTilt]} /><Image source={{ uri: '/icon-192.png' }} style={styles.orbitalLogo} /></View>
      <Text style={styles.sectionTitle}>Connect to Hermes Cockpit</Text>
      <Text style={styles.mutedCenter}>Sign in to your Hermes Agent instance.</Text>
    </View>
    <Card>
      <Label text="URL Dashboard" /><Input value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" placeholder="http://<server-ip>:8088" />
      <Label text="Username" /><Input value={username} onChangeText={setUsername} autoCapitalize="none" placeholder="username" />
      <Label text="Password" /><Input value={password} onChangeText={setPassword} secureTextEntry placeholder="••••••••" />
      <View style={{ height: 6 }} />
      <Button icon="flash-outline" text={status === 'testing' ? 'Connecting...' : 'Connect to Hermes'} onPress={save} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {statusPayload ? <Text style={styles.success}>REST OK · {safeText(statusPayload.version || statusPayload.hermes_version || 'Hermes')}</Text> : null}
      <Pressable onPress={() => setAdvanced(v => !v)} style={styles.advancedLink}><Text style={styles.advancedText}>Other options</Text><Ionicons name={advanced ? 'chevron-up' : 'chevron-down'} size={16} color={colors.primary2} /></Pressable>
      {advanced ? <View style={styles.advancedPanel}>
        <Label text="Profile name" /><Input value={name} onChangeText={setName} placeholder="Hermes Agent" />
        <Label text="Session token (optional)" /><Input value={token} onChangeText={setToken} autoCapitalize="none" secureTextEntry placeholder="Usually auto-discovered" />
      </View> : null}
    </Card>
    {profiles.length ? <Card><Text style={styles.sectionTitle}>Saved backends</Text>{profiles.map((p: ConnectionProfile) => <Pressable key={p.id} style={styles.listItem} onPress={() => onSelect(p)}><View style={{ flex: 1 }}><Text style={styles.listTitle}>{p.name}</Text><Text style={styles.listSub} numberOfLines={1}>{p.baseUrl} · {p.authMode || 'auto'}</Text></View><Pressable onPress={() => onDelete(p.id)} style={styles.compactIcon}><Ionicons name="trash-outline" size={17} color={colors.bad} /></Pressable></Pressable>)}</Card> : null}
  </ScrollView>;
}


let activeVoiceAudio: HTMLAudioElement | null = null;
// SFX streaming WAJIB ditahan di module scope: kalau cuma variabel lokal, elemen
// Audio bisa di-GC tepat setelah playVoiceAlert() return dan suaranya mati.
let activeSfxAudio: HTMLAudioElement | null = null;
let lastStreamChimeAt = 0;
let queuedVoiceTimer: any = null;
let hasStreamedThisTurn = false;

export function playVoiceAlert(
  type: 'processing' | 'streaming' | 'allclear',
  meta?: { provider?: string; model?: string; reasoning?: string }
) {
  try {
    if (typeof window === 'undefined') return;
    const enabled = window.localStorage.getItem('hermes-mobile.voice-alert-enabled.v1') !== 'false';
    if (!enabled) return;

    // 'streaming' is a quick cyberpunk SFX chime — play immediately in its own audio channel!
    if (type === 'streaming') {
      // Dedupe: jalur message.delta dan effect isResponding bisa menembak hampir
      // bersamaan untuk turn yang sama; satu chime per ~1.2s sudah cukup.
      const nowMs = Date.now();
      if (nowMs - lastStreamChimeAt < 1200) return;
      lastStreamChimeAt = nowMs;
      try { activeSfxAudio?.pause(); } catch {}
      const sfx = new Audio('/sounds/streaming.mp3');
      sfx.volume = 0.95;
      activeSfxAudio = sfx;
      sfx.onended = () => { if (activeSfxAudio === sfx) activeSfxAudio = null; };
      const sp = sfx.play();
      if (sp && typeof sp.catch === 'function') sp.catch(() => {});
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([35]);
      }
      return;
    }

    if (queuedVoiceTimer) {
      clearTimeout(queuedVoiceTimer);
      queuedVoiceTimer = null;
    }

    // For allclear: cut any still-playing voice announcement so the allclear chime plays on time
    if (type === 'allclear' && activeVoiceAudio) {
      try { activeVoiceAudio.pause(); activeVoiceAudio.currentTime = 0; } catch {}
      activeVoiceAudio = null;
    }

    if (activeVoiceAudio && !activeVoiceAudio.paused && !activeVoiceAudio.ended) {
      const dur = activeVoiceAudio.duration || 0.8;
      const cur = activeVoiceAudio.currentTime || 0;
      const waitMs = Math.max(200, Math.round((dur - cur) * 1000) + 150);
      queuedVoiceTimer = setTimeout(() => {
        queuedVoiceTimer = null;
        playVoiceAlert(type, meta);
      }, waitMs);
      return;
    }

    let soundUrl = '/sounds/allclear.mp3';
    if (type === 'processing') {
      const prov = encodeURIComponent(meta?.provider || '');
      const mdl = encodeURIComponent(meta?.model || '');
      const rsn = encodeURIComponent(meta?.reasoning || '');
      soundUrl = prov || mdl
        ? `/api/voice/announce?provider=${prov}&model=${mdl}&reasoning=${rsn}`
        : '/sounds/processing.mp3';
    }

    const audio = new Audio(soundUrl);
    audio.volume = 0.92;
    activeVoiceAudio = audio;

    audio.onended = () => {
      if (activeVoiceAudio === audio) activeVoiceAudio = null;
    };

    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {});
    }

    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      if (type === 'processing') {
        navigator.vibrate([50]);
      } else {
        navigator.vibrate([60, 40, 60]);
      }
    }
  } catch {}
}

function smartMergeTranscript(committed: string, incoming: string): string {
  const c = committed.trim();
  const inc = incoming.trim();
  if (!c) return inc;
  if (!inc) return c;

  const cWords = c.split(/\s+/);
  const incWords = inc.split(/\s+/);

  // 1. If incoming starts with similar prefix or covers the same sentence, incoming is a revision!
  let commonStart = 0;
  for (let i = 0; i < Math.min(cWords.length, incWords.length); i++) {
    if (cWords[i].toLowerCase() === incWords[i].toLowerCase()) {
      commonStart++;
    } else {
      break;
    }
  }

  if (commonStart >= 1 && (commonStart >= cWords.length * 0.3 || commonStart >= 2)) {
    return inc;
  }

  // 2. Check suffix/prefix word overlap
  const maxOverlap = Math.min(cWords.length, incWords.length);
  for (let k = maxOverlap; k > 0; k--) {
    const cTail = cWords.slice(-k).map(w => w.toLowerCase()).join(' ');
    const incHead = incWords.slice(0, k).map(w => w.toLowerCase()).join(' ');
    if (cTail === incHead) {
      return [...cWords, ...incWords.slice(k)].join(' ');
    }
  }

  if (inc.toLowerCase().startsWith(c.toLowerCase())) return inc;
  if (c.toLowerCase().startsWith(inc.toLowerCase())) return c;

  return `${c} ${inc}`;
}

function ChatScreen({ rest, rpc, events, setEvents, currentProfileName, onProfilePress, onNewProfilePress, onNavigate, connected, status, activeSession, setActiveSession, activeRuntimeSession, setActiveRuntimeSession, messages, setMessages, modelInfo, sessionModelInfo, setSessionModelInfo, reasoningEffort, onModelPress, streamingReasoning, setStreamingReasoning, flushReasoningBuffer, sessionReasoningMapRef, activeSessionRef, messagesRef, onReconnect, onPendingPrompts }: any) {
  const { colors, styles, isDark, toggleTheme } = useTheme();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const activeSessionObj = useMemo(() => sessions.find((s: SessionSummary) => sessionId(s) === activeSession), [sessions, activeSession]);
  // Model sesi menang atas model default profil — biar pill ikut sesi yang dibuka.
  const pillModel = sessionModelInfo?.model || (activeSessionObj?.model as string) || modelInfo?.model;
  const rawModel = pillModel
    ? (pillModel.includes('/') ? pillModel.split('/').pop() : pillModel)
    : 'Model';
  const baseModel = rawModel.replace(/^gemini-/, '');
  const shortModel = reasoningEffort && reasoningEffort !== 'none' && reasoningEffort !== REASONING_AUTO
    ? `${baseModel} · ${reasoningEffort}`
    : baseModel;

  // Sync sessionModelInfo into sessions list so drawer and history remain consistent
  useEffect(() => {
    if (sessionModelInfo?.model && activeSession) {
      setSessions((prev: SessionSummary[]) =>
        prev.map(s => sessionId(s) === activeSession ? { ...s, model: sessionModelInfo.model } : s)
      );
    }
  }, [sessionModelInfo?.model, activeSession]);

  const [drawerVisible, setDrawerVisible] = useState(false);
  const [sessionContext, setSessionContext] = useState<{ used: number; total: number; pct: number }>({
    used: 0,
    total: 1000000,
    pct: 0,
  });

  const loadSessionContext = useCallback(async (sid?: string) => {
    const targetSid = sid || activeSession || activeRuntimeSession;
    if (!targetSid) return;
    try {
      const prof = encodeURIComponent(currentProfileName || 'hermes-cockpit');
      const res = await fetch(`/api/session-context?session_id=${encodeURIComponent(targetSid)}&profile=${prof}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.used === 'number') {
          setSessionContext({
            used: data.used,
            total: data.total || 1000000,
            pct: data.pct || 0,
          });
        }
      }
    } catch {}
  }, [activeRuntimeSession, activeSession, currentProfileName]);

  useEffect(() => {
    if (activeRuntimeSession || activeSession) {
      void loadSessionContext();
    }
  }, [activeRuntimeSession, activeSession, loadSessionContext]);
  const drawerSlideAnim = useRef(new Animated.Value(0)).current;
  const [drawerMode, setDrawerMode] = useState<'chats' | 'cron'>('chats');
  const [drawerQuery, setDrawerQuery] = useState('');
  // Skala teks chat (0.9 / 1 / 1.15) — disimpan di localStorage.
  const [textScale, setTextScale] = useState(1);
  useEffect(() => {
    let alive = true;
    const read = () => { loadTextScale().then(v => { if (alive) setTextScale(v); }).catch(() => undefined); };
    read();
    if (typeof window === 'undefined' || !window.addEventListener) return () => { alive = false; };
    window.addEventListener(TEXT_SCALE_EVENT, read);
    return () => { alive = false; window.removeEventListener(TEXT_SCALE_EVENT, read); };
  }, []);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  // Active Pending Controls in Chat (Approvals & Clarify)
  const [respondingControl, setRespondingControl] = useState(false);
  const [clarifyAnswerText, setClarifyAnswerText] = useState('');
  const [clarifySelectedChoices, setClarifySelectedChoices] = useState<string[]>([]);
  const [dismissedClarifyIds, setDismissedClarifyIds] = useState<Set<string>>(new Set());

  // Find the active approval and clarify for this session
  const activeApproval = useMemo(() => {
    // Check if there is a settled event for this prompt
    const settledIds = new Set(
      (events || [])
        .filter((e: HermesEvent) => e.type === 'approval.settled')
        .map((e: HermesEvent) => e.payload?.prompt_id || e.payload?.request_id)
        .filter(Boolean)
    );
    return (events || []).find((e: HermesEvent) => {
      const matchSid = !e.session_id || e.session_id === activeSession || e.session_id === activeRuntimeSession;
      const pid = e.payload?.prompt_id || e.payload?.request_id;
      return matchSid && e.type === 'approval.request' && (!pid || !settledIds.has(pid));
    });
  }, [events, activeSession, activeRuntimeSession]);

  const activeClarify = useMemo(() => {
    // Check if there is a settled event for this clarify prompt
    const settledIds = new Set(
      (events || [])
        .filter((e: HermesEvent) => e.type === 'clarify.settled' || (e.type === 'request.cancel' && (e.payload?.method === 'clarify' || !e.payload?.method)))
        .map((e: HermesEvent) => e.payload?.prompt_id || e.payload?.request_id || e.payload?.id)
        .filter(Boolean)
    );
    return (events || []).find((e: HermesEvent) => {
      const matchSid = !e.session_id || e.session_id === activeSession || e.session_id === activeRuntimeSession;
      const pid = e.payload?.prompt_id || e.payload?.request_id || e.payload?.clarify_id || e.payload?.id;
      return matchSid && e.type === 'clarify.request' && (!pid || (!settledIds.has(pid) && !dismissedClarifyIds.has(pid)));
    });
  }, [events, activeSession, activeRuntimeSession, dismissedClarifyIds]);

  const handleApprovalRespond = async (choice: 'once' | 'deny' | 'session' | 'always') => {
    if (!activeApproval || !rpc) return;
    setRespondingControl(true);
    try {
      const p = activeApproval.payload || {};
      const promptId = p.prompt_id || p.request_id || activeApproval.session_id || '';
      const gen = p.execution_generation;
      const targetSid = activeApproval.session_id || activeRuntimeSession || activeSession;
      await rpc.approval(targetSid, choice, promptId, gen);
    } catch (e: any) {
      Alert.alert('Approval Error', e?.message || 'Gagal merespon approval');
    } finally {
      setRespondingControl(false);
    }
  };

  const resumeSessionHydrated = async (sid: string) => {
    const r: any = await rpc.resumeSession(sid);
    onPendingPrompts?.(sid, r?.prompts);
    return r;
  };

  // Antrean: serahkan teks ke turn yang sedang jalan, atau batalkan admission-nya.
  const steerQueuedNow = async () => {
    if (!queuedAdmission || !rpc) return;
    const sid = activeRuntimeSession || activeSession;
    try {
      await rpc.steerQueued(sid, queuedAdmission.admission_id);
      setQueuedAdmission(null);
    } catch (e: any) {
      setErr(e?.message || 'Gagal mengirim ke turn berjalan');
    }
  };

  const cancelQueuedNow = async () => {
    if (!queuedAdmission || !rpc) return;
    const sid = activeRuntimeSession || activeSession;
    try {
      await rpc.cancelQueued(sid, queuedAdmission.admission_id);
      setQueuedAdmission(null);
    } catch (e: any) {
      setErr(e?.message || 'Gagal membatalkan antrean');
    }
  };

  const handleClarifySubmit = async (overrideAnswer?: string) => {
    if (!activeClarify || !rpc) return;
    setRespondingControl(true);
    try {
      const p = activeClarify.payload || {};
      const promptId = p.prompt_id || p.request_id || p.clarify_id || p.id || '';
      const gen = p.execution_generation;
      const qid = p.qid || (p.questions && p.questions[0]?.qid) || 'q0';
      const targetSid = activeClarify.session_id || activeRuntimeSession || activeSession;
      let finalAns = overrideAnswer;
      if (finalAns === undefined) {
        if (p.multi_select) {
          finalAns = clarifySelectedChoices.join(', ');
        } else {
          finalAns = clarifyAnswerText.trim() || clarifySelectedChoices[0] || '';
        }
      }
      await rpc.clarify(targetSid, finalAns || '', promptId, gen, qid);
      setDismissedClarifyIds(prev => new Set(prev).add(promptId));
      if (typeof setEvents === 'function') {
        setEvents((prev: any) => [...prev, {
          type: 'clarify.settled',
          session_id: targetSid,
          receivedAt: Date.now(),
          payload: { prompt_id: promptId, request_id: promptId }
        }]);
      }
      setClarifyAnswerText('');
      setClarifySelectedChoices([]);
    } catch (e: any) {
      Alert.alert('Clarify Error', e?.message || 'Gagal merespon klarifikasi');
    } finally {
      setRespondingControl(false);
    }
  };

  // SPA nggak pernah narik ulang bundle sendiri: app yang dibiarkan terbuka bisa
  // jalanin versi lama berjam-jam (kejadian nyata — /context masih pakai jalur lama
  // padahal server udah punya build baru). Cek saat app balik ke depan + sekali
  // setelah mount, lalu reload kalau nama bundle-nya beda.
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  // Note: Automated location.reload() polling is disabled to prevent abrupt page restarts during chat.
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false);
  const [sessionOffset, setSessionOffset] = useState(0);
  const [sessionsHasMore, setSessionsHasMore] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [err, setErr] = useState('');
  // --- Offline banner: track browser online/offline + WS drop ---
  const [online, setOnline] = useState(Platform.OS === 'web' && typeof navigator !== 'undefined' ? navigator.onLine : true);
  const wasConnectedRef = useRef(false);
  useEffect(() => {
    if (wasConnectedRef.current || !connected) return;
    wasConnectedRef.current = true;
  }, [connected]);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onOnline = () => {
      setOnline(true);
      // Browser kembali online → langsung trigger reconnect kalau WS juga drop
      if (wasConnectedRef.current && !connected) void onReconnect?.();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [connected, onReconnect]);
  const [catalog, setCatalog] = useState<{ name: string; description: string }[]>([]);
  const [infoModal, setInfoModal] = useState<{ title: string; body: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachmentItem[]>([]);
  const [isListening, setIsListening] = useState(false);
  const isListeningRef = useRef(false);
  const recognitionRef = useRef<any>(null);
  const basePromptRef = useRef<string>('');
  const committedTextRef = useRef<string>('');
  const micPressStartRef = useRef<number>(0);
  const promptValueRef = useRef(prompt);
  useEffect(() => { promptValueRef.current = prompt; }, [prompt]);
  const messageDurationStoreRef = useRef<Record<string, number>>({});
  const thinkingSecondsRef = useRef(0);

  const stopListening = useCallback(() => {
    if (!isListeningRef.current) return;
    isListeningRef.current = false;
    setIsListening(false);
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate([25]);
    }
    // JANGAN hapus onresult sebelum stop()!
    // Di Web Speech API, stop() adalah perintah untuk memfinalisasi audio yang sudah direkam
    // dan mengirimkan hasil transkrip finalnya ke onresult.
    if (recognitionRef.current) {
      try {
        const r = recognitionRef.current;
        r.stop();
      } catch {}
    }
  }, []);

  const startListening = useCallback(() => {
    if (isListeningRef.current) return;

    const SpeechRec = typeof window !== 'undefined' && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
    if (!SpeechRec) {
      setInfoModal({
        title: 'Voice-to-Text',
        body: 'Web Speech API tidak didukung di browser ini. Pastikan menggunakan Chrome / Android WebView.'
      });
      return;
    }

    try {
      basePromptRef.current = promptValueRef.current.trim() ? promptValueRef.current.trim() + ' ' : '';
      committedTextRef.current = '';
      isListeningRef.current = true;
      setIsListening(true);

      const spawnAndStart = () => {
        if (!isListeningRef.current) return;
        try {
          const rec = new SpeechRec();
          rec.continuous = true;
          rec.interimResults = true;
          rec.maxAlternatives = 1;
          rec.lang = 'id-ID';

          rec.onstart = () => {
            if (typeof navigator !== 'undefined' && navigator.vibrate) {
              navigator.vibrate([45]);
            }
          };

          rec.onresult = (event: any) => {
            const rawChunks: string[] = [];
            const len = event.results ? event.results.length : 0;
            for (let i = 0; i < len; i++) {
              const res = event.results[i];
              const text = (res && res[0] && res[0].transcript ? res[0].transcript : '').trim();
              if (text) rawChunks.push(text);
            }

            // Deduplikasi progresif
            const cleaned: string[] = [];
            for (const item of rawChunks) {
              if (!cleaned.length) {
                cleaned.push(item);
                continue;
              }
              const last = cleaned[cleaned.length - 1];
              if (item.toLowerCase().startsWith(last.toLowerCase())) {
                cleaned[cleaned.length - 1] = item;
              } else if (last.toLowerCase().startsWith(item.toLowerCase())) {
                continue;
              } else {
                cleaned.push(item);
              }
            }

            const current = cleaned.join(' ').replace(/\s+/g, ' ').trim();
            const full = smartMergeTranscript(committedTextRef.current, current);
            if (full) {
              setPrompt(basePromptRef.current + full);
            }
          };

          rec.onerror = (e: any) => {
            console.warn('Speech recognition error:', e.error);
            if (e.error === 'no-speech' || e.error === 'aborted') return;
            if (e.error === 'not-allowed') {
              stopListening();
              setInfoModal({
                title: 'Izin Mikrofon',
                body: 'Izin mikrofon belum diberikan. Izinkan akses mikrofon di pengaturan browser/HP.'
              });
              return;
            }
          };

          rec.onend = () => {
            if (isListeningRef.current) {
              const currentPrompt = promptValueRef.current.trim();
              const base = basePromptRef.current.trim();
              if (currentPrompt.startsWith(base)) {
                committedTextRef.current = currentPrompt.slice(base.length).trim() ? currentPrompt.slice(base.length).trim() + ' ' : '';
              }
              setTimeout(() => {
                if (isListeningRef.current) spawnAndStart();
              }, 50);
            } else {
              recognitionRef.current = null;
            }
          };

          recognitionRef.current = rec;
          rec.start();
        } catch (err) {
          console.warn('Speech spawn error:', err);
        }
      };

      spawnAndStart();
    } catch (err: any) {
      stopListening();
      setInfoModal({
        title: 'Voice-to-Text Error',
        body: err?.message || 'Gagal memulai speech recognition.'
      });
    }
  }, [stopListening]);

  const handleMicDown = useCallback((e?: any) => {
    micPressStartRef.current = Date.now();
    if (e && e.target && typeof e.target.setPointerCapture === 'function') {
      try { e.target.setPointerCapture(e.pointerId); } catch {}
    }
    if (!isListeningRef.current) {
      startListening();
    }
  }, [startListening]);

  const handleMicUp = useCallback((e?: any) => {
    if (e && e.target && typeof e.target.releasePointerCapture === 'function') {
      try { e.target.releasePointerCapture(e.pointerId); } catch {}
    }
    const elapsed = Date.now() - micPressStartRef.current;
    if (elapsed > 350) {
      // Mode TAHAN (Hold-to-speak): Lepas jari = otomatis selesai & berhenti
      stopListening();
    } else {
      // Mode TAP: Sentuhan singkat (< 350ms) -> biarkan tetap mendengarkan agar user tidak perlu repot menahan jempol terus
    }
  }, [stopListening]);

  const handleMicClick = useCallback(() => {
    const elapsed = Date.now() - micPressStartRef.current;
    if (elapsed <= 350 && isListeningRef.current) {
      // Tap kedua saat mic sedang aktif: matikan
      stopListening();
    }
  }, [stopListening]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [hasSubmittedSearch, setHasSubmittedSearch] = useState(false);
  const INITIAL_VISIBLE_COUNT = 40;
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT);

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_COUNT);
  }, [activeSession]);
  const messageModelStoreRef = useRef<Record<string, string>>({});
  const messageYPositionsRef = useRef<Record<string, number>>({});
  const handleMessageLayout = useCallback((id: string, y: number) => {
    messageYPositionsRef.current[id] = y;
  }, []);
  const loadSessionsRef = useRef<any>(null);

  const activeModelName = pillModel || 'Model';
  const sessionModel = useMemo(() => {
    return activeModelName;
  }, [activeModelName]);

  useEffect(() => {
    loadMessageModels().then(saved => {
      if (saved) messageModelStoreRef.current = { ...saved, ...messageModelStoreRef.current };
    });
  }, []);

  // Whenever active model changes, freeze existing messages to their previous model so history is preserved
  const prevModelRef = useRef<string | null>(null);
  useEffect(() => {
    if (modelInfo?.model) {
      if (prevModelRef.current && prevModelRef.current !== modelInfo.model) {
        const freezeModel = prevModelRef.current;
        let changed = false;
        for (const m of messages) {
          if (m.role === 'assistant' && m.id && !messageModelStoreRef.current[m.id]) {
            messageModelStoreRef.current[m.id] = m.model || freezeModel;
            changed = true;
          }
        }
        if (changed) {
          saveMessageModels(messageModelStoreRef.current).catch(() => undefined);
        }
      }
      prevModelRef.current = modelInfo.model;
    }
  }, [modelInfo?.model, messages]);

  // Ensure latest assistant message model is indexed in store
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && last.id) {
      const cur = last.model || activeModelName;
      if (cur && messageModelStoreRef.current[last.id] !== cur) {
        messageModelStoreRef.current[last.id] = cur;
        saveMessageModels(messageModelStoreRef.current).catch(() => undefined);
      }
    }
  }, [messages, activeModelName]);

  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(new Set());

  const syncRunningSessions = useCallback(async () => {
    try {
      const res = await fetch(`/api/active-sessions?profile=${encodeURIComponent(currentProfileName)}`);
      const json = await res.json();
      if (Array.isArray(json?.active)) {
        setRunningSessionIds(new Set(json.active));
      }
      if (Array.isArray(json?.leases)) {
        for (const l of json.leases) {
          if (l.session_id && l.acquired_at > 0) {
            turnStartTimesRef.current[l.session_id] = l.acquired_at;
            try {
              if (typeof localStorage !== 'undefined') {
                localStorage.setItem(`cockpit_turn_start_${l.session_id}`, String(l.acquired_at));
              }
            } catch {}
          }
        }
      }
    } catch {}
  }, [currentProfileName]);

  const recordMessageModel = useCallback((msgId: string, modelName: string) => {
    if (!msgId || !modelName) return;
    if (messageModelStoreRef.current[msgId] === modelName) return;
    messageModelStoreRef.current[msgId] = modelName;
    saveMessageModels(messageModelStoreRef.current).catch(() => undefined);
  }, []);

  const fileInputRef = useRef<any>(null);

  const pickFiles = () => {
    if (Platform.OS === 'web' && fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  const handleFileChange = (e: any) => {
    const files: any[] = Array.from(e.target?.files || []);
    if (!files.length) return;
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) {
        setErr(`File ${file.name} melebihi batas 25MB`);
        continue;
      }
      const reader = new FileReader();
      const isImg = file.type?.startsWith('image/');
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        const base64 = dataUrl.includes(';base64,') ? dataUrl.split(';base64,')[1] : '';
        setAttachments(prev => [
          ...prev,
          {
            id: makeId(),
            name: file.name || 'file',
            size: file.size || 0,
            type: isImg ? 'image' : 'file',
            mime: file.type || 'application/octet-stream',
            dataUrl,
            base64,
          }
        ]);
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
  };
  // Chat scroll: stay pinned to the newest message unless the user scrolled up.
  const scrollRef = useRef<any>(null);
  const stickToBottomRef = useRef(true);
  const contentHeightRef = useRef(0);
  const scrollDebounceRef = useRef<any>(null);
  const isUserTouchingRef = useRef(false);
  // Scroll programatik juga memicu onScroll. Tanpa jendela ini, auto-follow membaca
  // posisi frame tengah-animasi miliknya sendiri, mengira user scroll naik, lalu
  // melepas pin — persis penyebab streaming berhenti auto-scroll.
  const programmaticScrollAtRef = useRef(0);
  // Handle safety-timeout 'busy' 120s: WAJIB disimpan supaya bisa di-clear saat turn
  // benar-benar selesai (kalau tidak, thinking box mati sendiri di menit ke-2).
  const safetyBusyTimerRef = useRef<any>(null);
  // Pesan yang diantre saat turn masih jalan (prompt.submit → status 'queued').
  const [queuedAdmission, setQueuedAdmission] = useState<{ admission_id: string; text: string } | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const scrollToBottom = useCallback((animated = true) => {
    const node = scrollRef.current;
    if (!node) return;
    programmaticScrollAtRef.current = Date.now();
    try {
      if (Platform.OS === 'web') {
        const domNode = node.getScrollableNode ? node.getScrollableNode() : (node.target || node);
        if (domNode) {
          const targetY = domNode.scrollHeight || 999999;
          // React Native Web's patched scrollTo expects { x, y, animated }
          if (typeof domNode.scrollTo === 'function') {
            domNode.scrollTo({ y: targetY, animated });
          } else {
            domNode.scrollTop = targetY;
          }
          return;
        }
      }
      node.scrollToEnd({ animated });
    } catch {
      try { node.scrollToEnd({ animated }); } catch {}
    }
  }, []);

  const autoScrollToBottom = useCallback((animated = true) => {
    if (!stickToBottomRef.current) return;
    // Trailing debounce: pertahankan panggilan TERAKHIR, bukan membuang semua
    // panggilan yang datang saat timer masih pending (delta token datang cepat).
    if (scrollDebounceRef.current) clearTimeout(scrollDebounceRef.current);
    scrollDebounceRef.current = setTimeout(() => {
      scrollDebounceRef.current = null;
      scrollToBottom(animated);
    }, 40);
  }, [scrollToBottom]);

  const onChatScroll = (event: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = event?.nativeEvent || {};
    if (!contentOffset || !contentSize || !layoutMeasurement) return;
    // Abaikan scroll yang kita picu sendiri (frame animasi tengah jalan bikin
    // distanceFromBottom terlihat besar padahal targetnya dasar). Drag/touch user
    // tetap dihormati: kalau jari sedang menempel, guard ini dilewati.
    if (!isUserTouchingRef.current && Date.now() - programmaticScrollAtRef.current < 350) return;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);

    // If user scrolled up by more than 60px, respect the user and do not yank them down!
    // Re-stick only when user scrolls back near the very bottom (within 35px).
    if (distanceFromBottom > 60) {
      stickToBottomRef.current = false;
    } else if (distanceFromBottom <= 35) {
      stickToBottomRef.current = true;
    }
    // Tombol "ke pesan terbaru" hanya saat user benar-benar menjauh dari dasar.
    setShowJumpToLatest(distanceFromBottom > 220);
  };


  const visibleMessages = messages.filter(isVisibleMessage);

  const searchMatches = useMemo(() => {
    if (!searchOpen || !searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase().trim();
    const list: { id: string; index: number }[] = [];
    visibleMessages.forEach((m: Message, idx: number) => {
      const textMatch = m.text && m.text.toLowerCase().includes(q);
      const toolMatch = m.parts?.some(p => p.kind !== 'text' && (
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.summary && p.summary.toLowerCase().includes(q)) ||
        (p.detail && p.detail.toLowerCase().includes(q))
      ));
      if (textMatch || toolMatch) {
        list.push({ id: m.id, index: idx });
      }
    });
    return list;
  }, [visibleMessages, searchOpen, searchQuery]);

  const scrollToMatch = useCallback((targetIndex: number) => {
    if (!searchMatches.length) return;
    const clamped = (targetIndex + searchMatches.length) % searchMatches.length;
    setSearchMatchIndex(clamped);
    const target = searchMatches[clamped];
    if (!target) return;

    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const el = document.getElementById(`msg-${target.id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
    }
    const y = messageYPositionsRef.current[target.id];
    if (typeof y === 'number' && scrollRef.current) {
      scrollRef.current.scrollTo({ y: Math.max(0, y - 60), animated: true });
    }
  }, [searchMatches]);

  useEffect(() => {
    if (searchOpen && searchMatches.length > 0) {
      const currentMatch = searchMatches[searchMatchIndex];
      if (currentMatch) {
        const matchIdxFromEnd = visibleMessages.length - currentMatch.index;
        if (matchIdxFromEnd > visibleCount) {
          setVisibleCount(matchIdxFromEnd + 10);
        }
      }
    }
  }, [searchOpen, searchMatches, searchMatchIndex, visibleMessages.length, visibleCount]);

  const handleSearchSubmit = useCallback(() => {
    if (!searchMatches.length) return;
    setHasSubmittedSearch(true);
    const nextIdx = hasSubmittedSearch ? (searchMatchIndex + 1) % searchMatches.length : 0;
    scrollToMatch(nextIdx);
  }, [searchMatches, hasSubmittedSearch, searchMatchIndex, scrollToMatch]);

  const currentTurnToolCalls = useMemo(() => {
    const lastUserIdx = visibleMessages.map((m: Message) => m.role).lastIndexOf('user');
    if (lastUserIdx === -1) return [];
    const calls: NonTextPart[] = [];
    for (let i = lastUserIdx + 1; i < visibleMessages.length; i++) {
      calls.push(...nonTextParts(visibleMessages[i]));
    }
    return calls;
  }, [visibleMessages]);

  const liveTurnTokens = useMemo(() => {
    let charCount = streamingReasoning?.length || 0;
    for (const p of currentTurnToolCalls) {
      charCount += (p.name?.length || 0) + (p.summary?.length || 0) + (p.detail?.length || 0);
    }
    const lastUser = [...visibleMessages].reverse().find(m => m.role === 'user');
    if (lastUser) charCount += (lastUser.text?.length || 0);
    const lastMsg = visibleMessages[visibleMessages.length - 1];
    if (lastMsg?.role === 'assistant') charCount += (lastMsg.text?.length || 0);
    const toolOverhead = currentTurnToolCalls.length * 1150;
    return Math.max(120, Math.round(charCount / 3.6) + toolOverhead);
  }, [currentTurnToolCalls, streamingReasoning, visibleMessages]);

  const syncMessages = useCallback(async (retryCount = 0, force = false) => {
    if (!rest || !activeSession) return;
    const targetSid = activeSession;
    try {
      const data = await fetchTranscript(rest, targetSid, force ? 0 : TRANSCRIPT_TTL_MS);
      if (activeSessionRef?.current !== targetSid) return;
      const activeModel = pillModel || modelInfo?.model || 'Model';
      const normalized = normalizeMessages(data, activeModel, messageModelStoreRef.current);
      if (normalized && normalized.length > 0) {
        setMessages((prev: Message[]) => {
          if (!prev.length) return normalized;

          // Merge server messages by canonical ID and maintain strict chronological order
          const msgMap = new Map<string, Message>();
          // Keep previously loaded server messages
          for (const m of prev) {
            if (!isNaN(Number(m.id))) {
              msgMap.set(m.id, m);
            }
          }
          // Overwrite / add newest from server
          for (const m of normalized) {
            msgMap.set(m.id, m);
          }

          // Sort all server messages strictly by database row ID (numeric) or timestamp
          const sortedServerMessages = Array.from(msgMap.values()).sort((a, b) => {
            const numA = Number(a.id);
            const numB = Number(b.id);
            if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
            return (a.at || 0) - (b.at || 0);
          });

          // Keep only recent local in-flight uncommitted prompts (e.g. submitted < 25s ago)
          const recentPending = prev.filter(p => {
            if (!isNaN(Number(p.id))) return false; // already a server message
            if (Date.now() - (p.at || 0) > 25000) return false; // expired
            if (p.role === 'user') {
              const textP = p.text.trim();
              return !normalized.some(n => n.role === 'user' && n.text.trim() === textP);
            }
            return false;
          });

          return [...sortedServerMessages, ...recentPending];
        });
        saveMessageModels(messageModelStoreRef.current).catch(() => undefined);
      }
      void loadSessionContext(targetSid);
    } catch {}
  }, [rest, activeSession, setMessages, modelInfo?.model, loadSessionContext]);

  // When switching back to the app/tab from background, ALWAYS resync messages and check live turn!
  useEffect(() => {
    const handleFocus = async () => {
      void syncMessages();
      if (!activeSession || !rest) return;
      try {
        // Probe server-side active sessions lease
        const res = await fetch(`/api/active-sessions?profile=${encodeURIComponent(currentProfileName)}`);
        const json = await res.json();
        const activeIds: string[] = Array.isArray(json?.active) ? json.active : [];
        if (activeIds.includes(activeSession)) {
          setBusy(true);
        } else {
        }
        if (Array.isArray(json?.leases)) {
          for (const l of json.leases) {
            if (l.session_id && l.acquired_at > 0) {
              turnStartTimesRef.current[l.session_id] = l.acquired_at;
              try {
                if (typeof localStorage !== 'undefined') {
                  localStorage.setItem(`cockpit_turn_start_${l.session_id}`, String(l.acquired_at));
                }
              } catch {}
            }
          }
        }

        // Restore any live reasoning from newest tail
        const tail = await rest.sessionTail(activeSession, 5);
        const rows: any[] = Array.isArray(tail?.messages) ? tail.messages : (Array.isArray(tail?.data) ? tail.data : []);
        if (rows.length > 0) {
          const lastWithReasoning = [...rows].reverse().find(r => r.reasoning || r.reasoning_content);
          const last = rows[rows.length - 1];
          const isTurnStillActive = last?.role === 'user' || (last?.role === 'assistant' && !safeText(last?.content || last?.text).trim());
          if (lastWithReasoning && isTurnStillActive) {
            const serverReasoning = safeText(lastWithReasoning.reasoning_content || lastWithReasoning.reasoning);
            if (serverReasoning) {
              if (sessionReasoningMapRef?.current) sessionReasoningMapRef.current[activeSession] = serverReasoning;
              setStreamingReasoning?.(serverReasoning);
            }
          }
          if (isTurnStillActive) {
            setBusy(true);
          }
        }
      } catch {}
    };
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const onVisChange = () => {
        if (document.visibilityState === 'visible') void handleFocus();
      };
      document.addEventListener('visibilitychange', onVisChange);
      window.addEventListener('focus', () => void handleFocus());
      return () => {
        document.removeEventListener('visibilitychange', onVisChange);
        window.removeEventListener('focus', () => void handleFocus());
      };
    }
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void handleFocus();
    });
    return () => sub.remove();
  }, [rest, activeSession, syncMessages, setStreamingReasoning]);



  const turnStartTimesRef = useRef<Record<string, number>>({});
  // Grace window setelah submit: transcript tail masih menampilkan baris assistant
  // dari turn SEBELUMNYA sampai backend meng-commit pesan user baru. Tanpa ini,
  // heuristik "turn selesai" langsung menembak → busy=false (all clear) lalu true
  // lagi = processing → allclear → processing, dan chime streaming ikut terlewat.
  const submitGraceUntilRef = useRef(0);
  // Turn yang sudah ditutup oleh event WS `message.complete`. Poller DB tidak boleh
  // menghidupkan lagi `busy` untuk turn yang sama (tail DB sering telat nulis).
  const terminalTurnStartRef = useRef(0);
  // REST-authoritative completion: prompt terakhir yang kita kirim + penanda turn tuntas.
  // UI tidak boleh bergantung pada satu channel saja (WS bisa putus / lease nempel).
  const lastSubmittedTextRef = useRef('');
  const turnDoneRef = useRef(false);
  const tailSigRef = useRef<{ sig: string; hits: number }>({ sig: '', hits: 0 });
  const lastEventAtRef = useRef(0);

  useEffect(() => {
    const t = (events || [])[0]?.receivedAt || 0;
    if (t) lastEventAtRef.current = t;
  }, [events]);

  // Live "what the agent is doing": only poll when busy is true to prevent endless background jitter
  useEffect(() => {
    if (!rest || !connected || !activeSession || !busy) {
      return;
    }
    let cancelled = false;
    let pollTimer: any = null;

    const read = async () => {
      try {
        // 1. Live probe backend turn leases
        let isHoldingBackendLease = false;
        try {
          const leaseRes = await fetch(`/api/active-sessions?profile=${encodeURIComponent(currentProfileName)}`);
          const leaseJson = await leaseRes.json();
          const activeList: string[] = Array.isArray(leaseJson?.active) ? leaseJson.active : [];
          isHoldingBackendLease = activeList.includes(activeSession) || (activeRuntimeSession ? activeList.includes(activeRuntimeSession) : false);
          setRunningSessionIds(new Set(activeList));

          if (Array.isArray(leaseJson?.leases)) {
            for (const l of leaseJson.leases) {
              if (l.session_id && l.acquired_at > 0) {
                turnStartTimesRef.current[l.session_id] = l.acquired_at;
                try {
                  if (typeof localStorage !== 'undefined') {
                    localStorage.setItem(`cockpit_turn_start_${l.session_id}`, String(l.acquired_at));
                  }
                } catch {}
              }
            }
          }
        } catch {}

        if (cancelled) return;

        // 2. Poll transcript tail for reasoning updates (live activity sekarang dari WS events)
        // limit 12: satu turn bisa berisi banyak baris tool sebelum baris assistant final.
        const tail = await rest.sessionTail(activeSession, 12);
        if (cancelled) return;

        const rows: any[] = Array.isArray(tail?.messages) ? tail.messages : (Array.isArray(tail?.data) ? tail.data : []);
        if (rows.length > 0) {
          const lastWithReasoning = [...rows].reverse().find(r => r.reasoning || r.reasoning_content);
          const lastMsg = rows[rows.length - 1];
          const isTurnStillActive = lastMsg?.role === 'user' || (lastMsg?.role === 'assistant' && !safeText(lastMsg?.content || lastMsg?.text).trim());
          if (lastWithReasoning && isTurnStillActive) {
            const serverReasoning = safeText(lastWithReasoning.reasoning_content || lastWithReasoning.reasoning);
            if (serverReasoning && serverReasoning.length > (sessionReasoningMapRef?.current?.[activeSession]?.length || 0)) {
              if (sessionReasoningMapRef?.current) sessionReasoningMapRef.current[activeSession] = serverReasoning;
              setStreamingReasoning?.(serverReasoning);
            }
          }
        }

        const currentTurnStart = Math.max(
          turnStartTimesRef.current[activeSession] || 0,
          turnStartTimesRef.current[activeRuntimeSession] || 0
        );
        const turnAge = currentTurnStart > 0 ? (Date.now() - currentTurnStart) : 0;

        const lastTailRow: any = rows.length > 0 ? rows[rows.length - 1] : null;
        const lastTailText = lastTailRow ? safeText(lastTailRow?.content || lastTailRow?.text).trim() : '';
        // Timestamp baris transcript bisa detik (backend) atau milidetik: normalisasi dulu.
        const rawTailStamp = Number(lastTailRow?.timestamp ?? lastTailRow?.at ?? lastTailRow?.created_at ?? 0);
        const tailStampMs = rawTailStamp > 1e12 ? rawTailStamp : rawTailStamp * 1000;
        // Tail hanya boleh dipakai sebagai bukti selesai kalau baris terakhirnya milik turn INI.
        const tailBelongsToCurrentTurn = tailStampMs > 0
          ? (currentTurnStart === 0 || tailStampMs >= currentTurnStart - 1000)
          : false;
        const tailProvesCompletion = Boolean(
          lastTailRow && lastTailRow.role === 'assistant' && lastTailText && tailBelongsToCurrentTurn
        );
        // --- Bukti REST: cari baris user MILIK KITA di transcript, lalu jawaban sesudahnya.
        // Ini jalur yang sama dengan yang dipakai user saat "pindah sesi lalu balik",
        // jadi hasilnya pasti benar walau event WS `message.complete` tidak pernah sampai.
        const norm = (v: any) => safeText(v).replace(/\s+/g, ' ').trim();
        const mine = norm(lastSubmittedTextRef.current).slice(0, 80);
        let userIdx = -1;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const row = rows[i];
          if (row?.role !== 'user') continue;
          const rowText = norm(row?.content || row?.text);
          const matches = !mine || !rowText
            || rowText.includes(mine.slice(0, 40)) || mine.includes(rowText.slice(0, 40));
          if (matches) { userIdx = i; break; }
        }
        const answerAfterUser = userIdx >= 0
          ? rows.slice(userIdx + 1)
              .filter((r: any) => r?.role === 'assistant')
              .map((r: any) => norm(r?.content || r?.text))
              .filter(Boolean)
              .join('\n\n')
          : '';
        // Ada teks jawaban? (lewat pencocokan prompt, ATAU baris terakhir assistant berisi)
        const hasAnswerText = Boolean(answerAfterUser)
          || Boolean(lastTailRow && lastTailRow.role === 'assistant' && lastTailText);
        const answerSig = `${userIdx}:${answerAfterUser.length}:${lastTailRow?.id ?? ''}:${lastTailText.length}`;
        const prevSig = tailSigRef.current;
        tailSigRef.current = hasAnswerText
          ? (prevSig.sig === answerSig ? { sig: answerSig, hits: prevSig.hits + 1 } : { sig: answerSig, hits: 1 })
          : { sig: '', hits: 0 };
        // Tidak ada event WS baru ~2.5s = stream sudah berhenti bicara.
        const quietWs = Date.now() - lastEventAtRef.current > 2500;
        // Panjang jawaban tidak berubah 2 poll berturut-turut (~3s) → tidak ada token baru.
        const transcriptStable = tailSigRef.current.hits >= 2;
        const restProvesCompletion = hasAnswerText && transcriptStable && quietWs;

        // Lease sudah lepas lama dan tail bukan lagi "user menunggu" = turn benar-benar tuntas.
        const leaseReleasedLongEnough = !isHoldingBackendLease && turnAge > 6000 && lastTailRow?.role !== 'user';
        const inSubmitGrace = Date.now() < submitGraceUntilRef.current;
        // Turn ini sudah ditutup oleh `message.complete` di WS: jangan pernah
        // menghidupkan busy lagi walau tail DB belum ikut menulis jawabannya.
        const alreadyTerminated = currentTurnStart > 0 && terminalTurnStartRef.current >= currentTurnStart;

        const turnFinished = alreadyTerminated
          || restProvesCompletion
          || leaseReleasedLongEnough;

        if (turnFinished) {
          turnDoneRef.current = true;
          if (safetyBusyTimerRef.current) { clearTimeout(safetyBusyTimerRef.current); safetyBusyTimerRef.current = null; }
          const dur = thinkingSecondsRef.current || (currentTurnStart > 0 ? Math.round(turnAge / 1000) : 0);
          if (dur > 0 && lastTailRow?.id) {
            messageDurationStoreRef.current[lastTailRow.id] = dur;
            try { if (typeof localStorage !== 'undefined') localStorage.setItem(`cockpit_dur_${lastTailRow.id}`, String(dur)); } catch {}
          }
          setBusy(false);
          setStreamingReasoning?.('');
          setQueuedAdmission(null); // turn ditutup: antrean (kalau ada) akan jalan sendiri
          void syncMessages(0, true);
        } else {
          // Turn masih berjalan (atau transcript belum menyusul): pertahankan busy.
          setBusy(true);
        }
      } catch {}

      if (!cancelled && busy) {
        pollTimer = setTimeout(read, 1500);
      }
    };

    read();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [rest, connected, activeSession, busy, syncMessages]);

  const isEventForCurrentSession = useCallback((e: HermesEvent) => {
    if (!e.session_id) return true;
    return e.session_id === activeSession || e.session_id === activeRuntimeSession;
  }, [activeSession, activeRuntimeSession]);

  const isHoldingLease = runningSessionIds.has(activeSession) || (activeRuntimeSession ? runningSessionIds.has(activeRuntimeSession) : false);

  const liveActivity = useMemo(() => {
    const sessionEvents = ((events || []) as HermesEvent[]).filter(e => 
      e.session_id ? (e.session_id === activeSession || e.session_id === activeRuntimeSession) : false
    );
    const currentTurnStart = Math.max(
      turnStartTimesRef.current[activeSession] || 0,
      turnStartTimesRef.current[activeRuntimeSession] || 0
    );
    const newest = sessionEvents[0];
    const age = newest ? Date.now() - (newest.receivedAt || 0) : Infinity;

    // Only consider message.complete if event is strictly after turn start!
    if (newest?.type === 'message.complete' && (currentTurnStart === 0 || (newest.receivedAt || 0) > currentTurnStart)) {
      return { label: '', active: false };
    }
    if (newest?.type === 'tool.start' || newest?.type === 'tool.progress' || newest?.type === 'tool.generating') {
      const name = safeText(newest.payload?.name || newest.payload?.tool_name || 'tool');
      const detail = toolSummary(name, newest.payload?.args || newest.payload?.arguments, null);
      return { label: `${toolTitle(name)}${detail ? ` · ${detail}` : ''}`.slice(0, 72), active: true };
    }
    if (newest?.type === 'message.delta' && age < 5000) return { label: 'Menulis balasan…', active: true };
    if (newest?.type === 'reasoning.delta' && age < 5000) return { label: 'Thinking…', active: true };
    if (newest?.type === 'status.update' && age < 15000) {
      const text = safeText(newest.payload?.text).replace(/\s+/g, ' ').trim();
      if (text) return { label: text.slice(0, 72), active: true };
    }
    // Hanya `busy` (turn yang kita mulai) yang boleh memaksa label Processing.
    // Lease backend sering nempel di sesi TUI walau turn sudah selesai.
    if (busy) return { label: 'Processing…', active: true };
    return { label: '', active: false };
  }, [events, busy, activeSession, activeRuntimeSession, isHoldingLease]);

  useEffect(() => {
    const recentEvents = ((events || []) as HermesEvent[]).slice(0, 15);
    const currentTurnStart = Math.max(
      turnStartTimesRef.current[activeSession] || 0,
      turnStartTimesRef.current[activeRuntimeSession] || 0
    );
    const isSessionLeaseActive = runningSessionIds.has(activeSession) || (activeRuntimeSession ? runningSessionIds.has(activeRuntimeSession) : false);

    // Event WS itu live (bukan transcript basi), jadi grace window TIDAK boleh dipakai
    // di sini: kalau ditahan, effect ini tak pernah re-run setelah grace lewat dan
    // busy nyangkut selamanya (thinking box tetap tampil setelah jawaban selesai).
    const terminalEvent = recentEvents.find(e => {
      const matchSid = !e.session_id || e.session_id === activeSession || e.session_id === activeRuntimeSession;
      if (!matchSid) return false;
      if (e.type !== 'message.complete' && e.type !== 'session.idle') return false;
      // Strictly ignore events from before current turn started!
      const isFresh = currentTurnStart > 0
        ? (e.receivedAt || 0) > currentTurnStart
        : (Date.now() - (e.receivedAt || 0)) < 15000;
      return isFresh;
    });

      if (terminalEvent) {
        const dur = thinkingSecondsRef.current || (currentTurnStart > 0 ? Math.round((Date.now() - currentTurnStart) / 1000) : 0);
        const lastMsg = visibleMessages[visibleMessages.length - 1];
        if (dur > 0 && lastMsg?.id) {
          messageDurationStoreRef.current[lastMsg.id] = dur;
          try { if (typeof localStorage !== 'undefined') localStorage.setItem(`cockpit_dur_${lastMsg.id}`, String(dur)); } catch {}
        }
        // Tandai turn ini tuntas: poller DB tidak boleh menghidupkan busy lagi.
        if (currentTurnStart > 0) terminalTurnStartRef.current = currentTurnStart;
        turnDoneRef.current = true;
        if (safetyBusyTimerRef.current) { clearTimeout(safetyBusyTimerRef.current); safetyBusyTimerRef.current = null; }
        setBusy(false);
        setStreamingReasoning?.('');
        setQueuedAdmission(null);
        const timer = setTimeout(() => void syncMessages(0, true), 600);
        return () => clearTimeout(timer);
      }
    const newest = recentEvents[0];
    if (newest?.type === 'sessions.changed') {
      // Reload drawer sessions list silently, NEVER clear busy mid-turn!
      loadSessionsRef.current?.(true, DRAWER_MIN_VISIBLE_SESSIONS, 'chats')?.catch?.(() => undefined);
    }
  }, [events, syncMessages, activeSession, activeRuntimeSession, visibleMessages, runningSessionIds]);

  const [allClear, setAllClear] = useState(false);
  const wasActiveRef = useRef(false);
  const allClearTimerRef = useRef<any>(null);

  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  useEffect(() => { thinkingSecondsRef.current = thinkingSeconds; }, [thinkingSeconds]);

  const recentEvents = ((events || []) as HermesEvent[]).slice(0, 20);
  const sessionRecentEvents = recentEvents.filter(e => 
    e.session_id ? (e.session_id === activeSession || e.session_id === activeRuntimeSession) : false
  );
  const currentTurnStart = Math.max(
    turnStartTimesRef.current[activeSession] || 0,
    turnStartTimesRef.current[activeRuntimeSession] || 0
  );
  const latestTerminalEvent = sessionRecentEvents.find(e => {
    if (e.type !== 'message.complete' && e.type !== 'session.idle') return false;
    return currentTurnStart > 0 ? (e.receivedAt || 0) > currentTurnStart : (Date.now() - (e.receivedAt || 0)) < 25000;
  });
  const lastDeltaEvent = sessionRecentEvents.find(e => e.type === 'message.delta');

  // SATU sumber kebenaran untuk status turn (lihat src/turnState.ts + tests/turnState.test.cjs).
  // Jangan menambah sinyal baru di luar ini: semua bug status sebelumnya lahir dari
  // kombinasi busy/isTerminated/liveActivity/lease/allClear yang dihitung terpisah.
  const turn = deriveTurnState({
    connected,
    busy,
    turnDone: turnDoneRef.current,
    leaseActive: isHoldingLease,
    liveActive: liveActivity.active,
    allClear,
    lastDeltaAt: lastDeltaEvent?.receivedAt || 0,
    terminalAt: latestTerminalEvent?.receivedAt || 0,
    turnStart: currentTurnStart,
    now: Date.now(),
  });
  const isTerminated = turn.terminated;
  const isResponding = turn.streaming;
  const isProcessing = turn.processing;
  const isBusyOrActive = turn.busyOrActive;

  // Thinking box: turunan langsung dari state machine di atas (jangan dihitung ulang
  // di sini — itu yang dulu bikin box nyangkut / hilang prematur).
  const isThinking = turn.thinking;

  const isSessionRunning = useCallback((sid: string) => {
    if (!sid) return false;
    if (activeSession === sid && isBusyOrActive) return true;
    return runningSessionIds.has(sid);
  }, [activeSession, isBusyOrActive, runningSessionIds]);

  const totalSessionTokens = useMemo(() => {
    let sum = 0;
    for (const m of visibleMessages) {
      if (m.tokenCount && m.tokenCount > 0) {
        sum += m.tokenCount;
      } else {
        const parts = m.parts || [];
        const nonText = parts.filter((p: any) => p.kind !== 'text') as NonTextPart[];
        sum += estimateActionTokens(nonText, m.text);
      }
    }
    if (isBusyOrActive) {
      sum += liveTurnTokens;
    }
    return sum;
  }, [visibleMessages, isBusyOrActive, liveTurnTokens]);



  const soundReadyRef = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => { soundReadyRef.current = true; }, 1500);
    return () => clearTimeout(t);
  }, []);

  const hasStreamedThisTurnRef = useRef(false);

  useEffect(() => {
    if (busy) {
      hasStreamedThisTurn = false;
      hasStreamedThisTurnRef.current = false;
      if (!wasActiveRef.current && soundReadyRef.current) {
        playVoiceAlert('processing', {
          provider: sessionModelInfo?.provider || modelInfo?.provider,
          model: pillModel || modelInfo?.model,
          reasoning: reasoningEffort
        });
      }
      wasActiveRef.current = true;
      if (allClearTimerRef.current) {
        clearTimeout(allClearTimerRef.current);
        allClearTimerRef.current = null;
      }
      if (allClear) setAllClear(false);
    } else if (wasActiveRef.current) {
      wasActiveRef.current = false;
      hasStreamedThisTurn = false;
      if (soundReadyRef.current) {
        playVoiceAlert('allclear');
      }
      setTimeout(() => void syncMessages(0, true), 600);
      setAllClear(true);
      if (allClearTimerRef.current) clearTimeout(allClearTimerRef.current);
      allClearTimerRef.current = setTimeout(() => {
        setAllClear(false);
        allClearTimerRef.current = null;
      }, 3000);
    }
  }, [busy, syncMessages]);

  // Cyberpunk voice alert for streaming start
  useEffect(() => {
    if (isResponding && !hasStreamedThisTurnRef.current && wasActiveRef.current && soundReadyRef.current) {
      hasStreamedThisTurnRef.current = true;
      playVoiceAlert('streaming');
    }
  }, [isResponding]);

  useEffect(() => {
    return () => {
      if (allClearTimerRef.current) clearTimeout(allClearTimerRef.current);
      if (safetyBusyTimerRef.current) clearTimeout(safetyBusyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setAllClear(false);
    wasActiveRef.current = false;
    turnDoneRef.current = false;
    tailSigRef.current = { sig: '', hits: 0 };
    if (safetyBusyTimerRef.current) { clearTimeout(safetyBusyTimerRef.current); safetyBusyTimerRef.current = null; }
    setShowJumpToLatest(false);
    setQueuedAdmission(null);
    if (allClearTimerRef.current) {
      clearTimeout(allClearTimerRef.current);
      allClearTimerRef.current = null;
    }
  }, [activeSession]);

  useEffect(() => {
    if (searchOpen) {
      try {
        scrollRef.current?.scrollTo({ y: 0, animated: false });
      } catch {}
    }
  }, [searchOpen, searchQuery]);

  const beaconPulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    if (isProcessing || isResponding) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(beaconPulse, { toValue: 1, duration: 420, useNativeDriver: Platform.OS !== 'web' }),
          Animated.timing(beaconPulse, { toValue: 0.35, duration: 420, useNativeDriver: Platform.OS !== 'web' }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      beaconPulse.setValue(1);
    }
  }, [isProcessing, isResponding, beaconPulse]);

  useEffect(() => {
    if (!activeSession) return;
    const lastUser = [...visibleMessages].reverse().find(m => m.role === 'user');
    const lastUserAt = lastUser?.at || 0;

    if (isBusyOrActive) {
      if (!turnStartTimesRef.current[activeSession]) {
        let savedStart = 0;
        try {
          if (typeof localStorage !== 'undefined') {
            savedStart = Number(localStorage.getItem(`cockpit_turn_start_${activeSession}`)) || 0;
          }
        } catch {}

        if (savedStart > 0 && (Date.now() - savedStart) < 7200000) {
          turnStartTimesRef.current[activeSession] = savedStart;
        } else if (lastUserAt > 0 && (Date.now() - lastUserAt) < 7200000) {
          turnStartTimesRef.current[activeSession] = lastUserAt;
        } else {
          turnStartTimesRef.current[activeSession] = Date.now();
        }
      }
      const tick = () => {
        const start = turnStartTimesRef.current[activeSession] || Date.now();
        const elapsed = Math.max(1, Math.round((Date.now() - start) / 1000));
        setThinkingSeconds(elapsed);
        thinkingSecondsRef.current = elapsed;
      };
      tick();
      const interval = setInterval(tick, 1000);
      return () => clearInterval(interval);
    } else {
      if (!allClear && !busy) {
        delete turnStartTimesRef.current[activeSession];
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(`cockpit_turn_start_${activeSession}`);
          }
        } catch {}
      }
    }
  }, [isBusyOrActive, activeSession, visibleMessages, allClear, busy]);

  useEffect(() => {
    if (isThinking && stickToBottomRef.current) {
      autoScrollToBottom(false);
    }
  }, [isThinking, streamingReasoning, autoScrollToBottom]);
  const renderMessages = () => {
    const nodes: React.ReactNode[] = [];
    let pendingCalls: NonTextPart[] = [];
    const flush = (key: string, nextMsg?: Message) => {
      if (!pendingCalls.length) return;
      const tokens = nextMsg?.tokenCount || estimateActionTokens(pendingCalls, nextMsg?.text || '');
      const model = nextMsg?.model || (nextMsg?.id ? messageModelStoreRef.current[nextMsg.id] : undefined) || sessionModel;
      nodes.push(
        <ActivitySummaryLine
          key={`calls-${key}`}
          parts={pendingCalls}
          tokens={tokens}
          model={model}
        />
      );
      pendingCalls = [];
    };
    // Count actual conversation messages (user & assistant), NOT raw tool calls
    const turnIndices: number[] = [];
    visibleMessages.forEach((m: Message, idx: number) => {
      if (m.role === 'user' || (m.role === 'assistant' && (m.text?.trim()?.length > 0 || m.parts?.some(p => p.kind === 'text')))) {
        turnIndices.push(idx);
      }
    });

    const totalTurns = turnIndices.length;
    const targetTurnsToShow = Math.max(visibleCount, 40);
    const cutoffTurnIdx = Math.max(0, totalTurns - targetTurnsToShow);
    const startMsgIdx = cutoffTurnIdx > 0 ? turnIndices[cutoffTurnIdx] : 0;
    const hiddenTurnsCount = cutoffTurnIdx;
    const displayedMessages = startMsgIdx > 0 ? visibleMessages.slice(startMsgIdx) : visibleMessages;

    if (hiddenTurnsCount > 0) {
      nodes.push(
        <View key="load-earlier-wrap" style={styles.loadEarlierWrap}>
          <Pressable onPress={() => setVisibleCount(prev => prev + 40)} style={styles.loadEarlierBtn}>
            <Ionicons name="time-outline" size={15} color={colors.primary} />
            <Text style={styles.loadEarlierText}>View earlier messages ({hiddenTurnsCount} more)</Text>
          </Pressable>
          <Pressable onPress={() => setVisibleCount(totalTurns + 100)} style={styles.loadAllBtn}>
            <Text style={styles.loadAllText}>Load all</Text>
          </Pressable>
        </View>
      );
    }

    displayedMessages.forEach((message: Message, index: number) => {
      if (isToolOnlyMessage(message)) {
        pendingCalls.push(...nonTextParts(message));
        return;
      }
      const isAssistant = message.role === 'assistant';
      const turnTools = isAssistant ? [...pendingCalls] : NO_TOOL_PARTS;
      if (isAssistant) {
        pendingCalls = [];
      } else if (pendingCalls.length > 0) {
        flush(message.id || String(index), message);
      }

      // Calculate turn duration for assistant messages:
      let turnDuration: number | undefined;
      if (isAssistant) {
        if (message.id && messageDurationStoreRef.current[message.id]) {
          turnDuration = messageDurationStoreRef.current[message.id];
        } else {
          try {
            if (typeof localStorage !== 'undefined' && message.id) {
              const saved = Number(localStorage.getItem(`cockpit_dur_${message.id}`));
              if (saved > 0) {
                turnDuration = saved;
                messageDurationStoreRef.current[message.id] = saved;
              }
            }
          } catch {}

          if (!turnDuration) {
            const searchList = visibleMessages.slice(0, startMsgIdx + index);
            const prevUser = [...searchList].reverse().find(m => m.role === 'user');
            if (prevUser && message.at && prevUser.at && message.at > prevUser.at) {
              const sec = Math.round((message.at - prevUser.at) / 1000);
              if (sec >= 1 && sec <= 7200) {
                turnDuration = sec;
                if (message.id) {
                  messageDurationStoreRef.current[message.id] = sec;
                  try { localStorage.setItem(`cockpit_dur_${message.id}`, String(sec)); } catch {}
                }
              }
            }
          }
        }
      }

      const isLast = (startMsgIdx + index) === visibleMessages.length - 1;
      const isStreaming = isLast && isAssistant && isResponding;
      const isCurrentMatch = searchOpen && hasSubmittedSearch && searchMatches[searchMatchIndex]?.id === message.id;
      const isAnyMatch = searchOpen && hasSubmittedSearch && searchMatches.some(m => m.id === message.id);
      nodes.push(
        <MessageBubble
          key={message.id}
          message={message}
          isStreaming={isStreaming}
          defaultModel={message.model || (message.id ? messageModelStoreRef.current[message.id] : undefined) || sessionModel}
          extraToolParts={turnTools}
          isCurrentMatch={isCurrentMatch}
          isAnyMatch={isAnyMatch}
          onLayoutY={handleMessageLayout}
          duration={turnDuration}
          onRetry={(text: string) => void submit(text)}
        />
      );
    });
    if (!isBusyOrActive && pendingCalls.length > 0) {
      flush('tail');
    }
    return nodes;
  };
  const storedIdFromRpc = (r: any) => safeText(r?.stored_session_id || r?.session_key || r?.resumed || r?.id || r?.session_id);
  const runtimeIdFromRpc = (r: any) => safeText(r?.session_id || r?.runtime_session_id || r?.id);
  const activeSessionTitle = activeSession
    ? (titleOf(sessions.find((s: SessionSummary) => sessionId(s) === activeSession) || ({ title: shortId(activeSession) } as any)) || shortId(activeSession))
    : 'New chat';
  const sortedSessions = useMemo(() => [...sessions].sort((a, b) => sessionTime(b) - sessionTime(a)), [sessions]);
  const drawerSessions = sortedSessions.filter(s => {
    if (!isUserFacingSession(s)) return false;
    if (drawerMode === 'cron' ? !isCronSession(s) : isCronSession(s)) return false;
    const q = drawerQuery.trim().toLowerCase();
    if (!q) return true;
    return `${titleOf(s)} ${sessionId(s)}`.toLowerCase().includes(q);
  });

  const loadSessions = async (reset = false, minVisible = 0, mode: 'chats' | 'cron' = drawerMode) => {
    if (!rest) return;
    loadSessionsRef.current = loadSessions;
    let offset = reset ? 0 : sessionOffset;
    if (!reset && (!sessionsHasMore || loadingSessions || loadingMoreSessions)) return;
    reset ? setLoadingSessions(true) : setLoadingMoreSessions(true);
    try {
      const extra = mode === 'cron' ? 'source=cron' : 'exclude_sources=cron';
      const data = await rest.sessions(30, offset, 'include', extra);
      const batch = Array.isArray(data) ? data : data.sessions || [];
      const total = Array.isArray(data) ? undefined : data.total;
      const merged = reset ? batch : appendUniqueSessions(sessions, batch);
      setSessions(merged);
      setSessionOffset(offset + batch.length);
      setSessionsHasMore(batch.length === 30 && (typeof total !== 'number' || (offset + batch.length) < total));
    } finally {
      reset ? setLoadingSessions(false) : setLoadingMoreSessions(false);
    }
  };
  const refresh = async () => loadSessions(true, DRAWER_MIN_VISIBLE_SESSIONS, 'chats');
  useEffect(() => { refresh().catch(e => setErr(e.message)); }, [rest]);

  const openDrawer = useCallback(() => {
    setDrawerMode('chats');
    setDrawerVisible(true);
    void syncRunningSessions();
    drawerSlideAnim.setValue(0);
    Animated.spring(drawerSlideAnim, {
      toValue: 1,
      damping: 24,
      stiffness: 220,
      mass: 0.8,
      useNativeDriver: false,
    }).start();
    loadSessions(false, DRAWER_MIN_VISIBLE_SESSIONS, 'chats').catch(e => setErr(e.message));
  }, [loadSessions, drawerSlideAnim, syncRunningSessions]);

  const closeDrawer = useCallback((afterClose?: () => void) => {
    Animated.timing(drawerSlideAnim, {
      toValue: 0,
      duration: 220,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished) {
        setDrawerVisible(false);
        if (afterClose) afterClose();
      }
    });
  }, [drawerSlideAnim]);

  const drawerTranslateX = drawerSlideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-420, 0],
  });

  const scrimOpacity = drawerSlideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });

  const sessionTargetVersionRef = useRef(0);

  // Model per-sesi: /api/model/info dan session.resume -> info.model dua-duanya cuma
  // nampilin DEFAULT PROFIL (sama untuk semua sesi) — itu sebabnya pill dulu kelihatan
  // nggak berubah saat pindah sesi. Satu-satunya nilai yang benar-benar per-sesi ada di
  // baris DB, yang dibaca oleh command /status. Jadi ambil dari situ, sekali per sesi.
  const modelFetchForRef = useRef<string>('');
  useEffect(() => {
    if (!rpc || !connected || !activeRuntimeSession) return;
    if (modelFetchForRef.current === activeRuntimeSession) return;
    modelFetchForRef.current = activeRuntimeSession;
    let cancelled = false;
    (async () => {
      try {
        const res: any = await rpc.slashExec(activeRuntimeSession, '/status');
        const out = safeText(res && (res.output || res.notice));
        const m = out.match(/(?:\*\*)?Model:(?:\*\*)?\s*`?([^`(\r\n]+)`?/i);
        if (!cancelled && m) {
          const found = m[1].replace(/\s*\(.*\)\s*$/, '').trim();
          if (found) {
            setSessionModelInfo({ model: found });
          }
        }
        const ctxMatch = out.match(/\*\*Context:\*\*\s*(?:~)?([0-9,]+)\s*(?:\/\s*([0-9,]+))?/i);
        if (!cancelled && ctxMatch) {
          const used = parseInt(ctxMatch[1].replace(/,/g, ''), 10);
          const total = ctxMatch[2] ? parseInt(ctxMatch[2].replace(/,/g, ''), 10) : 1000000;
          const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
          setSessionContext({ used, total, pct });
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [rpc, connected, activeRuntimeSession]);

  const openSession = async (sid: string) => {
    if (!sid) return;
    closeDrawer();
    if (activeSession === sid && messages.length > 0) {
      void syncMessages();
      return;
    }
    const version = ++sessionTargetVersionRef.current;
    setActiveSession(sid);
    setActiveRuntimeSession('');

    // Immediately resolve the target session's model from existing sessions list
    const targetSession = sessions.find((s: SessionSummary) => sessionId(s) === sid);
    const targetModel = targetSession?.model ? String(targetSession.model) : null;
    setSessionModelInfo(targetModel ? { model: targetModel, provider: targetSession?.provider as string } : null);

    void loadSessionContext(sid);
    flushReasoningBuffer?.('clear');
    setStreamingReasoning?.(sessionReasoningMapRef?.current?.[sid] || '');
    setMessages([]);
    setLoadingMessages(true); setErr('');
    try {
      const sessionModel = targetModel || modelInfo?.model || 'Model';

      // 1. Instant path: fetch full messages via REST immediately
      if (rest) {
        try {
          const data = await fetchTranscript(rest, sid);
          if (sessionTargetVersionRef.current !== version) return;
          const fastNorm = normalizeMessages(data, sessionModel, messageModelStoreRef.current);
          if (fastNorm.length > 0) {
            setMessages(fastNorm);
            setLoadingMessages(false);
          }
        } catch {}

        if (!targetModel) {
          rest.sessionDetail(sid).then((detail: any) => {
            if (sessionTargetVersionRef.current !== version || !detail?.model) return;
            setSessionModelInfo({ model: detail.model, provider: detail.provider });
            setSessions((prev: SessionSummary[]) => prev.map(s => sessionId(s) === sid ? { ...s, model: detail.model } : s));
          }).catch(() => undefined);
        }
      }

      // 2. In parallel/background: resume live runtime session over WebSocket
      if (rpc) {
        const resumed: any = await resumeSessionHydrated(sid);
        if (sessionTargetVersionRef.current !== version) return;
        const isRunning = Boolean(resumed?.running || resumed?.status === 'streaming');
        setBusy(isRunning);
        const stored = storedIdFromRpc(resumed) || sid;
        setActiveSession(stored);
        setActiveRuntimeSession(runtimeIdFromRpc(resumed));
        void loadSessionContext(stored);

        const rModel = resumed?.info?.model || resumed?.model;
        if (rModel) {
          setSessionModelInfo((prev: any) => ({
            ...prev,
            model: rModel,
            provider: resumed?.info?.provider || prev?.provider
          }));
          setSessions((prev: SessionSummary[]) => prev.map(s => sessionId(s) === stored ? { ...s, model: rModel } : s));
        }

        const rawMessages = resumed?.messages || [];
        const rpcNorm = normalizeMessages(rawMessages, rModel || sessionModel, messageModelStoreRef.current);
        if (rpcNorm.length > 0) {
          setMessages((prev: Message[]) => {
            if (prev.length >= rpcNorm.length) return prev;
            return rpcNorm;
          });
        }
        saveLastSessionId(stored).catch(() => undefined);
        saveMessageModels(messageModelStoreRef.current).catch(() => undefined);
      }
    } catch (e: any) {
      if (sessionTargetVersionRef.current !== version) return;
      const msg = /not found|404/i.test(e.message)
        ? 'Session not found or already deleted on the server.'
        : e.message;
      setErr(msg);
    } finally {
      if (sessionTargetVersionRef.current === version) {
        setLoadingMessages(false);
      }
    }
  };

  const newSession = async () => {
    if (!rpc) return;
    const version = ++sessionTargetVersionRef.current;
    setLoadingMessages(true);
    flushReasoningBuffer?.('clear');
    setStreamingReasoning?.('');
    setSessionModelInfo(null);
    try {
      const r: any = await rpc.createSession();
      if (sessionTargetVersionRef.current !== version) return;
      const stored = storedIdFromRpc(r);
      const runtime = runtimeIdFromRpc(r);
      const sid = stored || runtime;
      setActiveSession(sid);
      setActiveRuntimeSession(runtime);
      setMessages([]);
      closeDrawer();
      if (sid) saveLastSessionId(sid).catch(() => undefined);
      await refresh();
    } catch (e: any) {
      if (sessionTargetVersionRef.current !== version) return;
      setErr(e.message);
    } finally {
      if (sessionTargetVersionRef.current === version) {
        setLoadingMessages(false);
      }
    }
  };

  // Slash commands: the gateway has no command.run RPC, so the catalog is only
  // used for discovery and each command maps to something the app can do.
  useEffect(() => {
    if (!rpc || !connected) return;
    let cancelled = false;
    rpc.commandsCatalog()
      .then((data: any) => {
        if (cancelled) return;
        const pairs: [string, string][] = Array.isArray(data?.pairs) ? data.pairs : [];
        setCatalog(pairs.map(([name, description]) => ({ name, description: safeText(description) })));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [rpc, connected]);

  const slashQuery = prompt.startsWith('/') ? prompt.slice(1).split(/\s+/)[0].toLowerCase() : null;
  const slashMatches = slashQuery === null ? [] : catalog
    .filter(c => c.name.replace(/^\//, '').toLowerCase().startsWith(slashQuery))
    .slice(0, 7);

  // Satu jalur buat semua command yang dieksekusi backend (lewat RPC `slash.exec`).
  // Output-nya bisa berupa laporan teks (modal) atau turn yang harus di-submit.
  const execSlashOnBackend = async (name: string, raw: string) => {
    if (!rpc) {
      setInfoModal({ title: name, body: 'Not connected to Hermes.' });
      return;
    }
    setInfoModal({ title: name, body: 'Menjalankan…' });
    // slash.exec butuh session id RUNTIME dari gateway (bukan id sesi tersimpan);
    // kalau salah dia balas {"code":4001,"message":"session not found"}. Id ini
    // kosong setelah buka app / habis reconnect, jadi disiapkan di sini kalau perlu.
    let sid = activeRuntimeSession;
    if (!sid) {
      try {
        const stored = activeSession || activeSessionRef?.current || '';
        const r: any = stored ? await resumeSessionHydrated(stored) : await rpc.createSession();
        sid = runtimeIdFromRpc(r);
        const st = storedIdFromRpc(r);
        if (sid) setActiveRuntimeSession(sid);
        if (st && !stored) setActiveSession(st);
      } catch (e: any) {
        setInfoModal({ title: name, body: `Couldn't prepare session: ${e && e.message ? e.message : String(e)}` });
        return;
      }
    }
    if (!sid) {
      setInfoModal({ title: name, body: "Couldn't prepare the runtime session. Try again in a moment." });
      return;
    }
    try {
      const reply: any = await rpc.slashExec(sid, raw.trim());
      if (reply && (reply.type === 'skill' || reply.type === 'send')) {
        const notice = safeText(reply.notice);
        if (notice) {
          setMessages((m: Message[]) => [...m, { id: makeId(), role: 'system', text: notice, parts: [{ kind: 'text', text: notice }], at: Date.now() }]);
        }
        if (reply.message) {
          setInfoModal(null);
          await rpc.submitPrompt(sid, String(reply.message));
          return;
        }
        setInfoModal({ title: name, body: notice || 'No output.' });
        return;
      }
      const out = safeText(reply && (reply.output || reply.notice)) || `/${name.replace(/^\//, '')}: tidak ada output.`;
      setInfoModal({ title: name, body: out });
    } catch (e: any) {
      const msg = String(e && e.message ? e.message : e);
      setInfoModal({
        title: name,
        body: /unsupported_command/i.test(msg)
          ? `Command ${name} isn't supported for this session.`
          : `Failed to run ${name}: ${msg}`
      });
    }
  };

  const runSlash = async (raw: string) => {
    const name = raw.trim().split(/\s+/)[0].toLowerCase();
    const known = (label: string) => setInfoModal({ title: label, body: '' });
    switch (name) {
      case '/new':
      case '/clear':
        await newSession();
        return;
      case '/rename':
        if (activeSession) openRename(activeSession, activeSessionTitle);
        return;
      case '/model':
        onNavigate('ops', 'hub');
        setInfoModal({ title: '/model', body: 'Pick a model from the model pill in the top header (sparkles icon).' });
        return;
      case '/status':
        await execSlashOnBackend(name, raw);
        return;
      case '/skills':
        onNavigate('ops', 'skills');
        return;
      case '/cron':
        onNavigate('ops', 'cron');
        return;
      case '/logs':
        onNavigate('ops', 'logs');
        return;
      case '/stop':
      case '/interrupt':
        if (rpc && activeRuntimeSession) {
          try { await rpc.interrupt(activeRuntimeSession); setInfoModal({ title: 'Interrupt', body: 'Stop signal sent to the session.' }); }
          catch (e: any) { setErr(e.message); }
        } else {
          setInfoModal({ title: 'Interrupt', body: 'No active session running.' });
        }
        return;
      case '/usage':
        await execSlashOnBackend(name, raw);
        return;
      case '/help':
      case '/commands': {
        const list = catalog.length ? catalog : [];
        setInfoModal({
          title: 'Perintah slash',
          body: list.length
            ? list.map(c => `${c.name} — ${c.description}`).join('\n')
            : 'Command catalog not loaded yet.'
        });
        return;
      }
      default: {
        const inCatalog = catalog.some(c => c.name.toLowerCase() === name);
        if (!inCatalog || SLASH_LOCAL_ONLY.has(name)) {
          setInfoModal({
            title: name,
            body: inCatalog
              ? `Command ${name} needs another surface (terminal/editor); not supported in Cockpit yet.`
              : `Unknown command ${name}. Type /help for the command list.`
          });
          return;
        }
        // Command katalog: jalankan lewat RPC `slash.exec`. Penting — jangan pakai
        // prompt.submit: itu cuma nerusin teks ke model, command-nya nggak dieksekusi.
        await execSlashOnBackend(name, raw);
      }
    }
  };

  const openRename = (id: string, title: string) => {
    if (!id) return;
    setRenameValue(title || '');
    setRenameTarget({ id, title: title || '' });
  };

  const confirmDelete = async () => {
    if (!rest || !deleteTarget) return;
    setDeleting(true); setErr('');
    try {
      await rest.deleteSession(deleteTarget.id);
      setSessions((prev: SessionSummary[]) => prev.filter(s => sessionId(s) !== deleteTarget.id));
      if (activeSession === deleteTarget.id) {
        setActiveSession(''); setActiveRuntimeSession(''); setSessionModelInfo(null); setMessages([]);
        clearLastSessionId().catch(() => undefined);
      }
      setDeleteTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setDeleting(false);
    }
  };

  const submitRename = async () => {
    if (!rest || !renameTarget) return;
    const title = renameValue.trim();
    if (!title) return;
    setRenaming(true); setErr('');
    try {
      await rest.renameSession(renameTarget.id, title);
      setSessions((prev: SessionSummary[]) => prev.map(s => (sessionId(s) === renameTarget.id ? { ...s, title } : s)));
      setRenameTarget(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setRenaming(false);
    }
  };

  const submit = async (overrideText?: string, forwardSlash = false) => {
    if (isListeningRef.current) {
      stopListening();
    }
    const raw = (overrideText !== undefined ? overrideText : prompt).trim();
    if (!rpc || (!raw && !attachments.length)) return;
    if (!forwardSlash && raw.startsWith('/') && !attachments.length) {
      setPrompt('');
      await runSlash(raw);
      return;
    }
    if (busy && attachments.length) {
      setErr('Lampiran belum bisa diantre — kirim setelah turn ini selesai.');
      return;
    }
    let storedSid = activeSession;
    let runtimeSid = activeRuntimeSession;
    const prevTurnStart = storedSid ? (turnStartTimesRef.current[storedSid] || 0) : 0;
    setBusy(true); setErr('');
    // Tahan semua heuristik "turn selesai" sampai pesan user baru benar-benar
    // ter-commit di transcript (kalau tidak: processing → all clear → processing).
    submitGraceUntilRef.current = Date.now() + 3500;
    terminalTurnStartRef.current = 0; // turn baru: buka lagi penilaian selesai
    turnDoneRef.current = false;
    tailSigRef.current = { sig: '', hits: 0 };
    setShowJumpToLatest(false);
    stickToBottomRef.current = true;
    if (storedSid) {
      turnStartTimesRef.current[storedSid] = Date.now();
      if (sessionReasoningMapRef?.current) sessionReasoningMapRef.current[storedSid] = '';
    }
    setThinkingSeconds(1);
    setStreamingReasoning?.('');
    flushReasoningBuffer?.('clear'); // buang sisa delta turn sebelumnya
    scrollToBottom(false);
    let pendingId = ''; // id bubble user yang akan ditandai gagal kalau submit error
    try {
      const ensureSession = async () => {
        if (!rpc?.connected && onReconnect) {
          await onReconnect();
        }
        if (!runtimeSid) {
          const r: any = storedSid ? await resumeSessionHydrated(storedSid) : await rpc.createSession();
          runtimeSid = runtimeIdFromRpc(r);
          storedSid = storedIdFromRpc(r) || storedSid || runtimeSid;
          setActiveRuntimeSession(runtimeSid);
          setActiveSession(storedSid);
          if (storedSid) saveLastSessionId(storedSid).catch(() => undefined);
          if (r?.messages && messages.length === 0) setMessages(normalizeMessages(r.messages));
        }
        return runtimeSid;
      };

      await ensureSession();

      // Execute an RPC action on the live session, auto-recovering if the socket closed or runtime session expired
      const withSessionRetry = async <T,>(action: (sid: string) => Promise<T>): Promise<T> => {
        try {
          if (!rpc?.connected && onReconnect) {
            await onReconnect();
          }
          return await action(runtimeSid);
        } catch (err: any) {
          if (/not connected|not open|socket closed/i.test(err?.message)) {
            if (onReconnect) await onReconnect();
            return await action(runtimeSid);
          }
          if (/session not found/i.test(err?.message)) {
            const r: any = storedSid ? await resumeSessionHydrated(storedSid) : await rpc.createSession();
            runtimeSid = runtimeIdFromRpc(r);
            storedSid = storedIdFromRpc(r) || storedSid || runtimeSid;
            setActiveRuntimeSession(runtimeSid);
            setActiveSession(storedSid);
            return await action(runtimeSid);
          }
          throw err;
        }
      };

      // Upload / stage attachments via RPC if any
      const fileRefs: string[] = [];
      const pendingAttachments = [...attachments];
      for (const att of pendingAttachments) {
        if (att.type === 'image') {
          await withSessionRetry(sid => rpc.attachImageBytes(sid, att.name, att.base64));
        } else {
          const res: any = await withSessionRetry(sid => rpc.attachFile(sid, att.name, att.dataUrl));
          if (res?.ref_text) {
            fileRefs.push(res.ref_text);
          }
        }
      }

      const text = raw;
      const promptToSend = [...fileRefs, text].filter(Boolean).join('\n\n') || (pendingAttachments.some(a => a.type === 'image') ? 'Apa yang lo lihat di gambar ini?' : '');
      // Dipakai poller untuk memastikan baris `user` di transcript memang prompt KITA,
      // bukan prompt turn sebelumnya (yang bikin status "selesai" menembak terlalu awal).
      lastSubmittedTextRef.current = promptToSend;

      const userDisplay = text
        ? (pendingAttachments.length ? `${pendingAttachments.map(a => `📎 ${a.name}`).join('\n')}\n\n${text}` : text)
        : pendingAttachments.map(a => `📎 ${a.name}`).join('\n');

      pendingId = makeId();
      setMessages((m: Message[]) => [...m, { id: pendingId, role: 'user', text: userDisplay, parts: [{ kind: 'text', text: userDisplay }], at: Date.now() }]);
      setPrompt('');
      setAttachments([]);
      const receipt: any = await withSessionRetry(sid => rpc.submitPrompt(sid, promptToSend));
      // Prompt sudah diterima gateway: grace boleh lebih pendek, tapi tetap beri
      // ruang sampai baris user baru muncul di transcript.
      submitGraceUntilRef.current = Math.max(submitGraceUntilRef.current, Date.now() + 3000);
      if (receipt?.status === 'queued' && receipt?.admission_id) {
        // Turn masih berjalan: pesan masuk FIFO, bukan turn baru. Jangan sentuh busy,
        // jangan pasang safety timer, dan KEMBALIKAN turnStart turn yang sedang jalan
        // (kalau tidak, bukti selesai REST jadi salah turn).
        if (storedSid && prevTurnStart) turnStartTimesRef.current[storedSid] = prevTurnStart;
        setQueuedAdmission({ admission_id: String(receipt.admission_id), text: promptToSend });
        await refresh();
        return;
      }
      await refresh();
      // Safety timeout: auto-clear busy kalau tak ada kabar sama sekali setelah 120s.
      // Handle-nya disimpan supaya bisa di-clear begitu turn benar-benar selesai.
      if (safetyBusyTimerRef.current) clearTimeout(safetyBusyTimerRef.current);
      safetyBusyTimerRef.current = setTimeout(() => {
        safetyBusyTimerRef.current = null;
        setBusy(false);
      }, 120000);
    } catch(e:any){
      setErr(e.message);
      // Tandai bubble user yang gagal terkirim supaya jelas & bisa di-retry,
      // bukan cuma error text di atas composer.
      setMessages((m: Message[]) => m.map(x => x.id === pendingId ? { ...x, failed: true } : x));
      setBusy(false);
    }
  };

  // Auto-restore previous active session or latest user chat on connect
  useEffect(() => {
    if (!rest || !connected) return;
    let cancelled = false;

    const restore = async () => {
      const curSession = activeSession || activeSessionRef?.current;
      const curMsgCount = Math.max(messages.length, messagesRef?.current?.length || 0);
      if (curSession && curMsgCount > 0) return;

      try {
        const lastId = await loadLastSessionId();
        let targetId = lastId;

        if (!targetId) {
          const raw = await rest.sessions(10, 0, 'include');
          const list = Array.isArray(raw) ? raw : (raw?.sessions || []);
          const latest = list.find((s: any) => isUserFacingSession(s) && !isCronSession(s));
          if (latest) {
            targetId = sessionId(latest);
          }
        }

        // Sesi hasil /new yang belum pernah dikirimi pesan cuma ada di runtime —
        // nggak punya baris di DB, jadi nggak muncul di drawer dan id-nya nggak
        // ketemu di daftar. Jangan buka chat hantu: pakai sesi nyata terbaru.
        if (targetId && !cancelled) {
          try {
            const raw = await rest.sessions(10, 0, 'include');
            const list = Array.isArray(raw) ? raw : (raw?.sessions || []);
            const exists = list.some((s: any) => sessionId(s) === targetId);
            if (!exists) {
              const latest = list.find((s: any) => isUserFacingSession(s) && !isCronSession(s));
              targetId = latest ? sessionId(latest) : '';
            }
          } catch {}
        }
        if (targetId && !cancelled) {
          await openSession(targetId);
        }
      } catch {}
    };

    restore();
    return () => { cancelled = true; };
  }, [rest, connected]);

  // Follow new messages / streaming deltas smoothly while pinned to bottom.
  const latestMessage = visibleMessages[visibleMessages.length - 1];
  const latestMessageText = latestMessage?.text || '';
  const latestMessagePartsLen = latestMessage?.parts?.length || 0;

  useEffect(() => {
    // Selama turn aktif (streaming/tool), lompat instan: smooth-scroll selalu
    // ketinggalan karena konten tumbuh lebih cepat dari durasi animasinya.
    if (stickToBottomRef.current) autoScrollToBottom(!(busy || isResponding));
  }, [
    visibleMessages.length,
    latestMessageText,
    latestMessagePartsLen,
    streamingReasoning,
    busy,
    isResponding,
    autoScrollToBottom
  ]);

  // A freshly opened session starts at the newest message.
  useEffect(() => {
    if (!loadingMessages) {
      stickToBottomRef.current = true;
      const timer = setTimeout(() => scrollToBottom(false), 50);
      return () => clearTimeout(timer);
    }
  }, [activeSession, loadingMessages, scrollToBottom]);

  // Keep the composer visible when the on-screen keyboard opens (native).
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const show = Keyboard.addListener('keyboardDidShow', () => { if (stickToBottomRef.current) setTimeout(() => scrollToBottom(true), 60); });
    return () => show.remove();
  }, [scrollToBottom]);

  return <View style={styles.chatRoot}>
    <View style={styles.chatTopBar}>
      <Pressable onPress={openDrawer} style={styles.iconButton} accessibilityLabel="Open chats"><Ionicons name="menu-outline" size={24} color={colors.text} /></Pressable>
      <View style={{ flex: 1 }}>
        <Pressable disabled={!activeSession} onPress={() => activeSession && openRename(activeSession, activeSessionTitle)} style={styles.chatTitleRow}>
          <Text style={styles.chatTitle} numberOfLines={1}>{activeSessionTitle}</Text>
          {activeSession ? <Ionicons name="create-outline" size={14} color={colors.faint} /> : null}
        </Pressable>
        <View style={styles.chatSubRow}>
          {status === 'error' ? (
            <>
              <View style={[styles.statusIndicatorDot, { backgroundColor: isDark ? '#ef4444' : '#dc2626' }]} />
              <Text style={[styles.statusIndicatorText, { color: isDark ? '#f87171' : '#dc2626' }]} numberOfLines={1}>
                DISCONNECTED
              </Text>
            </>
          ) : (status === 'testing' && !rest) ? (
            <>
              <View style={[styles.statusIndicatorDot, { backgroundColor: isDark ? '#f59e0b' : '#d97706' }]} />
              <Text style={[styles.statusIndicatorText, { color: isDark ? '#fbbf24' : '#d97706' }]} numberOfLines={1}>
                CONNECTING…
              </Text>
            </>
          ) : allClear ? (
            <>
              <Text style={{ fontSize: 7, color: isDark ? '#38bdf8' : '#0284c7' }}>✦</Text>
              <Text style={[styles.statusIndicatorText, { color: isDark ? '#38bdf8' : '#0284c7' }]} numberOfLines={1}>
                ALL CLEAR
              </Text>
            </>
          ) : isResponding ? (
            <>
              <Animated.View style={[styles.statusIndicatorDot, { backgroundColor: isDark ? '#22d3ee' : '#0284c7', opacity: beaconPulse }]} />
              <Text style={[styles.statusIndicatorText, { color: isDark ? '#22d3ee' : '#0284c7' }]} numberOfLines={1}>
                STREAMING
              </Text>
            </>
          ) : isProcessing ? (
            <>
              <Animated.View style={[styles.statusIndicatorDot, { backgroundColor: isDark ? '#60a5fa' : '#2563eb', opacity: beaconPulse }]} />
              <Text style={[styles.statusIndicatorText, { color: isDark ? '#60a5fa' : '#2563eb' }]} numberOfLines={1}>
                PROCESSING
              </Text>
            </>
          ) : (
            <>
              <View style={[styles.statusIndicatorDot, { backgroundColor: isDark ? '#22c55e' : '#16a34a' }]} />
              <Text style={[styles.statusIndicatorText, { color: isDark ? '#94a3b8' : '#64748b' }]} numberOfLines={1}>
                IDLE
              </Text>
            </>
          )}
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Pressable
          onPress={() => setSearchOpen(prev => !prev)}
          style={styles.iconButton}
          accessibilityLabel="Search chats"
        >
          <Ionicons name={searchOpen ? "close-outline" : "search-outline"} size={21} color={searchOpen ? colors.primary : colors.text} />
        </Pressable>
        <Pressable onPress={newSession} disabled={!connected} style={styles.iconButton} accessibilityLabel="New chat">
          <Ionicons name="add-outline" size={24} color={connected ? colors.text : colors.faint} />
        </Pressable>
      </View>
    </View>
    {searchOpen ? (
      <View style={styles.chatSearchBar}>
        <View style={styles.chatSearchInputWrapper}>
          <Ionicons name="search-outline" size={14} color={colors.primary} />
          <TextInput
            value={searchQuery}
            onChangeText={(text) => {
              setSearchQuery(text);
              setSearchMatchIndex(0);
              setHasSubmittedSearch(false);
            }}
            placeholder="Search messages in this session…"
            placeholderTextColor={colors.faint}
            style={styles.chatSearchInput}
            autoFocus
            returnKeyType="search"
            onSubmitEditing={handleSearchSubmit}
          />
          {searchQuery ? (
            <Pressable
              onPress={() => {
                setSearchQuery('');
                setHasSubmittedSearch(false);
              }}
              hitSlop={8}
              style={{ padding: 2 }}
            >
              <Ionicons name="close-circle" size={15} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>

        {searchMatches.length > 1 ? (
          <View style={styles.searchNavControls}>
            <Text style={styles.chatSearchBadgeText}>
              {searchMatchIndex + 1}/{searchMatches.length}
            </Text>
            <Pressable
              onPress={() => scrollToMatch(searchMatchIndex - 1)}
              hitSlop={8}
              style={styles.searchNavBtn}
              accessibilityLabel="Previous"
            >
              <Ionicons name="chevron-up" size={15} color={colors.text} />
            </Pressable>
            <Pressable
              onPress={() => scrollToMatch(searchMatchIndex + 1)}
              hitSlop={8}
              style={styles.searchNavBtn}
              accessibilityLabel="Next"
            >
              <Ionicons name="chevron-down" size={15} color={colors.text} />
            </Pressable>
          </View>
        ) : searchMatches.length === 1 ? (
          <View style={styles.chatSearchBadge}>
            <Text style={styles.chatSearchBadgeText}>1 hasil</Text>
          </View>
        ) : hasSubmittedSearch && searchQuery.trim() ? (
          <View style={styles.chatSearchBadge}>
            <Text style={[styles.chatSearchBadgeText, { color: colors.muted }]}>0 hasil</Text>
          </View>
        ) : null}
      </View>
    ) : null}
    {err ? (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingBottom: 6 }}>
        <Text style={[styles.errorInline, { flex: 1 }]}>{err}</Text>
        {lastSubmittedTextRef.current ? (
          <Pressable
            onPress={() => { setErr(''); void submit(lastSubmittedTextRef.current); }}
            style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 7, borderWidth: 1, borderColor: colors.bad }}
          >
            <Text style={{ fontSize: 11.5, fontWeight: '700', color: colors.bad }}>Retry</Text>
          </Pressable>
        ) : null}
      </View>
    ) : null}
    {!online || (wasConnectedRef.current && !connected && status !== 'testing' && status !== 'error') ? (
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: 8,
        paddingHorizontal: 12, paddingVertical: 7,
        backgroundColor: !online
          ? (isDark ? 'rgba(239,68,68,0.15)' : 'rgba(220,38,38,0.1)')
          : (isDark ? 'rgba(245,158,11,0.15)' : 'rgba(217,119,6,0.1)'),
        borderBottomWidth: 1,
        borderBottomColor: !online
          ? (isDark ? 'rgba(239,68,68,0.3)' : 'rgba(220,38,38,0.2)')
          : (isDark ? 'rgba(245,158,11,0.3)' : 'rgba(217,119,6,0.2)'),
      }}>
        <Ionicons
          name={!online ? 'cloud-offline-outline' : 'sync-outline'}
          size={14}
          color={!online ? (isDark ? '#f87171' : '#dc2626') : (isDark ? '#fbbf24' : '#d97706')}
        />
        <Text style={{
          flex: 1, fontSize: 11, fontWeight: '600',
          color: !online ? (isDark ? '#f87171' : '#dc2626') : (isDark ? '#fbbf24' : '#d97706'),
        }}>
          {!online ? 'Koneksi internet terputus' : 'Koneksi ke server terputus · menyambung ulang…'}
        </Text>
        {online ? (
          <Pressable
            onPress={() => void onReconnect?.()}
            hitSlop={8}
            style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: isDark ? '#fbbf24' : '#d97706' }}
          >
            <Text style={{ fontSize: 10, fontWeight: '700', color: isDark ? '#fbbf24' : '#d97706' }}>Sambung ulang</Text>
          </Pressable>
        ) : null}
      </View>
    ) : null}
    <ScrollView
      ref={scrollRef}
      contentContainerStyle={[styles.chatMessages, searchOpen && { paddingTop: 22 }, Platform.OS === 'web' && textScale !== 1 ? ({ zoom: textScale } as any) : null]}
      onScroll={onChatScroll}
      scrollEventThrottle={60}
      onTouchStart={() => { isUserTouchingRef.current = true; }}
      onTouchEnd={() => { isUserTouchingRef.current = false; }}
      onScrollBeginDrag={() => { isUserTouchingRef.current = true; }}
      onScrollEndDrag={() => { isUserTouchingRef.current = false; }}
      onContentSizeChange={(_w: number, h: number) => {
        const grew = h > contentHeightRef.current;
        contentHeightRef.current = h;
        if (grew && stickToBottomRef.current) autoScrollToBottom(!(busy || isResponding));
      }}
      onLayout={() => { if (stickToBottomRef.current) autoScrollToBottom(false); }}
    >
      {searchOpen ? <View style={{ height: 10 }} /> : null}
      {status === 'testing' ? (
        <LoadingBlock label="Connecting to Hermes…" />
      ) : (loadingMessages && visibleMessages.length === 0) ? (
        <LoadingBlock label="Loading chat…" />
      ) : visibleMessages.length ? (
        renderMessages()
      ) : (
        <View style={styles.centerPane}>
          <Ionicons name="sparkles-outline" size={32} color={colors.primary2} />
          <Text style={styles.sectionTitle}>How can Hermes help?</Text>
          <Text style={styles.mutedCenter}>Start typing, or open the menu to pick an earlier session.</Text>
        </View>
      )}
      {isBusyOrActive ? (
        <View style={{ marginVertical: 3 }}>
          <ActivitySummaryLine
            parts={currentTurnToolCalls}
            tokens={liveTurnTokens}
            model={pillModel}
            isLive={true}
          />
          {isThinking && !isResponding ? (
            <ThinkingProcessCard
              seconds={thinkingSeconds}
              label={turn.remote ? 'Dikerjakan di perangkat lain…' : (liveActivity.active ? liveActivity.label : undefined)}
              reasoningText={streamingReasoning}
            />
          ) : null}
        </View>
      ) : null}
    </ScrollView>
    {queuedAdmission ? (
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginBottom: 6,
        paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10,
        backgroundColor: colors.card, borderWidth: 1, borderColor: colors.warn
      }}>
        <Ionicons name="time-outline" size={14} color={colors.warn} />
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 11.5, color: colors.text }}>
          Antre: {queuedAdmission.text.slice(0, 70)}
        </Text>
        <Pressable onPress={() => void steerQueuedNow()} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: colors.primary }}>
          <Text style={{ fontSize: 10.5, fontWeight: '700', color: '#fff' }}>Kirim sekarang</Text>
        </Pressable>
        <Pressable onPress={() => void cancelQueuedNow()} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: colors.bad }}>
          <Text style={{ fontSize: 10.5, fontWeight: '700', color: colors.bad }}>Batal</Text>
        </Pressable>
      </View>
    ) : null}
    {showJumpToLatest ? (
      <Pressable
        onPress={() => { stickToBottomRef.current = true; setShowJumpToLatest(false); scrollToBottom(true); }}
        style={{
          alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 5,
          marginBottom: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
          backgroundColor: colors.card, borderWidth: 1, borderColor: colors.stroke
        }}
      >
        <Ionicons name="arrow-down" size={13} color={colors.primary} />
        <Text style={{ fontSize: 11.5, fontWeight: '700', color: colors.primary }}>Pesan terbaru</Text>
      </Pressable>
    ) : null}
    {slashMatches.length ? <View style={styles.slashPalette}>{slashMatches.map(c => <Pressable key={c.name} onPress={() => { setPrompt(''); void runSlash(c.name); }} style={styles.slashRow}><Text style={styles.slashName}>{c.name}</Text><Text style={styles.slashDesc} numberOfLines={1}>{c.description}</Text></Pressable>)}</View> : null}
    {attachments.length ? (
      <View style={styles.attachmentBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.attachmentScroll}>
          {attachments.map(att => (
            <View key={att.id} style={styles.attachmentChip}>
              <Ionicons name={att.type === 'image' ? 'image-outline' : 'document-text-outline'} size={15} color={colors.primary} />
              <Text style={styles.attachmentName} numberOfLines={1}>{att.name}</Text>
              <Text style={styles.attachmentSize}>({Math.round(att.size / 1024) || 1} KB)</Text>
              <Pressable onPress={() => removeAttachment(att.id)} style={styles.attachmentRemove}>
                <Ionicons name="close" size={13} color={colors.muted} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      </View>
    ) : null}

    {/* Approval Card (Inline Gatekeeper) */}
    {activeApproval ? (
      <View style={{
        zIndex: 10,
        marginHorizontal: 12,
        marginBottom: 8,
        padding: 12,
        borderRadius: 12,
        backgroundColor: colors.card,
        borderWidth: 1.5,
        borderColor: colors.warn,
        shadowColor: '#000',
        shadowOpacity: 0.15,
        shadowRadius: 6,
        elevation: 3,
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <Ionicons name="shield-half-outline" size={18} color={colors.warn} />
          <Text style={{ fontSize: 13, fontWeight: '700', color: colors.warn, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Approval Required
          </Text>
        </View>
        <Text style={{ fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: 2 }}>
          {activeApproval.payload?.description || 'Hermes meminta izin eksekusi perintah:'}
        </Text>
        {activeApproval.payload?.command ? (
          <View style={{
            backgroundColor: isDark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.05)',
            padding: 8,
            borderRadius: 6,
            marginVertical: 6,
            borderLeftWidth: 3,
            borderLeftColor: colors.warn
          }}>
            <Text style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11.5, color: colors.text }}>
              {activeApproval.payload.command}
            </Text>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <Pressable
            disabled={respondingControl}
            onPress={() => void handleApprovalRespond('once')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              backgroundColor: colors.primary,
              paddingHorizontal: 12,
              paddingVertical: 7,
              borderRadius: 8
            }}
          >
            <Ionicons name="checkmark" size={15} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>Approve Once</Text>
          </Pressable>
          <Pressable
            disabled={respondingControl}
            onPress={() => void handleApprovalRespond('session')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
              paddingHorizontal: 10,
              paddingVertical: 7,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: colors.stroke
            }}
          >
            <Ionicons name="infinite-outline" size={15} color={colors.text} />
            <Text style={{ color: colors.text, fontSize: 12, fontWeight: '600' }}>For Session</Text>
          </Pressable>
          <Pressable
            disabled={respondingControl}
            onPress={() => void handleApprovalRespond('deny')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              backgroundColor: 'rgba(239, 68, 68, 0.15)',
              paddingHorizontal: 12,
              paddingVertical: 7,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: colors.bad
            }}
          >
            <Ionicons name="close" size={15} color={colors.bad} />
            <Text style={{ color: colors.bad, fontSize: 12, fontWeight: '700' }}>Deny</Text>
          </Pressable>
        </View>
      </View>
    ) : null}

    {/* Clarify Modal (Interactive Choice/Questionnaire) */}
    {activeClarify ? (
      <View style={{
        zIndex: 10,
        marginHorizontal: 12,
        marginBottom: 8,
        padding: 12,
        borderRadius: 12,
        backgroundColor: colors.card,
        borderWidth: 1.5,
        borderColor: colors.primary,
        shadowColor: '#000',
        shadowOpacity: 0.15,
        shadowRadius: 6,
        elevation: 3,
      }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <Ionicons name="help-circle-outline" size={18} color={colors.primary} />
          <Text style={{ fontSize: 13, fontWeight: '700', color: colors.primary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Clarification Needed
          </Text>
        </View>
        <Text style={{ fontSize: 13.5, color: colors.text, fontWeight: '600', marginBottom: 8 }}>
          {activeClarify.payload?.question || 'Hermes butuh keputusan/masukan Anda:'}
        </Text>
        {Array.isArray(activeClarify.payload?.choices) && activeClarify.payload.choices.length > 0 ? (
          <View style={{ gap: 6, marginBottom: 8 }}>
            {activeClarify.payload.choices.map((choice: string, idx: number) => {
              const selected = clarifySelectedChoices.includes(choice);
              return (
                <Pressable
                  key={idx}
                  onPress={() => {
                    setClarifyAnswerText('');
                    if (activeClarify.payload?.multi_select) {
                      setClarifySelectedChoices(prev => selected ? prev.filter(c => c !== choice) : [...prev, choice]);
                    } else {
                      setClarifySelectedChoices([choice]);
                    }
                  }}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    padding: 8,
                    borderRadius: 8,
                    backgroundColor: selected ? (isDark ? 'rgba(59, 130, 246, 0.2)' : 'rgba(59, 130, 246, 0.1)') : (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)'),
                    borderWidth: 1,
                    borderColor: selected ? colors.primary : colors.stroke
                  }}
                >
                  <Ionicons
                    name={selected ? (activeClarify.payload?.multi_select ? 'checkbox' : 'radio-button-on') : (activeClarify.payload?.multi_select ? 'square-outline' : 'radio-button-off')}
                    size={16}
                    color={selected ? colors.primary : colors.muted}
                  />
                  <Text style={{ fontSize: 12.5, color: colors.text, flex: 1 }}>{choice}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
          <TextInput
            value={clarifyAnswerText}
            onChangeText={(txt) => {
              setClarifyAnswerText(txt);
              if (txt && !activeClarify.payload?.multi_select) {
                setClarifySelectedChoices([]);
              }
            }}
            placeholder={activeClarify.payload?.choices?.length ? 'Atau ketik jawaban lain…' : 'Ketik jawaban klarifikasi…'}
            placeholderTextColor={colors.faint}
            style={{
              flex: 1,
              fontSize: 12.5,
              color: colors.text,
              backgroundColor: isDark ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.04)',
              borderRadius: 8,
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderWidth: 1,
              borderColor: colors.stroke
            }}
          />
          <Pressable
            disabled={respondingControl}
            onPress={() => void handleClarifySubmit('')}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: colors.stroke,
              backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <Text style={{ color: colors.muted, fontSize: 12, fontWeight: '600' }}>Skip</Text>
          </Pressable>
          <Pressable
            disabled={respondingControl}
            onPress={() => void handleClarifySubmit()}
            style={{
              backgroundColor: colors.primary,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 8,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4
            }}
          >
            <Ionicons name="send" size={13} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>Submit</Text>
          </Pressable>
        </View>
      </View>
    ) : null}

    <View style={styles.composerControlBar}>
      {/* Left: Model Selector Pill */}
      {onModelPress ? (
        <Pressable onPress={onModelPress} style={styles.composerModelPill}>
          <Ionicons name="sparkles" size={11} color={colors.primary2} />
          <Text style={styles.composerModelPillText} numberOfLines={1}>{shortModel}</Text>
          <Ionicons name="chevron-down" size={10} color={colors.muted} />
        </Pressable>
      ) : null}

      <View style={styles.composerControlDivider} />

      {/* Center: Session Context Window */}
      <View style={styles.sessionMetricsBadge} accessibilityLabel="Session Context Window">
        <Ionicons name="layers-outline" size={12} color={colors.primary2} />
        <Text style={styles.sessionMetricsText}>
          {formatContextTokens(sessionContext.used)}
          <Text style={{ color: colors.faint }}> / </Text>
          {formatContextWindow(sessionContext.total || modelInfo?.effective_context_length || 1048576)}
          {sessionContext.used > 0 ? (
            <Text style={{ color: colors.faint, fontSize: 9.5 }}>{` (${sessionContext.pct}%)`}</Text>
          ) : null}
        </Text>
      </View>

      {/* Right: STOP button (only appears when active/busy) */}
      {busy || isThinking ? (
        <Pressable
          onPress={async () => {
            try {
              if (rpc && activeRuntimeSession) {
                await rpc.interrupt(activeRuntimeSession);
              }
            } catch {}
            setBusy(false);
            void syncMessages();
          }}
          style={styles.composerStopBtn}
        >
          <Ionicons name="stop-circle" size={13} color={colors.bad} />
          <Text style={styles.composerStopText}>STOP</Text>
        </Pressable>
      ) : null}
    </View>
    <View style={styles.composer}>
      {Platform.OS === 'web' ? (
        <input
          ref={fileInputRef as any}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
      ) : null}
      <Pressable onPress={pickFiles} disabled={busy || !connected} style={styles.attachBtn}>
        <Ionicons name="attach-outline" size={19} color={colors.text} />
      </Pressable>
      <TextInput
        value={prompt}
        onChangeText={setPrompt}
        placeholder={attachments.length ? "Add a message..." : "Message Hermes…"}
        placeholderTextColor={colors.faint}
        style={styles.composerInput}
        multiline
        numberOfLines={1}
      />
      <Pressable
        onPressIn={handleMicDown}
        onPressOut={handleMicUp}
        onPress={handleMicClick}
        disabled={busy || !connected}
        hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
        pressRetentionOffset={{ top: 150, bottom: 150, left: 150, right: 150 }}
        style={[styles.micBtn, isListening && styles.micBtnActive, (!connected || busy) && { opacity: 0.45 }]}
        {...(Platform.OS === 'web' ? ({
          onContextMenu: (e: any) => e.preventDefault(),
          onPointerDown: handleMicDown,
          onPointerUp: handleMicUp,
          onPointerCancel: () => stopListening(),
        } as any) : {})}
      >
        <Ionicons
          name={isListening ? "mic" : "mic-outline"}
          size={18}
          color={isListening ? "#ef4444" : colors.text}
        />
      </Pressable>
      <Pressable
        onPress={() => void submit()}
        // Boleh kirim saat busy: gateway memasukkan pesan ke FIFO (status 'queued').
        disabled={!connected || (!prompt.trim() && !attachments.length)}
        style={[styles.send, (!connected || (!prompt.trim() && !attachments.length)) && { opacity: 0.45 }]}
      >
        <Ionicons name="send" color={colors.text} size={16}/>
      </Pressable>
    </View>
    <Modal visible={drawerVisible} transparent animationType="none" onRequestClose={() => closeDrawer()}>
      <Animated.View style={[styles.drawerScrim, { opacity: scrimOpacity }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => closeDrawer()} />
      </Animated.View>
      <Animated.View style={[styles.drawer, { transform: [{ translateX: drawerTranslateX }] }]}>
        <View style={styles.rowBetween}>
          <Text style={styles.sectionTitle}>Chat</Text>
          <Pressable onPress={() => closeDrawer()} style={styles.iconButton}>
            <Ionicons name="close-outline" size={24} color={colors.text} />
          </Pressable>
        </View>
        <Button text="New chat" icon="add-outline" onPress={() => closeDrawer(() => { void newSession(); })} />
        <View style={styles.drawerFilterRow}>
          <Pressable onPress={() => { setDrawerMode('chats'); void syncRunningSessions(); loadSessions(true, 0, 'chats').catch(e => setErr(e.message)); }} style={[styles.drawerFilterPill, drawerMode === 'chats' && styles.drawerFilterPillActive]}><Text style={styles.drawerFilterText}>Chat</Text></Pressable>
          <Pressable onPress={() => { setDrawerMode('cron'); void syncRunningSessions(); loadSessions(true, 0, 'cron').catch(e => setErr(e.message)); }} style={[styles.drawerFilterPill, drawerMode === 'cron' && styles.drawerFilterPillActive]}><Text style={styles.drawerFilterText}>Cron</Text></Pressable>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8, paddingHorizontal: 10, borderRadius: 9, borderWidth: 1, borderColor: colors.stroke, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)' }}>
          <Ionicons name="search-outline" size={14} color={colors.muted} />
          <TextInput
            value={drawerQuery}
            onChangeText={setDrawerQuery}
            placeholder={drawerMode === 'cron' ? 'Cari cron…' : 'Cari sesi…'}
            placeholderTextColor={colors.faint}
            style={{ flex: 1, paddingVertical: 7, fontSize: 12, color: colors.text }}
          />
          {drawerQuery ? (
            <Pressable onPress={() => setDrawerQuery('')} hitSlop={8}>
              <Ionicons name="close-circle" size={14} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>
        {loadingSessions && drawerSessions.length === 0 ? <LoadingBlock label="Loading sessions…" compact /> : <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 26 }} onScroll={(event) => { if (isNearScrollEnd(event)) loadSessions(false).catch(e => setErr(e.message)); }} scrollEventThrottle={240}>{drawerSessions.map(s => {
          const sid = sessionId(s);
          const isRunning = isSessionRunning(sid);
          return (
            <View key={sid} style={[styles.drawerItem, activeSession === sid && styles.selected]}>
              <Pressable style={{ flex: 1 }} onPress={() => { closeDrawer(); void openSession(sid); }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  {isRunning ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3.5, backgroundColor: isDark ? 'rgba(34,197,94,0.18)' : 'rgba(22,163,74,0.12)', paddingHorizontal: 5, paddingVertical: 1.5, borderRadius: 99 }}>
                      <View style={{ width: 5, height: 5, borderRadius: 99, backgroundColor: '#22c55e' }} />
                      <Text style={{ fontSize: 8.5, fontWeight: '800', color: isDark ? '#4ade80' : '#16a34a', letterSpacing: 0.3 }}>RUNNING</Text>
                    </View>
                  ) : null}
                  <Text style={[styles.listTitle, { flex: 1 }]} numberOfLines={1}>{titleOf(s)}</Text>
                </View>
                <Text style={styles.listSub}>{shortId(sid)} · {safeText(s.message_count ?? 0)} messages</Text>
              </Pressable>
              <Pressable onPress={() => openRename(sid, titleOf(s))} style={styles.drawerRenameBtn}>
                <Ionicons name="create-outline" size={16} color={colors.muted} />
              </Pressable>
            </View>
          );
        })}{loadingMoreSessions ? <LoadingBlock label="Loading more…" compact /> : sessionsHasMore ? <Text style={styles.mutedCenter}>Scroll to latest</Text> : null}</ScrollView>}
      </Animated.View>
    </Modal>

    <Modal visible={!!infoModal} transparent animationType="fade" onRequestClose={() => setInfoModal(null)}>
      <Pressable style={styles.drawerScrim} onPress={() => setInfoModal(null)} />
      <View style={styles.renameModal}>
        <Text style={styles.sectionTitle}>{infoModal?.title}</Text>
        <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ paddingBottom: 6 }}>
          <Text style={styles.text} selectable>{infoModal?.body || ''}</Text>
        </ScrollView>
        <Button text="Close" secondary onPress={() => setInfoModal(null)} />
      </View>
    </Modal>

    <Modal visible={!!deleteTarget} transparent animationType="fade" onRequestClose={() => setDeleteTarget(null)}>
      <Pressable style={styles.drawerScrim} onPress={() => setDeleteTarget(null)} />
      <View style={styles.renameModal}>
        <Text style={styles.sectionTitle}>Delete chat?</Text>
        <Text style={styles.muted}>“{deleteTarget?.title}” akan dihapus permanen dari Hermes. Tindakan ini nggak bisa dibatalkan.</Text>
        <View style={styles.row}>
          <Button text="Cancel" secondary onPress={() => setDeleteTarget(null)} />
          <Button text={deleting ? 'Menghapus…' : 'Delete'} icon="trash-outline" onPress={() => void confirmDelete()} />
        </View>
      </View>
    </Modal>

    <Modal visible={!!renameTarget} transparent animationType="fade" onRequestClose={() => setRenameTarget(null)}>
      <Pressable style={styles.drawerScrim} onPress={() => setRenameTarget(null)} />
      <View style={styles.renameModal}>
        <Text style={styles.sectionTitle}>Edit</Text>
        <Text style={styles.muted}>Rename this session or delete the conversation.</Text>
        <TextInput
          value={renameValue}
          onChangeText={setRenameValue}
          placeholder="Chat title"
          placeholderTextColor={colors.faint}
          style={styles.renameInput}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={() => void submitRename()}
        />
        <View style={styles.rowBetween}>
          <View style={styles.row}>
            <Button text="Cancel" secondary onPress={() => setRenameTarget(null)} />
            <Button text={renaming ? 'Menyimpan…' : 'Save'} icon="checkmark-outline" onPress={() => void submitRename()} />
          </View>
          <Pressable
            onPress={() => {
              if (renameTarget) {
                setDeleteTarget(renameTarget);
                setRenameTarget(null);
              }
            }}
            style={styles.deleteDangerBtn}
          >
            <Ionicons name="trash-outline" size={16} color={colors.bad} />
            <Text style={styles.deleteDangerText}>Delete</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  </View>;
}

function formatThoughtDuration(totalSeconds: number): string {
  if (!totalSeconds || totalSeconds <= 0) return 'sebentar';
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins > 0 && secs > 0) return `${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m`;
  return `${secs}s`;
}

function formatMessageTime(at: number): string {
  if (!at || at <= 0) return '';
  const d = new Date(at);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function ThinkingProcessCard({
  seconds,
  label,
  reasoningText,
}: {
  seconds: number;
  label?: string;
  reasoningText?: string;
}) {
  const { colors, styles } = useTheme();
  const [expanded, setExpanded] = useState(true);
  const streamScrollRef = useRef<any>(null);

  const enterAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enterAnim, {
      toValue: 1,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [enterAnim]);

  const reasoningLines = useMemo(() => {
    return parseReasoningLines(reasoningText || '');
  }, [reasoningText]);

  // Plafon baris: teks reasoning bisa jadi 90+ baris, dan semuanya dirender ulang tiap
  // flush. Cuma 8 baris terakhir yang relevan (streaming), sisanya diringkas jadi counter.
  const MAX_VISIBLE_REASONING_LINES = 8;
  const visibleReasoningLines = reasoningLines.length > MAX_VISIBLE_REASONING_LINES
    ? reasoningLines.slice(-MAX_VISIBLE_REASONING_LINES)
    : reasoningLines;
  const hiddenReasoningCount = reasoningLines.length - visibleReasoningLines.length;

  useEffect(() => {
    if (expanded && reasoningLines.length && streamScrollRef.current) {
      streamScrollRef.current.scrollToEnd({ animated: true });
    }
  }, [reasoningLines.length, expanded]);

  if (!expanded) {
    return (
      <Pressable onPress={() => setExpanded(true)} style={styles.thinkingPillCollapsed}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Text style={{ fontSize: 12 }}>🧠</Text>
          <Text style={styles.thinkingPillText}>
            Thought for {formatThoughtDuration(seconds)}
            {reasoningLines.length ? ` · ${reasoningLines.length} steps` : ''}
          </Text>
        </View>
        <Ionicons name="chevron-down" size={13} color={colors.primary2} />
      </Pressable>
    );
  }

  return (
    <Animated.View style={[styles.thinkingCard, { opacity: enterAnim }]}>
      <Pressable onPress={() => setExpanded(false)} style={styles.thinkingHeaderRow}>
        <View style={styles.thinkingHeaderLeft}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.thinkingTitle}>Thinking</Text>
          <Text style={styles.thinkingTimer}>{formatThoughtDuration(seconds)}</Text>
        </View>
        <Ionicons name="chevron-up" size={14} color={colors.muted} />
      </Pressable>

      {label ? (
        <View style={styles.thinkingStepRow}>
          <View style={styles.thinkingDot} />
          <Text style={styles.thinkingStepText} numberOfLines={2}>{label}</Text>
        </View>
      ) : null}

      {reasoningLines.length ? (
        <ScrollView
          ref={streamScrollRef}
          style={styles.thinkingStreamBox}
          nestedScrollEnabled
          onContentSizeChange={() => {
            if (streamScrollRef.current) {
              streamScrollRef.current.scrollToEnd({ animated: false });
            }
          }}
        >
          {hiddenReasoningCount > 0 ? (
            <Text style={{ color: colors.muted, fontSize: 10, fontWeight: '600', marginBottom: 3 }}>
              …{hiddenReasoningCount} previous steps
            </Text>
          ) : null}
          {visibleReasoningLines.map((line, idx) => {
            const isLast = idx === visibleReasoningLines.length - 1;
            return (
              <View key={`rl-${idx}`} style={styles.thinkingLineRow}>
                <Text style={styles.thinkingLinePrefix}>›</Text>
                <Text style={styles.thinkingLineText}>
                  {line}
                  {isLast ? <Text style={{ color: colors.primary }}> ▍</Text> : null}
                </Text>
              </View>
            );
          })}
        </ScrollView>
      ) : null}
    </Animated.View>
  );
}

function BlinkingCursor({ color }: { color: string }) {
  const cursorAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(cursorAnim, { toValue: 0.15, duration: 420, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(cursorAnim, { toValue: 1, duration: 420, useNativeDriver: Platform.OS !== 'web' }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [cursorAnim]);

  return (
    <Animated.Text style={{ color, opacity: cursorAnim, fontWeight: '900', fontSize: 15 }}>
      {' '}▍
    </Animated.Text>
  );
}

// memo(): tanpa ini, tiap flush delta turn baru bikin ulang semua kartu lama.
// Teks reasoning-nya sendiri nggak berubah, jadi cukup di-skip.
const FinishedThinkingAccordion = memo(function FinishedThinkingAccordion({
  reasoning,
  duration,
}: {
  reasoning: string;
  duration?: number;
}) {
  const { colors, styles } = useTheme();
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => parseReasoningLines(reasoning), [reasoning]);
  // Plafon 40 baris saat dibuka: reasoning panjang bisa jadi 100+ baris, dan semuanya
  // dibuat sekaligus di dalam satu ScrollView. Sisanya diringkas jadi counter.
  const MAX_OPEN_LINES = 40;
  const shown = lines.length > MAX_OPEN_LINES ? lines.slice(-MAX_OPEN_LINES) : lines;
  const hidden = lines.length - shown.length;

  if (!reasoning || !reasoning.trim()) return null;

  const durationStr = duration && duration > 0 ? `Thought for ${formatThoughtDuration(duration)}` : 'Thought process';

  return (
    <View style={{ marginVertical: 3 }}>
      <Pressable onPress={() => setOpen(prev => !prev)} style={styles.thinkingPillCollapsed}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Text style={{ fontSize: 12 }}>🧠</Text>
          <Text style={styles.thinkingPillText}>
            {durationStr} · {lines.length} steps
          </Text>
        </View>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={13} color={colors.primary2} />
      </Pressable>
      {open ? (
        <View style={[styles.thinkingCard, { marginTop: 4, width: '100%', maxWidth: '100%' }]}>
          <ScrollView nestedScrollEnabled style={styles.thinkingStreamBox} contentContainerStyle={{ gap: 4 }}>
            {hidden > 0 ? (
              <Text style={{ color: colors.muted, fontSize: 10, fontWeight: '600', marginBottom: 2 }}>
                …{hidden} previous steps
              </Text>
            ) : null}
            {shown.map((l, idx) => (
              <View key={`r-${idx}`} style={styles.thinkingLineRow}>
                <Text style={styles.thinkingLinePrefix}>›</Text>
                <Text style={styles.thinkingLineText}>{l}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
});

// memo(): dengan prop yang stabil (lihat handleMessageLayout + NO_TOOL_PARTS), bubble lama
// di-skip total tiap flush delta turn baru — cuma bubble yang lagi streaming yang render.
const MessageBubble = memo(function MessageBubble({
  message,
  isStreaming = false,
  defaultModel,
  extraToolParts = [],
  isCurrentMatch = false,
  isAnyMatch = false,
  onLayoutY,
  duration,
  onRetry,
}: {
  message: Message;
  isStreaming?: boolean;
  defaultModel?: string;
  extraToolParts?: NonTextPart[];
  isCurrentMatch?: boolean;
  isAnyMatch?: boolean;
  onLayoutY?: (id: string, y: number) => void;
  duration?: number;
  onRetry?: (text: string) => void;
}) {
  const { colors, styles, isDark } = useTheme();
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isReview = isSystem && (message.text.includes('Self-improvement') || message.text.includes('💾'));
  const parts = message.parts?.length ? message.parts : parseMessageParts(message.text, message.role);
  const textParts = parts.filter(p => p.kind === 'text') as Extract<MessagePart, { kind: 'text' }>[];
  const toolParts = parts.filter(p => p.kind !== 'text') as NonTextPart[];
  const allToolParts = [...extraToolParts, ...toolParts];

  const enterAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(enterAnim, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [enterAnim]);

  const actionModel = message.model || defaultModel;
  const actionTokens = message.tokenCount || estimateActionTokens(allToolParts, message.text);

  if (!textParts.length && allToolParts.length) {
    return (
      <View
        nativeID={`msg-${message.id}`}
        onLayout={(e) => onLayoutY?.(message.id, e.nativeEvent.layout.y)}
      >
        <ActivitySummaryLine parts={allToolParts} tokens={actionTokens} model={actionModel} duration={duration} />
      </View>
    );
  }
  return (
    <Animated.View
      nativeID={`msg-${message.id}`}
      onLayout={(e) => onLayoutY?.(message.id, e.nativeEvent.layout.y)}
      style={[
        styles.messageWrap,
        isUser && styles.messageWrapUser,
        isCurrentMatch && styles.messageHighlightActive,
        isAnyMatch && !isCurrentMatch && styles.messageHighlight,
        {
          opacity: enterAnim,
          ...(Platform.OS !== 'web' ? {
            transform: [{
              translateY: enterAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [6, 0],
              })
            }]
          } : {})
        }
      ]}
    >
      <View style={[
        styles.bubble,
        isUser ? styles.userBubble : styles.assistantBubble,
        isSystem && {
          backgroundColor: isDark ? 'rgba(30, 41, 59, 0.75)' : 'rgba(241, 245, 249, 0.95)',
          borderColor: isDark ? 'rgba(56, 189, 248, 0.35)' : 'rgba(14, 165, 233, 0.35)',
          borderWidth: 1,
        }
      ]}>
        {!isUser ? (
          <Text style={[styles.bubbleRole, isSystem && { color: colors.primary2 }]}>
            {isReview ? '💾 SELF-IMPROVEMENT REVIEW' : (isSystem ? 'SYSTEM NOTICE' : 'HERMES AGENT')}
          </Text>
        ) : null}
        {!isUser && message.reasoning ? (
          <FinishedThinkingAccordion reasoning={message.reasoning} duration={duration} />
        ) : null}
        {textParts.map((p, i) => (
          isUser ? (
            <Text key={`t-${i}`} style={[styles.text, styles.userBubbleText]}>{p.text}</Text>
          ) : (
            <View key={`t-${i}`}>
              <MarkdownView content={p.text} colors={colors} isDark={isDark} />
              {isStreaming && i === textParts.length - 1 ? (
                <BlinkingCursor color={colors.primary} />
              ) : null}
            </View>
          )
        ))}
        {!textParts.length && !allToolParts.length ? <Text style={styles.muted}>Nothing to display.</Text> : null}

        {message.failed ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <Ionicons name="alert-circle" size={13} color={colors.bad} />
            <Text style={{ fontSize: 10.5, fontWeight: '600', color: colors.bad, flex: 1 }}>Gagal terkirim</Text>
            {onRetry ? (
              <Pressable
                onPress={() => onRetry(message.text)}
                style={{ paddingHorizontal: 9, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderColor: colors.bad }}
              >
                <Text style={{ fontSize: 10.5, fontWeight: '700', color: colors.bad }}>Kirim ulang</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {/* WhatsApp-style bottom-right timestamp */}
        {message.at ? (
          <View style={{ alignSelf: 'flex-end', marginTop: 1, marginBottom: -1, marginRight: -2 }}>
            <Text style={{
              fontSize: 9.2,
              fontWeight: '500',
              color: isUser
                ? (isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.45)')
                : (isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)'),
              letterSpacing: 0.2
            }}>
              {formatMessageTime(message.at)}
            </Text>
          </View>
        ) : null}
      </View>

      {/* FINAL tools - tokens - model displayed right underneath HERMES AGENT response window */}
      {!isUser && !isSystem ? (
        <View style={{ marginTop: 2, paddingHorizontal: 4 }}>
          <ActivitySummaryLine
            parts={allToolParts}
            tokens={actionTokens}
            model={actionModel}
            duration={duration}
          />
        </View>
      ) : null}
    </Animated.View>
  );
});

function formatActionTokens(num: number): string {
  if (!num || num <= 0) return '0 Tk';
  if (num >= 1000000) return `${(num / 1000000).toFixed(1).replace(/\.0$/, '')}M Tk`;
  if (num >= 1000) return `${(num / 1000).toFixed(num >= 10000 ? 0 : 1).replace(/\.0$/, '')}k Tk`;
  return `${num} Tk`;
}

function formatContextTokens(num: number): string {
  if (!num || num <= 0) return '0';
  if (num >= 1000000) return `${(num / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(num >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return `${num}`;
}

function formatContextWindow(num: number): string {
  if (!num || num <= 0) return '1M';
  if (num >= 1048576) {
    const mb = num / 1048576;
    return mb % 1 === 0 ? `${mb}M` : `${mb.toFixed(1)}M`;
  }
  if (num >= 1000000) {
    const mb = num / 1000000;
    return mb % 1 === 0 ? `${mb}M` : `${mb.toFixed(1)}M`;
  }
  if (num >= 1000) return `${Math.round(num / 1000)}k`;
  return `${num}`;
}

function formatActionModel(rawModel?: string): string {
  if (!rawModel) return 'Model';
  let m = rawModel.split('/').pop() || rawModel;
  m = m.replace(/-(?:high|medium|low)$/i, '');
  if (/^deepseek/i.test(m)) {
    m = m.replace(/^deepseek-?/i, 'DeepSeek ').replace(/-/g, ' ');
  } else if (/^gemini/i.test(m)) {
    m = m.replace(/^gemini-?/i, 'Gemini ').replace(/-/g, ' ');
  } else if (/^claude/i.test(m)) {
    m = m.replace(/^claude-?/i, 'Claude ').replace(/-/g, ' ');
  } else if (/^gpt/i.test(m)) {
    m = m.toUpperCase();
  } else {
    m = m.replace(/-/g, ' ');
  }
  return m.replace(/\b([a-z])/g, (_, c) => c.toUpperCase()).trim();
}

function estimateActionTokens(parts: NonTextPart[] = [], text = '', rawTokenCount = 0): number {
  if (rawTokenCount > 0) return rawTokenCount;
  let charCount = text.length;
  for (const p of parts) {
    charCount += (p.name?.length || 0) + (p.summary?.length || 0) + (p.detail?.length || 0);
  }
  const toolOverhead = parts.length * 1150;
  return Math.max(120, Math.round(charCount / 3.6) + toolOverhead);
}

function ActivitySummaryLine({
  parts,
  tokens,
  model,
  isLive = false,
  duration,
}: {
  parts: NonTextPart[];
  tokens?: number;
  model?: string;
  isLive?: boolean;
  duration?: number;
}) {
  const { colors, styles, isDark } = useTheme();
  const toolCount = parts.filter(p => p.kind === 'tool' || p.kind === 'skill').length;
  const toolText = toolCount > 0 ? `${toolCount} Tool${toolCount === 1 ? '' : 's'}` : '';
  const calculatedTokens = typeof tokens === 'number' && tokens > 0 ? tokens : estimateActionTokens(parts);
  const tokenText = formatActionTokens(calculatedTokens);
  const modelText = formatActionModel(model);
  const durationText = duration && duration > 0 ? `Thought For ${formatThoughtDuration(duration)}` : '';

  const summaryItems = [
    durationText,
    toolText,
    tokenText,
    modelText,
  ].filter(Boolean);

  const mainSummary = summaryItems.join(' - ');

  return (
    <View style={styles.actionSummaryRow}>
      {isLive ? <View style={styles.actionLiveDot} /> : null}
      <Text style={[styles.activityLine, isLive && { color: isDark ? '#60a5fa' : '#2563eb' }]} numberOfLines={1}>
        {mainSummary}
      </Text>
    </View>
  );
}

function ToolCallCard({ part }: { part: NonTextPart }) {
  const { colors, styles } = useTheme();
  const isSkill = part.kind === 'skill';
  const color = part.status === 'error' ? colors.bad : isSkill ? colors.primary2 : colors.primary;
  const icon: keyof typeof Ionicons.glyphMap = isSkill ? 'library-outline' : part.status === 'error' ? 'warning-outline' : 'terminal-outline';
  return <View style={[styles.toolCard, isSkill && styles.skillCard, part.status === 'error' && styles.toolCardError]}>
    <View style={styles.toolGlyph}>{part.status === 'running' ? <ActivityIndicator size="small" color={color} /> : <Ionicons name={icon} size={17} color={color} />}</View>
    <View style={{ flex: 1 }}>
      <Text style={styles.toolTitle}>{isSkill ? 'Skill' : 'Tool'} · {toolTitle(part.name)}</Text>
      <Text style={styles.toolSub} numberOfLines={2}>{part.status === 'running' ? 'Running…' : part.status === 'error' ? 'Perlu perhatian' : 'Completed'}{part.summary ? ` · ${part.summary}` : ''}</Text>
      {part.detail ? <Text style={styles.toolDetail}>{part.detail}</Text> : null}
    </View>
  </View>;
}

let cachedDeliveredPulse: PulseItem[] = [];

function PulseScreen({ rest, rpc, events, activeSession, setActiveSession, setActiveRuntimeSession, setMessages, setTab, setOpsScreen, onBack }: any) {
  const { colors, styles } = useTheme();
  const [delivered, setDelivered] = useState<PulseItem[]>(() => cachedDeliveredPulse);
  const [selected, setSelected] = useState<PulseItem | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  // Tab ini murni RIWAYAT: approval/clarify sudah tampil inline di chat, jadi
  // daftar "Perhatian"/"Running" di sini cuma menduplikasi dan bikin bingung.
  const loadPulse = async (reset = false) => {
    if (!rest) return;
    const nextOffset = reset ? 0 : offset;
    if (!reset && (!hasMore || loading || loadingMore)) return;
    reset ? (!cachedDeliveredPulse.length && setLoading(true)) : setLoadingMore(true);
    try {
      const data = await rest.sessions(PULSE_SESSION_PAGE_SIZE, nextOffset, 'include', 'source=cron');
      const sessions = Array.isArray(data) ? data : data.sessions || [];
      const total = Array.isArray(data) ? undefined : data.total;

      const results = await Promise.allSettled(
        sessions.map(async (s: any) => {
          if (!isUserFacingSession(s)) return null;
          const sid = sessionId(s);
          const raw = await rest.sessionMessages(sid, 5);
          const messages = normalizeMessages(raw).filter(isUserFacingBriefMessage).sort((a, b) => b.at - a.at);
          const latest = messages[0];
          if (!latest) return null;
          return {
            id: `brief-${sid}-${latest.id}`,
            status: 'delivered' as const,
            title: briefTitle(latest.text, titleOf(s)),
            meta: `Delivered ${formatArtifactTime(latest.at || sessionTime(s))} · Automation`,
            summary: briefPreview(latest.text),
            at: latest.at || sessionTime(s),
            sourceId: sid,
            text: latest.text
          };
        })
      );

      const out: PulseItem[] = [];
      for (const res of results) {
        if (res.status === 'fulfilled' && res.value) {
          out.push(res.value);
        }
      }

      setDelivered(prev => {
        const byId = new Map<string, PulseItem>();
        for (const item of (reset && !prev.length ? out : [...prev, ...out])) byId.set(item.id, item);
        const sorted = Array.from(byId.values()).sort((a, b) => b.at - a.at);
        cachedDeliveredPulse = sorted.slice(0, 40);
        return sorted;
      });
      const advanced = nextOffset + sessions.length;
      setOffset(advanced);
      setHasMore(sessions.length === PULSE_SESSION_PAGE_SIZE && (typeof total !== 'number' || advanced < total));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };
  useEffect(() => { loadPulse(true).catch(e => setErr(e.message)); }, [rest]);
  const openChat = async (item: PulseItem) => {
    if (!item.sourceId) return;
    setActiveSession(item.sourceId);
    setActiveRuntimeSession('');
    try {
      const raw = await rest?.sessionMessages(item.sourceId);
      if (raw) setMessages(normalizeMessages(raw));
    } catch {}
    setSelected(null);
    setTab('chat');
  };
  const openOps = () => { setOpsScreen('cron'); setTab('ops'); };
  const shown = delivered;
  const renderActions = (item: PulseItem) => (
    <>
      <Button text="Baca" icon="reader-outline" secondary onPress={() => setSelected(item)} />
      <Button text="Buka chat" icon="chatbubble-outline" secondary onPress={() => openChat(item)} />
    </>
  );
  const renderItem = (item: PulseItem) => <Card key={item.id}>
    <View style={styles.rowBetween}><Text style={styles.eyebrow}>{item.status}</Text><Text style={styles.listSub}>{formatArtifactTime(item.at)}</Text></View>
    <Text style={styles.listTitle} numberOfLines={2}>{item.title}</Text>
    <Text style={styles.listSub} numberOfLines={1}>{item.meta}</Text>
    <Text style={styles.muted} numberOfLines={4}>{item.summary}</Text>
    <View style={styles.row}>{renderActions(item)}</View>
  </Card>;
  return <>
    <ScrollView contentContainerStyle={styles.screen} onScroll={(event) => { if (isNearScrollEnd(event)) loadPulse(false).catch(e => setErr(e.message)); }} scrollEventThrottle={240}>
      {onBack ? (
        <Pressable onPress={onBack} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, marginBottom: 2 }}>
          <Ionicons name="arrow-back" size={18} color={colors.primary} />
          <Text style={{ fontSize: 12.5, fontWeight: '700', color: colors.primary }}>Back to Settings</Text>
        </Pressable>
      ) : null}
      <Card>
        <View style={styles.rowBetween}>
          <Text style={styles.sectionTitle}>Riwayat Aktivitas</Text>
          {delivered.length ? <Text style={styles.listSub}>{delivered.length} item</Text> : null}
        </View>
        <Text style={styles.muted}>
          Brief otomasi & hasil run yang sudah selesai. Persetujuan dan pertanyaan Hermes
          muncul langsung di layar chat.
        </Text>
        {err ? <Text style={styles.error}>{err}</Text> : null}
      </Card>
      {loading && !shown.length
        ? <LoadingBlock label="Memuat riwayat…" />
        : shown.length
          ? shown.map(renderItem)
          : <Empty title="Belum ada riwayat" body="Brief otomasi dan hasil run yang selesai akan muncul di sini." />}
      {loadingMore ? <LoadingBlock label="Memuat lagi…" /> : hasMore && shown.length ? <Text style={styles.mutedCenter}>Geser untuk memuat lebih banyak</Text> : null}
    </ScrollView>
    <Modal visible={!!selected} transparent animationType="slide" onRequestClose={() => setSelected(null)}><Pressable style={styles.drawerScrim} onPress={() => setSelected(null)} /><View style={styles.briefModal}><View style={styles.rowBetween}><Text style={styles.sectionTitle} numberOfLines={2}>{selected?.title}</Text><Pressable onPress={() => setSelected(null)} style={styles.iconButton}><Ionicons name="close-outline" size={24} color={colors.text} /></Pressable></View><Text style={styles.listSub}>{selected?.meta}</Text><ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 18 }}><Text style={styles.text}>{selected?.text}</Text></ScrollView>{selected?.sourceId ? <Button text="Continue in chat" icon="chatbubble-outline" onPress={() => openChat(selected)} /> : null}</View></Modal>
  </>;
}

let cachedArtifacts: ArtifactItem[] = [];

function ArtifactsScreen({ rest, onBack }: { rest: HermesRestClient | null; onBack?: () => void }) {
  const { colors, styles } = useTheme();
  const [items, setItems] = useState<ArtifactItem[]>(() => cachedArtifacts);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [artifactOffset, setArtifactOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const seenRef = useRef(new Set<string>(cachedArtifacts.map(i => `${i.kind}:${i.value}`)));
  const loadPage = async (reset = false) => {
    if (!rest) return;
    const offset = reset ? 0 : artifactOffset;
    if (!reset && (!hasMore || loading || loadingMore)) return;
    reset ? (!cachedArtifacts.length && setLoading(true)) : setLoadingMore(true);
    try {
      if (reset && !cachedArtifacts.length) {
        seenRef.current = new Set<string>();
        setItems([]);
      }
      const data = await rest.sessions(12, offset, 'include');
      const sessions = Array.isArray(data) ? data : data.sessions || [];
      const total = Array.isArray(data) ? undefined : data.total;
      const out: ArtifactItem[] = [];

      const batch = sessions.filter(isUserFacingSession).slice(0, 8);
      const results = await Promise.allSettled(
        batch.map(async (s: any) => {
          const sid = sessionId(s);
          const m = await rest.sessionMessages(sid, 35);
          const messages = (m?.messages || m || []).slice().reverse();
          const list: ArtifactItem[] = [];
          for (const msg of messages) {
            for (const item of extractArtifactItems(msg, titleOf(s), sessionTime(s), isCronSession(s))) {
              list.push(item);
            }
          }
          return list;
        })
      );

      for (const res of results) {
        if (res.status === 'fulfilled') {
          for (const item of res.value) {
            const key = `${item.kind}:${item.value}`;
            if (seenRef.current.has(key)) continue;
            seenRef.current.add(key);
            out.push(item);
          }
        }
      }

      setItems(prev => {
        const merged = (reset && !prev.length) ? out : [...prev, ...out];
        const byKey = new Map<string, ArtifactItem>();
        for (const item of merged) {
          const key = `${item.kind}:${item.value}`;
          if (!byKey.has(key)) byKey.set(key, item);
        }
        const sorted = Array.from(byKey.values()).sort((a, b) => b.at - a.at);
        cachedArtifacts = sorted.slice(0, 60);
        return sorted;
      });
      const nextOffset = offset + sessions.length;
      setArtifactOffset(nextOffset);
      setHasMore(sessions.length === 12 && (typeof total !== 'number' || nextOffset < total));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };
  useEffect(()=>{ loadPage(true).catch(e=>setErr(e.message)); }, [rest]);
  return (
    <ScrollView contentContainerStyle={styles.screen} onScroll={(event) => { if (isNearScrollEnd(event)) loadPage(false).catch(e=>setErr(e.message)); }} scrollEventThrottle={240}>
      {onBack ? (
        <Pressable onPress={onBack} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, marginBottom: 2 }}>
          <Ionicons name="arrow-back" size={18} color={colors.primary} />
          <Text style={{ fontSize: 12.5, fontWeight: '700', color: colors.primary }}>Back to Settings</Text>
        </Pressable>
      ) : null}
      <Card>
        <Text style={styles.sectionTitle}>Artifacts & Media</Text>
        <Text style={styles.muted}>Files, links, images, and documents produced during the session.</Text>
        {err ? <Text style={styles.error}>{err}</Text> : null}
      </Card>
      {loading && !items.length ? (
        <LoadingBlock label="Loading artifacts…" />
      ) : items.length ? (
        items.map((it, i) => <ArtifactCard key={`${it.kind}-${it.value}-${i}`} item={it} />)
      ) : (
        <Empty title="No artifacts found" body="Shared files, links, images, and MEDIA attachments will appear here." />
      )}
      {loadingMore ? <LoadingBlock label="Loading more…" /> : hasMore && items.length ? <Text style={styles.mutedCenter}>Scroll to latest</Text> : null}
    </ScrollView>
  );
}

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const URL_RE = /https?:\/\/[^\s<>"')\]\*]+/g;
const PATH_RE = /(^|[\s("'`])((?:MEDIA:)?(?:\/|~\/|\.\.?\/)[^\s"'`<>]+(?:\.[a-z0-9]{1,8})?)/gi;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp)(?:\?.*)?$/i;
const FILE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|pdf|txt|json|md|csv|zip|tar|gz|mp3|wav|mp4|mov)(?:\?.*)?$/i;

function normalizeArtifactValue(value: string): string {
  return value
    .trim()
    .replace(/\\n/g, '')
    .replace(/^\*+|\*+$/g, '')
    .replace(/[\]}>]+$/g, '')
    .replace(/[\\),.;]+$/g, '')
    .replace(/^\*+|\*+$/g, '')
    .trim();
}
function looksLikePathOrUrl(value: string): boolean { return /^(?:https?:\/\/|file:\/\/|data:image\/|MEDIA:|\/|\.\.?\/|~\/)/i.test(value); }
function looksLikeArtifact(value: string): boolean { return /^(?:https?:\/\/|data:image\/)/i.test(value) || (looksLikePathOrUrl(value) && FILE_EXT_RE.test(value.replace(/^MEDIA:/, ''))); }
function artifactKind(value: string): ArtifactKind { return IMAGE_EXT_RE.test(value.replace(/^MEDIA:/, '')) || value.startsWith('data:image/') ? 'image' : /^(?:https?:\/\/)/i.test(value) ? 'link' : 'file'; }
function artifactHref(value: string): string {
  const clean = value.replace(/^MEDIA:/, '');
  if (/^(?:https?:\/\/|file:\/\/|data:)/i.test(clean)) return clean;
  if (clean.startsWith('/')) return `file://${encodeURI(clean)}`;
  return clean;
}
function artifactLabel(value: string): string {
  const clean = value.replace(/^MEDIA:/, '');
  try { const url = new URL(clean); return url.pathname.split('/').filter(Boolean).pop() || clean; }
  catch { return clean.split(/[\\/]/).filter(Boolean).pop() || clean; }
}
function canOpenArtifact(value: string): boolean { return /^(?:https?:\/\/|data:image\/)/i.test(value.replace(/^MEDIA:/, '')); }

function extractArtifactItems(raw: any, session: string, sessionFallback = 0, allowHermesProduced = false): ArtifactItem[] {
  const role = safeText(raw?.role).toLowerCase();
  const isUserGiven = role === 'user';
  const isHermesProduced = allowHermesProduced && role === 'assistant';
  if (!isUserGiven && !isHermesProduced) return [];
  const msg = messageFromRaw(raw, 0);
  if (!isVisibleMessage(msg)) return [];
  const text = msg.text || safeText(raw?.content ?? raw?.text ?? raw?.message ?? '');
  if (!text || isInternalContextBlob(text)) return [];
  const at = messageTime(raw, sessionFallback);
  const origin: ArtifactOrigin = isHermesProduced ? 'produced' : 'given';
  const items: ArtifactItem[] = [];
  const add = (value: string) => {
    const clean = normalizeArtifactValue(value);
    if (!clean || !looksLikeArtifact(clean) || isInternalContextBlob(clean)) return;
    items.push({ session, kind: artifactKind(clean), label: artifactLabel(clean), value: clean, href: artifactHref(clean), canOpen: canOpenArtifact(clean), at, origin });
  };
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) add(match[2] || '');
  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    const start = match.index ?? 0;
    if (start > 0 && text[start - 1] === '!') continue;
    add(match[2] || '');
  }
  for (const match of text.matchAll(URL_RE)) add(match[0] || '');
  for (const match of text.matchAll(/MEDIA:([^\s)]+)/g)) add(`MEDIA:${match[1]}`);
  for (const match of text.matchAll(PATH_RE)) add(match[2] || '');
  const directUrl = safeText(raw?.url || raw?.href || raw?.link);
  const directPath = safeText(raw?.path || raw?.file_path || raw?.filename);
  if (directUrl) add(directUrl);
  if (directPath) add(directPath);
  return items;
}

function ArtifactCard({ item }: { item: ArtifactItem }) {
  const { colors, styles } = useTheme();
  const [copied, setCopied] = useState(false);
  const icon: keyof typeof Ionicons.glyphMap = item.kind === 'image' ? 'image-outline' : item.kind === 'link' ? 'link-outline' : 'document-attach-outline';
  const open = async () => {
    if (item.canOpen && item.href.startsWith('http')) {
      try {
        await Linking.openURL(item.href);
      } catch {
        await Clipboard.setStringAsync(item.value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } else {
      await Clipboard.setStringAsync(item.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  return (
    <Card>
      <View style={styles.rowBetween}>
        <View style={{ flex: 1 }}>
          <Text style={styles.eyebrow}>{item.kind}</Text>
          <Text style={styles.listTitle} numberOfLines={1}>{item.label}</Text>
          <Text style={styles.listSub} numberOfLines={1}>{item.session}</Text>
          <Text style={styles.listSub}>{item.origin === 'produced' ? 'Produced' : 'Given'} {formatArtifactTime(item.at)}</Text>
        </View>
        <Ionicons name={icon} size={22} color={colors.primary2} />
      </View>
      <Text style={styles.muted} numberOfLines={2}>{item.value}</Text>
      <View style={styles.row}>
        {item.canOpen && item.href.startsWith('http') ? (
          <Button text="Open Link" icon="open-outline" secondary onPress={open} />
        ) : null}
        <Button
          text={copied ? 'Tersalin!' : 'Copy path'}
          icon={copied ? 'checkmark-outline' : 'copy-outline'}
          secondary
          onPress={open}
        />
      </View>
    </Card>
  );
}

function LogsScreen({ rest }: any) {
  const { colors, styles, isDark } = useTheme();
  const [lines, setLines] = useState<string[]>([]);
  const [file, setFile] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [live, setLive] = useState(true);

  const load = async (silent = false) => {
    if (!rest) return;
    if (!silent) setLoading(true);
    setErr(''); setNotice('');
    try {
      const data = await rest.logs(250);
      const raw = Array.isArray(data?.lines) ? data.lines : Array.isArray(data) ? data : [];
      setLines(raw.map((line: any) => safeText(line)).reverse());
      setFile(safeText(data?.file));
    } catch (e: any) {
      if (!silent) setErr(e.message);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    load().catch(() => undefined);
    if (!live || !rest) return;
    const timer = setInterval(() => {
      load(true).catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [rest, live]);

  const copy = async () => {
    try {
      await Clipboard.setStringAsync(lines.join(''));
      setNotice('Log copied to clipboard.');
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
            <Text style={styles.sectionTitle}>Agent Log</Text>
            {live ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: isDark ? 'rgba(34,197,94,0.15)' : 'rgba(22,163,74,0.1)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 99 }}>
                <View style={{ width: 6, height: 6, borderRadius: 99, backgroundColor: '#22c55e' }} />
                <Text style={{ fontSize: 9.5, fontWeight: '800', color: isDark ? '#4ade80' : '#16a34a' }}>LIVE</Text>
              </View>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: isDark ? 'rgba(148,163,184,0.15)' : 'rgba(148,163,184,0.1)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 99 }}>
                <View style={{ width: 6, height: 6, borderRadius: 99, backgroundColor: colors.muted }} />
                <Text style={{ fontSize: 9.5, fontWeight: '800', color: colors.muted }}>PAUSED</Text>
              </View>
            )}
          </View>

          <Pressable
            onPress={() => setLive(prev => !prev)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 7,
              paddingVertical: 5,
              paddingHorizontal: 9,
              borderRadius: radius.md,
              backgroundColor: colors.card2,
              borderWidth: 1,
              borderColor: live ? colors.primary2 : colors.stroke,
            }}
          >
            <Text style={{ fontSize: 11, fontWeight: '800', color: live ? colors.primary : colors.muted }}>
              Live Tail
            </Text>
            <View style={[styles.toggle, live && styles.toggleOn]}>
              <View style={[styles.knob, live && styles.knobOn]} />
            </View>
          </Pressable>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button text="Refresh" secondary icon="refresh-outline" onPress={() => void load()} />
            <Button text="Copy" secondary icon="copy-outline" onPress={() => void copy()} />
          </View>
          <Text style={styles.listSub}>{lines.length} lines</Text>
        </View>

        {notice ? <Text style={styles.success}>{notice}</Text> : null}
        {err ? <Text style={styles.error}>{err}</Text> : null}
      </Card>

      {loading && !lines.length ? (
        <LoadingBlock label="Membaca log…" />
      ) : (
        <Card>
          <Text style={styles.logText} selectable>{lines.join('') || 'Belum ada log.'}</Text>
        </Card>
      )}
    </ScrollView>
  );
}

function OpsHubScreen({ setOpsScreen }: { setOpsScreen: (screen: OpsScreen) => void }) {
  const { colors, styles } = useTheme();
  const rows: { id: OpsScreen; title: string; sub: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { id: 'skills', title: 'Skills', sub: 'Reusable toolsets and procedures', icon: 'library-outline' },
    { id: 'mcp', title: 'Server MCP', sub: 'Tools and external integrations', icon: 'git-network-outline' },
    { id: 'cron', title: 'Cron', sub: 'Pekerjaan otomatis terjadwal', icon: 'alarm-outline' },
    { id: 'logs', title: 'Log', sub: 'Pantau log agen Hermes', icon: 'document-text-outline' }
  ];
  return <ScrollView contentContainerStyle={styles.screen}>
    {rows.map(row => <Pressable key={row.id} onPress={() => setOpsScreen(row.id)} style={styles.opsRow}>
      <View style={styles.opsIcon}><Ionicons name={row.icon} size={21} color={colors.primary2} /></View>
      <View style={{ flex: 1 }}><Text style={styles.listTitle}>{row.title}</Text><Text style={styles.listSub}>{row.sub}</Text></View>
      <Ionicons name="chevron-forward" size={20} color={colors.muted} />
    </Pressable>)}
  </ScrollView>;
}

function SkillsScreen({ rest, onBack }: { rest: HermesRestClient | null; onBack?: () => void }) {
  const { colors, styles } = useTheme();
  const [skills,setSkills]=useState<SkillInfo[]>([]); const [tools,setTools]=useState<ToolsetInfo[]>([]); const [query,setQuery]=useState(''); const [err,setErr]=useState(''); const [loading,setLoading]=useState(false);
  const load=async()=>{ if(!rest)return; setLoading(true); try { const [s,t]=await Promise.all([rest.skills(), rest.toolsets()]); setSkills(Array.isArray(s)?s:[]); setTools(Array.isArray(t)?t:[]); } finally { setLoading(false); } };
  useEffect(()=>{ load().catch(e=>setErr(e.message)); },[rest]);
  const filtered=skills.filter(s=>`${s.name} ${s.description||''}`.toLowerCase().includes(query.toLowerCase()));
  return <ScrollView contentContainerStyle={styles.screen}>
    {onBack ? (
      <Pressable onPress={onBack} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, marginBottom: 2 }}>
        <Ionicons name="arrow-back" size={18} color={colors.primary} />
        <Text style={{ fontSize: 12.5, fontWeight: '700', color: colors.primary }}>Back to Settings</Text>
      </Pressable>
    ) : null}
    <Card><Text style={styles.sectionTitle}>Skills + tools</Text><Input value={query} onChangeText={setQuery} placeholder="Search skills…" />{err?<Text style={styles.error}>{err}</Text>:null}</Card>{loading ? <LoadingBlock label="Loading skills…" /> : <><Card><Text style={styles.sectionTitle}>Toolsets</Text>{tools.map(t=><ToggleRow key={t.name} title={safeText(t.name)} sub={`${safeText(t.tools?.length||0)} tools · ${safeText(t.provider||'default')}`} on={!!t.enabled} onPress={async()=>{ try { await rest?.toggleToolset(t.name,!t.enabled); await load(); } catch(e:any){ setErr(e.message); } }} />)}</Card><Card><Text style={styles.sectionTitle}>Skills</Text>{filtered.map(s=><ToggleRow key={s.name} title={safeText(s.name)} sub={safeText(s.description||s.category||'')} on={!!s.enabled} onPress={async()=>{ try { await rest?.toggleSkill(s.name,!s.enabled); await load(); } catch(e:any){ setErr(e.message); } }} />)}</Card></>}</ScrollView>;
}

function McpScreen({ rest, onBack }: { rest: HermesRestClient | null; onBack?: () => void }) {
  const { colors, styles } = useTheme();
  const [servers,setServers]=useState<McpServer[]>([]);
  const [catalog,setCatalog]=useState<McpCatalogEntry[]>([]);
  const [err,setErr]=useState('');
  const [notice,setNotice]=useState('');
  const [loading,setLoading]=useState(false);
  const [name,setName]=useState('');
  const [transport,setTransport]=useState<'http'|'stdio'>('http');
  const [url,setUrl]=useState('');
  const [command,setCommand]=useState('');
  const [args,setArgs]=useState('');
  const [env,setEnv]=useState('{}');
  const [auth,setAuth]=useState('');
  const [expanded,setExpanded]=useState('');
  const [catalogSearch,setCatalogSearch]=useState('');
  const [catalogLimit,setCatalogLimit]=useState(15);
  const normalizeServers=(raw:any):McpServer[]=>Array.isArray(raw)?raw:(Array.isArray(raw?.servers)?raw.servers:[]);
  const normalizeCatalog=(raw:any):McpCatalogEntry[]=>Array.isArray(raw)?raw:(Array.isArray(raw?.entries)?raw.entries:Array.isArray(raw?.servers)?raw.servers:Array.isArray(raw?.items)?raw.items:[]);
  const load=async()=>{ if(!rest)return; setLoading(true); setErr(''); try { const [s,c]=await Promise.all([rest.mcpServers(), rest.mcpCatalog().catch(()=>({ entries: [] })) as any]); setServers(normalizeServers(s)); setCatalog(normalizeCatalog(c)); } catch(e:any) { setErr(e.message); } finally { setLoading(false); } };
  useEffect(()=>{ load().catch(e=>setErr(e.message));},[rest]);
  const create=async()=>{ if(!rest)return; setErr(''); setNotice(''); const serverName=name.trim(); if(!serverName){setErr('Nama server wajib diisi.'); return;} let parsedEnv:Record<string,string>={}; try{ const raw=env.trim()?JSON.parse(env):{}; if(!raw||typeof raw!=='object'||Array.isArray(raw)) throw new Error('Env must be a JSON object'); parsedEnv=raw; } catch(e:any){ setErr(`Invalid env JSON: ${e.message}`); return; } const body:any={ name: serverName }; if(transport==='http') body.url=url.trim(); else { body.command=command.trim(); body.args=args.split(/\s+/).map(a=>a.trim()).filter(Boolean); } if(auth.trim()) body.auth=auth.trim(); if(Object.keys(parsedEnv).length) body.env=parsedEnv; try{ await rest.createMcpServer(body); setName(''); setUrl(''); setCommand(''); setArgs(''); setAuth(''); setEnv('{}'); setNotice(`${serverName} added. Reload MCP or start a fresh session for the tools.`); await load(); } catch(e:any){ setErr(e.message); } };
  const remove=(serverName:string)=>Alert.alert('Remove MCP server?', serverName, [{ text:'Cancel', style:'cancel' }, { text:'Remove', style:'destructive', onPress:()=>void (async()=>{ try{ await rest?.deleteMcpServer(serverName); setNotice(`Removed ${serverName}.`); await load(); } catch(e:any){ setErr(e.message); } })() }]);
  const test=async(serverName:string)=>{ try{ setErr(''); setNotice(`Ngetes ${serverName}…`); const result=await rest?.testMcpServer(serverName); const count=Array.isArray(result?.tools)?result.tools.length:0; setNotice(result?.ok ? `${serverName} connected · ${count} tools` : `${serverName} failed: ${safeText(result?.error||'unknown error')}`); } catch(e:any){ setErr(e.message); } };
  const install=async(entry:McpCatalogEntry)=>{ try{ setErr(''); setNotice(`Memasang ${entry.name}…`); await rest?.installMcp({ name: entry.name, enable: true }); setNotice(`${entry.name} installed. Add required env vars, then reload MCP/new turn.`); await load(); } catch(e:any){ setErr(e.message); } };
  const serverSub=(s:McpServer)=>`${safeText(s.transport || (s.url?'http':s.command?'stdio':'unknown'))}${s.url?` · ${s.url}`:s.command?` · ${s.command}`:''}${s.tools?` · ${Array.isArray(s.tools)?s.tools.length:'all'} tools`:''}`;
  const filteredCatalog = catalog.filter(e => {
    const q = catalogSearch.toLowerCase().trim();
    if (!q) return true;
    return (e.name || '').toLowerCase().includes(q) || (e.description || '').toLowerCase().includes(q);
  });
  const visibleCatalog = filteredCatalog.slice(0, catalogLimit);
  return <ScrollView contentContainerStyle={styles.screen}>
    {onBack ? (
      <Pressable onPress={onBack} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, marginBottom: 2 }}>
        <Ionicons name="arrow-back" size={18} color={colors.primary} />
        <Text style={{ fontSize: 12.5, fontWeight: '700', color: colors.primary }}>Back to Settings</Text>
      </Pressable>
    ) : null}
    {loading ? <LoadingBlock label="Loading MCP…" /> : <>
      <Card><View style={styles.rowBetween}><Text style={styles.sectionTitle}>Server</Text><Text style={styles.listSub}>{servers.length} terpasang</Text></View>{err?<Text style={styles.error}>{err}</Text>:null}{notice?<Text style={notice.includes('failed')?styles.error:styles.success}>{notice}</Text>:null}{servers.length===0?<Text style={styles.muted}>No MCP servers installed yet.</Text>:servers.map(s=><View key={s.name} style={styles.compactListItem}><Pressable onPress={()=>setExpanded(expanded===s.name?'':s.name)} style={styles.compactMain}><View style={{ flex: 1 }}><Text style={styles.listTitle}>{safeText(s.name)}</Text><Text style={styles.listSub} numberOfLines={1}>{serverSub(s)}</Text></View><View style={[styles.statusDot, s.enabled===false && styles.statusDotOff]} /><Ionicons name="chevron-forward" size={18} color={colors.muted} /></Pressable>{expanded===s.name?<View style={styles.detailsPanel}>{s.env&&Object.keys(s.env).length?<Text style={styles.muted}>env: {Object.keys(s.env).join(', ')}</Text>:null}<View style={styles.row}><Button text="Tes" secondary icon="flash-outline" onPress={()=>void test(s.name)}/><Button text={s.enabled===false?'Enable':'Disable'} secondary icon="power-outline" onPress={async()=>{await rest?.setMcpEnabled(s.name,s.enabled===false); await load();}}/><Button text="Delete" secondary icon="trash-outline" onPress={()=>remove(s.name)}/></View></View>:null}</View>)}</Card>
      <Card><Text style={styles.sectionTitle}>Tambah server</Text><Label text="Name"/><Input value={name} onChangeText={setName} placeholder="filesystem"/><View style={styles.row}><Button text="HTTP" secondary={transport!=='http'} icon="globe-outline" onPress={()=>setTransport('http')}/><Button text="Stdio" secondary={transport!=='stdio'} icon="terminal-outline" onPress={()=>setTransport('stdio')}/></View>{transport==='http'?<><Label text="URL"/><Input value={url} onChangeText={setUrl} placeholder="https://example.com/mcp" autoCapitalize="none"/></>:<><Label text="Command"/><Input value={command} onChangeText={setCommand} placeholder="npx" autoCapitalize="none"/><Label text="Args"/><Input value={args} onChangeText={setArgs} placeholder="-y @modelcontextprotocol/server-filesystem" autoCapitalize="none"/></>}<Label text="Auth header/value (optional)"/><Input value={auth} onChangeText={setAuth} placeholder="Bearer ..." autoCapitalize="none" secureTextEntry/><Label text="Env JSON"/><Input value={env} onChangeText={setEnv} multiline/><Button text="Tambah server" icon="add-outline" onPress={create}/></Card>
      <Card>
        <View style={styles.rowBetween}>
          <Text style={styles.sectionTitle}>MCP catalog (optional)</Text>
          <Text style={styles.listSub}>{catalogSearch ? `${filteredCatalog.length} dari ${catalog.length}` : `${catalog.length} tersedia`}</Text>
        </View>
        <Input value={catalogSearch} onChangeText={(t: string)=>{ setCatalogSearch(t); setCatalogLimit(15); }} placeholder="Cari MCP (misal: notion, git, stripe)…" autoCapitalize="none" style={{ marginBottom: 10 }} />
        {visibleCatalog.length === 0 ? (
          <Text style={styles.muted}>{catalogSearch ? 'Tidak ada MCP yang cocok dengan pencarian.' : 'Katalog kosong.'}</Text>
        ) : (
          visibleCatalog.map(entry=><View key={entry.name} style={styles.compactListItem}><View style={styles.compactMain}><View style={{ flex: 1 }}><Text style={styles.listTitle}>{safeText(entry.name)}</Text><Text style={styles.listSub} numberOfLines={2}>{safeText(entry.description||entry.transport||'Entri katalog')}</Text>{Array.isArray(entry.env)&&entry.env.length?<Text style={styles.muted}>env: {entry.env.join(', ')}</Text>:null}</View><Button text="Install" secondary icon="download-outline" onPress={()=>void install(entry)}/></View></View>)
        )}
        {filteredCatalog.length > catalogLimit ? (
          <View style={{ marginTop: 8 }}>
            <Button text={`Tampilkan lebih banyak (${filteredCatalog.length - catalogLimit} tersisa)`} secondary icon="chevron-down-outline" onPress={()=>setCatalogLimit(prev=>prev+20)}/>
          </View>
        ) : null}
      </Card>
    </>}
  </ScrollView>;
}

let cachedCronJobs: CronJob[] = [];

function CronScreen({ rest, onBack }: { rest: HermesRestClient | null; onBack?: () => void }) {
  const { colors, styles } = useTheme();
  const [jobs, setJobs] = useState<CronJob[]>(() => cachedCronJobs);
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('every 4h');
  const [prompt, setPrompt] = useState('');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const load = async () => {
    if (!rest) return;
    if (!cachedCronJobs.length) setLoading(true);
    try {
      const data = await rest.cronJobs('all');
      const list = Array.isArray(data) ? data : [];
      cachedCronJobs = list;
      setJobs(list);
    } catch(e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load().catch(e => setErr(e.message)); }, [rest]);
  const create = async () => {
    try {
      setErr(''); setNotice('Membuat cron baru…');
      await rest?.createCronJob({ name, schedule, prompt });
      setName('');
      setPrompt('');
      setNotice(`Cron "${name}" berhasil dibuat.`);
      await load();
    } catch(e: any) { setErr(e.message); }
  };
  const togglePause = async (job: CronJob) => {
    const jid = safeText(job.job_id || job.id);
    const jName = safeText(job.name || jid);
    const currentlyPaused = job.enabled === false || (job as any).state === 'paused' || (job as any).paused;
    const targetPaused = !currentlyPaused;

    // Optimistic UI update: langsung ubah tombol seketika tanpa nunggu network roundtrip
    setJobs(prev => {
      const updated = prev.map(item => {
        if ((item.id || item.job_id) === jid) {
          return { ...item, enabled: !targetPaused, state: targetPaused ? 'paused' : 'scheduled' };
        }
        return item;
      });
      cachedCronJobs = updated;
      return updated;
    });
    setNotice(targetPaused ? `"${jName}" dijeda (paused).` : `"${jName}" diaktifkan (active).`);
    setErr('');

    try {
      if (targetPaused) {
        await rest?.pauseCronJob(jid);
      } else {
        await rest?.resumeCronJob(jid);
      }
      const data = await rest?.cronJobs('all');
      if (Array.isArray(data)) {
        cachedCronJobs = data;
        setJobs(data);
      }
    } catch (e: any) {
      setErr(`Gagal mengubah status cron: ${e.message}`);
      void load();
    }
  };
  const runJob = async (job: CronJob) => {
    const jid = safeText(job.job_id || job.id);
    const jName = safeText(job.name || jid);
    setNotice(`Menjalankan cron "${jName}"…`);
    setErr('');
    try {
      await rest?.triggerCronJob(jid);
      setNotice(`Cron "${jName}" berhasil dipicu dan selesai dijalankan.`);
    } catch (e: any) {
      if (e?.message?.includes('timeout')) {
        setNotice(`Cron "${jName}" sedang berjalan di background (tugas membutuhkan waktu lama).`);
      } else {
        setErr(`Gagal menjalankan cron: ${e.message}`);
      }
    } finally {
      void load();
    }
  };
  const removeJob = (job: CronJob) => {
    const jid = safeText(job.job_id || job.id);
    const jName = safeText(job.name || jid);
    Alert.alert(
      'Hapus Cron Job?',
      `Yakin ingin menghapus cron "${jName}"?`,
      [
        { text: 'Batal', style: 'cancel' },
        {
          text: 'Hapus',
          style: 'destructive',
          onPress: () => void (async () => {
            try {
              setNotice(`Menghapus "${jName}"…`);
              setErr('');
              await rest?.deleteCronJob(jid);
              setNotice(`Cron "${jName}" berhasil dihapus.`);
              await load();
            } catch (e: any) {
              setErr(`Gagal menghapus cron: ${e.message}`);
            }
          })()
        }
      ]
    );
  };
  return <ScrollView contentContainerStyle={styles.screen}>
    {onBack ? (
      <Pressable onPress={onBack} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, marginBottom: 2 }}>
        <Ionicons name="arrow-back" size={18} color={colors.primary} />
        <Text style={{ fontSize: 12.5, fontWeight: '700', color: colors.primary }}>Back to Settings</Text>
      </Pressable>
    ) : null}
    <Card>
      <View style={styles.rowBetween}>
        <Text style={styles.sectionTitle}>Cron Schedule</Text>
        <Text style={styles.listSub}>{jobs.length} terdaftar</Text>
      </View>
      {err ? <Text style={styles.error}>{err}</Text> : null}
      {notice ? <Text style={notice.includes('Gagal') ? styles.error : styles.success}>{notice}</Text> : null}
      <Label text="Name" /><Input value={name} onChangeText={setName} placeholder="Brief operator pagi" />
      <Label text="Schedule" /><Input value={schedule} onChangeText={setSchedule} />
      <Label text="Prompt" /><Input value={prompt} onChangeText={setPrompt} placeholder="What should Hermes do?" multiline />
      <Button text="Create cron" icon="add-outline" onPress={create} />
    </Card>
    {loading && !jobs.length ? (
      <LoadingBlock label="Loading cron jobs…" />
    ) : jobs.length === 0 ? (
      <Card><Text style={styles.muted}>Belum ada scheduled cron yang aktif.</Text></Card>
    ) : (
      jobs.map(j => {
        const id = safeText(j.job_id || j.id);
        const scheduleText = safeText((j as any).schedule_display || (typeof j.schedule === 'object' ? (j.schedule as any).display : j.schedule));
        const isPaused = j.enabled === false || (j as any).state === 'paused' || (j as any).paused;
        return <Card key={id || makeId()}>
          <Text style={styles.listTitle}>{safeText(j.name || id)}</Text>
          <Text style={styles.listSub}>{scheduleText || 'no schedule'} · {isPaused ? 'paused' : 'enabled'}</Text>
          <Text style={styles.muted}>{safeText(j.prompt).slice(0, 160)}</Text>
          <View style={styles.row}>
            <Button text={isPaused ? 'Resume' : 'Pause'} secondary icon="pause-outline" onPress={() => void togglePause(j)} />
            <Button text="Run" secondary icon="play-outline" onPress={() => void runJob(j)} />
            <Button text="Delete" secondary icon="trash-outline" onPress={() => removeJob(j)} />
          </View>
        </Card>;
      })
    )}
  </ScrollView>;
}

function SettingsScreen({
  rest,
  profile,
  statusPayload,
  onOpenSubScreen,
  onDisconnect,
}: {
  rest: HermesRestClient | null;
  profile: ConnectionProfile | null;
  statusPayload: any;
  onOpenSubScreen: (sub: SettingsSubScreen) => void;
  onDisconnect?: () => void;
}) {
  const { colors, styles } = useTheme();
  const [stats, setStats] = useState<any>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [router9Stats, setRouter9Stats] = useState<any>(null);
  const [loading9Router, setLoading9Router] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  useEffect(() => {
    loadSoundEnabled().then(setSoundEnabled);
  }, []);
  const [textScale, setTextScale] = useState(1);
  useEffect(() => {
    loadTextScale().then(setTextScale).catch(() => undefined);
  }, []);

  const fetchHostStats = useCallback(async () => {
    if (!rest) return;
    setLoadingStats(true);
    try {
      const s = await rest.systemStats().catch(() => null);
      if (s) setStats(s);
    } catch {}
    finally {
      setLoadingStats(false);
    }
  }, [rest]);

  const fetch9RouterStats = useCallback(async () => {
    if (!rest) return;
    setLoading9Router(true);
    try {
      const data = await rest.router9Telemetry().catch(() => null);
      if (data) setRouter9Stats(data);
    } catch {}
    finally {
      setLoading9Router(false);
    }
  }, [rest]);

  useEffect(() => {
    fetchHostStats().catch(() => undefined);
    fetch9RouterStats().catch(() => undefined);
  }, [fetchHostStats, fetch9RouterStats]);

  const hostname = stats?.hostname || 'hermes-agent';
  const arch = stats?.arch === 'aarch64' ? 'ARM64' : (stats?.arch || 'Linux');
  const os = stats?.os || 'Linux';
  const cpuCount = stats?.cpu_count || 4;
  const cpuPct = stats?.cpu_percent != null ? Number(stats.cpu_percent).toFixed(1) : '0.0';
  const loads = Array.isArray(stats?.load_avg) ? stats.load_avg.map((n: number) => Number(n).toFixed(2)).join(', ') : '0.10, 0.15, 0.18';

  const memUsedGb = stats?.memory?.used ? (stats.memory.used / (1024 ** 3)).toFixed(1) : '3.3';
  const memTotalGb = stats?.memory?.total ? (stats.memory.total / (1024 ** 3)).toFixed(1) : '24.0';
  const memPct = stats?.memory?.percent != null ? Number(stats.memory.percent).toFixed(1) : '13.8';

  const diskUsedGb = stats?.disk?.used ? (stats.disk.used / (1024 ** 3)).toFixed(1) : '17.8';
  const diskTotalGb = stats?.disk?.total ? (stats.disk.total / (1024 ** 3)).toFixed(1) : '200.0';
  const diskPct = stats?.disk?.percent != null ? Number(stats.disk.percent).toFixed(1) : '8.9';

  const uptimeSec = stats?.uptime_seconds || 0;
  const uptimeHours = Math.floor(uptimeSec / 3600);
  const uptimeMins = Math.floor((uptimeSec % 3600) / 60);
  const uptimeStr = uptimeHours > 0 ? `${uptimeHours}h ${uptimeMins}m` : `${uptimeMins}m`;

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {/* 1. Host System Status at the top */}
      <View style={styles.hostCard}>
        <View style={styles.hostHeader}>
          <View style={styles.hostHeaderLeft}>
            <Ionicons name="server-outline" size={17} color={colors.primary} />
            <Text style={styles.hostTitle}>HOST SYSTEM TELEMETRY</Text>
            <View style={{ width: 6, height: 6, borderRadius: 99, backgroundColor: colors.good }} />
          </View>
          <Pressable onPress={fetchHostStats} style={styles.compactIcon}>
            {loadingStats ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Ionicons name="refresh-outline" size={16} color={colors.muted} />
            )}
          </Pressable>
        </View>

        <Text style={styles.listSub}>
          {hostname} · {os} {arch} · {cpuCount} vCPUs
        </Text>

        <View style={styles.hostGrid}>
          {/* CPU Tile */}
          <View style={styles.hostTile}>
            <Text style={styles.hostTileLabel}>CPU LOAD</Text>
            <Text style={styles.hostTileValue}>{cpuPct}%</Text>
            <Text style={styles.hostTileSub} numberOfLines={1}>Load: {loads}</Text>
          </View>

          {/* RAM Tile */}
          <View style={styles.hostTile}>
            <Text style={styles.hostTileLabel}>RAM</Text>
            <Text style={styles.hostTileValue}>{memUsedGb} / {memTotalGb} GB</Text>
            <View style={styles.hostProgressTrack}>
              <View style={[styles.hostProgressFill, { width: `${Math.min(100, Math.max(5, Number(memPct)))}%` }]} />
            </View>
            <Text style={styles.hostTileSub}>{memPct}% used</Text>
          </View>

          {/* DISK Tile */}
          <View style={styles.hostTile}>
            <Text style={styles.hostTileLabel}>DISK STORAGE</Text>
            <Text style={styles.hostTileValue}>{diskUsedGb} / {diskTotalGb} GB</Text>
            <View style={styles.hostProgressTrack}>
              <View style={[styles.hostProgressFill, { width: `${Math.min(100, Math.max(5, Number(diskPct)))}%`, backgroundColor: colors.primary2 }]} />
            </View>
            <Text style={styles.hostTileSub}>{diskPct}% used</Text>
          </View>

          {/* UPTIME & RUNTIME Tile */}
          <View style={styles.hostTile}>
            <Text style={styles.hostTileLabel}>UPTIME & RUNTIME</Text>
            <Text style={styles.hostTileValue}>{uptimeStr}</Text>
            <Text style={styles.hostTileSub} numberOfLines={1}>
              Hermes v{stats?.hermes_version || '0.22.5'} · Py {stats?.python_version || '3.14'}
            </Text>
          </View>
        </View>
      </View>

      {/* 2. 9Router Usage Overview & Quota Tracker */}
      <View style={styles.hostCard}>
        <View style={styles.hostHeader}>
          <View style={styles.hostHeaderLeft}>
            <Ionicons name="git-network-outline" size={17} color={colors.primary2} />
            <Text style={styles.hostTitle}>9ROUTER USAGE & QUOTA TRACKER</Text>
            <View style={{ width: 6, height: 6, borderRadius: 99, backgroundColor: router9Stats?.available ? colors.good : colors.muted }} />
          </View>
          <Pressable onPress={fetch9RouterStats} style={styles.compactIcon}>
            {loading9Router ? (
              <ActivityIndicator size="small" color={colors.primary2} />
            ) : (
              <Ionicons name="refresh-outline" size={16} color={colors.muted} />
            )}
          </Pressable>
        </View>

        <Text style={styles.listSub}>
          Port {router9Stats?.port || 20128} · 9Router Telemetry & Quota Engine
        </Text>

        {/* 4 Metrik Utama (Data Today) */}
        <View style={styles.hostGrid}>
          {/* TOTAL REQUEST Tile */}
          <View style={styles.hostTile}>
            <Text style={styles.hostTileLabel}>TOTAL REQUEST</Text>
            <Text style={styles.hostTileValue}>{router9Stats?.today?.requests || 0} reqs</Text>
            <Text style={styles.hostTileSub} numberOfLines={1}>Today's calls</Text>
          </View>

          {/* TOTAL INPUT Tile */}
          <View style={styles.hostTile}>
            <Text style={styles.hostTileLabel}>TOTAL INPUT</Text>
            <Text style={styles.hostTileValue}>{formatCompactNumber(router9Stats?.today?.promptTokens || 0)} tok</Text>
            <Text style={styles.hostTileSub} numberOfLines={1}>Prompt tokens</Text>
          </View>

          {/* TOTAL OUTPUT Tile */}
          <View style={styles.hostTile}>
            <Text style={styles.hostTileLabel}>TOTAL OUTPUT</Text>
            <Text style={styles.hostTileValue}>{formatCompactNumber(router9Stats?.today?.completionTokens || 0)} tok</Text>
            <Text style={styles.hostTileSub} numberOfLines={1}>Completion</Text>
          </View>

          {/* EST. COST Tile */}
          <View style={styles.hostTile}>
            <Text style={styles.hostTileLabel}>EST. COST</Text>
            <Text style={styles.hostTileValue}>${Number(router9Stats?.today?.cost || 0).toFixed(2)}</Text>
            <Text style={styles.hostTileSub} numberOfLines={1}>Today's spend</Text>
          </View>
        </View>

        {/* Recent Requests (3 items, 1-line format with comfortable spacing) */}
        <View style={{ marginTop: 6, paddingTop: 5, borderTopWidth: 1, borderColor: colors.stroke, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4.5 }}>
              <Ionicons name="time-outline" size={12} color={colors.primary2} />
              <Text style={{ fontSize: 9.5, fontWeight: '800', color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                RECENT MODELS
              </Text>
            </View>
            <Text style={{ fontSize: 9, color: colors.muted }}>3 latest</Text>
          </View>

          {router9Stats?.recentRequests?.length ? (
            <View style={{ backgroundColor: colors.card2, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.stroke, overflow: 'hidden' }}>
              {router9Stats.recentRequests.slice(0, 3).map((req: any, idx: number) => (
                <View key={req.id || idx} style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingHorizontal: 9,
                  paddingVertical: 6.5,
                  borderTopWidth: idx > 0 ? 1 : 0,
                  borderColor: colors.stroke
                }}>
                  <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7, marginRight: 8 }}>
                    <Text style={{ fontSize: 10.5, fontWeight: '700', color: colors.text }} numberOfLines={1}>
                      {safeText(req.model || 'Unknown')}
                    </Text>
                    <Text style={{ fontSize: 9.5, color: colors.muted }} numberOfLines={1}>
                      {formatCompactNumber(req.promptTokens)} / {formatCompactNumber(req.completionTokens)}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontSize: 9.5, color: colors.muted }}>
                      {formatRelativeTime(req.timestamp)}
                    </Text>
                    <Text style={{ fontSize: 9.5, fontWeight: '700', color: req.cost > 0 ? colors.primary2 : colors.good }}>
                      {req.cost > 0 ? `$${Number(req.cost).toFixed(3)}` : 'Free'}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          ) : (
            <Text style={{ fontSize: 10, color: colors.muted, fontStyle: 'italic' }}>
              Belum ada riwayat request.
            </Text>
          )}
        </View>

        {/* Quota Tracker (Unified Container, Inline Horizontal Bars) */}
        <View style={{ marginTop: 8, paddingTop: 6, borderTopWidth: 1, borderColor: colors.stroke, gap: 5 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4.5 }}>
              <Ionicons name="speedometer-outline" size={13} color={colors.primary2} />
              <Text style={{ fontSize: 9.5, fontWeight: '800', color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                PROVIDER QUOTA TRACKER
              </Text>
            </View>
          </View>

          <View style={{ backgroundColor: colors.card2, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.stroke, padding: 6, gap: 4.5 }}>
            {/* 1. Antigravity */}
            <View style={{ gap: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4.5 }}>
                  <Ionicons name="rocket-outline" size={12} color="#F59E0B" />
                  <Text style={{ fontSize: 10.5, fontWeight: '700', color: colors.text }}>Antigravity</Text>
                </View>
                <Text style={{ fontSize: 9.5, fontWeight: '700', color: colors.muted }}>
                  {router9Stats?.quotas?.antigravity?.active || 0}/{router9Stats?.quotas?.antigravity?.total || 0} active
                </Text>
              </View>

              {/* Line 1: 5-Hour */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View style={{ width: 104, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  <Text style={{ fontSize: 9.5, color: colors.muted }}>5-Hour</Text>
                  {formatResetCountdown(router9Stats?.quotas?.antigravity?.limit5hReset) ? (
                    <Text style={{ fontSize: 8.8, color: colors.primary2 }} numberOfLines={1}>
                      · {formatResetCountdown(router9Stats?.quotas?.antigravity?.limit5hReset)}
                    </Text>
                  ) : null}
                </View>
                <View style={[styles.hostProgressTrack, { flex: 1, height: 5.2 }]}>
                  <View style={[
                    styles.hostProgressFill,
                    {
                      width: `${Math.min(100, Math.max(3, router9Stats?.quotas?.antigravity?.limit5h ?? 100))}%`,
                      backgroundColor: (router9Stats?.quotas?.antigravity?.limit5h ?? 100) < 20 ? colors.bad : (router9Stats?.quotas?.antigravity?.limit5h ?? 100) < 50 ? colors.warn : colors.good
                    }
                  ]} />
                </View>
                <Text style={{ fontSize: 10, fontWeight: '700', color: colors.text, width: 32, textAlign: 'right' }}>
                  {router9Stats?.quotas?.antigravity?.limit5h ?? 100}%
                </Text>
              </View>

              {/* Line 2: Weekly */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View style={{ width: 104, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  <Text style={{ fontSize: 9.5, color: colors.muted }}>Weekly</Text>
                  {formatResetCountdown(router9Stats?.quotas?.antigravity?.limitWeeklyReset) ? (
                    <Text style={{ fontSize: 8.8, color: colors.primary2 }} numberOfLines={1}>
                      · {formatResetCountdown(router9Stats?.quotas?.antigravity?.limitWeeklyReset)}
                    </Text>
                  ) : null}
                </View>
                <View style={[styles.hostProgressTrack, { flex: 1, height: 5.2 }]}>
                  <View style={[
                    styles.hostProgressFill,
                    {
                      width: `${Math.min(100, Math.max(3, router9Stats?.quotas?.antigravity?.limitWeekly ?? 100))}%`,
                      backgroundColor: (router9Stats?.quotas?.antigravity?.limitWeekly ?? 100) < 20 ? colors.bad : (router9Stats?.quotas?.antigravity?.limitWeekly ?? 100) < 50 ? colors.warn : colors.good
                    }
                  ]} />
                </View>
                <Text style={{ fontSize: 10, fontWeight: '700', color: colors.text, width: 32, textAlign: 'right' }}>
                  {router9Stats?.quotas?.antigravity?.limitWeekly ?? 100}%
                </Text>
              </View>
            </View>

            {/* Divider */}
            <View style={{ height: 1, backgroundColor: colors.stroke, marginVertical: 1 }} />

            {/* 2. Codebuddy */}
            <View style={{ gap: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4.5 }}>
                  <Ionicons name="code-slash-outline" size={12} color="#3B82F6" />
                  <Text style={{ fontSize: 10.5, fontWeight: '700', color: colors.text }}>CodeBuddy</Text>
                </View>
                <Text style={{ fontSize: 9.5, fontWeight: '700', color: colors.muted }}>
                  {router9Stats?.quotas?.codebuddy?.active || 0}/{router9Stats?.quotas?.codebuddy?.total || 0} active
                </Text>
              </View>

              {/* Line 1: Monthly */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View style={{ width: 104, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  <Text style={{ fontSize: 9.5, color: colors.muted }}>Monthly</Text>
                  {formatResetCountdown(router9Stats?.quotas?.codebuddy?.monthly?.resetAt) ? (
                    <Text style={{ fontSize: 8.8, color: colors.primary2 }} numberOfLines={1}>
                      · {formatResetCountdown(router9Stats?.quotas?.codebuddy?.monthly?.resetAt)}
                    </Text>
                  ) : null}
                </View>
                <View style={[styles.hostProgressTrack, { flex: 1, height: 5.2 }]}>
                  <View style={[
                    styles.hostProgressFill,
                    {
                      width: `${Math.min(100, Math.max(3, router9Stats?.quotas?.codebuddy?.monthly?.remainingPct ?? 100))}%`,
                      backgroundColor: (router9Stats?.quotas?.codebuddy?.monthly?.remainingPct ?? 100) < 20 ? colors.bad : (router9Stats?.quotas?.codebuddy?.monthly?.remainingPct ?? 100) < 50 ? colors.warn : colors.good
                    }
                  ]} />
                </View>
                <Text style={{ fontSize: 10, fontWeight: '700', color: colors.text, width: 32, textAlign: 'right' }}>
                  {router9Stats?.quotas?.codebuddy?.monthly?.remainingPct ?? 100}%
                </Text>
              </View>

              {/* Line 2: Bonus (Bonus 1 & 2 Combined) */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View style={{ width: 104, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  <Text style={{ fontSize: 9.5, color: colors.muted }}>Bonus</Text>
                  {formatResetCountdown(router9Stats?.quotas?.codebuddy?.bonus?.resetAt, 'exp ') ? (
                    <Text style={{ fontSize: 8.8, color: colors.primary2 }} numberOfLines={1}>
                      · {formatResetCountdown(router9Stats?.quotas?.codebuddy?.bonus?.resetAt, 'exp ')}
                    </Text>
                  ) : null}
                </View>
                <View style={[styles.hostProgressTrack, { flex: 1, height: 5.2 }]}>
                  <View style={[
                    styles.hostProgressFill,
                    {
                      width: `${Math.min(100, Math.max(3, router9Stats?.quotas?.codebuddy?.bonus?.remainingPct ?? 100))}%`,
                      backgroundColor: (router9Stats?.quotas?.codebuddy?.bonus?.remainingPct ?? 100) < 20 ? colors.bad : (router9Stats?.quotas?.codebuddy?.bonus?.remainingPct ?? 100) < 50 ? colors.warn : colors.good
                    }
                  ]} />
                </View>
                <Text style={{ fontSize: 10, fontWeight: '700', color: colors.text, width: 32, textAlign: 'right' }}>
                  {router9Stats?.quotas?.codebuddy?.bonus?.remainingPct ?? 100}%
                </Text>
              </View>
            </View>

            {/* Divider */}
            <View style={{ height: 1, backgroundColor: colors.stroke, marginVertical: 1 }} />

            {/* 3. Qoder */}
            <View style={{ gap: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4.5 }}>
                  <Ionicons name="sparkles-outline" size={12} color="#10B981" />
                  <Text style={{ fontSize: 10.5, fontWeight: '700', color: colors.text }}>Qoder</Text>
                </View>
                <Text style={{ fontSize: 9.5, fontWeight: '700', color: colors.muted }}>
                  {router9Stats?.quotas?.qoder?.active || 0}/{router9Stats?.quotas?.qoder?.total || 0} active
                </Text>
              </View>

              {/* Line 1 (Cuma punya 1 line): Credits */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View style={{ width: 104, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  <Text style={{ fontSize: 9.5, color: colors.muted }}>Credits</Text>
                  {formatResetCountdown(router9Stats?.quotas?.qoder?.credits?.resetAt) ? (
                    <Text style={{ fontSize: 8.8, color: colors.primary2 }} numberOfLines={1}>
                      · {formatResetCountdown(router9Stats?.quotas?.qoder?.credits?.resetAt)}
                    </Text>
                  ) : null}
                </View>
                <View style={[styles.hostProgressTrack, { flex: 1, height: 5.2 }]}>
                  <View style={[
                    styles.hostProgressFill,
                    {
                      width: `${Math.min(100, Math.max(3, router9Stats?.quotas?.qoder?.credits?.remainingPct ?? 100))}%`,
                      backgroundColor: (router9Stats?.quotas?.qoder?.credits?.remainingPct ?? 100) < 20 ? colors.bad : (router9Stats?.quotas?.qoder?.credits?.remainingPct ?? 100) < 50 ? colors.warn : colors.good
                    }
                  ]} />
                </View>
                <Text style={{ fontSize: 10, fontWeight: '700', color: colors.text, width: 32, textAlign: 'right' }}>
                  {router9Stats?.quotas?.qoder?.credits?.remainingPct ?? 100}%
                </Text>
              </View>
            </View>
          </View>
        </View>
      </View>

      {/* 2. Integrated Modules & Sub-screens (Skills, Artifacts, MCP, Cron) */}
      <View style={styles.menuSection}>
        <Text style={styles.menuSectionTitle}>INTEGRATED MODULES & SURFACES</Text>

        <Pressable onPress={() => onOpenSubScreen('skills')} style={styles.menuItemRow}>
          <View style={styles.menuItemIcon}>
            <Ionicons name="library-outline" size={20} color={colors.primary} />
          </View>
          <View style={styles.menuItemText}>
            <Text style={styles.listTitle}>Skills & Toolsets</Text>
            <Text style={styles.listSub} numberOfLines={1}>Kelola reusable skills, tools & procedures agen</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.muted} />
        </Pressable>

        <Pressable onPress={() => onOpenSubScreen('artifacts')} style={styles.menuItemRow}>
          <View style={styles.menuItemIcon}>
            <Ionicons name="sparkles-outline" size={20} color={colors.primary2} />
          </View>
          <View style={styles.menuItemText}>
            <Text style={styles.listTitle}>Artifacts & Media</Text>
            <Text style={styles.listSub} numberOfLines={1}>Review files, reports, and generated code artifacts</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.muted} />
        </Pressable>

        <Pressable onPress={() => onOpenSubScreen('mcp')} style={styles.menuItemRow}>
          <View style={styles.menuItemIcon}>
            <Ionicons name="git-network-outline" size={20} color={colors.warn} />
          </View>
          <View style={styles.menuItemText}>
            <Text style={styles.listTitle}>MCP Tool Server</Text>
            <Text style={styles.listSub} numberOfLines={1}>Manage Model Context Protocol integrations</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.muted} />
        </Pressable>

        <Pressable onPress={() => onOpenSubScreen('cron')} style={styles.menuItemRow}>
          <View style={styles.menuItemIcon}>
            <Ionicons name="alarm-outline" size={20} color={colors.good} />
          </View>
          <View style={styles.menuItemText}>
            <Text style={styles.listTitle}>Scheduled Cron Jobs</Text>
            <Text style={styles.listSub} numberOfLines={1}>Background schedules and operator triggers</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.muted} />
        </Pressable>
      </View>

      {/* Voice Alerts Card */}
      <View style={styles.menuSection}>
        <Text style={styles.menuSectionTitle}>UKURAN TEKS CHAT</Text>
        <Card>
          <Text style={styles.listSub}>Besar teks di layar chat (langsung berlaku, tanpa reload).</Text>
          <View style={[styles.row, { marginTop: 8 }]}>
            {[{ v: 0.9, l: 'Kecil' }, { v: 1, l: 'Normal' }, { v: 1.15, l: 'Besar' }].map(opt => (
              <Pressable
                key={opt.v}
                onPress={() => { setTextScale(opt.v); void saveTextScale(opt.v); }}
                style={[styles.drawerFilterPill, textScale === opt.v && styles.drawerFilterPillActive]}
              >
                <Text style={styles.drawerFilterText}>{opt.l}</Text>
              </Pressable>
            ))}
          </View>
        </Card>
      </View>

      <View style={styles.menuSection}>
        <Text style={styles.menuSectionTitle}>CYBERPUNK VOICE ALERTS</Text>
        <Card>
          <View style={styles.rowBetween}>
            <View style={{ flex: 1, paddingRight: 8 }}>
              <Text style={styles.listTitle}>Cyberpunk AI Voice</Text>
              <Text style={styles.listSub}>
                "Processing your request" saat mikir, "Streaming" saat ngetik, & "All clear" saat selesai
              </Text>
            </View>
            <Pressable
              onPress={() => {
                const next = !soundEnabled;
                setSoundEnabled(next);
                saveSoundEnabled(next);
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
              }}
              style={[styles.toggle, soundEnabled && styles.toggleOn]}
            >
              <View style={[styles.knob, soundEnabled && styles.knobOn]} />
            </Pressable>
          </View>
          <View style={[styles.row, { marginTop: 10, flexWrap: 'wrap', gap: 6 }]}>
            <Button
              text='Play "Processing"'
              secondary
              icon="play-outline"
              onPress={() => playVoiceAlert('processing', {
                provider: 'combos',
                model: 'MODELSPAN',
                reasoning: 'high'
              })}
            />
            <Button
              text='Play "Streaming"'
              secondary
              icon="radio-outline"
              onPress={() => playVoiceAlert('streaming')}
            />
            <Button
              text='Play "All clear"'
              secondary
              icon="checkmark-done-outline"
              onPress={() => playVoiceAlert('allclear')}
            />
          </View>
        </Card>
      </View>

      {/* 3. Server & Connection */}
      <View style={styles.menuSection}>
        <Text style={styles.menuSectionTitle}>SERVER & CONNECTION</Text>
        <Card>
          <View style={styles.rowBetween}>
            <Text style={styles.listTitle}>{profile?.name || 'Hermes Agent'}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={{ width: 6, height: 6, borderRadius: 99, backgroundColor: colors.good }} />
              <Text style={{ fontSize: 9.5, fontWeight: '800', color: colors.good, letterSpacing: 0.5 }}>CONNECTED</Text>
            </View>
          </View>
          <Text style={styles.listSub}>{profile?.baseUrl || 'Not connected'}</Text>
          <Text style={styles.muted}>Auth mode: {profile?.authMode || 'basic'} · User: {profile?.username || 'admin'}</Text>
          {onDisconnect ? (
            <View style={{ marginTop: 8 }}>
              <Button text="Disconnect Server" secondary icon="log-out-outline" onPress={onDisconnect} />
            </View>
          ) : null}
        </Card>
      </View>

      {/* 4. Profile Management */}
      <View style={styles.menuSection}>
        <Text style={styles.menuSectionTitle}>PROFILE MANAGEMENT</Text>
        <ProfileCopyPanel rest={rest} />
      </View>
    </ScrollView>
  );
}

function ProfileCopyPanel({ rest }: { rest: HermesRestClient | null }) {
  const { colors, styles } = useTheme();
  const [profiles,setProfiles]=useState<any[]>([]);
  const [source,setSource]=useState('default');
  const [newName,setNewName]=useState('founder-agent');
  const [installSource,setInstallSource]=useState('https://github.com/NousResearch/hermes-agent-profile');
  const [includeAlias,setIncludeAlias]=useState(true);
  const [cloneAll,setCloneAll]=useState(true);
  const [loading,setLoading]=useState(false);
  const [err,setErr]=useState('');
  const [notice,setNotice]=useState('');
  const normalizeProfiles=(raw:any):any[]=>Array.isArray(raw)?raw:(Array.isArray(raw?.profiles)?raw.profiles:[]);
  const load=async()=>{ if(!rest)return; setLoading(true); setErr(''); try { const rows=normalizeProfiles(await rest.profiles()); setProfiles(rows); if(rows.length && !rows.some((p:any)=>p.name===source)) setSource(safeText(rows[0].name||'default')); } catch(e:any){ setErr(e.message); } finally { setLoading(false); } };
  useEffect(()=>{ load().catch(e=>setErr(e.message)); },[rest]);
  const installCommand=()=>`hermes profile install ${installSource.trim() || '<source>'}${newName.trim()?` --name ${newName.trim()}`:''}${includeAlias?' --alias':''}`;
  const copyInstallCommand=async()=>{ await Clipboard.setStringAsync(installCommand()); setNotice('Install command copied with --alias.'); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(()=>undefined); };
  const copyExistingProfile=async()=>{ if(!rest)return; const name=newName.trim(); if(!name){setErr('New profile name is required.'); return;} setErr(''); setNotice(''); try { const result=await rest.createProfile({ name, clone_from: source, clone_all: cloneAll, description: `Copied from ${source} in Hermes Cockpit` }); const setup=await rest.profileSetupCommand(name).catch(()=>({ command: name === 'default' ? 'hermes setup' : `${name} setup` })); setNotice(`Created ${safeText(result?.name||name)}${includeAlias?' with alias wrapper when available':''}. Setup: ${safeText(setup.command)}`); await Clipboard.setStringAsync(includeAlias ? safeText(setup.command) : `hermes -p ${name}`); await load(); } catch(e:any){ setErr(e.message); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(()=>undefined); } };
  return <Card>
    <View style={styles.rowBetween}><Text style={styles.sectionTitle}>Profile</Text><Text style={styles.listSub}>{profiles.length} installed</Text></View>
    <Text style={styles.muted}>Copy a local profile into a new alias-ready profile, or copy the one-line distribution install command for sharing.</Text>
    {err?<Text style={styles.error}>{err}</Text>:null}{notice?<Text style={styles.success}>{notice}</Text>:null}
    {loading ? <LoadingBlock label="Loading profiles…" compact /> : profiles.map((p:any)=><View key={safeText(p.name)} style={styles.compactListItem}><View style={styles.compactMain}><View style={{ flex: 1 }}><Text style={styles.listTitle}>{safeText(p.name)}</Text><Text style={styles.listSub} numberOfLines={1}>{safeText(p.provider||'provider?')} · {safeText(p.model||'model?')} · {p.has_alias?'alias':'no alias'}</Text></View><Pressable onPress={()=>setSource(safeText(p.name))} style={[styles.miniPill, source===safeText(p.name)&&styles.miniPillActive]}><Text style={styles.miniPillText}>{source===safeText(p.name)?'Source':'Use'}</Text></Pressable></View></View>)}
    <Label text="Copy from"/><Input value={source} onChangeText={setSource} placeholder="default" autoCapitalize="none" />
    <Label text="New profile / alias"/><Input value={newName} onChangeText={setNewName} placeholder="founder-agent" autoCapitalize="none" />
    <View style={styles.row}><Pressable onPress={()=>setCloneAll(v=>!v)} style={[styles.drawerFilterPill, cloneAll && styles.drawerFilterPillActive]}><Text style={styles.drawerFilterText}>{cloneAll?'Full copy':'Config only'}</Text></Pressable><Pressable onPress={()=>setIncludeAlias(v=>!v)} style={[styles.drawerFilterPill, includeAlias && styles.drawerFilterPillActive]}><Text style={styles.drawerFilterText}>{includeAlias?'--alias on':'--alias off'}</Text></Pressable></View>
    <Button text="Copy profile + alias" icon="copy-outline" onPress={copyExistingProfile} />
    <View style={styles.divider} />
    <Label text="Distribution source"/><Input value={installSource} onChangeText={setInstallSource} placeholder="https://github.com/org/hermes-profile" autoCapitalize="none" />
    <Command text={installCommand()} />
    <Button text="Copy install --alias command" icon="terminal-outline" secondary onPress={copyInstallCommand} />
  </Card>;
}

function LoadingBlock({ label, compact }: { label: string; compact?: boolean }) { const { colors, styles } = useTheme(); return <View style={[styles.loading, compact && { padding: 12 }]}><ActivityIndicator color={colors.primary2} /><Text style={styles.muted}>{label}</Text></View>; }
function ToggleRow({ title, sub, on, onPress }: { title:string; sub:string; on:boolean; onPress:()=>void }) { const { styles } = useTheme(); return <Pressable style={styles.listItem} onPress={onPress}><View style={{flex:1}}><Text style={styles.listTitle}>{title}</Text><Text style={styles.listSub}>{sub}</Text></View><View style={[styles.toggle,on&&styles.toggleOn]}><View style={[styles.knob,on&&styles.knobOn]}/></View></Pressable>; }
function JsonCard({ title, data }: { title:string; data:any }) { const { styles } = useTheme(); return <Card><Text style={styles.sectionTitle}>{title}</Text><Text style={styles.code}>{safeText(data ?? {}).slice(0,2200)}</Text></Card>; }
function Empty({ title, body }: { title:string; body:string }) { const { styles } = useTheme(); return <Card><Text style={styles.sectionTitle}>{title}</Text><Text style={styles.muted}>{body}</Text></Card>; }
function Card({ children }: { children: React.ReactNode }) { const { styles } = useTheme(); return <View style={styles.card}>{children}</View>; }
function Label({ text }: { text:string }) { const { styles } = useTheme(); return <Text style={styles.label}>{text}</Text>; }
function Input(props: any) { const { colors, styles } = useTheme(); return <TextInput {...props} placeholderTextColor={colors.faint} style={[styles.input, props.multiline && { minHeight: 96, textAlignVertical: 'top' }, props.style]} />; }
function Button({ text, icon, onPress, secondary }: { text:string; icon?: keyof typeof Ionicons.glyphMap; onPress?:()=>void; secondary?:boolean }) { const { colors, styles } = useTheme(); return <Pressable onPress={onPress} style={[styles.button, secondary && styles.buttonSecondary]}>{icon?<Ionicons name={icon} size={17} color={secondary ? colors.primary : '#ffffff'}/>:null}<Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>{text}</Text></Pressable>; }
function Command({ text }: { text:string }) { const { styles } = useTheme(); return <Text style={styles.code}>{text}</Text>; }

const styles = fallbackStyles;
const colors = fallbackColors;
