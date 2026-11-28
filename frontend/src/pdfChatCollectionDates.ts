/** Printed date inventory across independent PDF sources, without assuming
 * version relationships, official validity, or cross-document windows. */
import type { Corpus } from './pdfChatCore';
import type { CollectionDocument } from './pdfChatCollection';
import { selectedCollectionDocuments } from './pdfChatCollectionTools';
import { buildTimeline, filterTimeline, inspectWindows, type Timeline, type TimelineFilter,
  type TimelineRow, type WindowCheck, type DateEvent } from './pdfChatTimeline';
import { fieldDefinitions } from './pdfChatOverview';

const cache = new WeakMap<Corpus, Timeline>();
export const COLLECTION_DATE_PAGE_SIZE = 12;
export type CollectionDateRow = TimelineRow & { documentId: string };
export type CollectionDateFilter = Omit<TimelineFilter, 'scope'>;
export type CollectionDateSide = { documentId: string; timeline: Timeline };
export type CollectionDateWindow = WindowCheck & { documentId: string };
export type CollectionDateFieldSide = { documentId: string; event: DateEvent | null };
export type CollectionDateField = {
  label: string;
  id: string;
  sides: CollectionDateFieldSide[];
  state: 'one_document' | 'missing_label' | 'review_required' | 'same_day' | 'different_days';
  spanDays: number | null;
};
function invalid(): never { throw new Error('Invalid collection date inspection.'); }

export function collectionTimelines(documents: readonly CollectionDocument[], selection: readonly string[]): CollectionDateSide[] {
  return selectedCollectionDocuments(documents, selection).map(doc => {
    let timeline = cache.get(doc.corpus);
    if (!timeline) {
      timeline = buildTimeline(doc.index, { original: doc.corpus });
      cache.set(doc.corpus, timeline);
    }
    return { documentId: doc.id, timeline };
  });
}
function dateOrder(row: CollectionDateRow): number {
  const p = row.occurrence.parsed;
  if (p.kind === 'single' || p.kind === 'date_time') return p.date.serial;
  if (p.kind === 'range') return p.from.serial;
  return Number.POSITIVE_INFINITY;
}
export function collectionDates(sides: readonly CollectionDateSide[], filter: CollectionDateFilter): CollectionDateRow[] {
  const order = new Map(sides.map((side, i) => [side.documentId, i]));
  const rows = sides.flatMap(side => filterTimeline(side.timeline, { ...filter, scope: 'original' })
    .map(row => ({ ...row, documentId: side.documentId })));
  return rows.sort((a, b) => {
    if (filter.order === 'chronological') {
      const x = dateOrder(a), y = dateOrder(b);
      if (x !== y) return x < y ? -1 : 1;
    }
    return order.get(a.documentId)! - order.get(b.documentId)! ||
      a.occurrence.field.source.page - b.occurrence.field.source.page ||
      a.occurrence.field.source.ordinal - b.occurrence.field.source.ordinal;
  });
}
export function collectionDatePage<T>(rows: readonly T[], page: number, size = COLLECTION_DATE_PAGE_SIZE) {
  if (!Number.isSafeInteger(size) || size < 1 || size > 12) invalid();
  const pages = Math.max(1, Math.ceil(rows.length / size));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) invalid();
  const offset = (page - 1) * size;
  const visible = rows.slice(offset, offset + size);
  return { rows: visible, pages, first: visible.length ? offset + 1 : 0, last: offset + visible.length };
}
export function collectionDateFields(sides: readonly CollectionDateSide[]): CollectionDateField[] {
  return fieldDefinitions.flatMap(definition => {
    const entries = sides.map(side => ({ documentId: side.documentId,
      event: side.timeline.events.find(event => event.definition.id === definition.id) ?? null }));
    if (!entries.some(entry => entry.event)) return [];
    const dates = entries.map(entry => entry.event?.comparableDate?.serial);
    let state: CollectionDateField['state'];
    let spanDays: number | null = null;
    if (entries.some(entry => !entry.event)) state = 'missing_label';
    else if (dates.some(date => date === undefined)) state = 'review_required';
    else if (entries.length === 1) state = 'one_document';
    else {
      const values = dates as number[];
      spanDays = Math.max(...values) - Math.min(...values);
      state = spanDays === 0 ? 'same_day' : 'different_days';
    }
    return [{ id: definition.id, label: definition.label, sides: entries, state, spanDays }];
  });
}
export function collectionDateWindows(sides: readonly CollectionDateSide[]): CollectionDateWindow[] {
  return sides.flatMap(side => inspectWindows(side.timeline).map(window => ({
    ...window, documentId: side.documentId,
  })));
}
export function collectionDatePageFilter(input: string): number | undefined {
  if (!input.trim()) return undefined;
  if (!/^[1-9][0-9]?$/.test(input.trim()) || Number(input) > 80) invalid();
  return Number(input);
}
