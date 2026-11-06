// One CSV cell. Quoted when it holds a comma, a quote or a new line. Text a
// spreadsheet would run as a formula (starting =, +, -, @, or a tab or return)
// gets a ' in front, so a post titled "=HYPERLINK(…)" opens as plain text.
// Numbers stay numbers.
export function csvCell(v: string | number | null | undefined): string {
  if (typeof v === "number") return String(v);
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Only web addresses become clickable links in an exported sheet — never
// file:, javascript: or anything else someone typed in.
export const webLink = (url: string | null | undefined): url is string => !!url && /^https?:\/\//i.test(url.trim());
