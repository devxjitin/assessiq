// Exam integrity helpers: device and network flags, and code similarity between students.

// ------------------------------------------------------------------- limits

export const INTEGRITY = {
  /** Device ids are random strings made by the browser; anything outside this is rejected. */
  DEVICE_ID_PATTERN: /^[A-Za-z0-9_-]{16,64}$/,
  /** Wrong exam codes one student may try in the window below before being paused. */
  JOIN_MISS_LIMIT: 8,
  JOIN_MISS_WINDOW_MS: 10 * 60_000,
  /** Code answers whose similarity is at least this (0 to 1) are reported. */
  SIMILARITY_THRESHOLD: 0.8,
  /** Shorter programs than this (in tokens) are too small to compare fairly. */
  MIN_TOKENS: 30,
  /** Most answers compared per question, to keep the report quick. */
  MAX_COMPARED: 600,
} as const;

// -------------------------------------------------------------------- flags

export type IntegrityFlagCode =
  'SHARED_DEVICE' | 'DEVICE_MISMATCH' | 'NETWORK_CHANGED' | 'NO_DEVICE_ID';

export interface IntegrityFlag {
  code: IntegrityFlagCode;
  /** Plain-language line for the trainer. */
  message: string;
}

export interface IntegrityDto {
  startIp: string | null;
  lastIp: string | null;
  userAgent: string | null;
  hasDeviceId: boolean;
  /** Other students in this exam who used the same device. */
  sharedWith: { name: string; email: string }[];
  flags: IntegrityFlag[];
}

export const FLAG_TEXT: Record<IntegrityFlagCode, string> = {
  SHARED_DEVICE: 'The same device was used by more than one student',
  DEVICE_MISMATCH: 'Another device tried to continue this attempt (blocked)',
  NETWORK_CHANGED: 'The network address changed during the exam',
  NO_DEVICE_ID: 'The browser did not identify its device',
};

/**
 * Turns what the server recorded into flags. These are signals for a human to look at, not
 * proof: classrooms share networks, phones change networks, and browsers can be reset.
 */
export function integrityFlags(input: {
  hasDeviceId: boolean;
  sharedDeviceCount: number;
  mismatchEvents: number;
  startIp: string | null;
  lastIp: string | null;
}): IntegrityFlag[] {
  const codes: IntegrityFlagCode[] = [];
  if (input.sharedDeviceCount > 0) codes.push('SHARED_DEVICE');
  if (input.mismatchEvents > 0) codes.push('DEVICE_MISMATCH');
  if (input.startIp && input.lastIp && input.startIp !== input.lastIp)
    codes.push('NETWORK_CHANGED');
  if (!input.hasDeviceId) codes.push('NO_DEVICE_ID');
  return codes.map((code) => ({ code, message: FLAG_TEXT[code] }));
}

// --------------------------------------------------------------- similarity

const KEYWORDS = new Set(
  (
    'if else elif for while do switch case break continue return def class import from as with try ' +
    'except finally raise lambda pass in is not and or true false none null void int long short char ' +
    'float double bool boolean string str public private protected static final new this self ' +
    'function const let var print printf scanf cin cout endl main include using namespace std ' +
    'range len input System out println Scanner String Math'
  ).split(' '),
);

/**
 * Reduces source code to a stream of tokens that ignores what students change when they copy:
 * comments, spacing, variable names, literal values.
 */
export function tokenize(source: string): string[] {
  const s = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/(^|[^\w])#[^\n]*/g, '$1 ');
  const out: string[] = [];
  const re = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\d+(?:\.\d+)?|[A-Za-z_]\w*|[^\s\w]/g;
  for (const m of s.matchAll(re)) {
    const t = m[0];
    if (t[0] === '"' || t[0] === "'") out.push('STR');
    else if (/^\d/.test(t)) out.push('NUM');
    else if (/^[A-Za-z_]/.test(t)) out.push(KEYWORDS.has(t) ? t : 'ID');
    else out.push(t);
  }
  return out;
}

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

const K = 5;

/** The set of hashed token 5-grams of a program. Two programs are alike if they share many. */
export function fingerprint(source: string): { tokens: number; grams: Set<number> } {
  const t = tokenize(source);
  const grams = new Set<number>();
  for (let i = 0; i + K <= t.length; i++) grams.add(hash(t.slice(i, i + K).join(' ')));
  return { tokens: t.length, grams };
}

/** Share of 5-grams two programs have in common, 0 to 1 (Jaccard). `ignore` removes starter code. */
export function similarity(a: Set<number>, b: Set<number>, ignore?: Set<number>): number {
  let inter = 0;
  let sizeA = 0;
  for (const g of a) {
    if (ignore?.has(g)) continue;
    sizeA++;
    if (b.has(g)) inter++;
  }
  let sizeB = 0;
  for (const g of b) if (!ignore?.has(g)) sizeB++;
  const union = sizeA + sizeB - inter;
  return union === 0 ? 0 : inter / union;
}

export interface SimilarityEntry {
  attemptId: string;
  source: string;
}

export interface SimilarityHit {
  a: string;
  b: string;
  /** 0 to 1 */
  score: number;
}

/**
 * Finds pairs of answers that are suspiciously alike. An index of shared 5-grams keeps this fast
 * with hundreds of answers: only pairs that share at least one gram are ever compared.
 */
export function findSimilar(
  entries: SimilarityEntry[],
  options: { threshold?: number; starter?: string } = {},
): { hits: SimilarityHit[]; compared: number } {
  const threshold = options.threshold ?? INTEGRITY.SIMILARITY_THRESHOLD;
  const ignore = options.starter?.trim() ? fingerprint(options.starter).grams : undefined;
  const prints = entries
    .slice(0, INTEGRITY.MAX_COMPARED)
    .map((e) => ({ id: e.attemptId, ...fingerprint(e.source) }))
    .filter((p) => p.tokens >= INTEGRITY.MIN_TOKENS);

  const index = new Map<number, number[]>();
  prints.forEach((p, i) => {
    for (const g of p.grams) {
      if (ignore?.has(g)) continue;
      const list = index.get(g);
      if (list) list.push(i);
      else index.set(g, [i]);
    }
  });
  const candidates = new Set<number>();
  for (const list of index.values()) {
    if (list.length > 60) continue; // boilerplate everybody has says nothing
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) candidates.add(list[x] * 100_000 + list[y]);
  }
  const hits: SimilarityHit[] = [];
  for (const c of candidates) {
    const i = Math.floor(c / 100_000);
    const j = c % 100_000;
    const score = similarity(prints[i].grams, prints[j].grams, ignore);
    if (score >= threshold) hits.push({ a: prints[i].id, b: prints[j].id, score });
  }
  return { hits: hits.sort((x, y) => y.score - x.score), compared: prints.length };
}

export interface SimilarityReportDto {
  threshold: number;
  questions: {
    questionId: string;
    number: number;
    body: string;
    /** How many answers were long enough to compare. */
    compared: number;
    pairs: {
      similarity: number;
      a: { attemptId: string; name: string; email: string };
      b: { attemptId: string; name: string; email: string };
    }[];
  }[];
}
