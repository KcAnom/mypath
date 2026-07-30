const NUMBER_WORDS = new Map([['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8]]);
const MAX_DELIVERABLES = 8;

function cleanName(value, fallback) {
  const name = String(value || '').replace(/^[-*\d.)\s]+/, '').replace(/[.;]+$/, '').trim().slice(0, 64);
  return name || fallback;
}
function keyFor(name, index) {
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${String(index + 1).padStart(2, '0')}-${key || 'deliverable'}`;
}

/** Deterministically turns a request into independently executable, named outputs. */
export function planDeliverables(prompt, requested) {
  let specs = Array.isArray(requested) ? requested.slice(0, MAX_DELIVERABLES).map((entry, index) => typeof entry === 'string'
    ? { name: cleanName(entry, `Screen ${index + 1}`), prompt: String(prompt || '') }
    : { name: cleanName(entry?.name, `Screen ${index + 1}`), prompt: String(entry?.prompt || prompt || '') }) : [];
  const text = String(prompt || '').trim();
  if (!specs.length) {
    const list = text.match(/(?:screens?|pages?|deliverables?)\s*(?:named|called|:|—|-)\s*([^\n.]+)/i)?.[1]
      || text.match(/(?:create|build|design)\s+(?:an?\s+)?(?:screens?|pages?)\s*(?:for|:|—|-)\s*([^\n.]+)/i)?.[1];
    if (list) {
      const names = list.split(/,|\band\b/i).map((part) => cleanName(part, '')).filter(Boolean);
      if (names.length > 1) specs = names.slice(0, MAX_DELIVERABLES).map((name) => ({ name, prompt: text }));
    }
  }
  if (!specs.length) {
    const lines = text.split('\n').filter((line) => /^\s*(?:[-*]|\d+[.)])\s+/.test(line));
    if (lines.length > 1) specs = lines.slice(0, MAX_DELIVERABLES).map((line, index) => ({ name: cleanName(line, `Screen ${index + 1}`), prompt: text }));
  }
  if (!specs.length) {
    const countMatch = text.match(/\b(one|two|three|four|five|six|seven|eight|[1-8])\s+(?:independent\s+)?(?:screens?|pages?|deliverables?)\b/i);
    const count = countMatch ? (NUMBER_WORDS.get(countMatch[1].toLowerCase()) || Number(countMatch[1])) : 1;
    specs = Array.from({ length: count }, (_, index) => ({ name: count === 1 ? cleanName(text.split(/[.!?\n]/)[0], 'Design') : `Screen ${index + 1}`, prompt: text }));
  }
  const seen = new Map();
  return specs.map((spec, index) => {
    const base = cleanName(spec.name, `Screen ${index + 1}`); const occurrence = (seen.get(base) || 0) + 1; seen.set(base, occurrence);
    const name = occurrence === 1 ? base : `${base} ${occurrence}`;
    return { key: keyFor(name, index), name, prompt: spec.prompt || text, ordinal: index };
  });
}
