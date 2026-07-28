import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { useTaxonomy } from "@/lib/use-taxonomy";
import { useEditors } from "@/lib/use-editors";
import { useWorkspaces } from "@/lib/workspaces-context";
import { useResource } from "@/lib/use-resource";
import { api, ApiError } from "@/lib/api";
import type { Post, Platform, Account } from "@/lib/types";

type Status = "planned" | "published";
type Mode = "manual" | "ig";

const METRIC_FIELDS = [
  ["mViews", "Views"],
  ["mLikes", "Likes"],
  ["mComments", "Comments"],
  ["mShares", "Shares"],
  ["mSaves", "Saves"],
  ["mReach", "Accounts Reached"],
] as const;

export function AddPostPage({ onClose }: { onClose?: () => void } = {}) {
  const { taxonomy, loading } = useTaxonomy();
  const { editors } = useEditors();
  const { workspaces, active } = useWorkspaces();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const editing = Boolean(id);
  const modal = Boolean(onClose); // rendered inside the glass modal vs full page
  const cancel = () => (onClose ? onClose() : navigate("/posts"));

  const [mode, setMode] = useState<Mode>("manual");
  const [status, setStatus] = useState<Status>("planned");
  const [pillarId, setPillarId] = useState("");
  const [contentTypeId, setContentTypeId] = useState("");
  const [formatId, setFormatId] = useState("");
  const [postType, setPostType] = useState<"" | "reel" | "carousel">("");
  const [avatarId, setAvatarId] = useState("");
  const [editorId, setEditorId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [platformId, setPlatformId] = useState("");
  const [collabChannelId, setCollabChannelId] = useState("");

  // Platforms available for the chosen channel (its accounts).
  const { data: platData } = useResource<{ platforms: Platform[] }>("/platforms");
  const { data: acctData } = useResource<{ accounts: Account[] }>(
    channelId ? `/accounts?channel=${channelId}` : "/accounts?channel=all",
  );
  const channelPlatforms = useMemo<Platform[]>(() => {
    const ids = new Set((acctData?.accounts ?? []).map((a) => a.platform_id));
    return (platData?.platforms ?? []).filter((p) => ids.has(p.id));
  }, [acctData, platData]);
  const [date, setDate] = useState("2026-07-15");
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const [metrics, setMetrics] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loadingPost, setLoadingPost] = useState(editing);

  // Edit mode: load the existing post and prefill every field.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoadingPost(true);
    api<{ post: Post }>(`/posts/${id}`)
      .then(({ post }) => {
        if (cancelled) return;
        setDate(post.date);
        setTitle(post.title);
        setLink(post.permalink ?? "");
        setCollabChannelId(post.collab_channel_id ?? "");
        setPillarId(post.pillar_id);
        setContentTypeId(post.content_type_id);
        setFormatId(post.format_id);
        setPostType(post.post_type);
        setAvatarId(post.avatar_id);
        setEditorId(post.editor_id ?? "");
        setPlatformId(post.platform_id ?? "");
        setStatus(post.status);
        setMetrics({
          mViews: String(post.views ?? 0),
          mLikes: String(post.likes ?? 0),
          mComments: String(post.comments ?? 0),
          mShares: String(post.shares ?? 0),
          mSaves: String(post.saves ?? 0),
          mReach: String(post.reach ?? 0),
        });
      })
      .catch(() => {
        if (!cancelled) toast.error("Could not load this post.");
      })
      .finally(() => {
        if (!cancelled) setLoadingPost(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // New posts default to the first/active channel until the user picks another.
  useEffect(() => {
    if (!editing && !channelId && active) setChannelId(active.id);
  }, [editing, channelId, active]);

  // Default the platform to the first one available for the chosen channel;
  // re-pick if a channel change makes the current platform unavailable.
  useEffect(() => {
    if (!editing && channelPlatforms.length && !channelPlatforms.find((p) => p.id === platformId)) {
      setPlatformId(channelPlatforms[0].id);
    }
  }, [editing, channelPlatforms, platformId]);

  const contentTypes = useMemo(
    () => taxonomy?.contentTypes.filter((ct) => ct.pillar_id === pillarId) ?? [],
    [taxonomy, pillarId],
  );
  const formats = useMemo(
    () => taxonomy?.formats.filter((f) => f.pillar_id === pillarId) ?? [],
    [taxonomy, pillarId],
  );

  function onFormatChange(v: string) {
    setFormatId(v);
    // Suggest the format's type as a default — still fully overridable.
    const fmt = formats.find((f) => f.id === v);
    if (fmt) setPostType(fmt.post_type);
  }

  const num = (id: string) => parseFloat(metrics[id] ?? "") || 0;
  const engagement = num("mLikes") + num("mComments") + num("mShares") + num("mSaves");
  const reach = num("mReach");
  const rate = reach ? (engagement / reach) * 100 : null;
  const warn = reach > 0 && engagement > reach;

  function onPillarChange(v: string) {
    setPillarId(v);
    setContentTypeId("");
    setFormatId("");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!date || !title || !pillarId || !contentTypeId || !formatId || !avatarId || !postType) {
      setSubmitError("Fill in date, title, pillar, content type, format, post type and avatar.");
      return;
    }
    setSaving(true);
    const payload = {
      date,
      title,
      link: link || undefined,
      collabChannelId: collabChannelId || null,
      pillarId,
      contentTypeId,
      formatId,
      avatarId,
      editorId,
      channelId: channelId || undefined,
      platformId: platformId || undefined,
      postType,
      status,
      views: num("mViews"),
      likes: num("mLikes"),
      comments: num("mComments"),
      shares: num("mShares"),
      saves: num("mSaves"),
      reach: num("mReach"),
    };
    try {
      if (editing) {
        await api(`/posts/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast.success("Post updated.");
      } else {
        await api("/posts", { method: "POST", body: JSON.stringify(payload) });
        toast.success(status === "planned" ? "Planned post saved." : "Post saved.");
      }
      navigate("/posts");
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Failed to save post.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!id) return;
    if (!window.confirm(`Delete "${title || "this post"}"? This can't be undone.`)) return;
    setDeleting(true);
    try {
      await api(`/posts/${id}`, { method: "DELETE" });
      toast.success("Post deleted.");
      navigate("/posts");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete post.");
      setDeleting(false);
    }
  }

  if (loading || !taxonomy || loadingPost) {
    const l = <div className="hint">Loading…</div>;
    return modal ? l : <section className="screen">{l}</section>;
  }

  const body = (
    <>
      {editing ? (
        <div className="editing-flag" style={{ marginBottom: 16 }}>
          ✏️ Editing — {title || "post"}
        </div>
      ) : (
        <div className="seg">
          <button className={mode === "manual" ? "on" : ""} onClick={() => setMode("manual")}>
            ✍️ Manual entry
          </button>
          <button className={mode === "ig" ? "on" : ""} onClick={() => setMode("ig")}>
            ⚡ Import from Instagram
          </button>
        </div>
      )}

      {mode === "manual" || editing ? (
        <form
          className={modal ? "" : "card pad"}
          style={modal ? undefined : { maxWidth: 760 }}
          onSubmit={handleSubmit}
        >
          {!editing && workspaces.length > 0 && (
            <div className="grid g2">
              <div className="field">
                <label className="f">
                  Channel <span className="req">*</span>{" "}
                  <span style={{ fontWeight: 500, color: "var(--faint)" }}>· the brand account</span>
                </label>
                <select className="t" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="f">Platform <span className="req">*</span></label>
                <select className="t" value={platformId} onChange={(e) => setPlatformId(e.target.value)}>
                  {channelPlatforms.length === 0 && <option value="">No platforms</option>}
                  {channelPlatforms.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div className="grid g2">
            <div className="field">
              <label className="f">Date <span className="req">*</span></label>
              <input className="t" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="field">
              <label className="f">Title <span className="req">*</span></label>
              <input className="t" placeholder="e.g. Ingredient Glossary" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
          </div>

          <div className="grid g2">
            <div className="field">
              <label className="f">Link <span style={{ fontWeight: 500, color: "var(--faint)" }}>· published post URL</span></label>
              <input className="t" placeholder="https://…" value={link} onChange={(e) => setLink(e.target.value)} />
            </div>
            <div className="field">
              <label className="f">Collab <span style={{ fontWeight: 500, color: "var(--faint)" }}>· partner channel</span></label>
              <select className="t" value={collabChannelId} onChange={(e) => setCollabChannelId(e.target.value)}>
                <option value="">None</option>
                {workspaces.filter((w) => w.id !== channelId).map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid g3">
            <div className="field">
              <label className="f">Content Pillar <span className="req">*</span></label>
              <select className="t" value={pillarId} onChange={(e) => onPillarChange(e.target.value)}>
                <option value="">Select pillar…</option>
                {taxonomy.pillars.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="f">Content Type <span className="req">*</span></label>
              <select className="t" value={contentTypeId} disabled={!pillarId} onChange={(e) => setContentTypeId(e.target.value)}>
                <option value="">{pillarId ? "Select type…" : "Pick a pillar first"}</option>
                {contentTypes.map((ct) => (
                  <option key={ct.id} value={ct.id}>{ct.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="f">Format <span className="req">*</span></label>
              <select className="t" value={formatId} disabled={!pillarId} onChange={(e) => onFormatChange(e.target.value)}>
                <option value="">{pillarId ? "Select format…" : "Pick a pillar first"}</option>
                {formats.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid g2">
            <div className="field">
              <label className="f">
                Post Type <span className="req">*</span>{" "}
                <span style={{ fontWeight: 500, color: "var(--faint)" }}>· defaults from format</span>
              </label>
              <select
                className="t"
                value={postType}
                onChange={(e) => setPostType(e.target.value as "reel" | "carousel" | "")}
              >
                <option value="">Select post type…</option>
                <option value="reel">🎬 Reel</option>
                <option value="carousel">🖼️ Carousel</option>
              </select>
            </div>
            <div className="field">
              <label className="f">Audience Avatar <span className="req">*</span></label>
              <select className="t" value={avatarId} onChange={(e) => setAvatarId(e.target.value)}>
                <option value="">Select avatar…</option>
                {taxonomy.avatars.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="field">
            <label className="f">
              Assigned Editor{" "}
              <span style={{ fontWeight: 500, color: "var(--faint)" }}>· who edits this post</span>
            </label>
            <select className="t" value={editorId} onChange={(e) => setEditorId(e.target.value)}>
              <option value="">Unassigned</option>
              {(editors ?? []).map((ed) => (
                <option key={ed.id} value={ed.id}>
                  {ed.name}{ed.designation ? ` — ${ed.designation}` : ""}
                </option>
              ))}
            </select>
            {editors && editors.length === 0 && (
              <div className="hint" style={{ marginTop: 5 }}>
                No editors yet — add them in Settings → Editors.
              </div>
            )}
          </div>

          <div className="field" style={{ marginTop: 2 }}>
            <label className="f">Publishing status</label>
            <div className="statusseg">
              <button type="button" className={status === "planned" ? "on" : ""} data-st="planned" onClick={() => setStatus("planned")}>
                🕓 Planned / not published
              </button>
              <button type="button" className={status === "published" ? "on" : ""} data-st="published" onClick={() => setStatus("published")}>
                ✅ Published
              </button>
            </div>
            <div className="hint" style={{ marginTop: 7 }}>
              {status === "planned"
                ? "Create the record now. After you publish, switch this to Published and log the metrics."
                : "Enter the latest metrics below — you can return and update them anytime as the post grows."}
            </div>
          </div>

          <div className="sectitle"><span className="dot" />Performance metrics<span className="s">add after publishing · update anytime</span></div>

          {status === "planned" ? (
            <div className="metrics-planned">
              <span style={{ fontSize: 18 }}>🕓</span>
              <div>
                <b>Not published yet.</b> Save this post now, publish on Instagram, then come back to log{" "}
                <b>Views, Likes, Comments, Shares, Saves &amp; Accounts Reached</b> — and keep updating them over time as the post gains traction.
              </div>
            </div>
          ) : (
            <div>
              <div className="metricgrid">
                {METRIC_FIELDS.map(([id, label]) => (
                  <div className="metricbox field" key={id}>
                    <label className="f">{label}</label>
                    <input
                      className="t"
                      type="number"
                      min={0}
                      placeholder="0"
                      value={metrics[id] ?? ""}
                      onChange={(e) => setMetrics((m) => ({ ...m, [id]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
              <div className="liverate">
                ⚡ Engagement rate: <b>{rate == null ? "—" : rate.toFixed(1) + "%"}</b>
                <span style={{ fontWeight: 500, fontSize: 11.5, marginLeft: 6 }}>
                  (likes + comments + shares + saves) ÷ reach · computed live
                </span>
              </div>
              {warn && (
                <div className="hint" style={{ color: "var(--amber)" }}>
                  ⚠️ Reach looks lower than total engagement — double-check the numbers.
                </div>
              )}
            </div>
          )}

          {submitError && <p className="login-err" style={{ marginTop: 12 }}>{submitError}</p>}

          <div className="formfoot" style={{ justifyContent: editing ? "space-between" : "flex-end" }}>
            {editing && (
              <button
                type="button"
                className="btn"
                style={{ color: "var(--rose)", borderColor: "var(--rose)" }}
                onClick={handleDelete}
                disabled={deleting || saving}
              >
                {deleting ? "Deleting…" : "🗑 Delete post"}
              </button>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" className="btn" onClick={cancel}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "Saving…" : editing ? "Save changes" : status === "planned" ? "Save planned post" : "Save post"}
              </button>
            </div>
          </div>
        </form>
      ) : (
        <div className={modal ? "" : "card pad"} style={modal ? undefined : { maxWidth: 860 }}>
          <div className="ig-connect">
            <div className="ig-badge">📸</div>
            <h3 style={{ margin: "0 0 6px" }}>Import directly from Instagram</h3>
            <p style={{ color: "var(--muted)", fontSize: 13.5, maxWidth: 440, margin: "0 auto 18px" }}>
              Connect your Instagram account once, then pull any post's metrics (views, likes, comments,
              shares, saves, reach) automatically — no typing.
            </p>
            <button className="btn btn-primary" style={{ margin: "0 auto" }} disabled>
              🔗 Connect Instagram account
            </button>
            <div className="hint" style={{ justifyContent: "center", marginTop: 12 }}>
              Instagram import arrives in Phase 2 — manual entry always works.
            </div>
          </div>
        </div>
      )}
    </>
  );

  return modal ? body : <section className="screen">{body}</section>;
}
