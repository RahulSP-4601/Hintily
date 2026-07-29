import React from 'react';
import { ArrowUpRight, Check, Crown, RefreshCw } from 'lucide-react';
import {
  formatHintilyProductPrice,
  HINTILY_PRODUCTS,
} from '../../config/hintilyProducts';
import { useHintilyAccount } from '../../lib/hintily/HintilyAccountContext';

export function HintilyPlanGrid(
  { compact = false }: { compact?: boolean },
): React.ReactElement {
  const { busy, checkoutBusy, startCheckout } = useHintilyAccount();

  return (
    <div className={`grid gap-3 ${compact ? 'grid-cols-2 xl:grid-cols-4' : 'sm:grid-cols-2'}`}>
      {HINTILY_PRODUCTS.map(product => {
        const unlimited = product.sessions === null;
        const featured = !compact && product.interval === 'month';
        return (
        <button
          key={product.code}
          type="button"
          disabled={busy !== null || checkoutBusy}
          onClick={() => void startCheckout(product.code)}
          className={`group relative overflow-hidden rounded-2xl border p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_35px_rgba(0,0,0,0.18)] disabled:cursor-not-allowed disabled:opacity-50 ${
            featured
              ? 'border-accent-primary/45 bg-gradient-to-br from-accent-primary/[0.14] via-bg-elevated to-bg-elevated'
              : 'border-border-subtle bg-gradient-to-b from-bg-elevated to-bg-subtle/25 hover:border-accent-primary/35'
          }`}
          aria-label={`Buy ${product.label} for ${formatHintilyProductPrice(product)}`}
        >
          {featured && (
            <span className="absolute right-3 top-3 rounded-full bg-accent-primary/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-accent-primary">
              Popular
            </span>
          )}
          <span className="flex items-center justify-between gap-2">
            <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${
              unlimited ? 'bg-violet-500/15 text-violet-400' : 'bg-blue-500/15 text-blue-400'
            }`}>
              {unlimited ? <Crown size={15} /> : <Check size={15} />}
            </span>
            {checkoutBusy
              ? <RefreshCw size={12} className="animate-spin text-accent-primary" />
              : <ArrowUpRight size={14} className="text-text-tertiary transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-accent-primary" />}
          </span>
          <span className="mt-3 block text-xs font-semibold text-text-primary">{product.label}</span>
          <span className="mt-1 block text-lg font-bold tracking-tight text-accent-primary">
            {formatHintilyProductPrice(product)}
          </span>
          {!compact && (
            <span className="mt-2 block min-h-8 text-[10px] leading-relaxed text-text-tertiary">
              {product.description}
            </span>
          )}
          {!compact && (
            <span className="mt-3 flex items-center justify-center rounded-lg border border-border-subtle bg-bg-main/35 py-2 text-[10px] font-semibold text-text-primary transition group-hover:border-accent-primary/30 group-hover:bg-accent-primary/10">
              Choose plan
            </span>
          )}
        </button>
      )})}
    </div>
  );
}
