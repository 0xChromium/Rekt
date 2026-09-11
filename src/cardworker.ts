import { parentPort } from "node:worker_threads";
import { renderCard } from "./card.ts";
import { renderOgCard, type OgInput } from "./ogcard.ts";
import type { Report } from "./types.ts";

/**
 * The printer, off the API's event loop: satori lays out and resvg rasterises synchronously,
 * seconds of CPU per image, which would freeze the board and every other request if it ran
 * on the main thread. It prints boarding passes and the link preview alike; api.ts keeps one
 * of these and feeds it one job at a time from a bounded queue. Fonts are read once per worker.
 *
 * The link preview used to be rendered on the main thread because it is "just one image every
 * five minutes". At boot, beside two workers scanning the record, that one image took forty
 * seconds, and for forty seconds after every deploy the site answered nothing.
 */

export type CardJob =
  | { id: number; report: Report; nowTs?: number }
  | { id: number; kind: "og"; input: OgInput };
export type CardReply = { id: number; png?: Uint8Array; error?: string };

const port = parentPort;
if (!port) throw new Error("cardworker runs as a worker thread");

port.on("message", (job: CardJob) => {
  const work = "input" in job ? renderOgCard(job.input) : renderCard(job.report, job.nowTs);
  work.then(
    (png) => port.postMessage({ id: job.id, png } satisfies CardReply),
    (err) => port.postMessage({ id: job.id, error: String((err as Error)?.message ?? err) } satisfies CardReply),
  );
});
