/** Closed compound-query grammar. Each emitted question is independently
 * searchable and carries the same explicit trailing source/page route.
 * Never split free-form requirements, alternatives or qualified clauses.
 */
type Route = { subject: string; suffix: string };
const PAGE_SUFFIX = /\s+(?:on|in|from)\s+(?:physical\s+)?(?:pdf\s+)?page\s+[0-9]+$/i;
const SOURCE_SUFFIX = /\s+(?:in|from|of|on)\s+(?:the\s+)?(?:(?:original|previous|earlier|first|updated|revised|second)\s+(?:pdf|notice|document|version)|both\s+(?:pdfs?|notices?|documents?|versions?))$/i;
const SEPARATOR = /\s*,\s*(?:and\s+)?|\s+and\s+/i;

/** Only one trailing route of each kind, in either order, is accepted.
 * Preserve the exact original suffix, including the page number: the
 * shared physical-page validator remains responsible for its validity.
 */
export function trailingQuestionRoute(question: string): Route | null {
  const clean = question.trim().replace(/\?$/, '').trim();
  if (!clean || /[\r\n;?]/.test(clean)) return null;
  let subject = clean;
  let source = false, page = false;
  for (let i = 0; i < 3; i++) {
    const pageMatch = PAGE_SUFFIX.exec(subject), sourceMatch = SOURCE_SUFFIX.exec(subject);
    const match = pageMatch ?? sourceMatch;
    if (!match) break;
    if (pageMatch) {
      if (page) return null;
      page = true;
    } else {
      if (source) return null;
      source = true;
    }
    subject = subject.slice(0, match.index).trimEnd();
  }
  return { subject, suffix: clean.slice(subject.length) };
}
type EventPart = 'date' | 'time' | 'venue';
const eventNames: Record<string, string> = {
  exam: 'Examination', examination: 'Examination', interview: 'Interview',
  'document verification': 'Document verification',
};
const eventFields = new Set<EventPart>(['date', 'time', 'venue']);
function list<T extends string>(value: string, allowed: ReadonlySet<T>): T[] | null {
  const parts = value.toLowerCase().split(SEPARATOR).map(part => part.trim()) as T[];
  if (parts.length < 2 || parts.length > 3 || new Set(parts).size !== parts.length ||
      parts.some(part => !allowed.has(part))) return null;
  return parts;
}
function eventQuestions(subject: string): string[] | null {
  const event = '(exam|examination|interview|document verification)';
  // Explicit date/time/venue lists preserve requested order. "When"
  // follows the existing date-question convention, never both date and
  // time unless the user also explicitly asks for time.
  const named = new RegExp('^what (?:is|are) (?:the )?(.+?) (?:of|for) (?:the )?' + event + '$', 'i').exec(subject)
    ?? new RegExp('^(?:on )?what (.+?) (?:is|are|will be) (?:the )?' + event + '$', 'i').exec(subject)
    ?? new RegExp('^what (.+?) will (?:the )?' + event + ' (?:be held|take place)$', 'i').exec(subject);
  if (named) {
    const fields = list(named[1], eventFields);
    if (fields) return fields.map(field => eventNames[named[2].toLowerCase()] + ' ' + field);
  }
  const coordinated = new RegExp('^(when and where|where and when|where and at what time|at what time and where) (?:is|will be) (?:the )?' + event + '$', 'i').exec(subject)
    ?? new RegExp('^(when and where|where and when|where and at what time|at what time and where) will (?:the )?' + event + ' (?:be held|take place)$', 'i').exec(subject);
  if (!coordinated) return null;
  const pair: Record<string, EventPart[]> = {
    'when and where': ['date', 'venue'], 'where and when': ['venue', 'date'],
    'where and at what time': ['venue', 'time'], 'at what time and where': ['time', 'venue'],
  };
  return pair[coordinated[1].toLowerCase()].map(field =>
    eventNames[coordinated[2].toLowerCase()] + ' ' + field);
}
type WindowPart = 'start date' | 'opening date' | 'deadline' | 'last date' | 'fee' | 'eligibility';
function windowQuestions(subject: string): string[] | null {
  const match = /^(?:what (?:is|are) (?:the )?)?((?:application )?correction window|application|registration) (.+)$/i.exec(subject);
  if (!match) return null;
  const domain = match[1].toLowerCase();
  const correction = domain.endsWith('correction window');
  const allowed = new Set<WindowPart>(['start date', 'opening date', 'deadline', 'last date']);
  if (!correction) allowed.add('fee');
  if (domain === 'application') allowed.add('eligibility');
  const fields = list(match[2], allowed);
  if (!fields) return null;
  const canonical = fields.map(field => {
    if (field === 'eligibility') return 'Eligibility';
    const start = field === 'start date' || field === 'opening date';
    const deadline = field === 'last date' || field === 'deadline';
    if (correction) return 'Correction window ' + (start ? 'opening date' : 'deadline');
    if (domain === 'registration') return 'Registration ' + (start ? 'opening date' : deadline ? 'deadline' : 'fee');
    return 'Application ' + (start ? 'start date' : deadline ? 'deadline' : 'fee');
  });
  // Distinct spellings of the same field are not two distinct questions.
  if (new Set(canonical).size !== canonical.length) return null;
  return canonical;
}
/** Return null for anything outside the closed grammar. The caller
 * retains its original question rather than partially interpreting it.
 */
export function planStructuredQuestions(question: string): string[] | null {
  const route = trailingQuestionRoute(question);
  if (!route) return null;
  const subject = route.subject.replace(/[ \t]+/g, ' ');
  const parts = eventQuestions(subject) ?? windowQuestions(subject);
  return parts?.map(part => part + route.suffix) ?? null;
}
