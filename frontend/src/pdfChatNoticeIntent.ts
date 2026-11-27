/** Exact question templates for commonly printed notice fields.
 * Do not infer field intent from arbitrary synonyms or discard qualifiers.
 */
import { fieldDefinitions, fieldForLabel, type FieldDefinition, type FieldId } from './pdfChatOverview';

type Rule = { field: FieldId; pattern: RegExp };
const rules: readonly Rule[] = [
  { field: 'application_fee', pattern: /^(?:how much (?:is|are) (?:the )?application (?:fee|fees|charge|charges)|what (?:amount|fee) (?:must|should|do) (?:i|we) pay (?:to apply|for (?:the )?application))$/i },
  { field: 'registration_fee', pattern: /^(?:how much (?:is|are) (?:the )?registration (?:fee|fees|charge|charges)|what (?:amount|fee) (?:must|should|do) (?:i|we) pay (?:to register|for registration))$/i },
  { field: 'exam_fee', pattern: /^how much (?:is|are) (?:the )?(?:exam|examination) (?:fee|fees)$/i },
  { field: 'application_deadline', pattern: /^(?:what is (?:the )?(?:last day|final day) to apply|until when can (?:i|we) apply|by what date (?:must|should) (?:i|we) submit (?:the )?application)$/i },
  { field: 'registration_deadline', pattern: /^(?:what is (?:the )?(?:last day|last date|final day) to register|until when can (?:i|we) register|by what date (?:must|should) (?:i|we) register)$/i },
  { field: 'application_start', pattern: /^(?:on what date (?:do|will) (?:the )?applications? (?:open|start|begin)|from what date can (?:i|we) apply)$/i },
  { field: 'registration_start', pattern: /^(?:on what date (?:does|will) (?:the )?registration (?:open|start|begin)|from what date can (?:i|we) register)$/i },
  { field: 'eligibility', pattern: /^(?:who (?:can|may|is eligible to) apply|who is eligible (?:to apply|for (?:the )?application)|what (?:qualifications|educational qualifications) (?:do|must) (?:i|we) (?:need|have))$/i },
  { field: 'exam_date', pattern: /^(?:on which date (?:is|will be) (?:the )?(?:exam|examination)|when will (?:the )?(?:exam|examination) (?:be held|take place))$/i },
  { field: 'interview_date', pattern: /^(?:on which date (?:is|will be) (?:the )?interview|when will (?:the )?interview (?:be held|take place))$/i },
  { field: 'verification_date', pattern: /^(?:on which date (?:is|will be) (?:the )?document verification|when will (?:the )?document verification (?:be held|take place))$/i },
  { field: 'application_portal', pattern: /^(?:what (?:is|are) (?:the )?link (?:to|for) (?:the )?online application|which portal (?:should|must|can) (?:i|we) use to apply)$/i },
  { field: 'contact_email', pattern: /^(?:where (?:should|can) (?:i|we) send (?:an )?email (?:to|for) (?:the )?helpdesk|what is (?:the )?email address (?:of|for) (?:the )?helpdesk)$/i },
  { field: 'contact_phone', pattern: /^(?:what is (?:the )?(?:phone|telephone) number (?:of|for) (?:the )?helpdesk|which number (?:should|can) (?:i|we) call (?:for|to reach) (?:the )?helpdesk)$/i },
  { field: 'selection_process', pattern: /^(?:how (?:are|will) (?:the )?(?:applicants|candidates) (?:be )?selected|what (?:are|is) (?:the )?stages? of (?:the )?selection process)$/i },
  { field: 'application_deadline', pattern: /^(?:when do (?:the )?applications close|when does (?:the )?application close|when is (?:the )?last date to apply)$/i },
  { field: 'application_start', pattern: /^(?:when do (?:the )?applications open|when does (?:the )?application open)$/i },
  { field: 'registration_start', pattern: /^when does (?:the )?registration (?:open|start|begin)$/i },
  { field: 'registration_deadline', pattern: /^when does (?:the )?registration (?:close|end)$/i },
  { field: 'payment_deadline', pattern: /^(?:when is (?:the )?(?:fee )?payment due|what is (?:the )?deadline for (?:fee )?payment|when is (?:the )?last date for fee payment)$/i },
  { field: 'correction_start', pattern: /^when does (?:the )?(?:application )?correction window (?:open|start|begin)$/i },
  { field: 'correction_deadline', pattern: /^when does (?:the )?(?:application )?correction window (?:close|end)$/i },
  { field: 'admit_card_date', pattern: /^(?:when (?:is|will) (?:the )?(?:admit card|hall ticket) (?:be )?(?:released|issued)|when does (?:the )?(?:admit card|hall ticket) release)$/i },
  { field: 'result_date', pattern: /^when (?:is|will) (?:the )?result (?:be )?(?:declared|announced|published)$/i },
  { field: 'exam_date', pattern: /^(?:when is (?:the )?(?:exam|examination)|on what date is (?:the )?(?:exam|examination))$/i },
  { field: 'exam_time', pattern: /^(?:what time is (?:the )?(?:exam|examination)|at what time does (?:the )?(?:exam|examination) (?:start|begin))$/i },
  { field: 'exam_venue', pattern: /^(?:where is (?:the )?(?:exam|examination)|where will (?:the )?(?:exam|examination) take place)$/i },
  { field: 'interview_date', pattern: /^(?:when is (?:the )?interview|on what date is (?:the )?interview)$/i },
  { field: 'interview_time', pattern: /^what time is (?:the )?interview$/i },
  { field: 'interview_venue', pattern: /^(?:where is (?:the )?interview|where will (?:the )?interview take place)$/i },
  { field: 'verification_date', pattern: /^(?:when is (?:the )?document verification|on what date is (?:the )?document verification)$/i },
  { field: 'verification_time', pattern: /^what time is (?:the )?document verification$/i },
  { field: 'verification_venue', pattern: /^(?:where is (?:the )?document verification|where will (?:the )?document verification take place)$/i },
  { field: 'reporting_time', pattern: /^what time (?:should|must) (?:i|we) report$/i },
  { field: 'reporting_venue', pattern: /^where (?:should|must) (?:i|we) report$/i },
  { field: 'documents', pattern: /^(?:what (?:documents|certificates) (?:should|must) (?:i|we) (?:bring|submit|provide)|which (?:documents|certificates) are (?:required|needed))$/i },
  { field: 'application_method', pattern: /^(?:how (?:do|should|can) (?:i|we) apply|how (?:do|should) (?:i|we) submit (?:the )?application)$/i },
  { field: 'application_portal', pattern: /^(?:where (?:do|should|can) (?:i|we) apply online|which website (?:should|must) (?:i|we) use to apply)$/i },
  { field: 'payment_method', pattern: /^how (?:do|should|can) (?:i|we) pay (?:the )?fee$/i },
  { field: 'contact_email', pattern: /^(?:what is (?:the )?helpdesk email address|which email address (?:should|can) (?:i|we) contact)$/i },
  { field: 'contact_phone', pattern: /^(?:what is (?:the )?helpdesk phone number|which (?:phone|telephone) number (?:should|can) (?:i|we) call)$/i },
  { field: 'minimum_age', pattern: /^how old (?:must|should) (?:i|we) be at least$/i },
  { field: 'maximum_age', pattern: /^what is (?:the )?maximum permitted age$/i },
  { field: 'vacancy_count', pattern: /^how many vacancies (?:are there|are available)$/i },
];

const byId = new Map<FieldId, FieldDefinition>(fieldDefinitions.map(field => [field.id, field]));
export type NoticeIntent = { field: FieldDefinition; form: 'label' | 'template' };

/** Full-form matching only, after explicit source and physical page
 * routing have been separated by the caller. The label path accepts
 * fixed printed aliases, not arbitrary text with similar words.
 */
export function noticeFieldIntent(question: string): NoticeIntent | null {
  if (!question || question.length > 400) return null;
  const clean = question.trim().replace(/\?$/, '').trim().replace(/[ \t]+/g, ' ');
  if (!clean || /[\r\n;?]/.test(clean)) return null;
  const label = clean.replace(/^(?:what (?:is|are)|what's|tell me|show me|(?:can|could|would) you (?:please )?(?:tell|show) me|please (?:tell|show) me)\s+(?:the\s+)?/i, '');
  const field = fieldForLabel(label);
  if (field) return { field, form: 'label' };
  const matched = rules.filter(rule => rule.pattern.test(clean));
  if (matched.length !== 1) return null;
  const definition = byId.get(matched[0].field);
  return definition ? { field: definition, form: 'template' } : null;
}
