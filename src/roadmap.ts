/**
 * ROADMAP.md to the HTML fragment of /roadmap (SPEC 3.7). Owned by the api builder. api.ts reads
 * ROADMAP.md once at start, renders it, and fills {{content}} in web/templates/roadmap.html.
 *
 * No dependency: a small markdown subset (headings, lists, checkboxes, inline code, links, bold,
 * paragraphs), everything HTML-escaped before any tag is added.
 */

export type RoadmapStatus = "planned" | "in progress" | "live" | "dropped";
export const ROADMAP_STATUSES: readonly RoadmapStatus[] = ["planned", "in progress", "live", "dropped"];

export type RoadmapItem = {
  n: string;
  title: string;
  status: RoadmapStatus;
  /** Date for live items, reason for dropped ones, null otherwise. */
  statusDetail: string | null;
  /** Paragraph lines before and between the lists, markdown inline. */
  notes: string[];
  tasks: Array<{ done: boolean; text: string }>;
  /** Plain bullet points that are not checkboxes. */
  bullets: string[];
  /** The "Done when:" sentence without the label, null when the item has none. */
  doneWhen: string | null;
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Inline markdown on already-escaped text: code, links, bold, italics. */
export function renderInline(raw: string): string {
  let s = escapeHtml(raw);
  // Code first so nothing inside a span is touched by the other rules.
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, (_, text: string, href: string) => {
    const external = /^https?:/.test(href);
    return `<a href="${href}"${external ? ' rel="noopener"' : ""}>${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:]|$)/g, "$1<em>$2</em>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
  return s;
}

const statusClass = (s: RoadmapStatus): string => s.replace(/\s+/g, "-");

/** "Status: live 2026-09-12" / "Status: dropped, nobody asked" / "Status: in progress". */
export function parseStatus(line: string): { status: RoadmapStatus; detail: string | null } {
  const raw = line.replace(/^\s*\**status\**\s*:\s*/i, "").trim();
  const lower = raw.toLowerCase();
  for (const s of ["in progress", "planned", "live", "dropped"] as const) {
    if (lower.startsWith(s)) {
      let rest = raw.slice(s.length).trim();
      rest = rest.replace(/^[\s,:;(\-]+/, "").replace(/[)\s.]+$/, "").trim();
      return { status: s, detail: rest || null };
    }
  }
  return { status: "planned", detail: null };
}

/** Sections "## N. Title", skipping Operations (SPEC 3.7). */
export function parseRoadmap(markdown: string): RoadmapItem[] {
  const items: RoadmapItem[] = [];
  let cur: RoadmapItem | null = null;
  let skipping = false;

  for (const line of markdown.split(/\r?\n/)) {
    const h = /^##\s+(\d+)\.\s+(.+?)\s*$/.exec(line);
    if (h) {
      const [, n, title] = h;
      if (/^operations\b/i.test(title) || /not shown on the site/i.test(title)) {
        skipping = true;
        cur = null;
        continue;
      }
      skipping = false;
      cur = { n, title, status: "planned", statusDetail: null, notes: [], tasks: [], bullets: [], doneWhen: null };
      items.push(cur);
      continue;
    }
    if (/^#/.test(line)) { // any other heading ends the current section
      cur = null;
      skipping = true;
      continue;
    }
    if (skipping || !cur) continue;
    const t = line.trim();
    if (!t) continue;

    if (/^\**status\**\s*:/i.test(t)) {
      const { status, detail } = parseStatus(t);
      cur.status = status;
      cur.statusDetail = detail;
      continue;
    }
    const box = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(t);
    if (box) {
      cur.tasks.push({ done: box[1] !== " ", text: box[2] });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(t);
    if (bullet) {
      cur.bullets.push(bullet[1]);
      continue;
    }
    // A paragraph. "Done when:" may sit alone or at the end of a "Needs: ..." line.
    const dw = /(?:^|\s)Done when:\s*(.+)$/.exec(t);
    if (dw) {
      cur.doneWhen = dw[1].trim();
      const before = t.slice(0, t.length - dw[0].length).trim();
      if (before) cur.notes.push(before);
      continue;
    }
    cur.notes.push(t);
  }
  return items;
}

function renderItem(it: RoadmapItem): string {
  const cls = statusClass(it.status);
  let pill = escapeHtml(it.status);
  let pillAttrs = "";
  if (it.status === "live" && it.statusDetail) {
    const d = it.statusDetail;
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(d) ? ` datetime="${d}"` : "";
    pill = `live <time${iso}>${escapeHtml(d)}</time>`;
  } else if (it.status === "dropped" && it.statusDetail) {
    pillAttrs = ` title="${escapeHtml(it.statusDetail)}"`;
  }
  const out: string[] = [];
  out.push(`<li class="item status-${cls}" id="item-${escapeHtml(it.n)}">`);
  out.push(`<h2><span class="n">${escapeHtml(it.n)}</span> ${renderInline(it.title)} <span class="pill"${pillAttrs}>${pill}</span></h2>`);
  for (const n of it.notes) out.push(`<p class="note">${renderInline(n)}</p>`);
  if (it.tasks.length) {
    out.push(`<ul class="tasks">`);
    for (const t of it.tasks) out.push(`<li class="${t.done ? "done" : "todo"}">${renderInline(t.text)}</li>`);
    out.push(`</ul>`);
  }
  if (it.bullets.length) {
    out.push(`<ul class="list">`);
    for (const b of it.bullets) out.push(`<li>${renderInline(b)}</li>`);
    out.push(`</ul>`);
  }
  if (it.doneWhen) out.push(`<p class="done-when">Done when: ${renderInline(it.doneWhen)}</p>`);
  out.push(`</li>`);
  return out.join("\n");
}

/**
 * Every "## N. Title" section except Operations, in order, each with its status pill from the
 * "Status:" line (live and dropped keep the rest of the line: date or reason), its checklist as a
 * list, and the "Done when:" sentence. Output is a fragment (no <html>), classes documented in
 * docs/api.md under /roadmap.
 */
export function renderRoadmap(markdown: string): string {
  const items = parseRoadmap(markdown);
  return `<ol class="roadmap">\n${items.map(renderItem).join("\n")}\n</ol>`;
}

/**
 * The generic subset renderer, for any other markdown the site may show: ATX headings, bullet and
 * numbered lists, checkboxes, paragraphs, with the inline rules above. Blank lines split blocks.
 */
export function renderMarkdown(markdown: string): string {
  const out: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length) out.push(`<p>${para.map(renderInline).join(" ")}</p>`);
    para = [];
  };
  const flushList = (): void => {
    if (list) out.push(`<${list.tag}>\n${list.items.join("\n")}\n</${list.tag}>`);
    list = null;
  };

  for (const line of markdown.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) { flushPara(); flushList(); continue; }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(t);
    if (h) {
      flushPara(); flushList();
      out.push(`<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`);
      continue;
    }
    const box = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(t);
    const bullet = box ? null : /^[-*]\s+(.*)$/.exec(t);
    const numbered = box || bullet ? null : /^\d+[.)]\s+(.*)$/.exec(t);
    if (box || bullet || numbered) {
      flushPara();
      const tag = numbered ? "ol" : "ul";
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      if (box) list.items.push(`<li class="${box[1] !== " " ? "done" : "todo"}">${renderInline(box[2])}</li>`);
      else list.items.push(`<li>${renderInline((bullet ?? numbered as RegExpExecArray)[1])}</li>`);
      continue;
    }
    flushList();
    para.push(t);
  }
  flushPara(); flushList();
  return out.join("\n");
}
