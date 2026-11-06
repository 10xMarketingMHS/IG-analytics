import { useResource } from "@/lib/use-resource";
import { RELEASES } from "@/lib/whats-new";
import { EchoMark } from "@/components/echo-logo";
import "./about.css";

// Settings › About Echo (server/src/routes/about.js): the version running and
// when it went live, why it's called Echo, what it does, what's new in this
// release (lib/whats-new.ts) and who to ask. For everyone.

type About = { version: string; commit: string | null; deployedAt: string; superAdmins: string[] };

const WHAT = [
  ["Tasks", "Every job from brief to approval: who's on it, its time budget, its review"],
  ["Social", "Reels, carousels and posts through scheduling to live links and their numbers"],
  ["Ads", "Each ad through uploads to its results, by editor and by team"],
  ["Analytics", "How the posts are doing, platform by platform, pillar by pillar"],
  ["Goals", "Each person's month: what they set out to do and how far along they are"],
  ["Team", "Who's in today, rankings, leave, and the roster"],
  ["Knowledge Hub", "SOPs, brand guidelines and training, in one place"],
];

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", {
  day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
});
const day = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
// "1.0.0" → "1.0" (a third number only when it isn't 0)
const short = (v: string) => v.replace(/^(\d+\.\d+)\.0$/, "$1");

export function AboutSection() {
  const { data } = useResource<About>("/about");
  const release = RELEASES[0];
  return (
    <>
      <section className="st-card ab-hero">
        <EchoMark className="ab-mark" />
        <span className="ab-id">
          <b>Echo</b>
          <span>The Media House team's work, from brief to results</span>
          <small>
            {data ? <>Version {short(data.version)} · deployed {when(data.deployedAt)}{data.commit ? <> · build <code>{data.commit}</code></> : null}</> : "Loading…"}
          </small>
        </span>
      </section>

      <section className="st-card">
        <div className="st-cardhead"><b>Why “Echo”</b></div>
        <p className="ab-text">
          An echo is your own voice coming back to you. Every reel, carousel and ad the team makes goes out into the
          world, and Echo brings back what happened to it: the views, the results and the work behind it. That way the
          whole team hears how it's doing and makes the next one better. It's in the mark too: the E sends out its
          signal, and it comes back.
        </p>
      </section>

      <section className="st-card">
        <div className="st-cardhead"><b>What Echo does</b></div>
        {WHAT.map(([name, line]) => (
          <div key={name} className="st-row">
            <span className="st-label"><b>{name}</b><small>{line}</small></span>
          </div>
        ))}
      </section>

      {release && (
        <section className="st-card">
          <div className="st-cardhead">
            <span className="st-titleline"><b>What's new in {release.version}</b></span>
            <span>{day(release.date)}</span>
          </div>
          <ul className="ab-list">
            {release.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </section>
      )}

      <section className="st-card">
        <div className="st-cardhead">
          <b>Need help or access?</b>
          <span>
            {data?.superAdmins.length
              ? <>Ask {data.superAdmins.join(" or ")}, the Super Admin{data.superAdmins.length === 1 ? "" : "s"}. They set who can see and change each page.</>
              : "Ask your admin. They set who can see and change each page."}
          </span>
        </div>
      </section>
    </>
  );
}
