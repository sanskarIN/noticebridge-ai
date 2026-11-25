/**
 * Bounded strict JSON reader for local evidence files.
 *
 * JSON.parse silently accepts duplicate members. Scan the grammar first to
 * reject ambiguous object keys, non-finite numbers and excessive nesting.
 * The native parser then builds the result. No input is executed.
 */
const MAX_DEPTH = 40;
const MAX_NODES = 1_000_000;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEX = /^[0-9a-fA-F]{4}$/;

export class StrictJsonError extends Error {
  constructor() {
    super('Invalid or ambiguous JSON');
  }
}

function invalid(): never {
  throw new StrictJsonError();
}

class Scanner {
  private cursor = 0;
  private nodes = 0;
  private readonly numberPattern = new RegExp(NUMBER);

  constructor(private readonly text: string) {}

  scan(): void {
    this.space();
    this.value(0);
    this.space();
    if (this.cursor !== this.text.length) invalid();
  }

  private space(): void {
    while (this.cursor < this.text.length) {
      const c = this.text.charCodeAt(this.cursor);
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
      this.cursor++;
    }
  }

  private take(expected: string): boolean {
    if (this.text[this.cursor] !== expected) return false;
    this.cursor++;
    return true;
  }

  private require(expected: string): void {
    if (!this.take(expected)) invalid();
  }

  private value(depth: number): void {
    if (++this.nodes > MAX_NODES || depth > MAX_DEPTH) invalid();
    this.space();
    const char = this.text[this.cursor];
    switch (char) {
      case '{':
        this.object(depth);
        return;
      case '[':
        this.array(depth);
        return;
      case '"':
        this.string();
        return;
      case 't':
        this.literal('true');
        return;
      case 'f':
        this.literal('false');
        return;
      case 'n':
        this.literal('null');
        return;
      default:
        this.number();
    }
  }

  private literal(word: string): void {
    if (!this.text.startsWith(word, this.cursor)) invalid();
    this.cursor += word.length;
  }

  private number(): void {
    this.numberPattern.lastIndex = this.cursor;
    const match = this.numberPattern.exec(this.text);
    if (!match || !Number.isFinite(Number(match[0]))) invalid();
    this.cursor = this.numberPattern.lastIndex;
  }

  private string(): string {
    const start = this.cursor;
    this.require('"');
    while (this.cursor < this.text.length) {
      const char = this.text[this.cursor++];
      if (char === '"') {
        // Decode escaped names before duplicate detection: "a" and "\u0061"
        // are the same object key, as are escaped surrogate pairs.
        return JSON.parse(this.text.slice(start, this.cursor)) as string;
      }
      if (char.charCodeAt(0) < 32) invalid();
      if (char !== '\\') continue;
      const escaped = this.text[this.cursor++];
      if (escaped === 'u') {
        const digits = this.text.slice(this.cursor, this.cursor + 4);
        if (!HEX.test(digits)) invalid();
        this.cursor += 4;
      } else if (!escaped || !'"\\/bfnrt'.includes(escaped)) {
        invalid();
      }
    }
    return invalid();
  }

  private object(depth: number): void {
    this.require('{');
    this.space();
    if (this.take('}')) return;
    const names = new Set<string>();
    for (;;) {
      this.space();
      const name = this.string();
      if (names.has(name)) invalid();
      names.add(name);
      this.space();
      this.require(':');
      this.value(depth + 1);
      this.space();
      if (this.take('}')) return;
      this.require(',');
    }
  }

  private array(depth: number): void {
    this.require('[');
    this.space();
    if (this.take(']')) return;
    for (;;) {
      this.value(depth + 1);
      this.space();
      if (this.take(']')) return;
      this.require(',');
    }
  }
}

export function parseStrictJson(text: string): unknown {
  new Scanner(text).scan();
  return JSON.parse(text) as unknown;
}
