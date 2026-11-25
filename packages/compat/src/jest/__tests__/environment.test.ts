/**
 * The environment's circus-event handling (spec 010's integration-gated
 * contract): unit-scope abort on failure, file-scope abort on teardown, a
 * PASSING unit aborts nothing, adoption never re-inits, globals per
 * `exposeGlobals`, `expect.extend` on the circus setup event. The compat
 * surface is mocked at its module seam — the wire half of the same story
 * lives in `jest-hygiene.test.ts` over the fake transport.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COMPAT_STATE_KEY, compatStateBox, type CompatState } from '../../state';

const init = vi.fn(async (..._args: unknown[]) => {});

vi.mock('../../index', () => ({
  init: (...args: unknown[]) => (init as (...a: unknown[]) => Promise<void>)(...args),
  cleanup: vi.fn(async () => {}),
  device: { getPlatform: (): 'ios' => 'ios' },
  element: () => ({}),
  by: {},
  waitFor: () => ({}),
  expect: () => ({}),
}));

import { AbortError } from 'detox/client';

import { DetoxCircusEnvironment } from '../environment';
import { errorListsUnder, INTERRUPTED_ANSWER_BOUND_MS } from '../interrupted';

function writeSnapshotFixture(extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'detox-jest-env-test-'));
  const file = path.join(dir, 'config-snapshot.json');
  writeFileSync(
    file,
    JSON.stringify({
      configurationName: 'ios.sim',
      client: { server: 'ws://127.0.0.1:1', token: 'tkn' },
      apps: [{ name: 'app', bundleId: 'com.example.a' }],
      device: { type: 'ios.simulator', query: {} },
      ...extra,
    }),
  );
  return file;
}

function makeEnvironment(): DetoxCircusEnvironment {
  return new DetoxCircusEnvironment(
    {
      globalConfig: {} as never,
      projectConfig: { rootDir: '/tmp', testEnvironmentOptions: {} } as never,
    },
    { console, docblockPragmas: {}, testPath: '/tmp/fixture.test.js' },
  );
}

const box = compatStateBox();
const savedEnv = process.env.DETOX_CONFIG_SNAPSHOT_PATH;

beforeEach(() => {
  vi.clearAllMocks();
  box.state = undefined;
  box.pendingInit = undefined;
  box.ambient = undefined;
  box.unrefSocket = false;
  box.onSession = undefined;
  box.onCall = undefined;
  process.env.DETOX_CONFIG_SNAPSHOT_PATH = writeSnapshotFixture();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.DETOX_CONFIG_SNAPSHOT_PATH;
  else process.env.DETOX_CONFIG_SNAPSHOT_PATH = savedEnv;
  box.state = undefined;
  box.ambient = undefined;
  box.unrefSocket = false;
});

const dispatch = (
  env: DetoxCircusEnvironment,
  name: string,
  extra: Record<string, unknown> = {},
): void => {
  (env.handleTestEvent as (event: unknown, state: unknown) => void)(
    { name, ...extra },
    { currentDescribeBlock: { children: [{}] } },
  );
};

describe('setup', () => {
  it('inits ONCE with the mapped snapshot, mirrors the box, sets ambient + unref', async () => {
    const env = makeEnvironment();
    await env.setup();
    try {
      expect(init).toHaveBeenCalledTimes(1);
      expect(init.mock.calls[0][0]).toEqual({
        server: { url: 'ws://127.0.0.1:1', headers: { Authorization: 'Bearer tkn' } },
        apps: [{ name: 'app', bundleId: 'com.example.a' }],
        device: {},
        // Spec 015: compat allocates by the snapshot's own device type.
        deviceType: 'ios.simulator',
      });
      // NO session-scoped signal: the session must outlive this file.
      expect(init.mock.calls[0]).toHaveLength(1);
      expect((env.global as Record<symbol, unknown>)[COMPAT_STATE_KEY]).toBe(box);
      expect(box.ambient).toBeInstanceOf(AbortSignal);
      expect(box.ambient?.aborted).toBe(false);
      expect(box.unrefSocket).toBe(true);
    } finally {
      await env.teardown();
    }
  });

  it('exposes the detox globals by default — and never a detox `expect`', async () => {
    const env = makeEnvironment();
    await env.setup();
    try {
      const g = env.global as unknown as Record<string, unknown>;
      expect(g.device).toBeDefined();
      expect(g.element).toBeDefined();
      expect(g.by).toBeDefined();
      expect(g.waitFor).toBeDefined();
      expect(g.detox).toBeDefined();
      expect(g.expect).toBeUndefined();
    } finally {
      await env.teardown();
    }
  });

  it('exposes NO globals under behavior.init.exposeGlobals: false — the box still mirrors', async () => {
    process.env.DETOX_CONFIG_SNAPSHOT_PATH = writeSnapshotFixture({
      behavior: { init: { exposeGlobals: false } },
    });
    const env = makeEnvironment();
    await env.setup();
    try {
      const g = env.global as unknown as Record<string, unknown>;
      expect(g.device).toBeUndefined();
      expect(g.element).toBeUndefined();
      expect(g.waitFor).toBeUndefined();
      expect((env.global as Record<symbol, unknown>)[COMPAT_STATE_KEY]).toBe(box);
    } finally {
      await env.teardown();
    }
  });

  it('ADOPTS a live session: the second setup in a process never re-inits', async () => {
    box.state = { session: {} } as unknown as CompatState;
    const env = makeEnvironment();
    await env.setup();
    try {
      expect(init).not.toHaveBeenCalled();
      expect(box.ambient).toBeInstanceOf(AbortSignal);
    } finally {
      await env.teardown();
    }
  });

  it('surfaces a missing snapshot as the file failure, code name stamped', async () => {
    delete process.env.DETOX_CONFIG_SNAPSHOT_PATH;
    const env = makeEnvironment();
    await expect(env.setup()).rejects.toThrowError(/DETOX_NOT_INITIALIZED.*detox test/s);
    await env.teardown();
  });

  /**
   * @issue DTX-4050
   * The state box is mirrored into the test context at construction — jest evaluates
   * `setupFiles` before `environment.setup()`, and a fixture preload requiring detox there
   * must bind the real box, not a throwaway one minted on a bare context global.
   */
  it('mirrors the box AT CONSTRUCTION — a setupFiles require("detox") must bind the real box', () => {
    const env = makeEnvironment();
    expect((env.global as Record<symbol, unknown>)[COMPAT_STATE_KEY]).toBe(box);
  });

  /**
   * @issue DTX-4051
   * A prior environment's init still in flight is waited out and its outcome shared, rather
   * than silently adopting an uninitialized surface.
   */
  it('WAITS OUT a pending init instead of silently adopting an uninitialized surface', async () => {
    let resolvePending!: () => void;
    let pendingSettled = false;
    box.pendingInit = new Promise<void>((resolve) => {
      resolvePending = () => {
        pendingSettled = true;
        resolve();
      };
    });
    const env = makeEnvironment();
    const setupPromise = env.setup();
    let setupDone = false;
    void setupPromise.then(() => {
      setupDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(setupDone).toBe(false);
    resolvePending();
    await setupPromise;
    expect(pendingSettled).toBe(true);
    expect(init).not.toHaveBeenCalled();
    await env.teardown();
  });
});

describe('AbortSignal hygiene — unit and file scopes', () => {
  it('a failing test aborts ITS scope; the next unit gets a fresh one', async () => {
    const env = makeEnvironment();
    await env.setup();
    try {
      dispatch(env, 'test_fn_start');
      const unitAmbient = box.ambient;
      expect(unitAmbient).toBeInstanceOf(AbortSignal);
      dispatch(env, 'test_fn_failure', { error: new Error('timed out') });
      expect(unitAmbient?.aborted).toBe(true);

      dispatch(env, 'hook_start');
      expect(box.ambient?.aborted).toBe(false);
    } finally {
      await env.teardown();
    }
  });

  /**
   * @issue DTX-4055
   * A fresh scope per unit. The previous unit's controller is dropped, never aborted: a
   * passing test's completed work is not touched.
   * @issue DTX-4057
   * Between units the file scope alone governs.
   */
  it('a PASSING unit aborts nothing', async () => {
    const env = makeEnvironment();
    await env.setup();
    try {
      dispatch(env, 'test_fn_start');
      const unitAmbient = box.ambient;
      dispatch(env, 'test_done', { test: {} });
      expect(unitAmbient?.aborted).toBe(false);
      expect(box.ambient?.aborted).toBe(false);
    } finally {
      await env.teardown();
    }
  });

  it('a failing hook aborts its scope too', async () => {
    const env = makeEnvironment();
    await env.setup();
    try {
      dispatch(env, 'hook_start');
      const hookAmbient = box.ambient;
      dispatch(env, 'hook_failure', { error: new Error('hook died') });
      expect(hookAmbient?.aborted).toBe(true);
      dispatch(env, 'run_finish');
      expect(box.ambient?.aborted).toBe(false);
    } finally {
      await env.teardown();
    }
  });

  it('teardown aborts the file scope UNCONDITIONALLY and clears the ambient', async () => {
    const env = makeEnvironment();
    await env.setup();
    const fileAmbient = box.ambient;
    dispatch(env, 'test_fn_start');
    const unitAmbient = box.ambient;
    await env.teardown();
    expect(fileAmbient?.aborted).toBe(true);
    expect(unitAmbient?.aborted).toBe(true);
    expect(box.ambient).toBeUndefined();
  });

  /**
   * @issue DTX-4059
   * Scope per circus test object, so a failure aborts its own unit even under
   * `test.concurrent`, where starts and failures interleave — the scope map keys by the
   * circus test object so attribution survives the overlap.
   * @issue DTX-4056
   * The unit that failed is the one whose scope aborts, keyed so a concurrent sibling's is
   * never hit.
   * @issue DTX-4058
   * A finishing sibling must not strip the ambient from the still-running current unit.
   */
  it('a concurrent sibling failure aborts ITS OWN scope, never the current one', async () => {
    const env = makeEnvironment();
    await env.setup();
    try {
      const testA = {};
      const testB = {};
      dispatch(env, 'test_fn_start', { test: testA });
      const scopeA = box.ambient;
      dispatch(env, 'test_fn_start', { test: testB });
      const scopeB = box.ambient;
      dispatch(env, 'test_fn_failure', { test: testA, error: new Error('A timed out') });
      expect(scopeA?.aborted).toBe(true);
      expect(scopeB?.aborted).toBe(false);
      dispatch(env, 'test_done', { test: testA });
      expect(box.ambient).toBe(scopeB);
      dispatch(env, 'test_done', { test: testB });
      expect(box.ambient?.aborted).toBe(false);
    } finally {
      await env.teardown();
    }
  });

  it('stamps the typed code name onto a failing test error', async () => {
    const env = makeEnvironment();
    await env.setup();
    try {
      const error = Object.assign(new Error('app is gone'), { code: 2013 });
      dispatch(env, 'test_fn_start');
      dispatch(env, 'test_fn_failure', { error });
      expect(error.message).toBe('DETOX_APP_DIED: app is gone');
    } finally {
      await env.teardown();
    }
  });
});

describe('circus wiring', () => {
  it('extends jest own expect with the detox matchers on the setup event', async () => {
    const env = makeEnvironment();
    await env.setup();
    try {
      const extend = vi.fn();
      (env.global as unknown as Record<string, unknown>).expect = { extend };
      dispatch(env, 'setup');
      expect(extend).toHaveBeenCalledTimes(1);
      const registered = extend.mock.calls[0][0] as Record<string, unknown>;
      expect(Object.keys(registered)).toHaveLength(16);
      expect(typeof registered.toBeVisible).toBe('function');
    } finally {
      await env.teardown();
    }
  });

  it('extends through the setup event runtimeGlobals under injectGlobals: false', async () => {
    // With `injectGlobals: false` jest sets no `expect` global, but the
    // circus setup event still carries the file's expect — the same instance
    // `import { expect } from "@jest/globals"` serves.
    const env = makeEnvironment();
    await env.setup();
    try {
      const extend = vi.fn();
      expect((env.global as unknown as Record<string, unknown>).expect).toBeUndefined();
      dispatch(env, 'setup', { runtimeGlobals: { expect: { extend } } });
      expect(extend).toHaveBeenCalledTimes(1);
    } finally {
      await env.teardown();
    }
  });

  it('skips a foreign-platform test at registration', async () => {
    const env = makeEnvironment();
    await env.setup();
    try {
      const state = { currentDescribeBlock: { children: [{ mode: undefined }] } };
      (env.handleTestEvent as (event: unknown, state: unknown) => void)(
        { name: 'add_test', testName: ':android: not for us' },
        state,
      );
      expect(state.currentDescribeBlock.children[0].mode).toBe('skip');
    } finally {
      await env.teardown();
    }
  });
});

describe('the test tree and the run row (spec 013)', () => {
  interface FakeHandle {
    id: string;
    end: (outcome: unknown) => void;
    ended: boolean;
    run: <T>(fn: () => T) => T;
  }
  const begins: Array<Record<string, unknown>> = [];
  const ends: Array<Record<string, unknown>> = [];
  let next = 1;
  const fakeSession = {
    runId: 'run-abc',
    log: {
      begin: (options: Record<string, unknown>): FakeHandle => {
        const id = `s${String(next++)}`;
        begins.push({ ...options, id });
        const handle: FakeHandle = {
          id,
          ended: false,
          end: (outcome) => {
            handle.ended = true;
            ends.push({ id, ...(outcome as Record<string, unknown>) });
          },
          run: (fn) => fn(),
        };
        return handle;
      },
    },
  };

  beforeEach(() => {
    begins.length = 0;
    ends.length = 0;
    next = 1;
  });

  it('handleTestEvent is a prototype method, so a wrapping subclass can override it', () => {
    const env = makeEnvironment();
    expect(Object.hasOwn(env, 'handleTestEvent')).toBe(false);
    expect(typeof DetoxCircusEnvironment.prototype.handleTestEvent).toBe('function');
  });

  it('opens the file step on the session-opened door — before init allocates — and names the run', async () => {
    const order: string[] = [];
    init.mockImplementationOnce(async () => {
      order.push('connected');
      box.onSession?.(fakeSession as never);
      order.push('allocating');
      box.state = { session: fakeSession } as unknown as CompatState;
    });
    const env = makeEnvironment();
    await env.setup();
    try {
      expect(order).toEqual(['connected', 'allocating']);
      expect(begins).toEqual([{ id: 's1', kind: 'file', name: 'fixture.test.js', attrs: { filePath: 'fixture.test.js' } }]);
      expect(box.onSession).toBeUndefined();
      const snapshotPath = process.env.DETOX_CONFIG_SNAPSHOT_PATH as string;
      const rows = readFileSync(path.join(path.dirname(snapshotPath), 'runs', `${String(process.pid)}.jsonl`), 'utf8');
      expect(JSON.parse(rows.trim())).toEqual({
        runId: 'run-abc',
        serverUrl: 'ws://127.0.0.1:1',
        viewerUrl: 'http://127.0.0.1:1/v1/runs/run-abc/perfetto',
        gated: true,
      });
    } finally {
      await env.teardown();
    }
    expect(ends).toEqual([{ id: 's1', status: 'passed' }]);
  });

  it('an adopting file opens its own file step from the live session', async () => {
    box.state = { session: fakeSession } as unknown as CompatState;
    const env = makeEnvironment();
    await env.setup();
    try {
      expect(init).not.toHaveBeenCalled();
      expect(begins[0]).toMatchObject({ kind: 'file', name: 'fixture.test.js' });
    } finally {
      await env.teardown();
    }
  });

  it('declares describe, test and hook steps with explicit parents, ends them by outcome, and the file ends failed', async () => {
    box.state = { session: fakeSession } as unknown as CompatState;
    const env = makeEnvironment();
    await env.setup();
    try {
      const root = { name: 'ROOT_DESCRIBE_BLOCK' };
      const suite = { name: 'Sanity', parent: root };
      const beforeAll = { type: 'beforeAll', parent: suite, fn: () => undefined };
      const passes = { name: 'passes', parent: suite, fn: () => undefined, invocations: 1, errors: [] as unknown[] };
      const fails = { name: 'fails', parent: suite, fn: () => undefined, invocations: 1, errors: [new Error('nope')] };
      dispatch(env, 'run_describe_start', { describeBlock: root });
      dispatch(env, 'run_describe_start', { describeBlock: suite });
      dispatch(env, 'hook_start', { hook: beforeAll });
      dispatch(env, 'hook_success', { hook: beforeAll });
      dispatch(env, 'test_start', { test: passes });
      dispatch(env, 'test_fn_start', { test: passes });
      dispatch(env, 'test_done', { test: passes });
      dispatch(env, 'test_start', { test: fails });
      dispatch(env, 'test_fn_start', { test: fails });
      dispatch(env, 'test_fn_failure', { test: fails, error: fails.errors[0] });
      dispatch(env, 'test_done', { test: fails });
      const skipped = { name: 'skipped', parent: suite, mode: 'skip', invocations: 0, errors: [] as unknown[] };
      dispatch(env, 'test_start', { test: skipped });
      dispatch(env, 'test_skip', { test: skipped });
      const todo = { name: 'todo', parent: suite, mode: 'todo', invocations: 0, errors: [] as unknown[] };
      dispatch(env, 'test_start', { test: todo });
      dispatch(env, 'test_todo', { test: todo });
      dispatch(env, 'run_describe_finish', { describeBlock: suite });
      dispatch(env, 'run_describe_finish', { describeBlock: root });
      expect(begins.map((b) => [b.kind, b.name, b.parent])).toEqual([
        ['file', 'fixture.test.js', undefined],
        ['describe', 'Sanity', 's1'],
        ['hook', 'beforeAll', 's2'],
        ['test', 'passes', 's2'],
        ['test', 'fails', 's2'],
        ['test', 'skipped', 's2'],
        ['test', 'todo', 's2'],
      ]);
      expect(env.stepOf(suite)?.id).toBe('s2');
      expect(env.stepOf(passes)?.id).toBe('s4');
      expect(ends).toEqual([
        { id: 's3', status: 'passed' },
        { id: 's4', status: 'passed' },
        { id: 's5', status: 'failed', error: { name: 'Error', message: 'nope' } },
        { id: 's6', status: 'skipped' },
        { id: 's7', status: 'skipped' },
        { id: 's2', status: 'failed' },
      ]);
    } finally {
      await env.teardown();
    }
    expect(ends.at(-1)).toEqual({ id: 's1', status: 'failed' });
  });

  it('a failing hook ends its step failed with the error', async () => {
    box.state = { session: fakeSession } as unknown as CompatState;
    const env = makeEnvironment();
    await env.setup();
    try {
      const root = { name: 'ROOT_DESCRIBE_BLOCK' };
      const hook = { type: 'beforeEach', parent: root, fn: () => undefined };
      dispatch(env, 'hook_start', { hook });
      dispatch(env, 'hook_failure', { hook, error: new Error('hook died') });
      expect(ends).toEqual([{ id: 's2', status: 'failed', error: { name: 'Error', message: 'hook died' } }]);
    } finally {
      await env.teardown();
    }
  });

  it('a file whose init failed ends its step failed at teardown, when the step got opened at all', async () => {
    init.mockImplementationOnce(async () => {
      box.onSession?.(fakeSession as never);
      throw new Error('allocation refused');
    });
    const env = makeEnvironment();
    await expect(env.setup()).rejects.toThrow('allocation refused');
    expect(box.onSession).toBeUndefined();
    await env.teardown();
    expect(ends).toEqual([{ id: 's1', status: 'failed' }]);
  });
});

describe('the interrupted-call report (spec 020)', () => {
  const TIMEOUT = 'Exceeded timeout of 500 ms for a hook.\nAdd a timeout value to this test.';
  const interrupted = (on: string, forMs: number) =>
    new AbortError(Object.assign(new Error('cancelled'), { name: 'AbortReason', kind: 'test-failed' }), { outcome: 'undone', waiting: { on, forMs } });

  /** A wire call the session's tracker reports, settled by hand. */
  function trackedCall(method: string) {
    let reject!: (error: unknown) => void;
    let resolve!: () => void;
    const call = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    box.onCall?.(method, call);
    return { call, resolve, reject };
  }

  const handle = (env: DetoxCircusEnvironment, name: string, extra: Record<string, unknown>, state: unknown = {}) =>
    (env.handleTestEvent as (event: unknown, state: unknown) => void | Promise<void>)({ name, ...extra }, state);

  it('a timed-out test: the unit aborts typed, and the interrupted call is appended to the string verdict jest itself produced', async () => {
    const env = makeEnvironment();
    await env.setup();
    try {
      const test = { name: 't', errors: [] as unknown[] };
      dispatch(env, 'test_fn_start', { test });
      const unitAmbient = box.ambient;
      const launch = trackedCall('launchApp');
      const asyncError = new Error('registration site');
      const verdict = TIMEOUT.replace('hook', 'test');
      test.errors.push([verdict, asyncError]);
      const reported = handle(env, 'test_fn_failure', { test, error: verdict });
      expect(unitAmbient?.aborted).toBe(true);
      expect((unitAmbient?.reason as Record<string, unknown>).kind).toBe('test-failed');
      expect(reported).toBeInstanceOf(Promise);
      launch.reject(interrupted('awaiting-login', 512.4));
      await reported;
      expect(test.errors).toEqual([[`${verdict}\n\nInterrupted: launchApp — awaiting-login for 512ms`, asyncError]]);
    } finally {
      await env.teardown();
    }
  });

  it('a timed-out beforeAll: every test under the describe gets the line, and the hook step ends only after the answer', async () => {
    box.state = { session: { log: { begin: () => ({ id: 'h', end: () => ends.push('hook'), run: (fn: () => unknown) => fn() }) } } } as unknown as CompatState;
    const ends: string[] = [];
    const env = makeEnvironment();
    await env.setup();
    try {
      const root = { name: 'ROOT_DESCRIBE_BLOCK' };
      const hook = { type: 'beforeAll', parent: root };
      const inner = { name: 'inner', errors: [] as unknown[] };
      const outer = { name: 'outer', errors: [] as unknown[] };
      const describeBlock = { children: [{ type: 'test', ...outer }, { type: 'describeBlock', children: [{ type: 'test', ...inner }] }, { type: 'hook' }] };
      dispatch(env, 'hook_start', { hook });
      const launch = trackedCall('launchApp');
      // Circus pushes one tuple per test, before the environment hears the event.
      const lists = errorListsUnder(describeBlock);
      for (const list of lists) list.push([TIMEOUT, undefined]);
      const reported = handle(env, 'hook_failure', { hook, describeBlock, error: TIMEOUT });
      await Promise.resolve();
      expect(ends).toEqual([]);
      launch.reject(interrupted('spawning', 40));
      await reported;
      expect(ends).toEqual(['hook']);
      for (const list of lists) expect(list).toEqual([[`${TIMEOUT}\n\nInterrupted: launchApp — spawning for 40ms`, undefined]]);
    } finally {
      await env.teardown();
    }
  });

  it('an afterAll failure lands on the unhandled errors; a call with nothing to say adds nothing', async () => {
    const env = makeEnvironment();
    await env.setup();
    try {
      const hook = { type: 'afterAll', parent: { name: 'ROOT_DESCRIBE_BLOCK' } };
      const state = { unhandledErrors: [[TIMEOUT, undefined]] as unknown[] };
      dispatch(env, 'hook_start', { hook });
      const launch = trackedCall('launchApp');
      const plain = trackedCall('invoke');
      const reported = handle(env, 'hook_failure', { hook, error: TIMEOUT }, state);
      launch.reject(interrupted('awaiting-ready', 7));
      plain.reject(new Error('unrelated'));
      await reported;
      expect(state.unhandledErrors).toEqual([[`${TIMEOUT}\n\nInterrupted: launchApp — awaiting-ready for 7ms`, undefined]]);
    } finally {
      await env.teardown();
    }
  });

  it('no answer within the bound, no line: jest gets its own report, and the hook step still ends', async () => {
    box.state = { session: { log: { begin: () => ({ id: 'h', end: () => ends.push('hook'), run: (fn: () => unknown) => fn() }) } } } as unknown as CompatState;
    const ends: string[] = [];
    const env = makeEnvironment();
    await env.setup();
    vi.useFakeTimers();
    try {
      const hook = { type: 'beforeEach', parent: { name: 'ROOT_DESCRIBE_BLOCK' } };
      const test = { name: 't', errors: [[TIMEOUT, undefined]] as unknown[] };
      dispatch(env, 'hook_start', { hook });
      trackedCall('launchApp');
      const reported = handle(env, 'hook_failure', { hook, test, error: TIMEOUT });
      await vi.advanceTimersByTimeAsync(INTERRUPTED_ANSWER_BOUND_MS);
      await reported;
      expect(ends).toEqual(['hook']);
      expect(test.errors).toEqual([[TIMEOUT, undefined]]);
    } finally {
      vi.useRealTimers();
      await env.teardown();
    }
  });

  it('a call that settled before the failure is forgotten; a call outside any unit is never tracked', async () => {
    const env = makeEnvironment();
    await env.setup();
    try {
      trackedCall('allocateDevice').resolve();
      dispatch(env, 'test_fn_start');
      const done = trackedCall('invoke');
      const failed = trackedCall('invoke');
      done.resolve();
      failed.reject(new Error('own failure'));
      await failed.call.catch(() => undefined);
      expect(handle(env, 'test_fn_failure', { error: new Error('x') })).toBeUndefined();
    } finally {
      await env.teardown();
    }
  });
});
