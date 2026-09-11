import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseRoadmap, parseStatus, renderInline, renderMarkdown, renderRoadmap } from "./roadmap.ts";

const SAMPLE = `# Title

Intro paragraph that is not an item.

## 0. On-chain split
Status: in progress
Only if the contracts did not ship on day one.
- [ ] \`FeeSplitter\` v2 with permissionless \`harvest()\`
- [x] Foundry fork tests
Needs: one transaction. Effort: five hours. Done when: the desk page shows a live reward stream.

## 1. History
Status: live 2026-09-12
- [x] Extend fold
Done when: the cursor reaches the first block.

## 2. Versus
Status: dropped, nobody asked for it
- A plain bullet with a [link](https://example.com/x) and <b>markup</b>
Done when: never.

## 3. Lounge
- [ ] X-handle linking

## 4. Operations (not shown on the site)
- [ ] Second RPC
Done when: an outage does not stop the board.
`;

describe("parseRoadmap", () => {
  it("reads every numbered section except Operations, in order", () => {
    const items = parseRoadmap(SAMPLE);
    assert.deepEqual(items.map((i) => i.n), ["0", "1", "2", "3"]);
    assert.equal(items[0].title, "On-chain split");
  });

  it("splits status, tasks, notes and the done-when sentence", () => {
    const [split] = parseRoadmap(SAMPLE);
    assert.equal(split.status, "in progress");
    assert.equal(split.statusDetail, null);
    assert.deepEqual(split.tasks.map((t) => t.done), [false, true]);
    assert.equal(split.doneWhen, "the desk page shows a live reward stream.");
    assert.deepEqual(split.notes, [
      "Only if the contracts did not ship on day one.",
      "Needs: one transaction. Effort: five hours.",
    ]);
  });

  it("keeps the date of a live item and the reason of a dropped one", () => {
    const items = parseRoadmap(SAMPLE);
    assert.equal(items[1].status, "live");
    assert.equal(items[1].statusDetail, "2026-09-12");
    assert.equal(items[2].status, "dropped");
    assert.equal(items[2].statusDetail, "nobody asked for it");
    assert.equal(items[3].status, "planned");
  });

  it("parseStatus tolerates punctuation and case", () => {
    assert.deepEqual(parseStatus("Status: Live (2026-10-01)"), { status: "live", detail: "2026-10-01" });
    assert.deepEqual(parseStatus("**Status:** planned"), { status: "planned", detail: null });
    assert.deepEqual(parseStatus("Status: dropped: superseded by item 4."), { status: "dropped", detail: "superseded by item 4" });
    assert.deepEqual(parseStatus("Status: whatever"), { status: "planned", detail: null });
  });
});

describe("renderRoadmap", () => {
  const html = renderRoadmap(SAMPLE);

  it("emits the documented structure and classes", () => {
    assert.ok(html.startsWith('<ol class="roadmap">'));
    assert.ok(html.includes('<li class="item status-in-progress" id="item-0">'));
    assert.ok(html.includes('<h2><span class="n">0</span> On-chain split <span class="pill">in progress</span></h2>'));
    assert.ok(html.includes('<ul class="tasks">'));
    assert.ok(html.includes('<li class="todo"><code>FeeSplitter</code> v2 with permissionless <code>harvest()</code></li>'));
    assert.ok(html.includes('<li class="done">Foundry fork tests</li>'));
    assert.ok(html.includes('<p class="done-when">Done when: the desk page shows a live reward stream.</p>'));
    assert.ok(html.includes('<p class="note">Needs: one transaction. Effort: five hours.</p>'));
  });

  it("puts the date in a <time> for live items and the reason in the pill title for dropped ones", () => {
    assert.ok(html.includes('<span class="pill">live <time datetime="2026-09-12">2026-09-12</time></span>'));
    assert.ok(html.includes('<li class="item status-dropped" id="item-2">'));
    assert.ok(html.includes('<span class="pill" title="nobody asked for it">dropped</span>'));
  });

  it("escapes HTML and renders links and bullets", () => {
    assert.ok(html.includes("&lt;b&gt;markup&lt;/b&gt;"));
    assert.ok(!html.includes("<b>markup</b>"));
    assert.ok(html.includes('<a href="https://example.com/x" rel="noopener">link</a>'));
    assert.ok(html.includes('<ul class="list">'));
  });

  it("leaves the Operations section out", () => {
    assert.ok(!html.includes("Second RPC"));
    assert.ok(!html.includes("Operations"));
  });

  it("renders the real ROADMAP.md with item 0 first and no Operations", () => {
    const real = renderRoadmap(readFileSync(new URL("../ROADMAP.md", import.meta.url), "utf8"));
    assert.ok(real.includes('id="item-0"'));
    assert.ok(real.indexOf('id="item-0"') < real.indexOf('id="item-1"'));
    assert.ok(!/Operations/.test(real));
    assert.ok(/status-(planned|in-progress|live|dropped)/.test(real));
  });
});

describe("renderInline and renderMarkdown", () => {
  it("does not confuse numbers in prose with code placeholders", () => {
    assert.equal(renderInline("about 5 hours and `x` then 7 more"), "about 5 hours and <code>x</code> then 7 more");
  });

  it("renders bold, italics, code and links on escaped text", () => {
    assert.equal(renderInline("**b** *i* `<c>` [t](/p)"), '<strong>b</strong> <em>i</em> <code>&lt;c&gt;</code> <a href="/p">t</a>');
  });

  it("renders headings, lists, checkboxes and paragraphs", () => {
    const out = renderMarkdown("# H\n\nA line\nsame paragraph\n\n- one\n- [x] two\n\n1. first\n2. second\n");
    assert.equal(out, [
      "<h1>H</h1>",
      "<p>A line same paragraph</p>",
      "<ul>\n<li>one</li>\n<li class=\"done\">two</li>\n</ul>",
      "<ol>\n<li>first</li>\n<li>second</li>\n</ol>",
    ].join("\n"));
  });
});
