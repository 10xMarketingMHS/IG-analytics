import type { Editor } from "@/lib/types";

// Shared editor visuals — the avatar (photo, or a deterministic gradient with the
// initial as fallback) and the per-editor accent color. Both the leaderboard's
// Progress Path and the My Day "Top Performer" ticker render editors, so these
// live in one place instead of each page rolling its own.

const AV_GRADIENTS = [
  "linear-gradient(135deg,#7c3aed,#a855f7)",
  "linear-gradient(135deg,#8b5cf6,#22d3ee)",
  "linear-gradient(135deg,#a855f7,#f472b6)",
  "linear-gradient(135deg,#ec4899,#8b5cf6)",
  "linear-gradient(135deg,#6366f1,#22d3ee)",
  "linear-gradient(135deg,#f59e0b,#a855f7)",
];

// Stable gradient per name — same person always gets the same fallback avatar.
export function gradFor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AV_GRADIENTS[h % AV_GRADIENTS.length];
}

export function Avatar({ editor }: { editor: Editor }) {
  if (editor.image_url) {
    return <img className="lb-ava" src={editor.image_url} alt={editor.name} />;
  }
  return (
    <div className="lb-ava" style={{ background: gradFor(editor.name) }}>
      {editor.name.charAt(0).toUpperCase()}
    </div>
  );
}

// Per-editor accent color, keyed by the editor's position in the roster so it
// stays consistent across the app (Progress Path lines/dots and the ticker's
// avatar ring pick the same color for the same person).
export const RING_COLORS = ["#ef4444", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1", "#14b8a6", "#e11d48"];

export function ringColorOf(editors: Editor[], id: string) {
  const i = editors.findIndex((x) => x.id === id);
  return RING_COLORS[(i < 0 ? 0 : i) % RING_COLORS.length];
}
