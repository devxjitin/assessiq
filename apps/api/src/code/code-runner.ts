import { CODE_LANGUAGES, type CodeLanguage } from '@assessiq/shared';
import type { Env } from '../config/env';

export interface RunRequest {
  language: CodeLanguage;
  source: string;
  stdin: string;
  timeLimitMs: number;
  memoryMb: number;
}

export type RunStatus =
  'OK' | 'COMPILE_ERROR' | 'RUNTIME_ERROR' | 'TIME_LIMIT' | 'MEMORY_LIMIT' | 'ERROR';

export interface RunOutcome {
  status: RunStatus;
  stdout: string;
  /** Compiler output or runtime error text. */
  stderr: string;
  timeMs: number | null;
}

/** Runs one program against one input in a sandbox. Throws if the sandbox itself is unreachable. */
export interface CodeRunner {
  readonly name: 'judge0' | 'fake' | 'disabled';
  /** False when code cannot be run at all (nothing configured). */
  readonly available: boolean;
  run(req: RunRequest): Promise<RunOutcome>;
}

export const CODE_RUNNER = Symbol('CODE_RUNNER');

// ------------------------------------------------------------------ disabled

class DisabledRunner implements CodeRunner {
  readonly name = 'disabled' as const;
  readonly available = false;
  async run(): Promise<RunOutcome> {
    throw new Error('Code execution is not configured');
  }
}

// ---------------------------------------------------------------------- fake

/**
 * Deterministic stand-in used by tests and local development. The default "program" echoes its
 * input; a marker in the source picks a failure instead. Tests can replace `handler`.
 */
export class FakeRunner implements CodeRunner {
  readonly name = 'fake' as const;
  available = true;
  calls: RunRequest[] = [];
  handler: (req: RunRequest) => RunOutcome | Promise<RunOutcome> = (req) => {
    if (req.source.includes('UNAVAILABLE')) throw new Error('sandbox unreachable');
    if (req.source.includes('COMPILE_ERROR')) {
      return { status: 'COMPILE_ERROR', stdout: '', stderr: 'error: expected ;', timeMs: null };
    }
    if (req.source.includes('TIME_LIMIT')) {
      return { status: 'TIME_LIMIT', stdout: '', stderr: '', timeMs: req.timeLimitMs };
    }
    if (req.source.includes('RUNTIME_ERROR')) {
      return { status: 'RUNTIME_ERROR', stdout: '', stderr: 'Segmentation fault', timeMs: 12 };
    }
    const out = req.source.includes('WRONG') ? 'wrong' : req.stdin;
    return { status: 'OK', stdout: out, stderr: '', timeMs: 12 };
  };

  async run(req: RunRequest): Promise<RunOutcome> {
    this.calls.push(req);
    return this.handler(req);
  }
}

// -------------------------------------------------------------------- Judge0

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string | null | undefined) =>
  s ? Buffer.from(s, 'base64').toString('utf8') : '';

interface Judge0Result {
  status: { id: number; description: string };
  stdout?: string | null;
  stderr?: string | null;
  compile_output?: string | null;
  message?: string | null;
  time?: string | null;
}

/**
 * How Judge0 enforces the memory limit.
 *  - `cgroup`: Judge0's default, real memory accounting. Judge0 1.13 only supports cgroup v1,
 *    so the host needs `systemd.unified_cgroup_hierarchy=0`.
 *  - `process`: a limit on each process's address space. Works on modern cgroup v2 hosts
 *    (Amazon Linux 2023, Docker Desktop). Node.js and the JVM reserve far more address space
 *    than they use, so they get a higher floor; the process cap keeps a fork bomb bounded.
 */
export type Judge0LimitMode = 'cgroup' | 'process';

/** Address-space floors (KB) for runtimes that cannot start under a small limit. */
const PROCESS_MODE_FLOOR_KB: Partial<Record<CodeLanguage, number>> = {
  javascript: 1_000_000,
  java: 3_000_000,
};

/** Talks to a self-hosted Judge0 CE (1.13) over HTTP. The sandbox has no network access. */
export class Judge0Runner implements CodeRunner {
  readonly name = 'judge0' as const;
  readonly available = true;

  constructor(
    private readonly baseUrl: string,
    private readonly authToken?: string,
    private readonly mode: Judge0LimitMode = 'process',
  ) {}

  async run(req: RunRequest): Promise<RunOutcome> {
    const cpuSeconds = req.timeLimitMs / 1000;
    const process = this.mode === 'process';
    const memoryKb = Math.max(
      req.memoryMb * 1024,
      process ? (PROCESS_MODE_FLOOR_KB[req.language] ?? 0) : 0,
    );
    const res = await fetch(`${this.baseUrl}/submissions?base64_encoded=true&wait=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.authToken ? { 'X-Auth-Token': this.authToken } : {}),
      },
      body: JSON.stringify({
        language_id: CODE_LANGUAGES[req.language].judge0Id,
        source_code: b64(req.source),
        stdin: b64(req.stdin),
        cpu_time_limit: cpuSeconds,
        // Wall time catches programs that sleep or wait; give some room beyond CPU time.
        wall_time_limit: Math.min(Math.max(cpuSeconds * 2, 3), 20),
        memory_limit: memoryKb,
        max_processes_and_or_threads: 30,
        ...(process
          ? {
              enable_per_process_and_thread_time_limit: true,
              enable_per_process_and_thread_memory_limit: true,
            }
          : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Judge0 answered HTTP ${res.status}`);
    return Judge0Runner.toOutcome((await res.json()) as Judge0Result);
  }
  static toOutcome(r: Judge0Result): RunOutcome {
    const stdout = unb64(r.stdout);
    const stderr = unb64(r.compile_output) || unb64(r.stderr) || unb64(r.message);
    const timeMs = r.time ? Math.round(Number(r.time) * 1000) : null;
    const id = r.status.id;
    // 1 queued, 2 processing, 3 accepted, 5 time limit, 6 compile error, 7-12 runtime errors,
    // 13 internal error, 14 exec format error.
    if (id === 3) return { status: 'OK', stdout, stderr, timeMs };
    if (id === 5) return { status: 'TIME_LIMIT', stdout, stderr, timeMs };
    if (id === 6) return { status: 'COMPILE_ERROR', stdout, stderr, timeMs };
    if (id >= 7 && id <= 12) {
      const killedForMemory = /memory|SIGKILL|bad_alloc|OutOfMemory/i.test(stderr);
      return { status: killedForMemory ? 'MEMORY_LIMIT' : 'RUNTIME_ERROR', stdout, stderr, timeMs };
    }
    if (id === 14) return { status: 'RUNTIME_ERROR', stdout, stderr, timeMs };
    throw new Error(`Judge0 reported ${r.status.description} (status ${id})`);
  }
}

export function createRunner(env: Env): CodeRunner {
  if (env.CODE_RUNNER === 'judge0') {
    return new Judge0Runner(env.JUDGE0_URL, env.JUDGE0_AUTH_TOKEN, env.JUDGE0_LIMIT_MODE);
  }
  if (env.CODE_RUNNER === 'fake') return new FakeRunner();
  return new DisabledRunner();
}
