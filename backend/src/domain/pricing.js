// Prices take-off lines and computes totals. Pure: the caller passes in catalogue rows and current prices.
import { toMilli, milliToString, lineTotalCents, percentOfCents } from '../lib/money.js';

const WHOLE_UNITS = new Set(['each', 'bag']);

// materials: Map<code, {id, unit, name, wastage_bp}>
// prices: Map<material_id, {supplier_id, price_cents, observed_at}>  (cheapest approved price in the region)
// rates: { labour_bp, contingency_bp, vat_bp }
export function priceTakeoff(takeoffLines, materials, prices, rates) {
  let materialsCents = 0;
  let unpriced = 0;
  const lines = takeoffLines.map((line, i) => {
    const mat = materials.get(line.materialCode);
    // Wastage from the catalogue; whole units (bricks, bags, doors) round up.
    const wastage = mat ? mat.wastage_bp : 0;
    let qtyMilli = Math.round((toMilli(line.quantity) * (10000 + wastage)) / 10000);
    if (mat && WHOLE_UNITS.has(mat.unit)) qtyMilli = Math.ceil(qtyMilli / 1000) * 1000;
    const price = mat ? prices.get(mat.id) : undefined;
    const base = {
      lineNo: i + 1,
      component: line.component,
      materialId: mat?.id ?? null,
      materialCode: line.materialCode,
      description: line.description,
      unit: mat?.unit ?? 'each',
      quantity: milliToString(qtyMilli),
    };
    if (!price) {
      unpriced++;
      return { ...base, status: 'unpriced', supplierId: null, unitPriceCents: null, priceObservedAt: null, lineTotalCents: null };
    }
    const total = lineTotalCents(qtyMilli, price.price_cents);
    materialsCents += total;
    return {
      ...base, status: 'priced', supplierId: price.supplier_id, unitPriceCents: price.price_cents,
      priceObservedAt: price.observed_at, lineTotalCents: total,
    };
  });

  const labourCents = percentOfCents(materialsCents, rates.labour_bp);
  const contingencyCents = percentOfCents(materialsCents + labourCents, rates.contingency_bp);
  const subtotalCents = materialsCents + labourCents + contingencyCents;
  const vatCents = percentOfCents(subtotalCents, rates.vat_bp);
  return {
    lines,
    totals: {
      materialsCents, labourCents, contingencyCents, subtotalCents, vatCents,
      totalCents: subtotalCents + vatCents, unpricedLines: unpriced,
    },
  };
}
