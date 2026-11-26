import { expect, test } from '@playwright/test';
import { answerQuestion, buildIndex, type Passage } from '../src/pdfChatCore';
import { directFieldAnswer } from '../src/pdfChatDirectAnswer';
import { comparePrintedScalars, formatMoneyMagnitude, parsePrintedDate,
  parsePrintedMoney, scalarExplanation } from '../src/pdfChatScalarComparison';

for (const [value, currency, minor] of [
  ['Rs. 500', 'INR', 50000n], ['₹ 1,23,456.78', 'INR', 12345678n],
  ['INR 123,456.7', 'INR', 12345670n], ['rs 0.01', 'INR', 1n],
  ['USD 0', 'USD', 0n], ['€ 1,234.50', 'EUR', 123450n], ['GBP 42', 'GBP', 4200n],
  ['INR 999999999999999999.99', 'INR', 99999999999999999999n],
] as const) {
  test('exact currency parsing: ' + value, () => {
    expect(parsePrintedMoney(value)).toEqual({ currency, minor });
  });
}
for (const value of [
  '$500', '500', 'Rs. 500 or 750', 'Rs. 500 unless exempt', 'Rs. -500', 'Rs. +500',
  'Rs. 1e3', 'Rs. 00', 'Rs. 01.00', 'Rs. 1,00', 'USD 1,00,000', 'INR 123,45,678',
  'Rs. 1.001', 'Rs. 1.', 'Rs. .50', 'Rs. 1 000', 'Rs. １00', 'Rs. 100/-',
  'INR 1000000000000000000', 'Free', 'Rs. 500 per application', 'USD 10 EUR',
]) {
  test('reject ambiguous amount: ' + value, () => expect(parsePrintedMoney(value)).toBeNull());
}
for (const [value, year, month, day] of [
  ['2026-12-15', 2026, 12, 15], ['15 December 2026', 2026, 12, 15],
  ['29 February 2024', 2024, 2, 29], ['2000-02-29', 2000, 2, 29],
  ['1 january 2027', 2027, 1, 1], ['1000-01-01', 1000, 1, 1],
] as const) {
  test('valid civil date: ' + value, () => {
    expect(parsePrintedDate(value)).toMatchObject({ year, month, day });
  });
}
for (const value of [
  '01/02/2026', '12-15-2026', '2026-2-05', '2026-02-29', '1900-02-29',
  '2026-04-31', '2026-00-10', '2026-12-00', '15 Dec 2026', '15th December 2026',
  '15 December', 'December 15, 2026', '2026-12-15T12:00:00Z', '2026-12-15 to 2026-12-20',
  '15 December 2026 at 17:00', '999-01-01', '10000-01-01',
]) {
  test('reject ambiguous date: ' + value, () => expect(parsePrintedDate(value)).toBeNull());
}
function line(text: string, role: Passage['role'] = 'original', page = 1): Passage {
  return { text, role, page, ordinal: 1 };
}
function compare(lines: Passage[], question = 'Application fee?', scope: 'both' | 'original' = 'both') {
  const index = buildIndex(lines);
  const result = directFieldAnswer(index, answerQuestion(index, question, scope));
  if (!result) throw new Error('Missing recognized field.');
  return comparePrintedScalars(result);
}
const fees = [line('Application fee: Rs. 500'), line('Application charges: ₹350.50', 'revised')];
test('precise fee difference is grounded in both original printed values', () => {
  const result = compare(fees);
  expect(result).toMatchObject({ status: 'available', kind: 'money', currency: 'INR', difference: -14950n });
  if (result.status !== 'available') throw new Error('Expected comparison');
  expect(result.original.source).toBe(fees[0]);
  expect(result.revised.source).toBe(fees[1]);
  expect(scalarExplanation(result)).toBe('The revised printed amount is INR 149.50 lower than the original printed amount.');
});
test('equal numeric amounts retain different printed wording', () => {
  const result = compare([line('Application fee: INR 1,000.00'), line('Application fee: Rs. 1000', 'revised')]);
  expect(result).toMatchObject({ status: 'available', difference: 0n });
  if (result.status === 'available') expect(scalarExplanation(result)).toContain('same numeric value');
});
test('minor unit arithmetic never rounds large values', () => {
  const result = compare([line('Application fee: INR 999999999999999999.98'),
    line('Application fee: INR 999999999999999999.99', 'revised')]);
  expect(result).toMatchObject({ status: 'available', difference: 1n });
  expect(formatMoneyMagnitude(-1n, 'INR')).toBe('INR 0.01');
});
test('calendar comparison counts leap days and years', () => {
  const result = compare([line('Application deadline: 28 February 2024'),
    line('Application closing date: 2024-03-01', 'revised')], 'Application deadline?');
  expect(result).toMatchObject({ status: 'available', difference: 2 });
  if (result.status === 'available') expect(scalarExplanation(result)).toContain('2 calendar days later');
  const earlier = compare([line('Application deadline: 2027-01-01'),
    line('Application closing date: 31 December 2026', 'revised')], 'Application deadline?');
  expect(earlier).toMatchObject({ status: 'available', difference: -1 });
  if (earlier.status === 'available') expect(scalarExplanation(earlier)).toContain('1 calendar day earlier');
});
test('different currencies cannot be compared or converted', () => {
  expect(compare([fees[0], line('Application fee: USD 20', 'revised')]))
    .toEqual({ status: 'unavailable', reason: 'different_currency' });
});
test('competing values beyond citation display cap prevent comparison', () => {
  const rows = Array.from({ length: 5 }, (_, i) => line('Application fee: INR ' + (500 + i), 'original', i + 1));
  expect(compare([...rows, fees[1]])).toEqual({ status: 'unavailable', reason: 'competing_values' });
});
test('missing, single-source and unsupported fields fail closed', () => {
  expect(compare([fees[0]])).toEqual({ status: 'unavailable', reason: 'missing_value' });
  expect(compare(fees, 'Application fee?', 'original')).toEqual({ status: 'unavailable', reason: 'single_source' });
  expect(compare([line('Eligibility: Class 12'), line('Eligibility: Class 10', 'revised')], 'Eligibility?'))
    .toEqual({ status: 'unavailable', reason: 'unsupported_field' });
});
test('attached conditions and additional query text prevent arithmetic', () => {
  expect(compare([line('Application fee: Rs. 500 unless exempt'), fees[1]]))
    .toEqual({ status: 'unavailable', reason: 'unrecognized_value' });
  expect(compare([...fees, line('Application fee may be waived for eligible applicants', 'original', 2)]))
    .toEqual({ status: 'unavailable', reason: 'possible_conditions' });
});
