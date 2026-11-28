/** Closed-vocabulary recognition of explicit printed-value comparison intent. */
import { fieldForLabel, type FieldDefinition } from './pdfChatOverview';
import { scalarFieldKind } from './pdfChatScalarComparison';

export type ScalarIntent = {
  field: FieldDefinition;
  kind: 'money' | 'date';
  wording: 'compare' | 'difference' | 'change' | 'direction';
};
const PAIR_SUFFIX = /\s+(?:between (?:the )?(?:original|first) and (?:the )?(?:revised|updated|second) (?:notices|pdfs|documents|versions)|in (?:the )?both (?:notices|pdfs|documents|versions))$/i;

function recognized(label: string, wording: ScalarIntent['wording'], kind?: 'money' | 'date'): ScalarIntent | null {
  const field = fieldForLabel(label.trim());
  if (!field) return null;
  const actual = scalarFieldKind(field.id);
  if (!actual || (kind && kind !== actual)) return null;
  return { field, kind: actual, wording };
}

/** The entire question must match a supported form and exact printed
 * field vocabulary. Never discard a condition or infer applicability.
 */
export function scalarComparisonIntent(question: string): ScalarIntent | null {
  if (question.length > 400) return null;
  let clean = question.trim().replace(/\?$/, '').trim().replace(/[ \t]+/g, ' ');
  if (!clean || /[\r\n;?]/.test(clean)) return null;
  clean = clean.replace(PAIR_SUFFIX, '');
  const compare = /^compare (?:the )?(.+)$/i.exec(clean);
  if (compare) return recognized(compare[1], 'compare');
  const difference = /^(?:what is|what's|calculate|show)(?: the)? difference (?:in|of) (?:the )?(.+)$/i.exec(clean);
  if (difference) return recognized(difference[1], 'difference');
  const change = /^(?:how much did (?:the )?(.+) change|how much has (?:the )?(.+) changed|by how much did (?:the )?(.+) change)$/i.exec(clean);
  if (change) return recognized(change[1] ?? change[2] ?? change[3], 'change');
  const days = /^how many (?:calendar )?days (?:later|earlier) is (?:the )?(?:revised|updated|second) (.+?) than (?:the )?(?:original|previous|first)(?: (.+))?$/i.exec(clean);
  if (days) {
    const first = recognized(days[1], 'direction', 'date');
    if (!first || (days[2] && fieldForLabel(days[2].trim())?.id !== first.field.id)) return null;
    return first;
  }
  const money = /^how much (?:higher|lower) is (?:the )?(?:revised|updated|second) (.+?) than (?:the )?(?:original|previous|first)(?: (.+))?$/i.exec(clean);
  if (money) {
    const first = recognized(money[1], 'direction', 'money');
    if (!first || (money[2] && fieldForLabel(money[2].trim())?.id !== first.field.id)) return null;
    return first;
  }
  return null;
}
