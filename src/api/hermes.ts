import type { ConnectionProfile, CronJob, McpServer, SessionSummary, SkillInfo, ToolsetInfo } from '../types';

type RpcHandler = (event: any) => void;

export type AuthProviderInfo = {
  name: string;
  display_name?: string;
  supports_password?: boolean;
};

export type GatewayProbe = {
  baseUrl: string;
  status: any;
  authRequired: boolean;
  providers: AuthProviderInfo[];
  injectedToken?: string;
};

function providerLabel(provider: AuthProviderInfo): string {
  return provider.display_name || provider.name;
}

function providerListLabel(providers: AuthProviderInfo[]): string {
  return providers.map(providerLabel).filter(Boolean).join(', ') || 'unknown OAuth provider';
}

export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export function buildWsUrl(baseUrl: string, token: string): string {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  return url.toString();
}

export function buildWsTicketUrl(baseUrl: string, ticket: string, profile = 'hermes-cockpit'): string {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  if (profile) url.searchParams.set('profile', profile);
  return url.toString();
}

export function buildWsUrlForProfile(profile: ConnectionProfile, activeProfile = 'hermes-cockpit'): string {
  if (profile.wsTicket) return buildWsTicketUrl(profile.baseUrl, profile.wsTicket, profile.activeProfileName || activeProfile);
  return buildWsUrl(profile.baseUrl, profile.token || '');
}

export function extractInjectedSessionToken(html: string): string {
  const match = html.match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*("(?:\\.|[^"\\])*")/);
  if (!match) return '';
  try { return JSON.parse(match[1]); } catch { return ''; }
}

export function parsePairingPayload(input: string): Partial<ConnectionProfile> | null {
  const raw = input.trim();
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj.url === 'string') return { baseUrl: obj.url, token: String(obj.token ?? '') };
  } catch {}
  try {
    const url = new URL(raw);
    const baseUrl = url.searchParams.get('url') || url.searchParams.get('baseUrl') || (url.protocol.startsWith('http') ? raw : '');
    const token = url.searchParams.get('token') || '';
    if (baseUrl) return { baseUrl, token };
  } catch {}
  return null;
}

async function readJsonOrText(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

export class HermesRestClient {
  constructor(private profile: ConnectionProfile, public activeProfileName = 'hermes-cockpit') {}

  async request<T>(path: string, options: RequestInit = {}, timeoutMs = 20000): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string> | undefined) ?? {})
    };
    if (this.profile.token) headers['X-Hermes-Session-Token'] = this.profile.token;

    // Every REST call is bounded: a hung dashboard response used to stall the
    // 2s activity poll forever and leave the UI stuck in "thinking".
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const res = await fetch(`${normalizeBaseUrl(this.profile.baseUrl)}${path}`, {
        ...options,
        credentials: 'include',
        cache: 'no-store',
        headers,
        ...(controller ? { signal: controller.signal } : {})
      });
      const data = await readJsonOrText(res);
      if (!res.ok) throw new Error(typeof data === 'string' ? data : data?.detail || data?.message || `${res.status} ${res.statusText}`);
      return data as T;
    } catch (err: any) {
      if (err?.name === 'AbortError') throw new Error(`timeout after ${Math.round(timeoutMs / 1000)}s: ${path}`);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  status() { return this.request<any>('/api/status'); }
  authProviders() { return this.request<{providers?: AuthProviderInfo[]}>('/api/auth/providers'); }
  authMe() { return this.request<any>('/api/auth/me'); }
  passwordLogin(provider: string, username: string, password: string) {
    return this.request<any>('/auth/password-login', {
      method: 'POST',
      body: JSON.stringify({ provider, username, password })
    });
  }
  wsTicket() { return this.request<{ticket: string}>('/api/auth/ws-ticket', { method: 'POST' }); }

  systemStats() { return this.request<any>('/api/system/stats'); }
  router9Telemetry() { return this.request<any>('/api/9router/telemetry'); }
  sessions(limit = 30, offset = 0, archived: 'exclude' | 'include' | 'only' = 'exclude', extraParams = '') {
    const extra = extraParams ? `&${extraParams}` : '';
    const prof = this.activeProfileName ? `&profile=${encodeURIComponent(this.activeProfileName)}` : '';
    return this.request<{sessions?: SessionSummary[]; total?: number; limit?: number; offset?: number} | SessionSummary[]>(`/api/sessions?limit=${limit}&offset=${offset}&archived=${archived}&order=recent${extra}${prof}`);
  }
  sessionDetail(id: string) {
    const prof = this.activeProfileName ? `?profile=${encodeURIComponent(this.activeProfileName)}` : '';
    return this.request<any>(`/api/sessions/${encodeURIComponent(id)}${prof}`);
  }
  sessionMessages(id: string, limit = 500, order = 'latest') {
    const prof = this.activeProfileName ? `&profile=${encodeURIComponent(this.activeProfileName)}` : '';
    return this.request<any>(`/api/sessions/${encodeURIComponent(id)}/messages?limit=${limit}&order=${order}${prof}`);
  }
  // Latest rows only — cheap enough to poll for live "what is the agent doing".
  sessionTail(id: string, limit = 3) {
    const prof = this.activeProfileName ? `&profile=${encodeURIComponent(this.activeProfileName)}` : '';
    return this.request<any>(`/api/sessions/${encodeURIComponent(id)}/messages?limit=${limit}&order=latest${prof}`);
  }
  // Session writes are fenced by the backend: it refuses a PATCH without a
  // request id plus the revision/generation the client last saw, so read the
  // snapshot first and stamp the mutation with it.
  async renameSession(id: string, title: string) {
    const snapshot = await this.request<any>(`/api/sessions/${encodeURIComponent(id)}/mutation-snapshot`);
    const requestId = (globalThis as any)?.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return this.request(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title,
        request_id: requestId,
        expected_revision: snapshot?.runtime_revision ?? 0,
        expected_generation: snapshot?.runtime_generation ?? undefined
      })
    });
  }
  // Same fenced-write contract as rename: the delete carries the revision the
  // client last saw, otherwise the backend answers 409 client_upgrade_required.
  async deleteSession(id: string) {
    const snapshot = await this.request<any>(`/api/sessions/${encodeURIComponent(id)}/mutation-snapshot`);
    const requestId = (globalThis as any)?.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let query = `?request_id=${encodeURIComponent(requestId)}&expected_revision=${Number(snapshot?.runtime_revision ?? 0)}`;
    if (snapshot?.runtime_generation !== null && snapshot?.runtime_generation !== undefined) {
      query += `&expected_generation=${Number(snapshot.runtime_generation)}`;
    }
    return this.request(`/api/sessions/${encodeURIComponent(id)}${query}`, { method: 'DELETE' });
  }
  config() {
    const prof = this.activeProfileName ? `?profile=${encodeURIComponent(this.activeProfileName)}` : '';
    return this.request<any>(`/api/config${prof}`);
  }
  updateConfig(config: any) {
    const prof = this.activeProfileName ? `?profile=${encodeURIComponent(this.activeProfileName)}` : '';
    return this.request(`/api/config${prof}`, {
      method: 'PUT',
      body: JSON.stringify({ config })
    });
  }
  modelInfo() {
    const prof = this.activeProfileName ? `?profile=${encodeURIComponent(this.activeProfileName)}` : '';
    return this.request<any>(`/api/model/info${prof}`);
  }
  modelOptions() {
    const prof = this.activeProfileName ? `?profile=${encodeURIComponent(this.activeProfileName)}` : '';
    return this.request<any>(`/api/model/options${prof}`);
  }
  setModel(provider: string, model: string) {
    const prof = this.activeProfileName ? `?profile=${encodeURIComponent(this.activeProfileName)}` : '';
    return this.request(`/api/model/set${prof}`, { method: 'POST', body: JSON.stringify({ scope: 'main', provider, model }) });
  }
  skills() { return this.request<SkillInfo[]>('/api/skills'); }
  toggleSkill(name: string, enabled: boolean) { return this.request('/api/skills/toggle', { method: 'PUT', body: JSON.stringify({ name, enabled }) }); }
  toolsets() { return this.request<ToolsetInfo[]>('/api/tools/toolsets'); }
  toggleToolset(name: string, enabled: boolean) { return this.request(`/api/tools/toolsets/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ enabled }) }); }
  toolsetConfig(name: string) { return this.request<any>(`/api/tools/toolsets/${encodeURIComponent(name)}/config`); }
  cronJobs(profile = 'all') {
    const p = profile ? `?profile=${encodeURIComponent(profile)}` : '';
    return this.request<CronJob[]>(`/api/cron/jobs${p}`);
  }
  createCronJob(body: any) { return this.request<CronJob>('/api/cron/jobs', { method: 'POST', body: JSON.stringify(body) }); }
  pauseCronJob(id: string) { return this.request<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}/pause`, { method: 'POST' }); }
  resumeCronJob(id: string) { return this.request<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}/resume`, { method: 'POST' }); }
  triggerCronJob(id: string) { return this.request<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}/trigger`, { method: 'POST' }, 60000); }
  deleteCronJob(id: string) { return this.request(`/api/cron/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  mcpServers() { return this.request<{servers?: McpServer[]} | McpServer[]>('/api/mcp/servers'); }
  createMcpServer(body: any) { return this.request<McpServer>('/api/mcp/servers', { method: 'POST', body: JSON.stringify(body) }); }
  deleteMcpServer(name: string) { return this.request(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' }); }
  testMcpServer(name: string) { return this.request<any>(`/api/mcp/servers/${encodeURIComponent(name)}/test`, { method: 'POST' }); }
  mcpCatalog() { return this.request<any>('/api/mcp/catalog'); }
  installMcp(body: any) { return this.request('/api/mcp/catalog/install', { method: 'POST', body: JSON.stringify(body) }); }
  setMcpEnabled(name: string, enabled: boolean) { return this.request(`/api/mcp/servers/${encodeURIComponent(name)}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) }); }
  profiles() { return this.request<any>('/api/profiles'); }
  createProfile(body: any) { return this.request<any>('/api/profiles', { method: 'POST', body: JSON.stringify(body) }); }
  profileSetupCommand(name: string) { return this.request<{command: string}>(`/api/profiles/${encodeURIComponent(name)}/setup-command`); }
  logs(lines = 100) { return this.request<any>(`/api/logs?lines=${lines}`); }
  analytics(days = 7) { return this.request<any>(`/api/analytics/usage?days=${days}`); }
}

export async function probeGateway(baseUrl: string): Promise<GatewayProbe> {
  const clean = normalizeBaseUrl(baseUrl);
  const publicClient = new HermesRestClient({ id: 'probe', name: 'Probe', baseUrl: clean, token: '', createdAt: 0, lastUsedAt: 0 });
  const status = await publicClient.status();
  const authRequired = Boolean(status?.auth_required);
  let providers: AuthProviderInfo[] = [];
  if (authRequired) {
    try { providers = (await publicClient.authProviders()).providers || []; } catch { providers = []; }
  }
  let injectedToken = '';
  if (!authRequired) {
    const res = await fetch(`${clean}/`, { credentials: 'include' });
    const html = await res.text();
    injectedToken = extractInjectedSessionToken(html);
  }
  return { baseUrl: clean, status, authRequired, providers, injectedToken };
}

export async function prepareConnectionProfile(profile: ConnectionProfile): Promise<{ profile: ConnectionProfile; status: any; message: string }> {
  const probe = await probeGateway(profile.baseUrl);

  if (!probe.authRequired) {
    // In insecure Tailnet/LAN mode the dashboard injects the current websocket token
    // into the served HTML. Prefer that fresh token over any saved token because
    // restarting the dashboard can rotate it; REST may still look OK while /api/ws
    // rejects a stale saved token.
    const token = probe.injectedToken || profile.token;
    if (!token) throw new Error('Dashboard is reachable but did not expose a session token. Make sure it is running in mobile-compatible local mode.');
    return {
      profile: { ...profile, baseUrl: probe.baseUrl, token, authMode: 'token', wsTicket: undefined },
      status: probe.status,
      message: probe.injectedToken ? 'Auto-discovered dashboard session token from Hermes.' : 'Connected with saved session token.'
    };
  }

  const passwordProvider = probe.providers.find(p => p.supports_password);
  const client = new HermesRestClient({ ...profile, baseUrl: probe.baseUrl, token: '' });
  if (passwordProvider && profile.username && profile.password) {
    await client.passwordLogin(passwordProvider.name, profile.username, profile.password);
  } else {
    try {
      await client.authMe();
    } catch {
      const providerList = providerListLabel(probe.providers);
      if (passwordProvider) {
        throw new Error(`This dashboard is protected by Hermes internal login (${providerLabel(passwordProvider)}). Enter username/password, then connect again.`);
      }
      throw new Error(`External browser OAuth is gating this dashboard (${providerList}). Hermes Mobile does not use a WebView cookie bridge. Use Tailnet Quick Connect with --insecure, or enable a Hermes internal username/password provider.`);
    }
  }

  const ticket = await client.wsTicket();
  if (!ticket.ticket) throw new Error('Dashboard login worked, but /api/auth/ws-ticket did not return a ticket.');
  return {
    profile: { ...profile, baseUrl: probe.baseUrl, token: '', authMode: 'password', wsTicket: ticket.ticket },
    status: probe.status,
    message: 'Signed into protected dashboard and minted WebSocket ticket.'
  };
}

export type RpcCloseInfo = { code: number; reason: string; byClient: boolean };

export class HermesRpcClient {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v:any)=>void; reject:(e:any)=>void; timer:any }>();
  private handlers = new Set<RpcHandler>();
  private closeHandlers = new Set<(info: RpcCloseInfo) => void>();
  private intentional = new WeakSet<WebSocket>();
  private keepAliveTimer?: any;

  constructor(private profile: ConnectionProfile, public activeProfileName = 'hermes-cockpit') {}

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }
  onEvent(handler: RpcHandler) { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  onClose(handler: (info: RpcCloseInfo) => void) { this.closeHandlers.add(handler); return () => this.closeHandlers.delete(handler); }

  connect(): Promise<void> {
    this.close();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(buildWsUrlForProfile(this.profile));
      this.ws = ws;
      const failTimer = setTimeout(() => reject(new Error('WebSocket connection timed out')), 10000);
      ws.onopen = () => {
        clearTimeout(failTimer);
        this.startKeepAlive();
        this.advertiseCapabilities();
        resolve();
      };
      ws.onerror = () => { clearTimeout(failTimer); reject(new Error('Could not connect to /api/ws. Ensure Hermes is running with --tui and that auth is valid.')); };
      ws.onmessage = event => this.handleMessage(String(event.data));
      ws.onclose = (ev: any) => {
        clearTimeout(failTimer);
        this.stopKeepAlive();
        for (const [id, req] of this.pending) { clearTimeout(req.timer); req.reject(new Error('Hermes WebSocket closed')); this.pending.delete(id); }
        const info: RpcCloseInfo = { code: Number(ev?.code ?? 0), reason: String(ev?.reason ?? ''), byClient: this.intentional.has(ws) };
        for (const h of this.closeHandlers) { try { h(info); } catch {} }
      };
    });
  }

  ping() { return this.request('ping', {}, 10000); }

  // Idle proxies (Tailscale serve drops a quiet WSS after ~110s) kill the socket
  // even though nothing is wrong. A cheap JSON-RPC `ping` every 45s keeps the
  // connection warm; a ping that never answers closes the socket so the app's
  // reconnect path can mint a fresh ticket.
  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (!this.connected) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        // App is in the background; mobile browser throttles timers, do not kill socket prematurely
        return;
      }
      this.request('ping', {}, 25000).catch(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        try { this.ws?.close(); } catch {}
      });
    }, 45000);
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = undefined; }
  }

  advertiseCapabilities() {
    this.request('client.capabilities', { server_requests: true }).catch(() => {});
  }

  private handleServerRequest(id: string, method: string, params: Record<string, any>) {
    if (method === 'clarify') {
      const questions = Array.isArray(params.questions) ? params.questions : [];
      const firstQ = questions[0] || {};
      for (const h of this.handlers) {
        h({
          type: 'clarify.request',
          session_id: params.session_id,
          receivedAt: Date.now(),
          payload: {
            id,
            request_id: id,
            prompt_id: id,
            questions,
            question: firstQ.question || params.question,
            choices: firstQ.choices || params.choices,
            multi_select: Boolean(firstQ.multi_select ?? params.multi_select),
            qid: firstQ.qid || 'q0',
            answers: params.answers
          }
        });
      }
    } else if (method === 'approval') {
      for (const h of this.handlers) {
        h({
          type: 'approval.request',
          session_id: params.session_id,
          receivedAt: Date.now(),
          payload: {
            id,
            request_id: id,
            prompt_id: id,
            ...params
          }
        });
      }
    }
  }

  respondToServerRequest(id: string, result: Record<string, any>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  private handleMessage(raw: string) {
    for (const line of raw.split('\n').filter(Boolean)) {
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && this.pending.has(String(msg.id))) {
        const req = this.pending.get(String(msg.id))!;
        clearTimeout(req.timer);
        this.pending.delete(String(msg.id));
        if (msg.error) req.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else {
          if (msg.result?.open_requests && Array.isArray(msg.result.open_requests)) {
            for (const openReq of msg.result.open_requests) {
              if (openReq && typeof openReq.id === 'string' && typeof openReq.method === 'string') {
                this.handleServerRequest(openReq.id, openReq.method, openReq.params || {});
              }
            }
          }
          req.resolve(msg.result);
        }
        continue;
      }
      if (typeof msg.id === 'string' && typeof msg.method === 'string') {
        this.handleServerRequest(msg.id, msg.method, msg.params || {});
        continue;
      }
      if (msg.method === 'event') {
        if (msg.params?.type === 'request.cancel') {
          const payload = msg.params?.payload || {};
          if (payload.method === 'clarify' || !payload.method) {
            for (const h of this.handlers) {
              h({
                type: 'clarify.settled',
                session_id: msg.params.session_id,
                receivedAt: Date.now(),
                payload: { request_id: payload.id, prompt_id: payload.id, reason: payload.reason }
              });
            }
          }
          if (payload.method === 'approval' || !payload.method) {
            for (const h of this.handlers) {
              h({
                type: 'approval.settled',
                session_id: msg.params.session_id,
                receivedAt: Date.now(),
                payload: { request_id: payload.id, prompt_id: payload.id, reason: payload.reason }
              });
            }
          }
        }
        for (const h of this.handlers) h({ ...msg.params, receivedAt: Date.now() });
      } else if (msg.method === 'gateway.ready') {
        this.advertiseCapabilities();
        for (const h of this.handlers) h({ type: 'gateway.ready', payload: msg.params, receivedAt: Date.now() });
      }
    }
  }

  request<T=any>(method: string, params: Record<string, any> = {}, timeoutMs = 45000): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Hermes WebSocket is not connected');
    const id = String(this.nextId++);
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(payload + '\n');
    });
  }

  createSession(params: Record<string, any> = {}) { return this.request('session.create', { cols: 80, profile: this.activeProfileName, ...params }); }
  resumeSession(session_id: string, params: Record<string, any> = {}) { return this.request('session.resume', { session_id, profile: this.activeProfileName, ...params }); }
  sessionList(limit = 50, params: Record<string, any> = {}) { return this.request('session.list', { limit, profile: this.activeProfileName, ...params }); }
  // Slash-command catalog (name + description). Commands themselves are
  // executed client-side — the gateway has no command.run RPC.
  commandsCatalog() { return this.request<any>('commands.catalog', {}, 20000); }
  sessionHistory(session_id: string, params: Record<string, any> = {}) { return this.request('session.history', { session_id, profile: this.activeProfileName, ...params }); }
  attachFile(sessionId: string, name: string, dataUrl: string) {
    return this.request<{ attached: boolean; name: string; path: string; ref_path: string; ref_text: string; uploaded: boolean }>('file.attach', {
      session_id: sessionId,
      name,
      data_url: dataUrl
    });
  }
  attachImageBytes(sessionId: string, filename: string, contentBase64: string) {
    return this.request<{ attached: boolean; path: string; name: string; text: string }>('image.attach_bytes', {
      session_id: sessionId,
      filename,
      content_base64: contentBase64
    });
  }
  submitPrompt(session_id: string, text: string) {
    return this.request<{ admission_id?: string; status?: 'queued' | 'started' | 'unknown' | 'terminal' }>(
      'prompt.submit', { session_id, text });
  }
  // Admission yang masih `queued` bisa di-steer ke turn berjalan atau dibatalkan.
  steerQueued(session_id: string, admission_id: string) {
    return this.request('prompt.steer_queued', { session_id, admission_id });
  }
  cancelQueued(session_id: string, admission_id: string) {
    return this.request('prompt.cancel', { session_id, admission_id });
  }
  // Eksekusi slash command di sisi gateway. Beda dari submitPrompt: prompt.submit cuma
  // neruskan teks ke model, sedangkan slash.exec benar-benar menjalankan command-nya.
  // /compress atau /compact butuh waktu summarization AI panjang (bisa 75-90s di transkrip besar), beri timeout 180s.
  slashExec(session_id: string, command: string) {
    const isCompress = /^\/(?:compress|compact)\b/i.test(command.trim());
    const timeoutMs = isCompress ? 180000 : 60000;
    return this.request<any>('slash.exec', { session_id, command }, timeoutMs);
  }
  interrupt(session_id: string) { return this.request('session.interrupt', { session_id }); }
  approval(session_id: string, choice: 'once' | 'deny' | 'session' | 'always', prompt_id?: string, execution_generation?: number) {
    if (prompt_id) {
      this.respondToServerRequest(prompt_id, { choice });
    }
    if (prompt_id && execution_generation !== undefined) {
      return this.request('approval.respond', { session_id, choice, prompt_id, execution_generation }).catch(() => {});
    }
    return this.request('approval.respond', { session_id, choice }).catch(() => {});
  }
  clarify(session_id: string, answer: string, prompt_id?: string, execution_generation?: number, qid = 'q0') {
    if (prompt_id) {
      const answers: Record<string, string | null> = {};
      answers[qid] = answer ? answer : null;
      this.respondToServerRequest(prompt_id, {
        answers,
        outcome: answer ? 'submitted' : 'cancelled'
      });
    }
    if (prompt_id && execution_generation !== undefined) {
      return this.request('clarify.respond', { session_id, answer, prompt_id, execution_generation }).catch(() => {});
    }
    return this.request('clarify.respond', { session_id, request_id: prompt_id, answer }).catch(() => {});
  }
  close() { this.stopKeepAlive(); const ws = this.ws; if (ws) this.intentional.add(ws); ws?.close(); this.ws = undefined; }
}
