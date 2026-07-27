export const HINTILY_BRAND = Object.freeze({
  name: 'Hintily',
  aiName: 'Hintily AI',
  website: 'https://hintily.app',
  support: 'https://hintily.app/support',
  protocol: 'hintily',
});

// The inherited device-bound trial and Natively checkout flows do not match
// Hintily's account-linked entitlement model. Keep every legacy commerce
// surface off until the server-backed Phase 5+ flows replace them.
export const LEGACY_NATIVELY_COMMERCE_ENABLED = false;
