// A brand's short name, for tight spots (Home's schedule boxes): the one set in
// Settings › Channels, else made from its name — each word's first letter, an
// all-caps word kept whole: Doctor Farmer → DF, My Health School → MHS,
// MHS Diabetes → MHSD. A one-word name gives its first three letters.
export function autoShort(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return /^[A-Z0-9]{2,}$/.test(words[0]) ? words[0] : words[0].slice(0, 3).toUpperCase();
  return words.map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w[0].toUpperCase())).join("").slice(0, 8);
}

export function brandShort(name: string | null | undefined, short?: string | null): string {
  return short?.trim() || autoShort(name ?? "");
}
