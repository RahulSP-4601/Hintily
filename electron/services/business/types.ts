export interface HintilyAccountState {
  user_id: string;
  unlimited: boolean;
  remaining_seconds: number;
  trial_remaining_seconds: number;
  paid_session_count: number;
  access_revision: string | null;
  active_session: null | {
    id: string;
    client_session_id: string;
    status: 'pending' | 'active' | 'paused';
    consumed_seconds: number;
    last_heartbeat_at: string | null;
  };
}

export interface HintilySessionAuthorization {
  session_id: string;
  status: 'pending' | 'active' | 'paused';
  reconnected: boolean;
  unlimited: boolean;
  remaining_seconds: number | null;
  next_sequence_no: number;
}

export interface HintilyHeartbeatResult {
  accepted_seconds: number;
  duplicate: boolean;
  remaining_seconds: number | null;
  exhausted: boolean;
}

export type HintilyBusinessResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; offline?: boolean; status?: number };
