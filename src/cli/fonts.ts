import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fetches the static TTFs the boarding pass is set in (SPEC 3.3) into assets/fonts.
 * Static faces, not the variable ones: satori reads static TTF/OTF only. The files come from the
 * google/fonts repository (OFL). Idempotent: a file that exists and is not empty is left alone.
 * Run: npm run fonts
 */

export const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "fonts");

const BASE = "https://raw.githubusercontent.com/google/fonts/main/ofl";

/** Family directory in google/fonts, file name, and the weight the file carries. */
export const FONT_FILES: ReadonlyArray<{ dir: string; file: string; family: string; weight: number }> = [
  { dir: "barlowcondensed", file: "BarlowCondensed-Bold.ttf", family: "Barlow Condensed", weight: 700 },
  { dir: "barlowcondensed", file: "BarlowCondensed-ExtraBold.ttf", family: "Barlow Condensed", weight: 800 },
  { dir: "barlowsemicondensed", file: "BarlowSemiCondensed-Medium.ttf", family: "Barlow Semi Condensed", weight: 500 },
  { dir: "barlowsemicondensed", file: "BarlowSemiCondensed-SemiBold.ttf", family: "Barlow Semi Condensed", weight: 600 },
  { dir: "barlowsemicondensed", file: "BarlowSemiCondensed-Bold.ttf", family: "Barlow Semi Condensed", weight: 700 },
  { dir: "ibmplexmono", file: "IBMPlexMono-Regular.ttf", family: "IBM Plex Mono", weight: 400 },
  { dir: "ibmplexmono", file: "IBMPlexMono-Medium.ttf", family: "IBM Plex Mono", weight: 500 },
  { dir: "ibmplexmono", file: "IBMPlexMono-SemiBold.ttf", family: "IBM Plex Mono", weight: 600 },
];

const present = (path: string): boolean => existsSync(path) && statSync(path).size > 0;

export async function fetchFonts(dir: string = FONT_DIR): Promise<{ fetched: number; kept: number }> {
  mkdirSync(dir, { recursive: true });
  let fetched = 0, kept = 0;
  for (const f of FONT_FILES) {
    const out = join(dir, f.file);
    if (present(out)) { kept++; continue; }
    const url = `${BASE}/${f.dir}/${f.file}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // A TTF starts with 0x00010000 (or "true"); anything else is an error page, not a font.
    const magic = (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0;
    if (bytes.length < 1024 || (magic !== 0x00010000 && magic !== 0x74727565)) {
      throw new Error(`${url}: not a TrueType file (${bytes.length} bytes)`);
    }
    writeFileSync(out, bytes);
    fetched++;
    console.log(`fetched ${f.file} (${(bytes.length / 1024).toFixed(0)} KB)`);
  }
  return { fetched, kept };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await fetchFonts();
  console.log(`fonts: ${r.fetched} fetched, ${r.kept} already present, in ${FONT_DIR}`);
}
