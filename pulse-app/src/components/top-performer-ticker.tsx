import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useEditors } from "@/lib/use-editors";
import { useTasks } from "@/lib/use-tasks";
import { ymd, topEditorsInRange } from "@/lib/task-points";
import { Avatar, ringColorOf } from "@/lib/editor-visuals";

// Top Performer of the Month — a full-width, continuously-scrolling ticker at the
// top of My Day celebrating the month's leading editors. It reuses the exact
// Task Points aggregation the Media House Leaders board scores by (top 5 for the
// current calendar month), so it never recomputes or disagrees with the board.

const TOP_N = 5;
const SPEED = 55; // px/sec — the marquee crawls at a constant speed regardless of width.
const RANK_MEDAL: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };
const GOLD = "#f5b301";

function monthStartStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export function TopPerformerTicker() {
  const { editors } = useEditors();
  const { tasks } = useTasks();

  // Respect a reader's reduced-motion preference — with it on we drop the scroll
  // animation entirely and render a plain, static row (a real accessibility
  // requirement, not decoration). Tracked live so toggling the OS setting works.
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const leaders = useMemo(() => {
    if (!editors || !tasks) return [];
    const today = ymd(new Date());
    return topEditorsInRange(editors, tasks, monthStartStr(), today, TOP_N)
      .map((r) => ({ row: r, editor: editors.find((e) => e.id === r.editorId) }))
      .filter((x): x is { row: typeof x.row; editor: NonNullable<typeof x.editor> } => !!x.editor);
  }, [editors, tasks]);

  // Only scroll when the row is actually wider than its viewport. When it fits
  // (a handful of editors, or a wide screen) we render it statically — no point
  // animating, and it sidesteps the gap a narrow loop would show. When it does
  // overflow, duration scales with width so the crawl speed stays constant; the
  // track then holds two copies and translates by exactly one copy (-50%) for a
  // seamless loop.
  const viewportRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [duration, setDuration] = useState(30);
  useLayoutEffect(() => {
    const vp = viewportRef.current;
    const copy = copyRef.current;
    if (!vp || !copy) return;
    const measure = () => {
      const copyWidth = copy.scrollWidth;
      const over = copyWidth > vp.clientWidth + 4;
      setOverflow(over);
      if (over && copyWidth > 0) setDuration(copyWidth / SPEED);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(vp);
    ro.observe(copy);
    return () => ro.disconnect();
  }, [leaders]);

  // Nothing to celebrate yet this month — render nothing at all (no empty shell).
  if (leaders.length === 0) return null;

  const animate = overflow && !reduced;

  const card = (l: (typeof leaders)[number], rank: number, key: string) => {
    const gold = rank === 1;
    const ring = gold ? GOLD : ringColorOf(editors ?? [], l.editor.id);
    return (
      <Link
        key={key}
        to="/leaderboard"
        className={"tpf-card" + (gold ? " tpf-card--gold" : "")}
        style={{ ["--ring" as string]: ring }}
      >
        <span className="tpf-rank">{RANK_MEDAL[rank] ?? `#${rank}`}</span>
        <span className="tpf-ava"><Avatar editor={l.editor} /></span>
        <span className="tpf-meta">
          <span className="tpf-name">{l.editor.name}</span>
          <span className="tpf-pts">{Math.round(l.row.points).toLocaleString()} pts</span>
        </span>
      </Link>
    );
  };

  const copy = (tag: string, hidden: boolean) => (
    <div className="tpf-copy" ref={tag === "a" ? copyRef : undefined} aria-hidden={hidden || undefined}>
      {leaders.map((l, i) => card(l, i + 1, tag + l.editor.id))}
    </div>
  );

  return (
    <div className="tpf" aria-label="Top performers this month">
      <Link to="/leaderboard" className="tpf-label">
        <span className="tpf-trophy" aria-hidden>🏆</span>
        <span className="tpf-label-txt">Top Performer<span className="tpf-label-sub">This Month</span></span>
      </Link>
      <div className="tpf-viewport" ref={viewportRef}>
        <div
          className={"tpf-track" + (animate ? " tpf-track--scroll" : "")}
          style={animate ? { animationDuration: `${duration}s` } : undefined}
        >
          {copy("a", false)}
          {/* Second copy makes the -50% loop seamless; only present while scrolling. */}
          {animate && copy("b", true)}
        </div>
      </div>
      <Link to="/leaderboard" className="tpf-more" aria-label="View the full leaderboard">→</Link>
    </div>
  );
}
