import { useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { Modal } from "@/components/modal";
import "./view-as.css";

// Super Admin test mode: open Echo as someone else by their employee code
// (Team › Roster) to see exactly what they see. The server makes it read-only
// and logs it in Activity; the bar at the bottom switches back. Each switch
// reloads the app, so nothing from one person's view is left in the other's.

export function ViewAsModal({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api("/auth/view-as", { method: "POST", body: JSON.stringify({ employeeCode: code.trim() }) });
      window.location.assign("/home");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't open that view.");
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} title="View Echo as someone">
      <form className="va-form" onSubmit={submit}>
        <label className="f" htmlFor="va-code">Employee code</label>
        <input id="va-code" className="t va-code" autoFocus placeholder="e.g. MHS01" maxLength={20} value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())} />
        <p className="hint">
          Opens their Echo so you see exactly what they see. It's read-only — nothing can be changed under their name — and it ends after two hours.
          Switch back from the bar at the bottom.
        </p>
        {error && <p className="login-err">{error}</p>}
        <div className="va-acts">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()}>{busy ? "Opening…" : "View as"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ViewAsBar({ name, realName }: { name: string; realName: string }) {
  const [busy, setBusy] = useState(false);
  async function back() {
    setBusy(true);
    try {
      await api("/auth/view-as/stop", { method: "POST" });
      window.location.assign("/my-team?tab=roster");
    } catch {
      // Their own session ended meanwhile — sign in again.
      window.location.assign("/login");
    }
  }
  return (
    <div className="va-bar" role="status">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
      </svg>
      <span>Viewing as <b>{name}</b> · read-only</span>
      <button type="button" onClick={back} disabled={busy}>{busy ? "Switching…" : `Back to ${realName.split(" ")[0]}`}</button>
    </div>
  );
}
