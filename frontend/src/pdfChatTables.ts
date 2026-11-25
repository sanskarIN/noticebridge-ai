/** Conservative aligned native-text table candidates. Not a ruled-grid detector. */
import { knownQuestionField, queryTerms, type Answer, type Corpus, type Passage, type Role, type TextPosition } from './pdfChatCore';
import { parsePageFilter, stripScopePhrases } from './pdfChatInsights';
import { fieldForLabel, type FieldId } from './pdfChatOverview';

const MAX_PAGE_FRAGMENTS = 512;
const MAX_TABLE_ROWS = 40;
const MAX_TABLES = 32;
const MAX_MATCHES = 8;
const Y_TOLERANCE = 2;
const X_TOLERANCE = 5;
const ROW_HEADERS = new Set(['category', 'applicant category', 'candidate category', 'application category']);
type Cell = Passage & { position: TextPosition };
type Line = Cell[];
export type CategoryTable = {
  role: Role;
  page: number;
  headers: Cell[];
  fields: FieldId[];
  rows: Line[];
};
export type TableIndex = { tables: CategoryTable[]; limited: boolean; skippedPages: number[] };
export type TableMatch = {
  role: Role; page: number;
  categoryHeader: Passage; fieldHeader: Passage; category: Passage; value: Passage;
};
export type TableAnswer = {
  matches: TableMatch[];
  total: number;
  missingRoles: Role[];
  category: string;
  field: FieldId;
};

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}
function categoryKey(text: string): string {
  return normalize(text).replace(/\s+category$/, '');
}
function validCell(passage: Passage): passage is Cell {
  const p = passage.position;
  return !!p && [p.x0, p.x1, p.y, p.height].every(Number.isFinite) &&
    p.x1 > p.x0 && p.height >= 4 && p.height <= 40 &&
    Math.abs(p.x0) < 10000 && Math.abs(p.x1) < 10000 && Math.abs(p.y) < 10000 &&
    passage.text.trim().length > 0;
}

function linesForPage(passages: Passage[]): Line[] | null {
  if (passages.length > MAX_PAGE_FRAGMENTS || !passages.every(validCell)) return null;
  const sorted = [...passages].sort((a, b) =>
    b.position.y - a.position.y || a.position.x0 - b.position.x0 || a.ordinal - b.ordinal);
  const lines: Line[] = [];
  for (const cell of sorted) {
    const last = lines.at(-1);
    if (last && Math.abs(last[0].position.y - cell.position.y) <= Y_TOLERANCE) last.push(cell);
    else lines.push([cell]);
  }
  return lines.map(line => line.sort((a, b) => a.position.x0 - b.position.x0));
}

function separated(line: Line): boolean {
  return line.every((cell, i) => i === 0 || cell.position.x0 - line[i - 1].position.x1 >= 8);
}

function headerFields(line: Line): FieldId[] | null {
  if (line.length < 2 || line.length > 4 || !separated(line) ||
      !ROW_HEADERS.has(normalize(line[0].text))) return null;
  const fields = line.slice(1).map(cell => fieldForLabel(cell.text)?.id);
  if (fields.some(field => !field) || new Set(fields).size !== fields.length) return null;
  return fields as FieldId[];
}

function fits(row: Line, header: Line): boolean {
  if (row.length !== header.length || !separated(row)) return false;
  return row.every((cell, i) =>
    Math.abs(cell.position.x0 - header[i].position.x0) <= X_TOLERANCE &&
    Math.abs(cell.position.height - header[i].position.height) <= 3 &&
    (i === row.length - 1 || cell.position.x1 <= header[i + 1].position.x0 - 8));
}

function validCategory(text: string): boolean {
  // Do not accept prose, compound sentences, or column/row footnote markers.
  return /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u.test(text) &&
    !ROW_HEADERS.has(normalize(text)) && categoryKey(text).length > 0;
}

function rowGap(previous: Line, row: Line): number {
  return previous[0].position.y - row[0].position.y;
}

function tablesOnPage(passages: Passage[]): CategoryTable[] | null {
  const lines = linesForPage(passages);
  if (!lines) return null;
  const found: CategoryTable[] = [];
  for (let i = 0; i < lines.length; i++) {
    const headers = lines[i];
    const fields = headerFields(headers);
    if (!fields) continue;
    const rows: Line[] = [];
    const keys = new Set<string>();
    let spacing: number | null = null;
    let previous = headers;
    let ambiguous = false;
    for (let j = i + 1; j < lines.length; j++) {
      const row = lines[j];
      const gap = rowGap(previous, row);
      const height = Math.max(...headers.map(cell => cell.position.height));
      if (gap > Math.max(48, height * 3.5)) break;
      if (headerFields(row)) break;
      if (gap < height * 1.1 || !fits(row, headers) || !validCategory(row[0].text) ||
          row.slice(1).some(cell => cell.text.length > 300 || fieldForLabel(cell.text)) ||
          (spacing !== null && Math.abs(gap - spacing) > Math.max(3, spacing * 0.15))) {
        // A nearby incomplete, merged, misaligned or wrapped row makes
        // the entire candidate table ambiguous, rather than a shorter table.
        ambiguous = true;
        break;
      }
      const key = categoryKey(row[0].text);
      if (keys.has(key) || rows.length >= MAX_TABLE_ROWS) {
        ambiguous = true;
        break;
      }
      keys.add(key);
      rows.push(row);
      previous = row;
      spacing ??= gap;
    }
    if (ambiguous || rows.length < 2) continue;
    found.push({ role: headers[0].role, page: headers[0].page, headers, fields, rows });
    i += rows.length;
  }
  return found;
}

export function buildCategoryTables(corpus: Corpus): TableIndex {
  const byPage = new Map<number, Passage[]>();
  const skippedPages: number[] = [];
  const tables: CategoryTable[] = [];
  let limited = false;
  for (const passage of corpus.passages) {
    const group = byPage.get(passage.page) ?? [];
    group.push(passage);
    byPage.set(passage.page, group);
  }
  for (const [page, rows] of [...byPage].sort(([a], [b]) => a - b)) {
    if (corpus.limitedPages.includes(page) || rows.some(row => row.role !== rows[0].role)) {
      skippedPages.push(page);
      continue;
    }
    const detected = tablesOnPage(rows);
    if (!detected) {
      skippedPages.push(page);
      continue;
    }
    for (const table of detected) {
      if (tables.length >= MAX_TABLES) {
        limited = true;
        break;
      }
      tables.push(table);
    }
  }
  return { tables, skippedPages, limited };
}

/** Explicit single field + exact category. No fuzzy category matching,
 * numeric calculations, or inference from cells in a different row.
 */
export function tableQuestion(answer: Pick<Answer, 'question' | 'pageFilter'>): { field: FieldId; category: string } | null {
  // Remove only explicit source-phrase prepositions. Leaving a dangling
  // "in" after "General category in the original notice" would turn it
  // into a different category. Never remove arbitrary category words.
  const sourceNeutral = answer.question
    .replace(/\b(?:in|from|of|on)\s+(?:the\s+)?(?:original|previous|earlier|first|updated|revised|second)\s+(?:pdf|notice|document|version)\b/gi, ' ')
    .replace(/\b(?:in|from|of|on)\s+(?:the\s+)?both\s+(?:pdfs?|notices?|documents?|versions?)\b/gi, ' ');
  const { content, page } = parsePageFilter(stripScopePhrases(sourceNeutral));
  if (page !== answer.pageFilter) return null;
  const clean = content.replace(/[?]+$/, '').trim();
  const match = /^(.+?)\s+for\s+(.+)$/i.exec(clean);
  if (!match) return null;
  const field = knownQuestionField(queryTerms(match[1]));
  const raw = match[2].trim();
  if (!field || !validCategory(raw) || /\b(?:and|or|except|not|without|with|before|after|under|over)\b/i.test(raw)) return null;
  const category = categoryKey(raw);
  return category ? { field, category } : null;
}

export function answerCategoryTable(tables: readonly CategoryTable[], answer: Answer): TableAnswer | null {
  const query = tableQuestion(answer);
  if (!query) return null;
  const roles: Role[] = answer.scope === 'both' ? ['original', 'revised'] : [answer.scope];
  const matches: TableMatch[] = [];
  const missingRoles: Role[] = [];
  let total = 0;
  for (const role of roles) {
    let count = 0;
    for (const table of tables) {
      if (table.role !== role || (answer.pageFilter !== undefined && table.page !== answer.pageFilter)) continue;
      const column = table.fields.indexOf(query.field) + 1;
      if (!column) continue;
      for (const row of table.rows) {
        if (categoryKey(row[0].text) !== query.category) continue;
        count++;
        total++;
        // Reserve a separate display budget for each requested source.
        if (count <= MAX_MATCHES) matches.push({
          role, page: table.page, categoryHeader: table.headers[0],
          fieldHeader: table.headers[column], category: row[0], value: row[column],
        });
      }
    }
    if (!count) missingRoles.push(role);
  }
  if (!total) return null;
  return { ...query, matches, total, missingRoles };
}


/** Prefill a question only if it round-trips through the same conservative
 * grammar to the exact field and category. The caller selects the source.
 */
export function tableCellQuestion(table: CategoryTable, row: number, column: number): string | null {
  if (!Number.isInteger(row) || !Number.isInteger(column) ||
      row < 0 || row >= table.rows.length || column < 1 || column >= table.headers.length) return null;
  const question = table.headers[column].text + ' for ' + table.rows[row][0].text + ' on page ' + table.page + '?';
  if (question.length > 400) return null;
  const parsed = tableQuestion({ question, pageFilter: table.page });
  return parsed?.field === table.fields[column - 1] && parsed.category === categoryKey(table.rows[row][0].text)
    ? question : null;
}
