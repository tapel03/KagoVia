// Renders a plan as a simple SVG (what ai-design.html displays). All text is escaped.
const PX = 40; // pixels per metre
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v) => Math.round(v * PX * 10) / 10;

const FILL = {
  bedroom: '#eef2ff', bathroom: '#e0f2fe', ensuite: '#e0f2fe', kitchen: '#fef3c7', living: '#ecfdf5',
  dining: '#fefce8', garage: '#f1f5f9', laundry: '#f0f9ff', study: '#faf5ff', passage: '#ffffff',
};

export function renderSvg(spec, level = 0) {
  const rooms = spec.rooms.filter((r) => r.level === level);
  const w = n(spec.plot.w);
  const h = n(spec.plot.d);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="Inter, Arial, sans-serif">`,
    `<rect x="0" y="0" width="${w}" height="${h}" fill="#fafafa" stroke="#cbd5e1" stroke-dasharray="6 4"/>`];
  for (const r of rooms) {
    const { x, y, w: rw, d } = r.rect;
    parts.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(rw)}" height="${n(d)}" fill="${FILL[r.type] || '#fff'}" stroke="#334155" stroke-width="3"/>`);
    if (r.type !== 'passage') {
      const cx = n(x + rw / 2);
      const cy = n(y + d / 2);
      parts.push(`<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="12" fill="#0f172a">${esc(r.name)}</text>`);
      parts.push(`<text x="${cx}" y="${cy + 12}" text-anchor="middle" font-size="10" fill="#475569">${esc((rw * d).toFixed(1))} m²</text>`);
    }
    for (const win of r.windows) {
      const [x1, y1, x2, y2] = openingLine(r.rect, win);
      parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#0ea5e9" stroke-width="5"/>`);
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

function openingLine(rect, o) {
  const mid = (a, len) => a + len / 2;
  switch (o.wall) {
    case 'N': return [n(mid(rect.x, rect.w) - o.width / 2), n(rect.y), n(mid(rect.x, rect.w) + o.width / 2), n(rect.y)];
    case 'S': return [n(mid(rect.x, rect.w) - o.width / 2), n(rect.y + rect.d), n(mid(rect.x, rect.w) + o.width / 2), n(rect.y + rect.d)];
    case 'W': return [n(rect.x), n(mid(rect.y, rect.d) - o.width / 2), n(rect.x), n(mid(rect.y, rect.d) + o.width / 2)];
    default: return [n(rect.x + rect.w), n(mid(rect.y, rect.d) - o.width / 2), n(rect.x + rect.w), n(mid(rect.y, rect.d) + o.width / 2)];
  }
}
