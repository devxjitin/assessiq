import { describe, expect, it } from 'vitest';
import { findSimilar, fingerprint, integrityFlags, similarity, tokenize } from './integrity';

describe('tokenize', () => {
  it('ignores comments, names, numbers and strings', () => {
    const a = tokenize('x = 10  # ten\nprint("hello")');
    const b = tokenize('total = 99\nprint("bye")');
    expect(a).toEqual(b);
  });
  it('keeps the structure that makes a program', () => {
    expect(tokenize('for i in range(3): print(i)')).toContain('for');
    expect(tokenize('a + b')).not.toEqual(tokenize('a - b'));
    expect(tokenize('int a; // c\n/* block */ int b;')).toEqual(tokenize('int a; int b;'));
  });
});

describe('similarity', () => {
  const base =
    'def f(a):\n  s = 0\n  for x in a:\n    s += x\n  return s\nprint(f([1,2,3]))\nprint(f([4]))';
  it('is 1 for a renamed copy and low for a different program', () => {
    const copy = base.replace(/\bs\b/g, 'acc').replace(/\bx\b/g, 'item');
    const other =
      'import sys\nwords = sys.stdin.read().split()\nprint(len(set(words)), sorted(words)[0])';
    const f = fingerprint(base).grams;
    expect(similarity(f, fingerprint(copy).grams)).toBe(1);
    expect(similarity(f, fingerprint(other).grams)).toBeLessThan(0.2);
  });
  it('can leave out starter code everybody shares', () => {
    const starter = 'def solve(a, b):\n    pass\n\nsolve(1, 2)\nprint(solve(3, 4))\n';
    const x = starter + 'print("x")';
    const y = starter + 'import os\nprint(os.getcwd())';
    const g = fingerprint(starter).grams;
    expect(similarity(fingerprint(x).grams, fingerprint(y).grams)).toBeGreaterThan(0.2);
    expect(similarity(fingerprint(x).grams, fingerprint(y).grams, g)).toBeLessThan(0.2);
  });
  it('finds only the alike pairs and skips tiny programs', () => {
    const copy = base.replace(/\bs\b/g, 'acc');
    const other =
      'import sys\nfor line in sys.stdin:\n  parts = line.split()\n  print(len(parts), parts[0], parts[-1])\nprint(1)';
    const { hits, compared } = findSimilar([
      { attemptId: 'a', source: base },
      { attemptId: 'b', source: copy },
      { attemptId: 'c', source: other },
      { attemptId: 'd', source: 'print(1)' },
    ]);
    expect(compared).toBe(3);
    expect(hits).toHaveLength(1);
    expect([hits[0].a, hits[0].b].sort()).toEqual(['a', 'b']);
  });
});

describe('integrityFlags', () => {
  const clean = {
    hasDeviceId: true,
    sharedDeviceCount: 0,
    mismatchEvents: 0,
    startIp: '1.1.1.1',
    lastIp: '1.1.1.1',
  };
  it('is empty for a normal attempt', () => {
    expect(integrityFlags(clean)).toEqual([]);
  });
  it('lists every signal', () => {
    const codes = integrityFlags({
      hasDeviceId: false,
      sharedDeviceCount: 1,
      mismatchEvents: 2,
      startIp: '1.1.1.1',
      lastIp: '2.2.2.2',
    }).map((f) => f.code);
    expect(codes).toEqual(['SHARED_DEVICE', 'DEVICE_MISMATCH', 'NETWORK_CHANGED', 'NO_DEVICE_ID']);
  });
});
