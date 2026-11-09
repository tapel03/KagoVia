// Money is always integer cents. Quantities are decimals with up to 3 places, handled as integer thousandths.
// No floating-point money anywhere (TRD NFR-11).

export const VAT_PERCENT_DEFAULT = 15;

// "12.345" | 12.345 -> 12345 (thousandths). Rejects more than 3 decimals after rounding to 3.
export function toMilli(qty) {
  const s = typeof qty === 'number' ? qty.toFixed(3) : String(qty).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid quantity: ${qty}`);
  const [whole, frac = ''] = s.split('.');
  const f = (frac + '000').slice(0, 3);
  const roundUp = frac.length > 3 && Number(frac[3]) >= 5;
  const sign = whole.startsWith('-') ? -1 : 1;
  const milli = Math.abs(Number(whole)) * 1000 + Number(f) + (roundUp ? 1 : 0);
  return sign * milli;
}

export const milliToString = (m) => {
  const sign = m < 0 ? '-' : '';
  const a = Math.abs(m);
  return `${sign}${Math.trunc(a / 1000)}.${String(a % 1000).padStart(3, '0')}`;
};

// quantity (thousandths) x unit price (cents) -> cents, rounded half up. BigInt avoids overflow.
export function lineTotalCents(qtyMilli, unitCents) {
  const p = BigInt(qtyMilli) * BigInt(unitCents);
  const sign = p < 0n ? -1n : 1n;
  const abs = p < 0n ? -p : p;
  const rounded = (abs + 500n) / 1000n;
  return Number(sign * rounded);
}

// Percentage of an amount in cents, percent given in basis points (1500 = 15.00%). Half up.
export function percentOfCents(cents, basisPoints) {
  const p = BigInt(cents) * BigInt(basisPoints);
  return Number((p + 5000n) / 10000n);
}

export const randsToCents = (r) => {
  const m = toMilli(r); // rands with up to 3 decimals
  return Math.round(m / 10);
};

export const centsToRands = (c) => `${c < 0 ? '-' : ''}${Math.trunc(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
