/** Pure, bounded native-text assembly for one physical PDF page.
 * No dependency on PDF.js, browser globals, OCR or authority inference. */
import { MAX_PASSAGE_CHARS, MAX_PASSAGES, type Passage, type Role, type TextPosition } from './pdfChatCore';

export const MAX_NATIVE_PAGE_ITEMS = 80_000;
export const MAX_NATIVE_DOCUMENT_ITEMS = 240_000;
export const MAX_NATIVE_DOCUMENT_CHARS = 800_000;
export const MAX_NATIVE_DOCUMENT_PASSAGES = MAX_PASSAGES / 2;

export type NativeTextItem = {
  str: string;
  transform: readonly number[];
  width: number;
  height: number;
  hasEOL: boolean;
};
type Geometry = { x: number; y: number; width: number; height: number };
export type PageBudget = { chars: number; passages: number; items: number };
export type NativePageResult = {
  passages: Passage[];
  chars: number;
  items: number;
  limited: boolean;
  stopped: boolean;
};
function withinBudget(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function geometry(item: NativeTextItem): Geometry | null {
  if (!Array.isArray(item.transform) || item.transform.length !== 6) return null;
  const [a, b, c, d, x, y] = item.transform;
  if (![a, b, c, d, x, y, item.width, item.height, x + item.width].every(Number.isFinite) ||
      a <= 0 || d <= 0 || Math.abs(b) > 0.01 || Math.abs(c) > 0.01 ||
      item.width < 0 || item.height <= 0) return null;
  return { x, y, width: item.width, height: Math.max(1, Math.abs(item.height)) };
}

/** Accept items in extraction order. A false return means stop reading
 * this page: no partial line is emitted after budget exhaustion. */
export class NativePageAssembler {
  private readonly passages: Passage[] = [];
  private chars = 0;
  private items = 0;
  private ordinal = 0;
  private line = '';
  private oversized = false;
  private previous: Geometry | null = null;
  private position: TextPosition | null = null;
  private positionInvalid = false;
  private limited = false;
  private stopped = false;
  private finished = false;

  constructor(private readonly role: Role, private readonly page: number,
    private readonly budget: PageBudget) {
    if ((role !== 'original' && role !== 'revised') ||
        !Number.isSafeInteger(page) || page < 1 || page > 80 ||
        !withinBudget(budget.chars, MAX_NATIVE_DOCUMENT_CHARS) ||
        !withinBudget(budget.passages, MAX_NATIVE_DOCUMENT_PASSAGES) ||
        !withinBudget(budget.items, MAX_NATIVE_PAGE_ITEMS)) {
      throw new Error('Invalid native page extraction budget.');
    }
    // Copy caller-owned settings before consuming untrusted input.
    this.budget = { ...budget };
  }
  private resetLine(): void {
    this.line = '';
    this.oversized = false;
    this.previous = null;
    this.position = null;
    this.positionInvalid = false;
  }
  private flush(): void {
    const text = this.line.trim();
    const position = this.positionInvalid ? null : this.position;
    const oversized = this.oversized;
    this.resetLine();
    if (oversized) {
      this.ordinal++; // An omitted line must leave a contextual-retrieval gap.
      this.limited = true;
      return;
    }
    if (!text) return;
    this.ordinal++;
    if (this.chars + text.length > this.budget.chars ||
        this.passages.length >= this.budget.passages) {
      this.limited = true;
      return;
    }
    this.chars += text.length;
    this.passages.push({ role: this.role, page: this.page, text, ordinal: this.ordinal,
      ...(position ? { position } : {}) });
  }
  private stop(): false {
    this.stopped = true;
    this.limited = true;
    this.resetLine();
    return false;
  }
  private full(): boolean {
    return this.chars >= this.budget.chars || this.passages.length >= this.budget.passages;
  }
  private append(text: string, separator = ''): void {
    if (this.oversized) return;
    if (this.line.length + separator.length + text.length > MAX_PASSAGE_CHARS) {
      this.oversized = true;
      this.line = '';
    } else this.line += separator + text;
  }
  private isolate(text: string): void {
    // Preserve the literal fragment but never join it to neighboring
    // coordinates or let adjacent-line retrieval bridge its layout gaps.
    this.flush();
    this.ordinal++;
    this.append(text);
    this.positionInvalid = true;
    this.flush();
    this.ordinal++;
  }
  push(item: unknown): boolean {
    if (this.finished) throw new Error('Native page extraction is already finished.');
    if (this.stopped) return false;
    if (this.items >= this.budget.items || this.full()) return this.stop();
    this.items++;
    // PDF.js also emits marked-content records without a string.
    if (!item || typeof item !== 'object' || !('str' in item)) return true;
    const source = item as NativeTextItem;
    if (typeof source.str !== 'string') {
      this.flush();
      this.ordinal++;
      this.limited = true;
      return this.full() ? this.stop() : true;
    }
    const blank = !source.str.trim();
    const g = geometry(source);
    if (!g || (!blank && g.width <= 0)) {
      if (blank) {
        // Unknown blank geometry cannot establish continuity across cells.
        this.flush();
        this.ordinal++;
      } else this.isolate(source.str);
      return this.full() ? this.stop() : true;
    }
    const previous = this.previous;
    if (blank) {
      // Synthetic whitespace can span the entire gap between text cells.
      // Never replace previous nonblank geometry with a whitespace item.
      if (source.hasEOL) this.flush();
      else if (previous && (
        Math.abs(g.y - previous.y) > Math.max(g.height, previous.height) * 0.55 ||
        g.x + g.width - (previous.x + previous.width) > previous.height * 4
      )) this.flush();
      else if (source.str.length && this.line && !/\s$/.test(this.line)) this.append(' ');
      return this.full() ? this.stop() : true;
    }
    if (previous && (Math.abs(g.y - previous.y) > Math.max(g.height, previous.height) * 0.55 ||
        g.x < previous.x - g.height ||
        g.x - (previous.x + previous.width) > g.height * 4)) this.flush();
    if (this.full()) return this.stop();
    const prior = this.previous;
    const gap = prior ? g.x - (prior.x + prior.width) : 0;
    const separator = this.line && gap > g.height * 0.15 && !/\s$/.test(this.line) &&
      !/^\s/.test(source.str) ? ' ' : '';
    this.append(source.str, separator);
    if (this.position !== null && Math.abs(this.position.y - g.y) > 2) {
      this.positionInvalid = true;
    } else if (this.position === null) {
      this.position = { x0: g.x, x1: g.x + g.width, y: g.y, height: g.height };
    } else {
      this.position = { x0: Math.min(this.position.x0, g.x),
        x1: Math.max(this.position.x1, g.x + g.width), y: this.position.y,
        height: Math.max(this.position.height, g.height) };
    }
    this.previous = g;
    if (source.hasEOL) this.flush();
    return this.full() ? this.stop() : true;
  }

  /** Call once after end-of-stream, or with complete=false on truncation. */
  finish(complete = true): NativePageResult {
    if (this.finished) throw new Error('Native page extraction is already finished.');
    this.finished = true;
    if (!complete || this.stopped) {
      this.limited = true;
      this.resetLine();
    } else this.flush();
    return { passages: this.passages.slice(), chars: this.chars, items: this.items,
      limited: this.limited, stopped: this.stopped };
  }
}
