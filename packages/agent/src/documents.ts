// Turn an uploaded file into text per page (for provenance) and, for budgets, structured lines.
import type { BudgetLine } from "@fe/core";
import { toNumber } from "@fe/core";

export interface ReadDocument {
  pages: string[];
  budget?: BudgetLine[];
  kind: "text" | "pdf" | "docx" | "csv" | "xlsx" | "unknown";
  warnings: string[];
}

const PAGE_MARK = /^=== Page (\d+) ===\s*$/m;

export function splitPages(text: string): string[] {
  if (!PAGE_MARK.test(text)) return [text];
  const parts = text.split(/^=== Page \d+ ===\s*$/m);
  return parts.slice(1).map((p) => p.trim());
}

const CATEGORY_KEYWORDS: [string, RegExp][] = [
  ["entertainment", /\b(gala|entertainment|concert|golf|party|show tickets?)\b/i],
  ["gifts", /\b(gift|basket|souvenir)\b/i],
  ["learner-travel", /\b(attendee|learner|participant|delegate)s?\b.*\b(travel|lodging|hotel|airfare|registration)\b/i],
  ["faculty-travel", /\b(faculty|speaker)s?\b.*\b(travel|lodging|hotel|airfare)\b/i],
  ["faculty-honoraria", /\b(honorari(a|um)|speaker fees?|faculty fees?)\b/i],
  ["meals", /\b(dinner|lunch|breakfast|catering|meal|reception|coffee|refreshments)\b/i],
  ["venue", /\b(venue|room hire|meeting space|hall)\b/i],
  ["av", /\b(audio.?visual|a\/?v|av equipment|streaming|recording)\b/i],
  ["materials", /\b(print|materials|syllabus|handouts?|app)\b/i],
  ["accreditation", /\b(accreditation|cme credit|ce credit)\b/i],
  ["outcomes", /\b(outcomes?|evaluation|survey|assessment)\b/i],
  ["marketing", /\b(marketing|promotion|advertis\w*|mailing)\b/i],
  ["management-fee", /\b(management|administrative|admin|overhead|project management)\b/i],
];

export function categorizeBudgetLine(description: string): string {
  for (const [cat, re] of CATEGORY_KEYWORDS) if (re.test(description)) return cat;
  return "other";
}

/** Parse a CSV budget with a header row containing Description and Amount (Line and Category optional). */
export function parseBudgetCsv(text: string, documentId?: string, documentName?: string): BudgetLine[] {
  const rows = text.split(/\r?\n/).filter((l) => l.trim()).map(parseCsvRow);
  if (rows.length < 2) return [];
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const col = (n: string) => header.findIndex((h) => h === n || h.startsWith(n));
  const iLine = col("line"), iDesc = col("description"), iCat = col("category"), iAmt = col("amount");
  if (iDesc < 0 || iAmt < 0) return [];
  const out: BudgetLine[] = [];
  rows.slice(1).forEach((r, idx) => {
    const desc = (r[iDesc] ?? "").trim();
    const amount = toNumber(r[iAmt]);
    if (!desc || amount === undefined || /^total$/i.test(desc)) return;
    const line = iLine >= 0 ? toNumber(r[iLine]) ?? idx + 1 : idx + 1;
    const rowNum = idx + 2;
    out.push({
      line,
      description: desc,
      category: (iCat >= 0 && r[iCat]?.trim()) ? r[iCat]!.trim().toLowerCase() : categorizeBudgetLine(desc),
      amount,
      source: { kind: "document", documentId, documentName, cell: `${String.fromCharCode(65 + iAmt)}${rowNum}`, quote: `${desc}, ${r[iAmt]}` },
    });
  });
  return out;
}

function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export function budgetAsText(lines: BudgetLine[]): string {
  return ["Line,Description,Category,Amount", ...lines.map((l) => `${l.line},"${l.description}",${l.category},${l.amount}`),
    `,Total,,${lines.reduce((s, l) => s + l.amount, 0)}`].join("\n");
}

async function readPdf(buf: Buffer): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    let lastY: number | undefined;
    for (const item of content.items as { str: string; transform: number[]; hasEOL?: boolean }[]) {
      const y = item.transform[5];
      if (lastY !== undefined && y !== undefined && Math.abs(y - lastY) > 2) text += "\n";
      text += item.str;
      if (item.hasEOL) text += "\n";
      lastY = y;
    }
    pages.push(text.replace(/\n{3,}/g, "\n\n").trim());
  }
  return pages;
}

async function readXlsx(buf: Buffer, documentId?: string, documentName?: string): Promise<{ pages: string[]; budget: BudgetLine[] }> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const pages: string[] = [];
  let budget: BudgetLine[] = [];
  wb.eachSheet((ws) => {
    const rows: string[] = [];
    ws.eachRow((row) => {
      const vals = (row.values as unknown[]).slice(1).map((v) => {
        if (v && typeof v === "object" && "result" in (v as object)) return String((v as { result: unknown }).result ?? "");
        return v === null || v === undefined ? "" : String(v);
      });
      rows.push(vals.map((v) => (v.includes(",") ? `"${v}"` : v)).join(","));
    });
    const csv = rows.join("\n");
    pages.push(csv);
    if (!budget.length) budget = parseBudgetCsv(csv, documentId, documentName);
  });
  return { pages, budget };
}

export async function readDocument(buf: Buffer, name: string, mime: string, ids: { documentId?: string } = {}): Promise<ReadDocument> {
  const lower = name.toLowerCase();
  try {
    if (mime === "application/pdf" || lower.endsWith(".pdf")) return { pages: await readPdf(buf), kind: "pdf", warnings: [] };
    if (lower.endsWith(".docx") || mime.includes("wordprocessingml")) {
      const { default: mammoth } = await import("mammoth");
      const { value } = await mammoth.extractRawText({ buffer: buf });
      return { pages: [value], kind: "docx", warnings: value.trim() ? [] : ["No text was found in the Word document."] };
    }
    if (lower.endsWith(".xlsx") || mime.includes("spreadsheetml")) {
      const r = await readXlsx(buf, ids.documentId, name);
      return { ...r, kind: "xlsx", warnings: r.budget.length ? [] : ["No budget table with Description and Amount columns was found."] };
    }
    const text = buf.toString("utf8");
    if (lower.endsWith(".csv") || mime === "text/csv") {
      const budget = parseBudgetCsv(text, ids.documentId, name);
      return { pages: [text], budget, kind: "csv", warnings: budget.length ? [] : ["No budget table with Description and Amount columns was found."] };
    }
    if (mime.startsWith("text/") || /\.(md|txt|markdown)$/.test(lower)) return { pages: splitPages(text), kind: "text", warnings: [] };
    return { pages: [], kind: "unknown", warnings: [`${name} could not be read as text. A person will review it.`] };
  } catch (e) {
    return { pages: [], kind: "unknown", warnings: [`${name} could not be read: ${(e as Error).message}`] };
  }
}
