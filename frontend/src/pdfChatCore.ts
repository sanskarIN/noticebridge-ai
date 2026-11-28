/** Bounded extractive document QA. Retrieval scores are not confidence probabilities. */
import { extractKnownField, fieldDefinitions, type ExtractedField, type FieldId } from './pdfChatOverview';
export const MAX_QUESTION = 400;
export const MAX_PASSAGES = 12000;
export const MAX_PASSAGE_CHARS = 900;
export type Role = 'original' | 'revised';
export type Scope = Role | 'both';
export type TextPosition = { x0: number; x1: number; y: number; height: number };
export type Passage = { role: Role; page: number; text: string; ordinal: number; position?: TextPosition };
export type Corpus = {
  passages: Passage[];
  missingPages: number[];
  limited: boolean;
  pageCount: number;
  processedPages: number;
  limitedPages: number[];
};
export type PageCoverage = 'not_present' | 'not_indexed' | 'no_indexed_text' | 'limited' | 'some_text';

/** "Some text" never means complete extraction, including image or hidden text. */
export function pageCoverage(corpus: Corpus, page: number): PageCoverage {
  if (!Number.isSafeInteger(page) || page < 1 || page > corpus.pageCount) return 'not_present';
  if (page > corpus.processedPages) return 'not_indexed';
  if (corpus.limitedPages.includes(page)) return 'limited';
  if (corpus.missingPages.includes(page)) return 'no_indexed_text';
  return 'some_text';
}
export type Answer = {
  kind: 'passages' | 'insufficient';
  scope: Scope;
  question: string;
  citations: Passage[];
  missingRoles: Role[];
  matchedCounts: Record<Role, number>;
  contextGroups: ContextGroup[];
  pageFilter?: number;
  printedFields: { citation: number; label: string; value: string }[];
};
export type ContextGroup = { role: Role; page: number; citations: number[] };
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
export type IndexedPassage = { passage: Passage; counts: Map<string, number>; length: number; field: ExtractedField | null };
export type SearchIndex = { rows: IndexedPassage[]; df: Map<string, number>; average: number; corpusSize: number };
// Internal acceleration only: callers still see the same SearchIndex shape.
// Indexes constructed by buildIndex and pageScopedIndex are treated as
// immutable snapshots. Foreign or spread/filter views retain the scan path.
type RoleLookup = {
  all: number[];
  terms: Map<string, number[]>;
  fields: Map<FieldId, number[]>;
  readingOrder: IndexedPassage[];
};
type RetrievalLookup = {
  rows: IndexedPassage[];
  roles: Record<Role, RoleLookup>;
  pages: Map<number, IndexedPassage[]>;
  views: Map<number, SearchIndex>;
};
const lookups = new WeakMap<SearchIndex, RetrievalLookup>();
const MAX_CACHED_PAGE_VIEWS = 8;
function emptyRoleLookup(): RoleLookup {
  return { all: [], terms: new Map(), fields: new Map(), readingOrder: [] };
}
function appendPosting<K>(map: Map<K, number[]>, key: K, ordinal: number): void {
  const existing = map.get(key);
  if (existing) existing.push(ordinal);
  else map.set(key, [ordinal]);
}
function createLookup(rows: IndexedPassage[]): RetrievalLookup {
  const roles = { original: emptyRoleLookup(), revised: emptyRoleLookup() };
  const pages = new Map<number, IndexedPassage[]>();
  rows.forEach((row, ordinal) => {
    const role = roles[row.passage.role];
    role.all.push(ordinal);
    role.readingOrder.push(row);
    for (const word of row.counts.keys()) appendPosting(role.terms, word, ordinal);
    if (row.field) appendPosting(role.fields, row.field.definition.id, ordinal);
    const page = pages.get(row.passage.page);
    if (page) page.push(row);
    else pages.set(row.passage.page, [row]);
  });
  for (const role of Object.values(roles)) {
    role.readingOrder.sort((a, b) => a.passage.page - b.passage.page ||
      a.passage.ordinal - b.passage.ordinal);
  }
  return { rows, roles, pages, views: new Map() };
}
function lookupFor(index: SearchIndex): RetrievalLookup | undefined {
  const lookup = lookups.get(index);
  return lookup?.rows === index.rows ? lookup : undefined;
}

/** Restrict candidates to a physical PDF page, retaining full-corpus BM25
 * statistics. Repeated questions share a bounded cache of derived indexes.
 * Do not rebuild document frequency from the page: that changes ranking. */
export function pageScopedIndex(index: SearchIndex, page: number): SearchIndex {
  if (!Number.isSafeInteger(page) || page < 1 || page > 80) throw new Error('Invalid physical PDF page.');
  const lookup = lookupFor(index);
  if (!lookup) return { ...index, rows: index.rows.filter(row => row.passage.page === page) };
  const existing = lookup.views.get(page);
  if (existing) {
    lookup.views.delete(page);
    lookup.views.set(page, existing);
    return existing;
  }
  const view = { ...index, rows: lookup.pages.get(page) ?? [] };
  lookups.set(view, createLookup(view.rows));
  lookup.views.set(page, view);
  if (lookup.views.size > MAX_CACHED_PAGE_VIEWS) {
    const oldest = lookup.views.keys().next();
    if (!oldest.done) lookup.views.delete(oldest.value);
  }
  return view;
}

/** A lexical match must contain every query term, so its row must appear
 * in the rarest role-specific posting. Add field-alias rows independently:
 * a known field can match even when no lexical term is shared. Preserve
 * original input order for stable ranking ties and duplicate resolution. */
function candidateOrdinals(lookup: RoleLookup, words: string[], field: FieldId | null): number[] {
  let shortest = lookup.all;
  for (const word of words) {
    const posting = lookup.terms.get(word);
    if (!posting) { shortest = []; break; }
    if (posting.length < shortest.length) shortest = posting;
  }
  const known = field === null ? undefined : lookup.fields.get(field);
  if (!known?.length || shortest === lookup.all) return shortest;
  if (!shortest.length) return known;
  // Both input postings are already ordered by their source array index.
  // Linear merge deduplicates without building a Set or sorting all rows.
  const merged: number[] = [];
  let left = 0, right = 0;
  while (left < shortest.length && right < known.length) {
    const a = shortest[left], b = known[right];
    if (a <= b) { merged.push(a); left++; if (a === b) right++; }
    else { merged.push(b); right++; }
  }
  while (left < shortest.length) merged.push(shortest[left++]);
  while (right < known.length) merged.push(known[right++]);
  return merged;
}

export function buildIndex(passages: Passage[]): SearchIndex {
  if (passages.length > MAX_PASSAGES) throw new Error('Passage budget exceeded.');
  const df = new Map<string, number>();
  const rows = passages.map(passage => {
    if (passage.text.length > MAX_PASSAGE_CHARS) throw new Error('Passage budget exceeded.');
    const words = tokens(passage.text);
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    for (const word of counts.keys()) df.set(word, (df.get(word) ?? 0) + 1);
    return { passage, counts, length: words.length, field: extractKnownField(passage) };
  });
  const index = { rows, df, corpusSize: rows.length, average: Math.max(1, rows.reduce((n, row) => n + row.length, 0) / Math.max(1, rows.length)) };
  lookups.set(index, createLookup(rows));
  return index;
}

export function queryTerms(question: string): string[] {
  // Normalize familiar notice-specific paraphrases without broad semantic guesses.
  const expanded = question
    .replace(/\blast date\b/gi, 'deadline')
    .replace(/\bclosing date\b/gi, 'deadline')
    // Do not turn "how much time" or "how much experience" into a fee query.
    .replace(/\bhow much\b/gi, '')
    .replace(/\bwho (?:can|may|is eligible to) apply\b/gi, 'eligibility')
    .replace(/\bwhen do applications close\b/gi, 'application deadline')
    .replace(/\bwhat (?:is|are) the (documents|certificates) (?:needed|required)\b/gi, 'required $1')
    // An opening date, closing date and application window are distinct.
    // A generic "when can I apply" is not automatically a deadline.
    .replace(/\bwhen (?:do|does|will) (?:the )?applications? (?:open|start|begin)\b/gi, 'application start date')
    .replace(/\bwhen (?:do|does|will) (?:the )?applications? (?:close|end)\b/gi, 'application deadline')
    .replace(/\bwhen (?:can|do|should|must) (?:i|we) apply\b/gi, 'application window')
    .replace(/\bwhen is the application due\b/gi, 'application deadline');
  return terms(expanded);
}

// An exact normalized query for one vocabulary field can retrieve the same
// field printed under a different recognized label. Additional qualifiers
// must not disappear: "application fee for rural applicants" is not a bare
// field query. If normalization makes two fields collide, abstain from expansion.
const questionFields = new Map<string, FieldId | null>();
function fieldKey(words: string[]): string {
  return [...new Set(words)].sort().join('\u0000');
}
for (const definition of fieldDefinitions) {
  for (const alias of definition.aliases) {
    const key = fieldKey(terms(alias));
    if (!key) continue;
    const prior = questionFields.get(key);
    questionFields.set(key, prior === undefined || prior === definition.id ? definition.id : null);
  }
}

export function knownQuestionField(words: string[]): FieldId | null {
  return questionFields.get(fieldKey(words)) ?? null;
}

export type RankedMatch={passage:Passage;score:number;lexical:boolean;knownField:boolean;duplicates:number};
export type MatchTermScore={term:string;tf:number;df:number;idf:number;contribution:number};
function weightedTerms(index:SearchIndex,words:string[]){
  return words.map(word=>{
    const df=index.df.get(word)??0;
    return {word,df,idf:Math.log(1+(index.corpusSize-df+0.5)/(df+0.5))};
  });
}
function termContribution(index:SearchIndex,row:IndexedPassage,tf:number,idf:number){
  return idf*tf*2.2/(tf+1.2*(0.25+0.75*row.length/index.average));
}

/** The diagnostic and displayed answer share the exact ranker. Duplicate
 * occurrences on one page are counted, not ranked as separate evidence. */
export function rankedMatchDetails(index:SearchIndex,words:string[],role:Role,field:FieldId|null):RankedMatch[]{
  const scores:RankedMatch[]=[];
  const lookup=lookupFor(index);
  const candidates=lookup?candidateOrdinals(lookup.roles[role],words,field):null;
  const count=candidates?.length??index.rows.length;
  const weighted=weightedTerms(index,words);
  for(let i=0;i<count;i++){
    const row=index.rows[candidates?candidates[i]:i];
    if(row.passage.role!==role)continue;
    const lexical=words.every(word=>row.counts.has(word));
    const knownField=field!==null&&row.field?.definition.id===field;
    if(!lexical&&!knownField)continue;
    let score=0;
    for(const {word,idf} of weighted)score+=termContribution(index,row,row.counts.get(word)??0,idf);
    scores.push({passage:row.passage,score,lexical,knownField,duplicates:0});
  }
  scores.sort((a,b)=>b.score-a.score||a.passage.page-b.passage.page||
    a.passage.ordinal-b.passage.ordinal);
  const seen=new Map<string,RankedMatch>();
  const unique:RankedMatch[]=[];
  for(const row of scores){
    const key=row.passage.page+':'+row.passage.text;
    const earlier=seen.get(key);
    if(earlier){earlier.duplicates++;continue;}
    seen.set(key,row);unique.push(row);
  }
  return unique;
}
export function rankedMatches(index:SearchIndex,words:string[],role:Role,field:FieldId|null):Passage[]{
  return rankedMatchDetails(index,words,role,field).map(row=>row.passage);
}

/** Explain one exact row using the same corpus statistics and scoring
 * formula. The caller supplies an index row identity, not imported text. */
export function matchTermScores(index:SearchIndex,source:Passage,words:string[]):MatchTermScore[]{
  const row=index.rows.find(candidate=>candidate.passage===source);
  if(!row||words.length>16||new Set(words).size!==words.length)throw new Error('Invalid retrieval explanation.');
  return weightedTerms(index,words).map(({word,df,idf})=>{
    const tf=row.counts.get(word)??0;
    return {term:word,tf,df,idf,contribution:termContribution(index,row,tf,idf)};
  });
}

/** Geometry is optional. Where both hints exist, do not combine same-baseline
 * cells, far-apart columns, reversed reading direction or distant rows.
 * This is a conservative reading-flow guard, not a proof of semantic linkage.
 */
export function sameTextFlow(first: Passage, next: Passage): boolean {
  const a = first.position, b = next.position;
  if (!a || !b) return true;
  const height = Math.max(a.height, b.height);
  const drop = a.y - b.y;
  return [a.x0, b.x0, a.y, b.y, height].every(Number.isFinite) && height > 0 &&
    drop >= height * 0.5 && drop <= height * 4 && Math.abs(a.x0 - b.x0) <= height * 2;
}

/** Adjacent-line retrieval is a fallback, not an entailment model.
 * Require all distinct query terms in a minimal contiguous window. Each
 * endpoint must contribute evidence not present in the other fragments.
 * Keep fragments separate; never turn a window into a printed value.
 */
export function contextualMatches(index: SearchIndex, words: string[], role: Role): Passage[][] {
  if (words.length < 2 || words.length > 16) return [];
  const rows = lookupFor(index)?.roles[role].readingOrder ?? index.rows.filter(row => row.passage.role === role)
    .sort((a, b) => a.passage.page - b.passage.page || a.passage.ordinal - b.passage.ordinal);
  const candidates: { rows: IndexedPassage[]; score: number }[] = [];
  const covers = (window: IndexedPassage[]) =>
    words.every(word => window.some(row => row.counts.has(word)));
  for (let start = 0; start < rows.length; start++) {
    const first = rows[start];
    // A window must start on a query-bearing fragment.
    if (!words.some(word => first.counts.has(word))) continue;
    const window = [first];
    for (let offset = 1; offset <= 2 && start + offset < rows.length; offset++) {
      const next = rows[start + offset];
      const last = window[window.length - 1];
      if (next.passage.page !== first.passage.page ||
          next.passage.ordinal !== last.passage.ordinal + 1 ||
          !sameTextFlow(last.passage, next.passage)) break;
      window.push(next);
      if (!covers(window)) continue;
      if (!covers(window.slice(1)) && !covers(window.slice(0, -1))) {
        const chars = window.reduce((n, row) => n + row.passage.text.length, 0);
        if (chars <= 1400) {
          // Prefer short minimal windows and concentrated query evidence.
          const score = words.reduce((n, word) => n + Math.log(1 +
            (index.corpusSize - (index.df.get(word) ?? 0) + 0.5) /
            ((index.df.get(word) ?? 0) + 0.5)), 0) / (1 + chars / 500 + (window.length - 2));
          candidates.push({ rows: [...window], score });
        }
      }
      // Longer windows would not be minimal.
      break;
    }
  }
  candidates.sort((a, b) => b.score - a.score ||
    a.rows[0].passage.page - b.rows[0].passage.page ||
    a.rows[0].passage.ordinal - b.rows[0].passage.ordinal);
  const seen = new Set<string>();
  const result: Passage[][] = [];
  for (const candidate of candidates) {
    const keys = candidate.rows.map(row => row.passage.page + ':' + row.passage.ordinal);
    if (keys.some(key => seen.has(key))) continue;
    keys.forEach(key => seen.add(key));
    result.push(candidate.rows.map(row => row.passage));
    if (result.length === 2) break;
  }
  return result;
}

export function answerQuestion(
  index: SearchIndex, question: string, scope: Scope, includeContext = false,
): Answer {
  const clean = question.trim();
  if (!clean || clean.length > MAX_QUESTION) throw new Error('Invalid question length.');
  const words = queryTerms(clean);
  const knownField = knownQuestionField(words);
  const roles: Role[] = scope === 'both' ? ['original', 'revised'] : [scope];
  const citations: Passage[] = [];
  const missingRoles: Role[] = [];
  const contextGroups: ContextGroup[] = [];
  const contextualCitationIds = new Set<number>();
  const matchedCounts: Record<Role, number> = { original: 0, revised: 0 };
  for (const role of roles) {
    const ranked = words.length && words.length <= 16
      ? rankedMatches(index, words, role, knownField) : [];
    const matches = ranked.slice(0, 4);
    matchedCounts[role] = ranked.length;
    if (matches.length) {
      citations.push(...matches);
      continue;
    }
    const windows = includeContext ? contextualMatches(index, words, role) : [];
    if (!windows.length) missingRoles.push(role);
    for (const window of windows) {
      const ids = window.map((_, i) => citations.length + i + 1);
      ids.forEach(id => contextualCitationIds.add(id));
      contextGroups.push({ role, page: window[0].page, citations: ids });
      citations.push(...window);
    }
  }
  return {
    kind: citations.length ? 'passages' : 'insufficient',
    scope, question: clean, citations, missingRoles, matchedCounts, contextGroups,
    printedFields: citations.flatMap((passage, i) => {
      // Only a literal colon-delimited printed field whose label covers all
      // query terms qualifies for the compact answer. Never synthesize values.
      if (contextualCitationIds.has(i + 1)) return [];
      const colon = passage.text.indexOf(':');
      if (colon <= 0 || colon > 100) return [];
      const label = passage.text.slice(0, colon).trim();
      const value = passage.text.slice(colon + 1).trim();
      const labelTerms = terms(label);
      const known = knownField !== null && extractKnownField(passage)?.definition.id === knownField;
      if (!value || value.length > 300 || (!known && !words.every(word => labelTerms.includes(word)))) return [];
      // If the row looks like a recognized field but has a second field in
      // its value, avoid promoting the ambiguous line to a printed answer.
      if (knownQuestionField(labelTerms) !== null && !extractKnownField(passage)) return [];
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
