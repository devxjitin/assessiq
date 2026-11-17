import { describe, expect, it } from 'vitest';
import type { CodeLanguage } from '@assessiq/shared';
import { Judge0Runner, RunRequest } from './code-runner';

/**
 * Talks to a real Judge0. Skipped unless LIVE_JUDGE0_URL is set, e.g.
 *   LIVE_JUDGE0_URL=http://localhost:2358 npx vitest run src/code/judge0.live.test.ts
 */
const url = process.env.LIVE_JUDGE0_URL;
const runner = url ? new Judge0Runner(url, undefined, 'process') : undefined;

const base = (language: CodeLanguage, source: string, stdin = ''): RunRequest => ({
  language,
  source,
  stdin,
  timeLimitMs: 2000,
  memoryMb: 128,
});
const run = (req: RunRequest) => runner!.run(req);

describe.skipIf(!url)('real Judge0', () => {
  const sums: [CodeLanguage, string][] = [
    ['python', 'a,b=map(int,input().split())\nprint(a+b)'],
    [
      'c',
      '#include <stdio.h>\nint main(){int a,b;scanf("%d %d",&a,&b);printf("%d\\n",a+b);return 0;}',
    ],
    ['cpp', '#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<std::endl;}'],
    [
      'java',
      'import java.util.*;\npublic class Main{public static void main(String[] x){Scanner s=new Scanner(System.in);System.out.println(s.nextInt()+s.nextInt());}}',
    ],
    [
      'javascript',
      'const [a,b]=require("fs").readFileSync(0,"utf8").trim().split(" ").map(Number);console.log(a+b);',
    ],
  ];

  for (const [lang, src] of sums) {
    it(`runs ${lang}`, async () => {
      const out = await run({ ...base(lang, src, '2 3'), memoryMb: lang === 'java' ? 512 : 128 });
      expect(out.status).toBe('OK');
      expect(out.stdout.trim()).toBe('5');
    }, 60_000);
  }

  it('reports compile errors', async () => {
    const out = await run(base('c', 'int main( { return 0; }'));
    expect(out.status).toBe('COMPILE_ERROR');
    expect(out.stderr.length).toBeGreaterThan(0);
  });

  it('reports runtime errors', async () => {
    const out = await run(base('python', 'print(1/0)'));
    expect(out.status).toBe('RUNTIME_ERROR');
    expect(out.stderr).toMatch(/ZeroDivisionError/);
  });

  it('stops an infinite loop within the time limit', async () => {
    const started = Date.now();
    const out = await run(base('python', 'while True: pass'));
    expect(out.status).toBe('TIME_LIMIT');
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);

  it('stops a program that sleeps instead of computing', async () => {
    const out = await run(base('python', 'import time\ntime.sleep(60)'));
    expect(out.status).toBe('TIME_LIMIT');
  }, 60_000);

  it('stops a memory hog', async () => {
    const out = await run(base('python', 'x = bytearray(2 * 1024 * 1024 * 1024)\nprint(len(x))'));
    expect(['MEMORY_LIMIT', 'RUNTIME_ERROR']).toContain(out.status);
  }, 60_000);

  it('contains a fork bomb', async () => {
    const started = Date.now();
    const out = await run(base('python', 'import os\nwhile True:\n    os.fork()'));
    expect(out.status).not.toBe('OK');
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it('has no network access', async () => {
    const out = await run(
      base(
        'python',
        'import socket\ns=socket.socket()\ns.settimeout(3)\ntry:\n    s.connect(("1.1.1.1",80))\n    print("CONNECTED")\nexcept Exception as e:\n    print("BLOCKED")',
      ),
    );
    expect(out.stdout.trim()).toBe('BLOCKED');
  }, 60_000);

  it('survives a flood of output', async () => {
    const out = await run(base('python', 'while True: print("x"*1000)'));
    expect(out.status).not.toBe('OK');
  }, 60_000);
});
