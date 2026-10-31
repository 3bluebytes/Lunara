// textSimilarity.js — CJK-aware text similarity for insight de-duplication.
//
// The whitespace tokenizer behind types.contentSimilarity treats an entire
// Chinese sentence as a single token, so similarity degenerates to
// all-or-nothing exactly where we need it (paraphrased reflections about the
// same event). Overlapping character bigrams work language-agnostically on the
// short observation texts this system produces.

export function charBigrams(value) {
  const text = String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (text.length <= 1) return text ? [text] : [];
  const grams = [];
  for (let i = 0; i < text.length - 1; i++) grams.push(text.slice(i, i + 2));
  return grams;
}

/** Dice coefficient over character bigrams: 1 = identical, 0 = disjoint. */
export function charBigramSimilarity(a, b) {
  const gramsA = charBigrams(a);
  const gramsB = charBigrams(b);
  if (!gramsA.length || !gramsB.length) return 0;
  const counts = new Map();
  for (const gram of gramsB) counts.set(gram, (counts.get(gram) || 0) + 1);
  let overlap = 0;
  for (const gram of gramsA) {
    const n = counts.get(gram) || 0;
    if (n > 0) { overlap++; counts.set(gram, n - 1); }
  }
  return (2 * overlap) / (gramsA.length + gramsB.length);
}
