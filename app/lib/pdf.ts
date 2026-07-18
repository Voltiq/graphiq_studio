// PDF export — TODO §9 "PDF export (flattened, with DPI/paper size)".
//
// A hand-written, dependency-free single-page PDF 1.4 writer: the flattened
// composite goes in as ONE image XObject — either the untouched JPEG bytes
// (/DCTDecode — small, lossy) or zlib-deflated raw RGB (/FlateDecode —
// lossless, larger) — drawn by a tiny content stream onto a page sized either
// to the image at a chosen DPI or to a standard paper size with margins
// (fit-to-margins or actual-size-at-DPI, centred). Info dictionary carries
// Title/Author/Creator/Producer/CreationDate (Unicode via UTF-16BE hex
// strings). Pure byte assembly + layout math here (Node-verifiable); the
// dialog owns canvas flattening and JPEG encoding.

/* ------------------------------- layout math ------------------------------- */

export interface PaperSize {
  id: string;
  label: string;
  /** Portrait dimensions in PostScript points (1 pt = 1/72 in). */
  wPt: number;
  hPt: number;
}

export const PAPER_SIZES: PaperSize[] = [
  { id: "a4", label: "A4", wPt: 595.28, hPt: 841.89 },
  { id: "letter", label: "Letter", wPt: 612, hPt: 792 },
  { id: "legal", label: "Legal", wPt: 612, hPt: 1008 },
  { id: "a3", label: "A3", wPt: 841.89, hPt: 1190.55 },
  { id: "a5", label: "A5", wPt: 419.53, hPt: 595.28 },
];

export const MM_TO_PT = 72 / 25.4;

export interface PdfLayoutOptions {
  mode: "image" | "paper";
  /** px → pt scale for image mode and paper actual-size placement. */
  dpi: number;
  /** Paper mode only. */
  paper?: PaperSize;
  landscape?: boolean;
  marginMm?: number;
  /** Paper mode: scale to the margin box (true) or place at DPI size (false). */
  fit?: boolean;
}

export interface PdfLayout {
  pageW: number;
  pageH: number;
  /** Image draw rect in PDF coordinates (origin bottom-left). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Actual-size placement overflows the printable area (dialog warns). */
  overflow: boolean;
}

/** Compute the page size and centred image rect (all in points). */
export function layoutPage(pxW: number, pxH: number, o: PdfLayoutOptions): PdfLayout {
  const dpi = o.dpi > 0 ? o.dpi : 300;
  const iw = (pxW * 72) / dpi;
  const ih = (pxH * 72) / dpi;
  if (o.mode === "image") {
    return { pageW: iw, pageH: ih, x: 0, y: 0, w: iw, h: ih, overflow: false };
  }
  const paper = o.paper ?? PAPER_SIZES[0];
  const pageW = o.landscape ? paper.hPt : paper.wPt;
  const pageH = o.landscape ? paper.wPt : paper.hPt;
  const margin = Math.max(0, o.marginMm ?? 10) * MM_TO_PT;
  const availW = Math.max(1, pageW - 2 * margin);
  const availH = Math.max(1, pageH - 2 * margin);
  let w = iw;
  let h = ih;
  if (o.fit !== false) {
    const s = Math.min(availW / iw, availH / ih);
    w = iw * s;
    h = ih * s;
  }
  return {
    pageW,
    pageH,
    x: (pageW - w) / 2,
    y: (pageH - h) / 2,
    w,
    h,
    overflow: w > availW + 0.01 || h > availH + 0.01,
  };
}

/* ------------------------------- PDF assembly ------------------------------ */

export interface PdfImage {
  /** JPEG file bytes (kind "jpeg") or raw un-deflated RGB triplets ("rgb"). */
  data: Uint8Array;
  kind: "jpeg" | "rgb";
  pxW: number;
  pxH: number;
}

export interface PdfInfo {
  title?: string;
  author?: string;
  /** Defaults to now; injectable for deterministic tests. */
  date?: Date;
}

const te = new TextEncoder();

/** PDF string: literal with escapes for ASCII, UTF-16BE hex for anything else. */
export function pdfString(s: string): string {
  let ascii = true;
  for (const ch of s) if (ch.codePointAt(0)! > 126) ascii = false;
  if (ascii) return `(${s.replace(/[\\()]/g, (m) => `\\${m}`)})`;
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return `<${hex}>`;
}

const fmt = (n: number): string => {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
};

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const ao = Math.abs(off);
  return (
    `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(ao / 60))}'${p(ao % 60)}'`
  );
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Assemble a single-page PDF: the image XObject drawn into the given layout.
 * Objects: 1 Catalog, 2 Pages, 3 Page, 4 image, 5 contents, 6 Info.
 */
export async function buildPdf(img: PdfImage, layout: PdfLayout, info: PdfInfo): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (b: Uint8Array | string) => {
    const bytes = typeof b === "string" ? te.encode(b) : b;
    chunks.push(bytes);
    pos += bytes.length;
  };
  const beginObj = (n: number) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n`);
  };

  push("%PDF-1.4\n%âãÏÓ\n"); // binary-comment line per spec

  beginObj(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  beginObj(2);
  push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  beginObj(3);
  push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(layout.pageW)} ${fmt(layout.pageH)}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
  );

  const isJpeg = img.kind === "jpeg";
  const data = isJpeg ? img.data : await deflate(img.data);
  beginObj(4);
  push(
    `<< /Type /XObject /Subtype /Image /Width ${img.pxW} /Height ${img.pxH} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
      `/Filter /${isJpeg ? "DCTDecode" : "FlateDecode"} /Length ${data.length} >>\nstream\n`,
  );
  push(data);
  push("\nendstream\nendobj\n");

  const content = `q\n${fmt(layout.w)} 0 0 ${fmt(layout.h)} ${fmt(layout.x)} ${fmt(layout.y)} cm\n/Im0 Do\nQ\n`;
  beginObj(5);
  push(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);

  beginObj(6);
  const parts = [
    info.title ? `/Title ${pdfString(info.title)}` : "",
    info.author ? `/Author ${pdfString(info.author)}` : "",
    `/Creator ${pdfString("Graphiq Studio")}`,
    `/Producer ${pdfString("Graphiq Studio")}`,
    `/CreationDate (${pdfDate(info.date ?? new Date())})`,
  ].filter(Boolean);
  push(`<< ${parts.join(" ")} >>\nendobj\n`);

  const xrefAt = pos;
  let xref = "xref\n0 7\n0000000000 65535 f \n";
  for (let i = 1; i <= 6; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(pos);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out as Uint8Array<ArrayBuffer>;
}
