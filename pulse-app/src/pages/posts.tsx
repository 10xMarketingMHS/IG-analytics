import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useTaxonomy } from "@/lib/use-taxonomy";
import { useEditors } from "@/lib/use-editors";
import { usePosts } from "@/lib/use-posts";
import { formatScore } from "@/lib/score";
import type { Post } from "@/lib/types";

type Filter = "all" | "planned" | "published" | "reel" | "carousel";

const FILTERS: Array<[Filter, string]> = [
  ["all", "All"],
  ["planned", "🕓 Planned"],
  ["published", "✅ Published"],
  ["reel", "Reels"],
  ["carousel", "Carousels"],
];

function fmtNum(n: number) {
  return n > 0 ? n.toLocaleString() : "—";
}

export function PostsPage() {
  const { taxonomy } = useTaxonomy();
  const { editors } = useEditors();
  const { posts, refetch } = usePosts();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const name = (list: { id: string; name: string }[] | undefined, id: string) =>
    list?.find((x) => x.id === id)?.name ?? "—";
  const pillarName = (id: string) => name(taxonomy?.pillars, id);
  const avatarName = (id: string) => name(taxonomy?.avatars, id);
  const formatName = (id: string) => name(taxonomy?.formats, id);
  const editorName = (id: string | null) =>
    id ? editors?.find((e) => e.id === id)?.name ?? "—" : "—";

  const plannedCount = posts?.filter((p) => p.status === "planned").length ?? 0;

  async function handleDelete(e: React.MouseEvent, post: Post) {
    e.stopPropagation();
    if (!window.confirm(`Delete "${post.title}"? This can't be undone.`)) return;
    try {
      await api(`/posts/${post.id}`, { method: "DELETE" });
      await refetch();
      toast.success("Post deleted.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete post.");
    }
  }

  const rows = useMemo(() => {
    if (!posts) return [];
    return posts.filter((p) => {
      if (filter === "planned" && p.status !== "planned") return false;
      if (filter === "published" && p.status !== "published") return false;
      if (filter === "reel" && p.post_type !== "reel") return false;
      if (filter === "carousel" && p.post_type !== "carousel") return false;
      if (query) {
        const hay = (p.title + " " + formatName(p.format_id)).toLowerCase();
        if (!hay.includes(query.toLowerCase())) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts, filter, query, taxonomy]);

  return (
    <section className="screen">
      <div className="toolbar">
        <div className="search">
          <span>🔎</span>
          <input
            placeholder="Search posts, captions, formats…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {FILTERS.map(([f, label]) => (
          <button
            key={f}
            className={"chip" + (filter === f ? " on" : "")}
            onClick={() => setFilter(f)}
          >
            {label}
          </button>
        ))}
        <button className="btn" style={{ marginLeft: "auto" }} disabled>⬇ Export CSV</button>
        <button className="btn" disabled>⬆ Import</button>
      </div>

      <div className="card" style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Date</th>
              <th>Title / Format</th>
              <th>Editor</th>
              <th>Pillar</th>
              <th>Type</th>
              <th>Avatar</th>
              <th className="num">Views</th>
              <th className="num">Likes</th>
              <th className="num">Saves</th>
              <th className="num">Score</th>
              <th>Status</th>
              <th>Source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {posts === null ? (
              <tr><td colSpan={13} style={{ textAlign: "center", padding: 26, color: "var(--muted)" }}>Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={13} style={{ textAlign: "center", padding: 26, color: "var(--muted)" }}>
                No posts match this filter.
              </td></tr>
            ) : (
              rows.map((p) => (
                <tr key={p.id} className="clickrow" onClick={() => navigate(`/posts/${p.id}/edit`)}>
                  <td>{p.date}</td>
                  <td>
                    <b style={{ fontWeight: 650 }}>{p.title}</b>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>{formatName(p.format_id)}</div>
                  </td>
                  <td>{editorName(p.editor_id)}</td>
                  <td><span className="tag">{pillarName(p.pillar_id)}</span></td>
                  <td>{p.post_type === "reel" ? "Reel" : "Carousel"}</td>
                  <td><span className="tag av">{avatarName(p.avatar_id)}</span></td>
                  <td className="num">{fmtNum(p.views)}</td>
                  <td className="num">{fmtNum(p.likes)}</td>
                  <td className="num">{fmtNum(p.saves)}</td>
                  <td className="num"><b>{formatScore(p)}</b></td>
                  <td>
                    {p.status === "planned" ? (
                      <span className="stbadge st-planned">🕓 Planned</span>
                    ) : (
                      <span className="stbadge st-pub">✅ Published</span>
                    )}
                  </td>
                  <td>
                    <span className={"src " + (p.source === "instagram" ? "ig" : "man")}>
                      {p.source === "instagram" ? "⚡ IG" : "✍️ Manual"}
                    </span>
                  </td>
                  <td>
                    <button
                      className="rowbtn"
                      title="Delete post"
                      onClick={(e) => handleDelete(e, p)}
                    >
                      🗑
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {posts && posts.length > 0 && (
        <div className="hint" style={{ marginTop: 12 }}>
          Showing {rows.length} of {posts.length}
          {plannedCount > 0 && (
            <> · <b style={{ color: "var(--amber)" }}>{plannedCount} planned</b> awaiting metrics</>
          )}
        </div>
      )}
    </section>
  );
}
