/** Bounded outline candidates based only on printed section-like markers.
 * Extraction order is not certified logical or visual document structure.
 */
import { MAX_PASSAGES, MAX_PASSAGE_CHARS, type Passage, type Role, type Corpus, type Scope } from './pdfChatCore';
import { referencesIn, literalRanges, type Reference } from './pdfChatEvidenceExplorer';
import { passageId } from './pdfChatResearch';
import { fieldDefinitions } from './pdfChatOverview';
import type { ChatCorpora } from './pdfChatEvidenceReport';

export const OUTLINE_PAGE_SIZE = 12;
export const SECTION_FRAGMENT_PAGE_SIZE = 16;
export const MAX_SECTION_FILTER_CHARS = 120;
export const MAX_SECTION_COMPARISON_FRAGMENTS = 160;
export const MAX_SECTION_COMPARISON_CHARS = 100_000;
const ROLES: Role[] = ['original', 'revised'];
const named = new Set<string>([
  'important dates', 'application procedure', 'application process', 'how to apply',
  'instructions', 'general instructions', 'important instructions', 'important information',
  'documents required', 'required documents', 'terms and conditions', 'eligibility criteria',
  'selection procedure', 'selection process', 'payment instructions', 'fee details',
  'contact details', 'contact information', 'examination schedule', 'exam schedule',
  'reservation policy', 'age relaxation', 'correction window', 'document verification',
  'admit card', 'results', 'vacancy details', 'exceptions and exemptions',
  ...fieldDefinitions.map(field => field.label.toLowerCase()),
]);

export type OutlineHeading =
  | { kind: 'reference'; reference: Reference; title: string; key: string }
  | { kind: 'numbered'; number: string; title: string; key: string }
  | { kind: 'named'; title: string; key: string };
export type OutlineSection = {
  id: string;
  heading: OutlineHeading;
  source: Passage;
  fragments: Passage[];
  firstPage: number;
  lastPage: number;
  ordinalGaps: number;
  uncertainPages: number[];
};
export type OutlineSide = {
  role: Role;
  sections: OutlineSection[];
  beforeFirst: Passage[];
  nativeFragments: number;
  processedPages: number;
  physicalPages: number;
  limited: boolean;
};
export type Outline = Partial<Record<Role, OutlineSide>>;
export type OutlineRow = {
  section: OutlineSection;
  sameKeyOther: OutlineSection[];
  repeatedHere: number;
};
export type OutlineFilter = {
  scope: Scope;
  keyword: string;
  kind: 'all' | OutlineHeading['kind'];
  pairedOnly: boolean;
};

function invalid(): never { throw new Error('Invalid outline inspection.'); }
function ascii(value: string) { return value.replace(/[A-Z]/g, letter => letter.toLowerCase()); }
function normalizedName(value: string): string {
  return ascii(value.trim().replace(/\s+/g, ' '));
}
function isTitle(value: string): boolean {
  return value.length <= 140 && value.length >= 2 && /\p{L}/u.test(value) &&
    !/[.!?;]$/.test(value) && !/\b(?:shall|must|may|is required|are required)\b/i.test(value);
}

/** Require a heading-like separator or standalone recognized heading.
 * A running reference (e.g. "Clause 3 applies") is not a boundary.
 */
export function detectOutlineHeading(text: string): OutlineHeading | null {
  if (!text || text.length > 180 || /[\r\n]/.test(text) || text.trim() !== text) return null;
  const first = referencesIn(text)[0];
  if (first?.range.start === 0) {
    const rest = text.slice(first.range.end);
    const separated = /^\s*(?::|[–—-])\s*(.*)$/.exec(rest);
    if (!rest.trim() || (separated && (!separated[1] || isTitle(separated[1])))) {
      const { reference } = first;
      return { kind: 'reference', reference, title: separated?.[1] || '',
        key: 'ref:' + reference.kind + ':' + reference.identifier };
    }
  }
  // Dotted identifiers are not dates, currency amounts or simple bullet
  // sentences. Require an explicit separator and a short heading-like label.
  const numbered = /^([1-9][0-9]{0,3}(?:\.[0-9]{1,4}){0,5})(?:[.)]\s+|\s*[:–—]\s*)(.+)$/.exec(text);
  if (numbered && isTitle(numbered[2])) {
    const title = numbered[2];
    // Numbered lines without a recognized heading name or upper-case style
    // are too often ordinary list items to act as boundaries.
    if (named.has(normalizedName(title)) || (/\p{Lu}/u.test(title) &&
        title === title.toUpperCase() && !/\d/.test(title))) {
      return { kind: 'numbered', number: numbered[1], title, key: 'number:' + numbered[1] };
    }
  }
  const name = normalizedName(text.replace(/:$/, ''));
  if (named.has(name)) return { kind: 'named', title: text, key: 'name:' + name };
  return null;
}

function ordered(corpus: Corpus, role: Role): Passage[] {
  if (corpus.passages.length > MAX_PASSAGES / 2) invalid();
  const rows = [...corpus.passages].sort((a, b) => a.page - b.page || a.ordinal - b.ordinal);
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.role !== role || row.page > corpus.processedPages || row.text.length > MAX_PASSAGE_CHARS) invalid();
    const id = passageId(row);
    if (seen.has(id)) invalid();
    seen.add(id);
  }
  return rows;
}

function sectionCoverage(section: OutlineSection, corpus: Corpus): void {
  const last = section.fragments.at(-1) ?? section.source;
  section.lastPage = last.page;
  let previous = section.source;
  for (const row of section.fragments) {
    if (row.page === previous.page && row.ordinal > previous.ordinal + 1) section.ordinalGaps++;
    previous = row;
  }
  const uncertain = new Set([...corpus.missingPages, ...corpus.limitedPages]);
  section.uncertainPages = [...uncertain].filter(page =>
    page >= section.firstPage && page <= section.lastPage).sort((a, b) => a - b);
}

export function buildOutline(corpora: ChatCorpora): Outline {
  const outline: Outline = {};
  for (const role of ROLES) {
    const corpus = corpora[role];
    if (!corpus) continue;
    const rows = ordered(corpus, role);
    const sections: OutlineSection[] = [], beforeFirst: Passage[] = [];
    let active: OutlineSection | null = null;
    for (const row of rows) {
      const heading = detectOutlineHeading(row.text);
      if (heading) {
        active = { id: passageId(row), heading, source: row, fragments: [],
          firstPage: row.page, lastPage: row.page, ordinalGaps: 0, uncertainPages: [] };
        sections.push(active);
      } else if (active) active.fragments.push(row);
      else beforeFirst.push(row);
    }
    for (const section of sections) sectionCoverage(section, corpus);
    outline[role] = { role, sections, beforeFirst, nativeFragments: rows.length,
      processedPages: corpus.processedPages, physicalPages: corpus.pageCount, limited: corpus.limited };
  }
  return outline;
}

function groupByKey(sections: OutlineSection[]): Map<string, OutlineSection[]> {
  const map = new Map<string, OutlineSection[]>();
  for (const section of sections) {
    const group = map.get(section.heading.key) ?? [];
    group.push(section);
    map.set(section.heading.key, group);
  }
  return map;
}
export function filterOutline(outline: Outline, filter: OutlineFilter): OutlineRow[] {
  if (!['original', 'revised', 'both'].includes(filter.scope) ||
      !['all', 'reference', 'numbered', 'named'].includes(filter.kind) ||
      typeof filter.keyword !== 'string' || filter.keyword.length > MAX_SECTION_FILTER_CHARS ||
      typeof filter.pairedOnly !== 'boolean') invalid();
  const keyword = filter.keyword.trim();
  const groups = {
    original: groupByKey(outline.original?.sections ?? []),
    revised: groupByKey(outline.revised?.sections ?? []),
  };
  return ROLES.filter(role => filter.scope === 'both' || role === filter.scope)
    .flatMap(role => (outline[role]?.sections ?? []).flatMap(section => {
      const other = role === 'original' ? 'revised' : 'original';
      const sameKeyOther = groups[other].get(section.heading.key) ?? [];
      if (filter.kind !== 'all' && section.heading.kind !== filter.kind) return [];
      if (keyword && !literalRanges(section.source.text, keyword, true).length) return [];
      if (filter.pairedOnly && !sameKeyOther.length) return [];
      return [{ section, sameKeyOther, repeatedHere: groups[role].get(section.heading.key)!.length }];
    }));
}

export function outlinePage<T>(rows: readonly T[], page: number, size = OUTLINE_PAGE_SIZE) {
  if (size !== OUTLINE_PAGE_SIZE && size !== SECTION_FRAGMENT_PAGE_SIZE) invalid();
  const pages = Math.max(1, Math.ceil(rows.length / size));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) invalid();
  const offset = (page - 1) * size;
  const items = rows.slice(offset, offset + size);
  return { items, pages, first: items.length ? offset + 1 : 0,
    last: Math.min(offset + items.length, rows.length) };
}
export function findOutlineSection(outline: Outline, id: string): OutlineSection {
  const item = ROLES.flatMap(role => outline[role]?.sections ?? []).find(section => section.id === id);
  if (!item) invalid();
  return item;
}

/** Literal filtering of the selected candidate span, not answer generation. */
export function searchSectionFragments(section: OutlineSection, keyword: string): Passage[] {
  if (typeof keyword !== 'string' || keyword.length > MAX_SECTION_FILTER_CHARS) invalid();
  const clean = keyword.trim();
  const rows = [section.source, ...section.fragments];
  return clean ? rows.filter(row => literalRanges(row.text, clean, true).length) : rows;
}

export type SectionComparisonRow =
  | { kind: 'same_wording'; original: Passage; revised: Passage }
  | { kind: 'original_unpaired'; original: Passage }
  | { kind: 'revised_unpaired'; revised: Passage };
export type SectionComparison = {
  original: OutlineSection;
  revised: OutlineSection;
  rows: SectionComparisonRow[];
  same: number;
  originalUnpaired: number;
  revisedUnpaired: number;
  repeatedText: boolean;
  coverageLimited: boolean;
};

/** Bounded exact sequence alignment. Repeated text may have several valid
 * alignments; an unpaired fragment is not an asserted addition/removal.
 * The user must select both physical section candidates explicitly.
 */
export function compareOutlineSections(outline: Outline, originalId: string, revisedId: string): SectionComparison {
  const original = findOutlineSection(outline, originalId), revised = findOutlineSection(outline, revisedId);
  if (original.source.role !== 'original' || revised.source.role !== 'revised' ||
      original.heading.key !== revised.heading.key) invalid();
  const a = [original.source, ...original.fragments], b = [revised.source, ...revised.fragments];
  if (a.length > MAX_SECTION_COMPARISON_FRAGMENTS || b.length > MAX_SECTION_COMPARISON_FRAGMENTS ||
      [...a, ...b].reduce((sum, row) => sum + row.text.length, 0) > MAX_SECTION_COMPARISON_CHARS) {
    throw new Error('Section comparison exceeds the bounded alignment limit. Inspect each source separately.');
  }
  const width = b.length + 1;
  const dp = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * width + j] = a[i].text === b[j].text
        ? 1 + dp[(i + 1) * width + j + 1]
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const rows: SectionComparisonRow[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].text === b[j].text) {
      rows.push({ kind: 'same_wording', original: a[i++], revised: b[j++] });
    } else if (i < a.length && (j >= b.length || dp[(i + 1) * width + j] >= dp[i * width + j + 1])) {
      rows.push({ kind: 'original_unpaired', original: a[i++] });
    } else {
      rows.push({ kind: 'revised_unpaired', revised: b[j++] });
    }
  }
  const same = rows.filter(row => row.kind === 'same_wording').length;
  return { original, revised, rows, same, originalUnpaired: a.length - same, revisedUnpaired: b.length - same,
    repeatedText: new Set(a.map(row => row.text)).size !== a.length ||
      new Set(b.map(row => row.text)).size !== b.length,
    coverageLimited: Boolean(outline.original?.limited || outline.revised?.limited ||
      original.uncertainPages.length || revised.uncertainPages.length || original.ordinalGaps || revised.ordinalGaps),
  };
}
