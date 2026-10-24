import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { avatarColor, initials, useChat, type ChatPerson } from "@/lib/chat";
import "./online-now.css";

// Who's on Pulse right now, on the top bar: four faces in a tight stack that,
// on hover (or on a first tap, on a phone), spreads out into everyone side by
// side, each naming itself when pointed at; a click opens your direct messages
// with that person.
// From chat's presence (lib/chat.tsx): the people with Pulse open, you left out.

const STACK = 4;  // faces in the stack
const SHOW = 8;   // faces spread out; anyone past these is in the "+N"

export function OnlineNow() {
  const { available, state, people, online, refresh } = useChat();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // a touch can't hover: the first tap spreads the faces, the next one picks
  const touch = useRef(false);

  // spread by a tap: a tap anywhere else gathers them up again
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  if (!available || !state) return null;
  const me = state.me;
  const live = [...online]
    .filter((id) => id !== me)
    .map((id) => people.get(id))
    .filter((p): p is ChatPerson => !!p)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!live.length) return null;
  const shown = live.slice(0, SHOW);
  // past eight, once spread: a "+N" (the stack is just four faces; the label has the count)
  const more = live.slice(SHOW);

  async function message(p: ChatPerson) {
    // your conversation with just them, if there is one; otherwise it's started
    const dm = state!.channels.find((c) => c.kind === "dm" && c.member_ids.length === 2 && c.member_ids.includes(p.id));
    if (dm) { setOpen(false); navigate(`/chat?c=${dm.id}`); return; }
    setBusy(p.id);
    try {
      const out = await api<{ channelId: string }>("/chat/dm", { method: "POST", body: JSON.stringify({ userIds: [p.id] }) });
      await refresh();
      setOpen(false);
      navigate(`/chat?c=${out.channelId}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't open the chat — try again.");
    } finally {
      setBusy(null);
    }
  }

  const pick = (go: () => void) => () => {
    if (touch.current && !open) { setOpen(true); return; }
    go();
  };

  return (
    <div
      ref={ref}
      className="on-now"
      data-open={open || undefined}
      role="group"
      aria-label={`Online now: ${live.map((p) => p.name).join(", ")}`}
      onPointerDown={(e) => { touch.current = e.pointerType !== "mouse"; }}
      onPointerEnter={(e) => { if (e.pointerType === "mouse") setOpen(true); }}
      onPointerLeave={(e) => { if (e.pointerType === "mouse") setOpen(false); }}
      onKeyDown={() => { touch.current = false; }}
      // (a tap focuses the face too, before its click: that tap only spreads them)
      onFocus={() => { if (!touch.current) setOpen(true); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
    >
      <span className="on-label" aria-hidden="true"><i />{live.length} online</span>
      <div className="on-faces">
        {shown.map((p, i) => (
          <button
            key={p.id}
            type="button"
            className={"on-face" + (i >= STACK ? " extra" : "")}
            style={{ zIndex: SHOW + 1 - i }}
            aria-label={`Message ${p.name}`}
            aria-busy={busy === p.id || undefined}
            disabled={busy !== null}
            onClick={pick(() => { void message(p); })}
          >
            {p.image_url
              ? <img src={p.image_url} alt="" />
              : <span className="on-in" style={{ background: p.color || avatarColor(p.name) }}>{initials(p.name)}</span>}
            <span className="on-dot" />
            <span className="on-tip" role="tooltip">
              <b>{p.name}</b>
              <span>{busy === p.id ? "Opening the chat…" : (p.designation ? `${p.designation} · ` : "") + "Message"}</span>
            </span>
          </button>
        ))}
        {more.length > 0 && (
          <button
            type="button"
            className={"on-face on-more" + (open ? "" : " gone")}
            style={{ zIndex: 0 }}
            aria-label={`${more.length} more online: ${more.map((p) => p.name).join(", ")}. Open Team Chat`}
            onClick={pick(() => { setOpen(false); navigate("/chat"); })}
          >
            <span className="on-in">+{more.length}</span>
            <span className="on-tip" role="tooltip">
              <b>{more.slice(0, 8).map((p) => p.name).join(", ")}{more.length > 8 ? ` and ${more.length - 8} more` : ""}</b>
              <span>Open Team Chat</span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
