/** Exact printed scalar comparisons, not a finding of legal applicability. */
import type { FieldId, ExtractedField } from './pdfChatOverview';
import type { DirectAnswer } from './pdfChatDirectAnswer';

export type Currency = 'INR' | 'USD' | 'EUR' | 'GBP' | 'RS';
export type Money = { currency: Currency; minor: bigint };
export type CivilDate = { year: number; month: number; day: number; serial: number };
export type ScalarFailure = 'single_source' | 'unsupported_field' | 'missing_value' |
  'competing_values' | 'possible_conditions' | 'unrecognized_value' | 'different_currency';
export type Comparison =
  | { status: 'unavailable'; reason: ScalarFailure }
  | { status: 'available'; kind: 'money'; currency: Currency; original: ExtractedField;
      revised: ExtractedField; difference: bigint }
  | { status: 'available'; kind: 'date'; original: ExtractedField;
      revised: ExtractedField; difference: number };

const FEE_FIELDS = new Set<FieldId>(['application_fee', 'exam_fee', 'registration_fee']);
const DATE_FIELDS = new Set<FieldId>(['application_deadline', 'registration_deadline',
  'application_start', 'exam_date', 'interview_date', 'registration_start', 'payment_deadline',
  'correction_start', 'correction_deadline', 'admit_card_date', 'result_date', 'verification_date']);
const CURRENCIES: Record<string, Currency> = {
  '₹': 'INR', 'rs': 'RS', 'rs.': 'RS', 'inr': 'INR', 'usd': 'USD',
  'eur': 'EUR', '€': 'EUR', 'gbp': 'GBP', '£': 'GBP',
};
const MONEY = /^(₹|Rs\.?|INR|USD|EUR|€|GBP|£)[ \t]*([0-9][0-9,]*)(?:\.([0-9]{1,2}))?$/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

/** No implicit currency, signed values, exponent, range or attached condition.
 * Retain exact integer minor units; no floating-point currency arithmetic.
 */
export function parsePrintedMoney(value: string): Money | null {
  if (value.length > 80) return null;
  const match = MONEY.exec(value.trim());
  if (!match) return null;
  const currency = CURRENCIES[match[1].toLowerCase()];
  const integer = match[2], fraction = match[3] ?? '';
  if (!currency) return null;
  const plain = /^(?:0|[1-9][0-9]*)$/.test(integer);
  const western = /^[1-9][0-9]{0,2}(?:,[0-9]{3})+$/.test(integer);
  const indian = (currency === 'INR' || currency === 'RS') && /^[1-9][0-9]?(?:,[0-9]{2})*,[0-9]{3}$/.test(integer);
  if (!plain && !western && !indian) return null;
  const digits = integer.replace(/,/g, '');
  if (digits.length > 18) return null;
  return { currency, minor: BigInt(digits) * 100n + BigInt(fraction.padEnd(2, '0')) };
}

/** Accept only ISO or full English month dates. No locale guessing, time
 * zones or inclusive-period assumptions. Validate Gregorian rollover.
 */
export function parsePrintedDate(value: string): CivilDate | null {
  if (value.length > 80) return null;
  const clean = value.trim();
  let year: number, month: number, day: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  const named = /^(\d{1,2})[ \t]+([A-Za-z]+)[ \t]+(\d{4})$/.exec(clean);
  if (iso) {
    year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]);
  } else if (named) {
    year = Number(named[3]); month = MONTHS.indexOf(named[2].toLowerCase()) + 1;
    day = Number(named[1]);
  } else return null;
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const time = Date.UTC(year, month - 1, day);
  const actual = new Date(time);
  if (actual.getUTCFullYear() !== year || actual.getUTCMonth() + 1 !== month ||
      actual.getUTCDate() !== day) return null;
  return { year, month, day, serial: time / 86_400_000 };
}
export function scalarFieldKind(field: FieldId): 'money' | 'date' | null {
  return FEE_FIELDS.has(field) ? 'money' : DATE_FIELDS.has(field) ? 'date' : null;
}
function unavailable(reason: ScalarFailure): Comparison {
  return { status: 'unavailable', reason };
}

/** Withhold arithmetic for detected alternative values or possible
 * qualifications. Absence of a review lead does not prove completeness.
 */
export function comparePrintedScalars(result: DirectAnswer): Comparison {
  const kind = scalarFieldKind(result.field.id);
  if (!kind) return unavailable('unsupported_field');
  if (result.sides.length !== 2) return unavailable('single_source');
  const old = result.sides.find(side => side.role === 'original');
  const next = result.sides.find(side => side.role === 'revised');
  if (!old || !next || !old.distinctValues || !next.distinctValues) return unavailable('missing_value');
  if (old.distinctValues !== 1 || next.distinctValues !== 1 ||
      old.values.length !== 1 || next.values.length !== 1) return unavailable('competing_values');
  if (old.otherMatchingPassages || next.otherMatchingPassages || old.nearbyPassages ||
      next.nearbyPassages || old.reviewPassages.length || next.reviewPassages.length) {
    return unavailable('possible_conditions');
  }
  const original = old.values[0].sources[0], revised = next.values[0].sources[0];
  if (!original || !revised || original.source.role !== 'original' || revised.source.role !== 'revised' ||
      original.definition.id !== result.field.id || revised.definition.id !== result.field.id ||
      original.value !== old.values[0].value || revised.value !== next.values[0].value) {
    return unavailable('unrecognized_value');
  }
  if (kind === 'money') {
    const a = parsePrintedMoney(original.value), b = parsePrintedMoney(revised.value);
    if (!a || !b) return unavailable('unrecognized_value');
    if (a.currency !== b.currency) return unavailable('different_currency');
    return { status: 'available', kind, currency: a.currency, original, revised, difference: b.minor - a.minor };
  }
  const a = parsePrintedDate(original.value), b = parsePrintedDate(revised.value);
  if (!a || !b) return unavailable('unrecognized_value');
  return { status: 'available', kind, original, revised, difference: b.serial - a.serial };
}

export function formatMoneyMagnitude(minor: bigint, currency: Currency): string {
  const magnitude = minor < 0n ? -minor : minor;
  return (currency === 'RS' ? 'Rs.' : currency) + ' ' + (magnitude / 100n).toString() + '.' +
    (magnitude % 100n).toString().padStart(2, '0');
}

/** Finite deterministic prose templates, scoped to two literal values. */
export function scalarExplanation(value: Extract<Comparison, { status: 'available' }>): string {
  if (value.kind === 'money') {
    if (value.difference === 0n) return 'The two printed amounts have the same numeric value in ' + (value.currency === 'RS' ? 'the printed Rs. notation' : value.currency) + '.';
    return 'The revised printed amount is ' + formatMoneyMagnitude(value.difference, value.currency) +
      (value.difference > 0n ? ' higher' : ' lower') + ' than the original printed amount.';
  }
  if (value.difference === 0) return 'The two printed dates denote the same calendar day.';
  const days = Math.abs(value.difference);
  return 'The revised printed date is ' + days + ' calendar ' + (days === 1 ? 'day' : 'days') +
    (value.difference > 0 ? ' later' : ' earlier') + ' than the original printed date.';
}
