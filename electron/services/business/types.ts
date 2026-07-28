export interface HintilyAccountState {
  user_id: string;
  unlimited: boolean;
  remaining_seconds: number;
  trial_remaining_seconds: number;
  free_session_available?: boolean;
  paid_session_count: number;
  access_revision: string | null;
  active_session: null | {
    id: string;
    client_session_id: string;
    status: 'pending' | 'active' | 'paused';
    surface?: 'interview_helper' | 'meeting';
    consumed_seconds: number;
    maximum_seconds?: number | null;
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

export interface HintilyPurchaseSummary {
  id: string;
  product_code: string;
  amount_minor: number | null;
  currency: string | null;
  status: 'pending' | 'paid' | 'refunded' | 'partially_refunded' | 'disputed' | 'failed';
  purchased_at: string | null;
  created_at: string;
}

export type HintilyBusinessResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; offline?: boolean; status?: number };
