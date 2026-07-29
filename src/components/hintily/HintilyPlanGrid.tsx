import React from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
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
    <div className={`grid gap-2 ${compact ? 'grid-cols-2 xl:grid-cols-4' : 'sm:grid-cols-2'}`}>
      {HINTILY_PRODUCTS.map(product => (
        <button
          key={product.code}
          type="button"
          disabled={busy !== null || checkoutBusy}
          onClick={() => void startCheckout(product.code)}
          className="group rounded-xl border border-border-subtle bg-bg-subtle/30 px-3 py-2.5 text-left transition-all hover:border-accent-primary/50 hover:bg-bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`Buy ${product.label} for ${formatHintilyProductPrice(product)}`}
        >
          <span className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-text-primary">{product.label}</span>
            {checkoutBusy
              ? <RefreshCw size={12} className="animate-spin text-accent-primary" />
              : <ExternalLink size={12} className="text-text-tertiary transition-colors group-hover:text-accent-primary" />}
          </span>
          <span className="mt-0.5 block text-[11px] font-medium text-accent-primary">
            {formatHintilyProductPrice(product)}
          </span>
          {!compact && (
            <span className="mt-1 block text-[10px] leading-snug text-text-tertiary">
              {product.description}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
