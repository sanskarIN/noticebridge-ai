/** Printed calendar evidence, never an inferred official schedule. */
import { MAX_PASSAGES, pageCoverage, sameTextFlow, type Corpus, type Passage,
  type Role, type Scope, type SearchIndex } from './pdfChatCore';
import { fieldDefinitions, type FieldDefinition, type FieldId, type ExtractedField } from './pdfChatOverview';
import { parsePrintedDate, scalarFieldKind, type CivilDate } from './pdfChatScalarComparison';
import { passageId } from './pdfChatResearch';
import type { ChatCorpora } from './pdfChatEvidenceReport';

export const TIMELINE_PAGE_SIZE = 12;
export const MAX_DATE_FIELD_LENGTH = 300;
export const MAX_DATE_REVIEW_LEADS = 12;
export type DateEventKind = 'opening' | 'closing' | 'event';
export type PrintedDateValue =
  | { kind: 'single'; date: CivilDate }
  | { kind: 'range'; from: CivilDate; to: CivilDate }
  | { kind: 'date_time'; date: CivilDate; timeText: string }
  | { kind: 'unparsed' };
export type DateOccurrence = {
  id: string;
  field: ExtractedField;
  parsed: PrintedDateValue;
  reviewLeads: Passage[];
  reviewLeadCount: number;
};
export type DateEvent = {
  definition: FieldDefinition;
  kind: DateEventKind;
  role: Role;
  occurrences: DateOccurrence[];
  distinctPrintedValues: number;
  comparableDate: CivilDate | null;
  reason: 'unique' | 'multiple_values' | 'not_single_date' | 'possible_conditions';
};
export type Timeline = {
  events: DateEvent[];
  attached: Role[];
  indexed: Record<Role, number>;
};
export type TimelineFilter = {
  scope: Scope;
  kind: DateEventKind | 'all';
  parse: 'all' | 'parsed' | 'unparsed';
  page?: number;
  order: 'source' | 'chronological';
};
export type TimelineRow = {
  occurrence: DateOccurrence;
  event: DateEvent;
};
export type DatePair = {
  field: FieldDefinition;
  original: DateEvent | null;
  revised: DateEvent | null;
  outcome: 'missing_source' | 'missing_label' | 'review_required' | 'same_day' | 'different_day';
  deltaDays: number | null;
};
export type WindowCheck = {
  name: string;
  role: Role;
  opening: DateEvent | null;
  closing: DateEvent | null;
  outcome: 'missing_label' | 'review_required' | 'printed_order' | 'reversed_printed_order';
  differenceDays: number | null;
};
const ROLES: Role[] = ['original', 'revised'];
const OPENING = new Set<FieldId>(['application_start', 'registration_start', 'correction_start']);
const CLOSING = new Set<FieldId>(['application_deadline', 'registration_deadline', 'payment_deadline', 'correction_deadline']);
const WINDOWS: readonly { name: string; open: FieldId; close: FieldId }[] = [
  { name: 'Application window', open: 'application_start', close: 'application_deadline' },
  { name: 'Registration window', open: 'registration_start', close: 'registration_deadline' },
  { name: 'Correction window', open: 'correction_start', close: 'correction_deadline' },
];
const CLOCK = /^(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*(?:IST|UTC|GMT))?$|^(?:0?[1-9]|1[0-2]):[0-5]\d\s*(?:AM|PM)(?:\s*(?:IST|UTC|GMT))?$/i;

function invalid(): never { throw new Error('Invalid timeline inspection.'); }
function eventKind(id: FieldId): DateEventKind {
  return OPENING.has(id) ? 'opening' : CLOSING.has(id) ? 'closing' : 'event';
}

/** Parse only complete literal date expressions, using the existing
 * Gregorian date validator. Never infer a missing year, time zone,
 * range endpoint, inclusive duration, or applicant-specific date.
 */
export function parseTimelineValue(value: string): PrintedDateValue {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_DATE_FIELD_LENGTH ||
      /[\r\n]/.test(value)) return { kind: 'unparsed' };
  const text = value.trim();
  const date = parsePrintedDate(text);
  if (date) return { kind: 'single', date };
  const range = /^(?:from\s+)?(.+?)\s+(?:to|through|–|—)\s+(.+)$/i.exec(text);
  if (range) {
    const from = parsePrintedDate(range[1]), to = parsePrintedDate(range[2]);
    if (from && to && from.serial <= to.serial) return { kind: 'range', from, to };
    return { kind: 'unparsed' };
  }
  const dateTime = /^(.+?)(?:,\s*|\s+at\s+|\s+)(\d{1,2}:\d{2}(?:\s*(?:AM|PM))?(?:\s*(?:IST|UTC|GMT))?)$/i.exec(text);
  if (dateTime) {
    const day = parsePrintedDate(dateTime[1]);
    if (day && CLOCK.test(dateTime[2])) return { kind: 'date_time', date: day, timeText: dateTime[2] };
  }
  return { kind: 'unparsed' };
}
function order(a: Passage, b: Passage): number {
  return ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.page - b.page || a.ordinal - b.ordinal;
}
function compareEvent(event: Omit<DateEvent, 'comparableDate' | 'reason'>): Pick<DateEvent, 'comparableDate' | 'reason'> {
  if (event.distinctPrintedValues !== 1) return { comparableDate: null, reason: 'multiple_values' };
  const first = event.occurrences[0];
  if (!first || first.parsed.kind !== 'single') return { comparableDate: null, reason: 'not_single_date' };
  if (event.occurrences.some(row => row.reviewLeadCount > 0)) return { comparableDate: null, reason: 'possible_conditions' };
  return { comparableDate: first.parsed.date, reason: 'unique' };
}
function comparableLead(field: ExtractedField, candidate: Passage): boolean {
  // Explicit field words must occur together. This is only an inspection
  // lead, not an assertion that the fragment modifies the printed date.
  const label = field.definition.label.toLowerCase();
  const text = candidate.text.toLowerCase();
  if (field.definition.aliases.some(alias => text.includes(alias))) return true;
  if (text.includes(label)) return true;
  return false;
}
function collectLeads(field: ExtractedField, rows: SearchIndex['rows'], byId: Map<string, SearchIndex['rows'][number]>) {
  const source = field.source, id = passageId(source);
  const leads = new Map<string, Passage>();
  for (const candidate of rows) {
    if (candidate.passage.role !== source.role || candidate.field?.definition.id === field.definition.id ||
        passageId(candidate.passage) === id) continue;
    if (!candidate.field && comparableLead(field, candidate.passage)) {
      leads.set(passageId(candidate.passage), candidate.passage);
    }
  }
  // Only geometry-supported same-page neighbors; no adjacency guesses across
  // columns, unindexed gaps or other sources.
  if (source.position) {
    for (const delta of [-1, 1]) {
      const candidate = byId.get(source.role + ':' + source.page + ':' + (source.ordinal + delta));
      if (!candidate || candidate.field || !candidate.passage.position) continue;
      if (delta < 0 ? sameTextFlow(candidate.passage, source) : sameTextFlow(source, candidate.passage)) {
        leads.set(passageId(candidate.passage), candidate.passage);
      }
    }
  }
  const all = [...leads.values()].sort(order);
  return { reviewLeads: all.slice(0, MAX_DATE_REVIEW_LEADS), reviewLeadCount: all.length };
}
export function buildTimeline(index: SearchIndex, corpora: ChatCorpora): Timeline {
  if (index.rows.length > MAX_PASSAGES) invalid();
  const attached = ROLES.filter(role => Boolean(corpora[role]));
  const indexed = { original: 0, revised: 0 };
  const byId = new Map<string, SearchIndex['rows'][number]>();
  for (const row of index.rows) {
    const id = passageId(row.passage);
    if (byId.has(id) || !attached.includes(row.passage.role)) invalid();
    byId.set(id, row); indexed[row.passage.role]++;
  }
  const events: DateEvent[] = [];
  const definitions = fieldDefinitions.filter(definition => scalarFieldKind(definition.id) === 'date');
  const byField = new Map<string, ExtractedField[]>();
  for (const row of index.rows) {
    const field = row.field;
    if (!field || scalarFieldKind(field.definition.id) !== 'date') continue;
    const key = field.source.role + ':' + field.definition.id;
    const current = byField.get(key) ?? [];
    current.push(field); byField.set(key, current);
  }
  // Collect query leads once per role/field, not once per occurrence. A
  // repeated date on thousands of pages cannot trigger quadratic scanning.
  const baseLeads = new Map<string, Passage[]>();
  for (const role of attached) {
    for (const definition of definitions) {
      const key = role + ':' + definition.id;
      const fields = byField.get(key);
      if (!fields?.length) continue;
      const representative = fields[0];
      baseLeads.set(key, index.rows.filter(row => row.passage.role === role && !row.field &&
        comparableLead(representative, row.passage)).map(row => row.passage).sort(order));
      const baseIds = new Set(baseLeads.get(key)!.map(passageId));
      const occurrences = fields.sort((a, b) => order(a.source, b.source)).map(field => {
        // Bounded query lead sample plus at most two verified neighbors.
        const all = baseLeads.get(key)!;
        const sample = new Map(all.slice(0, MAX_DATE_REVIEW_LEADS).map(source => [passageId(source), source]));
        let count = all.length;
        const local = collectLeads(field, [], byId);
        for (const source of local.reviewLeads) {
          const id = passageId(source);
          if (!baseIds.has(id)) count++;
          if (sample.size < MAX_DATE_REVIEW_LEADS) sample.set(id, source);
        }
        return { id: passageId(field.source), field, parsed: parseTimelineValue(field.value),
          reviewLeads: [...sample.values()].sort(order), reviewLeadCount: count };
      });
      const partial = { definition, kind: eventKind(definition.id), role, occurrences,
        distinctPrintedValues: new Set(fields.map(field => field.value)).size };
      events.push({ ...partial, ...compareEvent(partial) });
    }
  }
  return { events, attached, indexed };
}
function dateOrder(parsed: PrintedDateValue): number {
  if (parsed.kind === 'single' || parsed.kind === 'date_time') return parsed.date.serial;
  if (parsed.kind === 'range') return parsed.from.serial;
  return Number.POSITIVE_INFINITY;
}
export function filterTimeline(timeline: Timeline, filter: TimelineFilter): TimelineRow[] {
  if (!['original', 'revised', 'both'].includes(filter.scope) ||
      !['all', 'opening', 'closing', 'event'].includes(filter.kind) ||
      !['all', 'parsed', 'unparsed'].includes(filter.parse) ||
      !['source', 'chronological'].includes(filter.order) ||
      (filter.page !== undefined && (!Number.isSafeInteger(filter.page) || filter.page < 1 || filter.page > 80))) invalid();
  const rows = timeline.events.flatMap(event => {
    if ((filter.scope !== 'both' && event.role !== filter.scope) ||
        (filter.kind !== 'all' && event.kind !== filter.kind)) return [];
    return event.occurrences.filter(row =>
      (filter.page === undefined || row.field.source.page === filter.page) &&
      (filter.parse === 'all' || (filter.parse === 'unparsed') === (row.parsed.kind === 'unparsed')))
      .map(occurrence => ({ occurrence, event }));
  });
  return rows.sort((a, b) => {
    if (filter.order === 'chronological') {
      const first = dateOrder(a.occurrence.parsed), second = dateOrder(b.occurrence.parsed);
      if (first !== second) return first < second ? -1 : 1;
    }
    return order(a.occurrence.field.source, b.occurrence.field.source);
  });
}
export function timelinePage<T>(rows: T[], page: number) {
  const pages = Math.max(1, Math.ceil(rows.length / TIMELINE_PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) invalid();
  return { pages, rows: rows.slice((page - 1) * TIMELINE_PAGE_SIZE, page * TIMELINE_PAGE_SIZE) };
}
export function compareTimeline(timeline: Timeline): DatePair[] {
  return fieldDefinitions.filter(field => scalarFieldKind(field.id) === 'date').flatMap(field => {
    const original = timeline.events.find(event => event.role === 'original' && event.definition.id === field.id) ?? null;
    const revised = timeline.events.find(event => event.role === 'revised' && event.definition.id === field.id) ?? null;
    if (!original && !revised) return [];
    const base = { field, original, revised };
    if (timeline.attached.length < 2) return [{ ...base, outcome: 'missing_source', deltaDays: null } as DatePair];
    if (!original || !revised) return [{ ...base, outcome: 'missing_label', deltaDays: null } as DatePair];
    if (!original.comparableDate || !revised.comparableDate) {
      return [{ ...base, outcome: 'review_required', deltaDays: null } as DatePair];
    }
    const deltaDays = revised.comparableDate.serial - original.comparableDate.serial;
    return [{ ...base, outcome: deltaDays === 0 ? 'same_day' : 'different_day', deltaDays } as DatePair];
  });
}
export function inspectWindows(timeline: Timeline): WindowCheck[] {
  return timeline.attached.flatMap(role => WINDOWS.flatMap(window => {
    const opening = timeline.events.find(event => event.role === role && event.definition.id === window.open) ?? null;
    const closing = timeline.events.find(event => event.role === role && event.definition.id === window.close) ?? null;
    if (!opening && !closing) return [];
    const base = { name: window.name, role, opening, closing };
    if (!opening || !closing) return [{ ...base, outcome: 'missing_label', differenceDays: null } as WindowCheck];
    if (!opening.comparableDate || !closing.comparableDate) {
      return [{ ...base, outcome: 'review_required', differenceDays: null } as WindowCheck];
    }
    const differenceDays = closing.comparableDate.serial - opening.comparableDate.serial;
    return [{ ...base, outcome: differenceDays < 0 ? 'reversed_printed_order' : 'printed_order', differenceDays } as WindowCheck];
  }));
}
export function isoDate(date: CivilDate): string {
  return String(date.year).padStart(4, '0') + '-' + String(date.month).padStart(2, '0') + '-' + String(date.day).padStart(2, '0');
}
export function describeTimelineValue(parsed: PrintedDateValue): string {
  if (parsed.kind === 'single') return isoDate(parsed.date);
  if (parsed.kind === 'range') return isoDate(parsed.from) + ' to ' + isoDate(parsed.to);
  if (parsed.kind === 'date_time') return isoDate(parsed.date) + ' · printed clock text: ' + parsed.timeText;
  return 'Not parsed as a complete supported date expression';
}
export function dateCoverage(corpus: Corpus | undefined, page?: number): string {
  if (!corpus) return 'Source not attached.';
  if (page === undefined) return corpus.processedPages + '/' + corpus.pageCount + ' physical pages processed.' +
    (corpus.limited || corpus.missingPages.length ? ' Native extraction is incomplete.' : ' Extraction may omit content.');
  const status = pageCoverage(corpus, page);
  if (status === 'not_present') return 'Physical page does not exist.';
  if (status === 'not_indexed') return 'Physical page was not indexed.';
  if (status === 'no_indexed_text') return 'Physical page has no indexed native text.';
  if (status === 'limited') return 'Physical page was partially indexed.';
  return 'Some native text was indexed on this physical page.';
}
