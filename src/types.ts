export type ConnectionProfile = {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
  authMode?: 'auto' | 'token' | 'password' | 'oauth';
  username?: string;
  password?: string;
  wsTicket?: string;
  activeProfileName?: string;
  createdAt: number;
  lastUsedAt: number;
};

export type SessionSummary = {
  id?: string;
  session_id?: string;
  stored_session_id?: string;
  title?: string;
  name?: string;
  updated_at?: string;
  created_at?: string;
  message_count?: number;
  source?: string;
  archived?: boolean;
  [key: string]: unknown;
};

export type HermesEvent = {
  type: string;
  session_id?: string;
  payload?: any;
  receivedAt: number;
};

export type CronJob = {
  id?: string;
  job_id?: string;
  name?: string;
  schedule?: string;
  prompt?: string;
  enabled?: boolean;
  paused?: boolean;
  status?: string;
  next_run?: string;
  [key: string]: unknown;
};

export type SkillInfo = { name: string; description?: string; enabled?: boolean; category?: string; tags?: string[]; [key: string]: unknown };
export type ToolsetInfo = { name: string; description?: string; enabled?: boolean; tools?: string[]; provider?: string; [key: string]: unknown };
export type McpServer = { name: string; command?: string; url?: string; transport?: string; auth?: string; enabled?: boolean; status?: string; args?: string[]; env?: Record<string, string>; tools?: string[] | null; [key: string]: unknown };
export type McpCatalogEntry = { name: string; description?: string; source?: string; transport?: string; auth_type?: string; required_env?: { name: string; prompt?: string; required?: boolean }[]; needs_install?: boolean; installed?: boolean; enabled?: boolean; [key: string]: unknown };
