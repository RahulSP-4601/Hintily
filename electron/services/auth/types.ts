export interface HintilyUser {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export type HintilyAuthStatus =
  | { state: 'unconfigured'; user: null; error: string }
  | { state: 'signed_out'; user: null }
  | { state: 'signing_in'; user: null }
  | { state: 'signed_in'; user: HintilyUser }
  | { state: 'error'; user: null; error: string };

export interface HintilyAuthResult {
  ok: boolean;
  status: HintilyAuthStatus;
  error?: string;
}

