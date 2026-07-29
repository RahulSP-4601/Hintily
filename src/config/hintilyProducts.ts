export type HintilyProductCode =
  | 'session_1'
  | 'session_3'
  | 'session_7'
  | 'session_12'
  | 'unlimited_monthly'
  | 'unlimited_quarterly'
  | 'unlimited_yearly'
  | 'unlimited_lifetime';

export interface HintilyProductDefinition {
  code: HintilyProductCode;
  label: string;
  description: string;
  amountMinor: number;
  currency: 'INR';
  sessions: number | null;
  interval: 'single' | 'month' | 'quarter' | 'year' | 'lifetime';
}

/**
 * Public display catalogue. Product IDs, checkout URLs, grants, and charged
 * amounts remain server-authoritative in the Dodo edge functions.
 */
export const HINTILY_PRODUCTS: readonly HintilyProductDefinition[] = [
  {
    code: 'session_1',
    label: '1 session',
    description: 'One single-use session, up to 60 minutes',
    amountMinor: 49_900,
    currency: 'INR',
    sessions: 1,
    interval: 'single',
  },
  {
    code: 'session_3',
    label: '3 sessions',
    description: 'Three single-use sessions, up to 60 minutes each',
    amountMinor: 109_900,
    currency: 'INR',
    sessions: 3,
    interval: 'single',
  },
  {
    code: 'session_7',
    label: '7 sessions',
    description: 'Seven single-use sessions, up to 60 minutes each',
    amountMinor: 189_900,
    currency: 'INR',
    sessions: 7,
    interval: 'single',
  },
  {
    code: 'session_12',
    label: '12 sessions',
    description: 'Twelve single-use sessions, up to 60 minutes each',
    amountMinor: 279_900,
    currency: 'INR',
    sessions: 12,
    interval: 'single',
  },
  {
    code: 'unlimited_monthly',
    label: 'Monthly unlimited',
    description: 'Unlimited sessions for one month',
    amountMinor: 339_900,
    currency: 'INR',
    sessions: null,
    interval: 'month',
  },
  {
    code: 'unlimited_quarterly',
    label: 'Quarterly unlimited',
    description: '₹2,499/month, billed every three months',
    amountMinor: 749_700,
    currency: 'INR',
    sessions: null,
    interval: 'quarter',
  },
  {
    code: 'unlimited_yearly',
    label: 'Yearly unlimited',
    description: '₹2,099/month, billed yearly',
    amountMinor: 2_518_800,
    currency: 'INR',
    sessions: null,
    interval: 'year',
  },
  {
    code: 'unlimited_lifetime',
    label: 'Lifetime unlimited',
    description: 'Unlimited sessions with no expiry',
    amountMinor: 3_500_000,
    currency: 'INR',
    sessions: null,
    interval: 'lifetime',
  },
] as const;

export const formatHintilyProductPrice = (
  product: Pick<HintilyProductDefinition, 'amountMinor' | 'currency'>,
): string => new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: product.currency,
  maximumFractionDigits: 0,
}).format(product.amountMinor / 100);
