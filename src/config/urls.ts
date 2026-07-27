/**
 * Centralised checkout & external URL constants.
 *
 * Change URLs here once — all files that import from this module
 * will pick up the update automatically.
 */

export const CHECKOUT_URLS = {
    // Compatibility shape for the isolated legacy settings components. The old
    // Natively products must never be opened by Hintily.
    pro: '',
    apiStandard: '',
    apiPro: '',
    apiMax: '',
    apiUltra: '',
} as const;
