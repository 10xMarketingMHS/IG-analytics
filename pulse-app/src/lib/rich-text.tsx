import type { ReactNode } from "react";

// Knowledge Hub pages: plain text with a few marks, turned into React elements —
// never HTML — so nothing pasted into a page can run.
//   # Heading    ## Smaller heading    ### Smallest
//   - item  (or * item)      1. a numbered step
//   **bold**    *italic*    [name](https://…)    a bare https://… address
//   a blank line starts a new paragraph; a single line break stays one
// Links open only http:// and https:// addresses, in a new tab.
export const RICH_TEXT_HELP = "# Heading · - list · 1. steps · **bold** · *italic* · [name](https://…)";

function inline(text: string, key: string): ReactNode[] {
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|(https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"])/gi;
  const out: ReactNode[] = [];
  let last = 0, i = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}.${i++}`;
    if (m[1] !== undefined) out.push(<a key={k} href={m[2]} target="_blank" rel="noopener noreferrer">{m[1]}</a>);
    else if (m[3] !== undefined) out.push(<strong key={k}>{inline(m[3], k)}</strong>);
    else if (m[4] !== undefined) out.push(<em key={k}>{m[4]}</em>);
    else out.push(<a key={k} href={m[5]} target="_blank" rel="noopener noreferrer">{m[5]}</a>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const key = () => `b${blocks.length}`;
  const endPara = () => {
    if (!para.length) return;
    const k = key();
    blocks.push(<p key={k}>{para.flatMap((l, n) => (n ? [<br key={`${k}br${n}`} />, ...inline(l, `${k}.${n}`)] : inline(l, `${k}.${n}`)))}</p>);
    para = [];
  };
  const endList = () => {
    if (!list) return;
    const k = key();
    const items = list.items.map((it, n) => <li key={n}>{inline(it, `${k}.${n}`)}</li>);
    blocks.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
    list = null;
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { endPara(); endList(); continue; }
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    const ul = /^\s*[-*•]\s+(.+)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (h) {
      endPara(); endList();
      const k = key(), body = inline(h[2], k);
      blocks.push(h[1].length === 1 ? <h2 key={k}>{body}</h2> : h[1].length === 2 ? <h3 key={k}>{body}</h3> : <h4 key={k}>{body}</h4>);
    } else if (ul || ol) {
      endPara();
      const ordered = !ul;
      if (list && list.ordered !== ordered) endList();
      if (!list) list = { ordered, items: [] };
      list.items.push((ul ?? ol)![1]);
    } else {
      endList();
      para.push(line);
    }
  }
  endPara(); endList();
  return <div className={"rt" + (className ? " " + className : "")}>{blocks}</div>;
}
