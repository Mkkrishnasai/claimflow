// Money by string only (NFR-DATA-1): no float arithmetic anywhere.
export const formatCents = (c: number): string => {
  const s = String(c).padStart(3, '0');
  return `EUR ${s.slice(0, -2)}.${s.slice(-2)}`;
};

// "12", "12.5", "12,50" -> cents; null when malformed, over 2 decimals or outside 0.01..10000.00 (server is authoritative).
export function parseEuro(input: string): number | null {
  const m = /^(\d{1,5})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const cents = Number(m[1] + (m[2] ?? '').padEnd(2, '0'));
  return cents >= 1 && cents <= 1_000_000 ? cents : null;
}

// CR-1: a justification is sent only while the line is over its category limit; otherwise null (a stale text must not reach the server).
export const justificationFor = (cents: number, limitCents: number, text: string): string | null =>
  cents > limitCents ? text.trim() || null : null;
