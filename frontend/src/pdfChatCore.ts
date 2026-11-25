/** Bounded extractive document QA. Retrieval scores are not confidence probabilities. */
export const MAX_QUESTION = 400;
export const MAX_PASSAGES = 12000;
export const MAX_PASSAGE_CHARS = 900;
export type Role = 'original' | 'revised';
export type Scope = Role | 'both';
export type Passage = { role: Role; page: number; text: string; ordinal: number };
export type Corpus = { passages: Passage[]; missingPages: number[]; limited: boolean };
export type Answer = {
  kind: 'passages' | 'insufficient';
  scope: Scope;
  question: string;
  citations: Passage[];
  missingRoles: Role[];
  matchedCounts: Record<Role, number>;
  printedFields: { citation: number; label: string; value: string }[];
};
const STOP = new Set(('what which when where who how is are was were be been being the a an of to for in on at from by with and or does do did can could would should will shall me tell please show find give about pdf notice original revised updated old new both previous version current i we you it its this that these those as per mentioned stated according information detail details change changed changes compare between versus vs much many').split(' '));
const ALIASES: Record<string, string> = {
  fees: 'fee', cost: 'fee', costs: 'fee', charges: 'fee', charge: 'fee',
  deadlines: 'deadline', closing: 'deadline', cutoff: 'deadline',
  eligible: 'eligibility', qualifications: 'eligibility', qualification: 'eligibility',
  requirements: 'requirement', documents: 'document', certificates: 'certificate', required: 'requirement',
  timings: 'time', timing: 'time', starts: 'start', begins: 'start',
  applicants: 'applicant', applications: 'application', exams: 'exam',
  examinations: 'exam', examination: 'exam', dates: 'date',
  registration: 'registration', register: 'registration',
};
function tokens(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
    .replace(/\b(?:last date|closing date|cut-off date|cutoff date|due date)\b/g, 'deadline')
    .replace(/\bapplications? (?:close|closes)\b/g, 'application deadline')
    .replace(/\bapplication charges?\b/g, 'application fee')
    .replace(/\b(?:eligibility criteria|eligibility conditions)\b/g, 'eligibility');
  return (normalized.match(/[\p{L}\p{N}]+/gu) ?? [])
    .map(word => Object.prototype.hasOwnProperty.call(ALIASES, word) ? ALIASES[word] : word)
    .filter(word => !STOP.has(word));
}
function terms(text: string): string[] {
  return [...new Set(tokens(text))];
}
export type IndexedPassage = { passage: Passage; counts: Map<string, number>; length: number };
export type SearchIndex = { rows: IndexedPassage[]; df: Map<string, number>; average: number };
export function buildIndex(passages: Passage[]): SearchIndex {
  if (passages.length > MAX_PASSAGES) throw new Error('Passage budget exceeded.');
  const df = new Map<string, number>();
  const rows = passages.map(passage => {
    if (passage.text.length > MAX_PASSAGE_CHARS) throw new Error('Passage budget exceeded.');
    const words = tokens(passage.text);
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    for (const word of counts.keys()) df.set(word, (df.get(word) ?? 0) + 1);
    return { passage, counts, length: words.length };
  });
  return { rows, df, average: Math.max(1, rows.reduce((n, row) => n + row.length, 0) / Math.max(1, rows.length)) };
}

function queryTerms(question: string): string[] {
  // Normalize familiar notice-specific paraphrases without broad semantic guesses.
  const expanded = question
    .replace(/\blast date\b/gi, 'deadline')
    .replace(/\bclosing date\b/gi, 'deadline')
    // Do not turn "how much time" or "how much experience" into a fee query.
    .replace(/\bhow much\b/gi, '')
    .replace(/\bwho (?:can|may|is eligible to) apply\b/gi, 'eligibility')
    .replace(/\bwhen do applications close\b/gi, 'application deadline')
    .replace(/\bwhat (?:is|are) the (documents|certificates) (?:needed|required)\b/gi, 'required $1')
    .replace(/\bwhen (?:can|do|should|must) (?:i|we) apply\b/gi, 'application deadline')
    .replace(/\bwhen is the application due\b/gi, 'application deadline');
  return terms(expanded);
}

function rank(index: SearchIndex, words: string[], role: Role): { matches: Passage[]; count: number } {
  // Full query-term coverage prevents a result based solely on a generic
  // shared word such as "application". This is intentionally conservative.
  const scores = [];
  for (const row of index.rows) {
    if (row.passage.role !== role || !words.every(word => row.counts.has(word))) continue;
    let score = 0;
    for (const word of words) {
      const df = index.df.get(word) ?? 0;
      const tf = row.counts.get(word) ?? 0;
      const idf = Math.log(1 + (index.rows.length - df + 0.5) / (df + 0.5));
      score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * row.length / index.average));
    }
    scores.push({ passage: row.passage, score });
  }
  scores.sort((a, b) => b.score - a.score || a.passage.page - b.passage.page ||
    a.passage.ordinal - b.passage.ordinal);
  // Keep repeated wording on distinct pages: it may be relevant to ambiguity.
  const seen = new Set<string>();
  const unique = scores.filter(({ passage }) => {
    const key = passage.page + ':' + passage.text;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { matches: unique.slice(0, 4).map(row => row.passage), count: unique.length };
}

export function answerQuestion(index: SearchIndex, question: string, scope: Scope): Answer {
  const clean = question.trim();
  if (!clean || clean.length > MAX_QUESTION) throw new Error('Invalid question length.');
  const words = queryTerms(clean);
  const roles: Role[] = scope === 'both' ? ['original', 'revised'] : [scope];
  const citations: Passage[] = [];
  const missingRoles: Role[] = [];
  const matchedCounts: Record<Role, number> = { original: 0, revised: 0 };
  for (const role of roles) {
    const { matches, count } = words.length && words.length <= 16
      ? rank(index, words, role) : { matches: [], count: 0 };
    matchedCounts[role] = count;
    if (matches.length) citations.push(...matches);
    else missingRoles.push(role);
  }
  return {
    kind: citations.length ? 'passages' : 'insufficient',
    scope, question: clean, citations, missingRoles, matchedCounts,
    printedFields: citations.flatMap((passage, i) => {
      // Only a literal colon-delimited printed field whose label covers all
      // query terms qualifies for the compact answer. Never synthesize values.
      const colon = passage.text.indexOf(':');
      if (colon <= 0 || colon > 100) return [];
      const label = passage.text.slice(0, colon).trim();
      const value = passage.text.slice(colon + 1).trim();
      const labelTerms = terms(label);
      if (!value || value.length > 300 || !words.every(word => labelTerms.includes(word))) return [];
      return [{ citation: i + 1, label, value }];
    }),
  };
}

/** Follow-ups reuse the previous explicit question only on user request.
 * Do not use previous assistant output as evidence or infer pronoun referents.
 */
export function resolveQuestion(input: string, previous: string | null, reuse: boolean): string {
  const clean = input.trim();
  if (!clean || clean.length > MAX_QUESTION) throw new Error('Invalid question length.');
  if (!reuse) return clean;
  if (!previous) throw new Error('No previous question to reuse.');
  const combined = previous + ' ' + clean;
  if (combined.length > MAX_QUESTION) throw new Error('Combined question is too long.');
  return combined;
}
