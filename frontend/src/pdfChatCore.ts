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
};
const STOP = new Set(('what which when where who how is are was were be been being the a an of to for in on at from by with and or does do did can could would should will shall me tell please show find give about document pdf notice original revised updated old new both previous version current it its this that these those as per mentioned stated according information detail details change changed changes compare between versus vs much many').split(' '));
const ALIASES: Record<string, string> = {
  fees: 'fee', cost: 'fee', costs: 'fee', charges: 'fee', charge: 'fee',
  deadlines: 'deadline', closing: 'deadline', cutoff: 'deadline',
  eligible: 'eligibility', qualifications: 'eligibility', qualification: 'eligibility',
  requirements: 'requirement', documents: 'document', certificates: 'certificate',
  timings: 'time', timing: 'time', starts: 'start', begins: 'start',
  applicants: 'applicant', applications: 'application', exams: 'exam',
  examinations: 'exam', examination: 'exam', dates: 'date',
  registration: 'registration', register: 'registration',
};
function tokens(text: string): string[] {
  return (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .map(word => ALIASES[word] ?? word).filter(word => !STOP.has(word));
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
    .replace(/\bhow much\b/gi, 'fee')
    .replace(/\bwho can apply\b/gi, 'eligibility')
    .replace(/\bwhen (?:can|do|should|must) (?:i|we) apply\b/gi, 'application deadline')
    .replace(/\bwhen is the application due\b/gi, 'application deadline');
  return terms(expanded);
}

function rank(index: SearchIndex, words: string[], role: Role): Passage[] {
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
  return scores.filter(({ passage }) => {
    const key = passage.page + ':' + passage.text;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4).map(row => row.passage);
}

export function answerQuestion(index: SearchIndex, question: string, scope: Scope): Answer {
  const clean = question.trim();
  if (!clean || clean.length > MAX_QUESTION) throw new Error('Invalid question length.');
  const words = queryTerms(clean);
  const roles: Role[] = scope === 'both' ? ['original', 'revised'] : [scope];
  const citations: Passage[] = [];
  const missingRoles: Role[] = [];
  for (const role of roles) {
    const matches = words.length && words.length <= 16 ? rank(index, words, role) : [];
    if (matches.length) citations.push(...matches);
    else missingRoles.push(role);
  }
  return {
    kind: citations.length ? 'passages' : 'insufficient',
    scope, question: clean, citations, missingRoles,
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
