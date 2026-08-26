import { useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { fileToSquareDataUrl } from "@/lib/image";
import { Modal } from "@/components/modal";

// Same gradient-string convention used for editor/avatar chips elsewhere
// (see leaderboard.tsx's AV_GRADIENTS) — stored as-is in app_user.color.
const COLOR_PRESETS = [
  "linear-gradient(135deg,#7c3aed,#a855f7)",
  "linear-gradient(135deg,#8b5cf6,#22d3ee)",
  "linear-gradient(135deg,#a855f7,#f472b6)",
  "linear-gradient(135deg,#ec4899,#8b5cf6)",
  "linear-gradient(135deg,#6366f1,#22d3ee)",
  "linear-gradient(135deg,#f59e0b,#a855f7)",
  "linear-gradient(135deg,#16a34a,#22d3ee)",
  "linear-gradient(135deg,#f43f5e,#f59e0b)",
];

// Same colors as COLOR_PRESETS above, split into stops so they can also back
// an SVG gradient (CSS gradient strings can't be reused directly in <svg>).
const GRADIENT_STOPS: [string, string][] = [
  ["#7c3aed", "#a855f7"],
  ["#8b5cf6", "#22d3ee"],
  ["#a855f7", "#f472b6"],
  ["#ec4899", "#8b5cf6"],
  ["#6366f1", "#22d3ee"],
  ["#f59e0b", "#a855f7"],
  ["#16a34a", "#22d3ee"],
  ["#f43f5e", "#f59e0b"],
];

// A built-in "pick a face" set (Netflix/Slack-style icon avatars) for anyone
// who'd rather not upload a real photo. Each is a tiny inline SVG — a
// gradient square with a centered emoji — encoded straight into a data URI
// and stored in the same app_user.image_url column a real photo would use,
// so no schema or backend change was needed for this.
const AVATAR_EMOJI = [
  "🦊", "🐼", "🦁", "🐧", "🐨", "🦉", "🐬", "🐙",
  "🦄", "🐝", "🌵", "🍕", "🎸", "🚀", "🌈", "🎯",
  "🔥", "💎", "🎨", "🐯",
];

function svgAvatarUrl(emoji: string, [from, to]: [string, string]): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
    `</linearGradient></defs>` +
    `<rect width="160" height="160" rx="32" fill="url(#g)"/>` +
    `<text x="50%" y="55%" font-size="86" text-anchor="middle" dominant-baseline="middle">${emoji}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const AVATAR_PRESETS = AVATAR_EMOJI.map((emoji, i) => ({
  emoji,
  url: svgAvatarUrl(emoji, GRADIENT_STOPS[i % GRADIENT_STOPS.length]),
}));

// Self-service — your own login's display name, photo, and accent color.
// Deliberately separate from the admin Settings hub: no admin access needed,
// and it never touches the org-wide "Team" roster (a different record you
// may or may not be linked to).
export function MyProfileModal({ onClose }: { onClose: () => void }) {
  const { user, refreshUser } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(user?.name ?? "");
  const [imageUrl, setImageUrl] = useState<string | null>(user?.imageUrl ?? null);
  const [color, setColor] = useState<string | null>(user?.color ?? null);
  const [saving, setSaving] = useState(false);

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setImageUrl(await fileToSquareDataUrl(file));
    } catch {
      toast.error("Couldn't process that image.");
    }
  }

  async function save() {
    if (!name.trim()) {
      toast.error("Name can't be empty.");
      return;
    }
    setSaving(true);
    try {
      await api("/users/me", { method: "PATCH", body: JSON.stringify({ name: name.trim(), imageUrl, color }) });
      await refreshUser();
      toast.success("Profile updated.");
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save your profile.");
    } finally {
      setSaving(false);
    }
  }

  const initial = (name || user?.email || "?").charAt(0).toUpperCase();

  return (
    <Modal title="My Profile" onClose={onClose}>
      <div className="profile-photo-row">
        <div
          className="profile-photo-preview"
          style={{ background: imageUrl ? undefined : (color ?? "var(--grad)") }}
        >
          {imageUrl ? <img src={imageUrl} alt={name} /> : initial}
        </div>
        <div>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            📷 {imageUrl ? "Change photo" : "Upload photo"}
          </button>
          {imageUrl && (
            <button type="button" className="linkbtn" style={{ marginLeft: 6 }} onClick={() => setImageUrl(null)}>
              Remove
            </button>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickFile} />
      </div>

      <div className="field">
        <label className="f">Or pick an avatar</label>
        <div className="avatar-picker">
          {AVATAR_PRESETS.map((p) => (
            <button
              key={p.emoji}
              type="button"
              className={"avatar-picker-opt" + (imageUrl === p.url ? " on" : "")}
              title={`Use this avatar`}
              onClick={() => setImageUrl(p.url)}
            >
              <img src={p.url} alt="" />
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label className="f">Name</label>
        <input className="t" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>

      <div className="field">
        <label className="f">Accent color</label>
        <div className="hint" style={{ marginTop: -2, marginBottom: 8 }}>Used behind your initial when you don't have a photo or avatar.</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {COLOR_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              title="Use this color"
              style={{
                width: 30, height: 30, borderRadius: 9, background: c, cursor: "pointer",
                border: color === c ? "2px solid var(--text)" : "2px solid transparent",
              }}
            />
          ))}
        </div>
      </div>

      <div className="hint" style={{ marginTop: 4 }}>
        This only changes your own login — it's separate from admin Settings and doesn't need admin access, and
        doesn't touch your Team-roster profile (if you have one) either.
      </div>

      <div className="mfoot" style={{ marginTop: 18 }}>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </Modal>
  );
}
