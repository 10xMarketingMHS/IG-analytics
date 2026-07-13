import { useMemo } from "react";
import { useTaxonomy } from "@/lib/use-taxonomy";
import { usePosts } from "@/lib/use-posts";

type Insight = [tint: string, icon: string, title: string, body: string, rec: string];

export function InsightsPage() {
  const { taxonomy } = useTaxonomy();
  const { posts } = usePosts();

  const insights = useMemo<Insight[]>(() => {
    if (!posts || !taxonomy) return [];
    const pub = posts.filter((p) => p.status === "published" && p.reach > 0);
    if (pub.length < 3) return [];
    const out: Insight[] = [];

    // Top pillar by total views.
    const pillarViews = new Map<string, number>();
    for (const p of pub) pillarViews.set(p.pillar_id, (pillarViews.get(p.pillar_id) ?? 0) + p.views);
    const topPillar = [...pillarViews.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topPillar) {
      const nm = taxonomy.pillars.find((x) => x.id === topPillar[0])?.name ?? "—";
      const total = [...pillarViews.values()].reduce((a, b) => a + b, 0);
      const share = total ? Math.round((topPillar[1] / total) * 100) : 0;
      out.push(["tint-teal", "🏆", `${nm} is your top pillar`,
        `Highest total views (${topPillar[1].toLocaleString()}) — about ${share}% of all views.`,
        `→ Keep investing in ${nm} content; it consistently outperforms.`]);
    }

    // Carousels vs reels on saves per reach.
    const saveRate = (type: "reel" | "carousel") => {
      const set = pub.filter((p) => p.post_type === type);
      const r = set.reduce((a, p) => a + p.reach, 0);
      const s = set.reduce((a, p) => a + p.saves, 0);
      return r ? s / r : 0;
    };
    const cr = saveRate("carousel"), rr = saveRate("reel");
    if (cr > 0 && rr > 0) {
      const ratio = (cr / rr).toFixed(1);
      const winner = cr >= rr ? "Carousels" : "Reels";
      out.push(["tint-indigo", "🔖", `${winner} win on saves`,
        `${winner} earn ~${cr >= rr ? ratio : (rr / cr).toFixed(1)}× more saves per reach — your strongest quality signal.`,
        `→ Use ${winner.toLowerCase()} for reference content (lists, glossaries, tests).`]);
    }

    // Under-served avatar (fewest posts but decent engagement).
    const avatarCount = new Map<string, number>();
    for (const p of pub) avatarCount.set(p.avatar_id, (avatarCount.get(p.avatar_id) ?? 0) + 1);
    const used = taxonomy.avatars.filter((a) => avatarCount.has(a.id));
    if (used.length > 1) {
      const least = used.sort((a, b) => (avatarCount.get(a.id) ?? 0) - (avatarCount.get(b.id) ?? 0))[0];
      const share = Math.round(((avatarCount.get(least.id) ?? 0) / pub.length) * 100);
      out.push(["tint-rose", "🕑", `"${least.name}" avatar is under-served`,
        `Only ${share}% of posts target ${least.name} — consider testing more.`,
        `→ Add more ${least.name}-focused content next cycle.`]);
    }

    return out;
  }, [posts, taxonomy]);

  return (
    <section className="screen">
      <div className="hint" style={{ marginBottom: 14 }}>
        🧮 Computed automatically from your data — updates as you add posts. (Rule-based, no AI writing.)
      </div>
      {insights.length ? (
        <div className="grid g2">
          {insights.map((x) => (
            <div className="card insight" key={x[2]}>
              <div className={"ic2 " + x[0]}>{x[1]}</div>
              <div>
                <h4>{x[2]}</h4>
                <p>{x[3]}</p>
                <div className="rec">{x[4]}</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card pad" style={{ color: "var(--muted)", fontSize: 13 }}>
          Insights appear once you have a few published posts with metrics. Add and publish content, then check back.
        </div>
      )}
    </section>
  );
}
