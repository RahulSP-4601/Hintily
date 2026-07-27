export type NegotiationTurn = { role: 'user' | 'assistant' | 'interviewer'; text: string };

export type NegotiationConversationState = {
  turns: NegotiationTurn[];
  turnCount: number;
  lastUpdatedAt: string | null;
};

const COMPENSATION_PATTERN =
  /\b(?:salary|compensation|pay|base|equity|bonus|offer|budget|range|ctc|lpa|lakhs?|remuneration|signing bonus)\b/i;
const MONEY_PATTERN =
  /(?:[$€£₹]\s?\d[\d,.]*|\b\d+(?:[.,]\d+)?\s?(?:k|m|lpa|lakhs?|million|thousand)\b)/i;

/** Shared, conservative detector used by transcript-aware intent routing. */
export function textHasCompEvidence(text: string): boolean {
  const normalized = String(text || '').trim();
  return Boolean(normalized && (COMPENSATION_PATTERN.test(normalized) || MONEY_PATTERN.test(normalized)));
}

export class NegotiationConversationTracker {
  private turns: NegotiationTurn[] = [];
  private lastUpdatedAt: string | null = null;

  addTurn(role: NegotiationTurn['role'], text: string): void {
    const normalized = String(text || '').trim();
    if (!normalized) return;
    this.turns.push({ role, text: normalized });
    if (this.turns.length > 20) this.turns.splice(0, this.turns.length - 20);
    this.lastUpdatedAt = new Date().toISOString();
  }

  getTurns(): NegotiationTurn[] {
    return this.turns.map(turn => ({ ...turn }));
  }

  getState(): NegotiationConversationState {
    return {
      turns: this.getTurns(),
      turnCount: this.turns.length,
      lastUpdatedAt: this.lastUpdatedAt,
    };
  }

  isActive(): boolean {
    return this.turns.length > 0;
  }

  reset(): void {
    this.turns = [];
    this.lastUpdatedAt = null;
  }
}
