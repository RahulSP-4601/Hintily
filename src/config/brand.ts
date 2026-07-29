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

// The inherited companion browser extension is not part of the current
// Hintily launch experience. Keep its implementation in the repository, but
// do not advertise or offer pairing until the product is ready to ship it.
export const HINTILY_BROWSER_EXTENSION_ENABLED = false;

// Customer builds are fully managed by Hintily. The inherited provider
// configuration surface is available only to explicit local development
// builds so packaged users can never enable BYOK or legacy Natively routing.
export const LEGACY_PROVIDER_CONFIGURATION_ENABLED =
  import.meta.env.DEV && import.meta.env.VITE_HINTILY_ENABLE_LEGACY_BYOK_DEV === 'true';
