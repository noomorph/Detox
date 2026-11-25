/**
 * Acceptance: spec 020 — an interrupted call says what it was doing.
 *
 * This file speaks only the public dialect and the `detox` CLI; the only
 * other import is `./helpers/*`. Straight-line awaits, no function
 * definitions in this file.
 *
 * What is being proven: jest's `testTimeout` stays the only test clock, and
 * nobody has to outrun it. When jest fails a test or a hook while a Detox
 * call is still in flight, the call is cancelled — and its cancellation
 * answer says what it was waiting for. That account reaches the tester where
 * they are already looking: jest's own failure report. And the run's log
 * records the cause: the cancelled call's end names why it was cancelled,
 * and it ends before the step that cancelled it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server';
import { resolveDetoxFrameworkExternally } from './helpers/real-app';
import { runDetoxCli } from './helpers/cli';
import { tokenOf } from './helpers/project';
import { dialConnectionLog, parseNdjson } from './helpers/session-log';
import { exampleApp, exampleDevice, writeJestProject } from './helpers/jest-project';

const JEST_CONFIG = {
  rootDir: '..',
  testMatch: ['<rootDir>/e2e/**/*.test.js'],
  testEnvironment: 'detox/runners/jest/testEnvironment',
  globalSetup: 'detox/runners/jest/globalSetup',
  globalTeardown: 'detox/runners/jest/globalTeardown',
  reporters: ['detox/runners/jest/reporter'],
  maxWorkers: 1,
  testTimeout: 120_000,
};

/**
 * Test 1 — a test killed by jest's timeout mid-launch reports what the
 * launch was doing.
 *
 * A real launch takes seconds; the test's own 500 ms timeout kills it first
 * (spec 010's hygiene fixture). The run fails with exactly that test, jest's
 * own timeout message is still there — and next to it one Detox line names
 * the interrupted call, the stage it stood at and for how long:
 * `Interrupted: launchApp — <stage> for <N>ms`. The stage is whichever the
 * launch had reached; the test pins the vocabulary, not the race.
 */
void test('a test that jest times out mid-launch reports the interrupted call and its stage', async (t) => {
  const frameworkPath = await resolveDetoxFrameworkExternally(t.signal);
  await using server = await startServer({
    dedicated: true,
    iosDetoxFrameworkPath: frameworkPath,
    signal: t.signal,
  });
  const project = await writeJestProject({
    '.detoxrc.js': {
      testRunner: { args: { $0: 'jest', config: 'e2e/jest.config.js' } },
      client: { server: server.address.url, token: tokenOf(server.address) },
      devices: { sim: { type: 'ios.simulator', device: { type: exampleDevice() } } },
      apps: {
        example: {
          type: 'ios.app',
          name: 'example',
          bundleId: 'com.wix.detox-example',
          binaryPath: exampleApp(),
        },
      },
      configurations: { 'ios.sim.release': { device: 'sim', app: 'example' } },
    },
    'e2e/jest.config.js': JEST_CONFIG,
    'e2e/interrupted.test.js': `
describe('an interrupted call', () => {
  it('times out mid-launch', async () => {
    await device.launchApp({ newInstance: true });
  }, 500);
});
`,
  });

  const result = await runDetoxCli(['test', '-c', 'ios.sim.release'], {
    cwd: project.dir,
    signal: t.signal,
  });

  assert.equal(result.exitCode, 1, `expected exactly the timed-out failure, output:\n${result.output}`);
  assert.ok(result.output.includes('times out mid-launch'), 'the timed-out test is the named failure');
  assert.match(result.output, /Exceeded timeout of 500 ?ms/, "jest's own timeout verdict is kept: jest is the only test clock");
  assert.match(
    result.output,
    /Interrupted: launchApp — (spawning|awaiting-login|awaiting-ready) for \d+ms/,
    `the failure names the interrupted call, its stage and the time spent there, output:\n${result.output}`,
  );
});

/**
 * Test 2 — the log records the cause, and a child never outlives its parent.
 *
 * A `beforeAll` with a 500 ms timeout calls `device.launchApp()`; jest fails
 * the hook and the environment cancels the launch. In the run's log:
 *  - the `launchApp` node ends failed, and its end line says WHY it was
 *    cancelled by field, not by prose: `fields.reason === 'hook-failed'` —
 *    the same field a torn connection already fills with
 *    `'connection-closed'`, one vocabulary for every way a call is cut short;
 *  - the same end line says what the call was waiting for
 *    (`fields.waiting.on`, spec 019's stages);
 *  - the hook's own step — the launch's parent — ends failed AFTER the
 *    launch does: child before parent, so a viewer draws the cancelled call
 *    inside the hook that cancelled it.
 */
void test('a hook that jest times out mid-launch: the log names why the launch was cancelled, and the launch ends before its hook', async (t) => {
  const frameworkPath = await resolveDetoxFrameworkExternally(t.signal);
  await using server = await startServer({
    dedicated: true,
    isolatedLogRoot: true,
    iosDetoxFrameworkPath: frameworkPath,
    signal: t.signal,
  });
  const project = await writeJestProject({
    '.detoxrc.js': {
      testRunner: { args: { $0: 'jest', config: 'e2e/jest.config.js' } },
      client: { server: server.address.url, token: tokenOf(server.address) },
      devices: { sim: { type: 'ios.simulator', device: { type: exampleDevice() } } },
      apps: {
        example: {
          type: 'ios.app',
          name: 'example',
          bundleId: 'com.wix.detox-example',
          binaryPath: exampleApp(),
        },
      },
      configurations: { 'ios.sim.release': { device: 'sim', app: 'example' } },
    },
    'e2e/jest.config.js': JEST_CONFIG,
    'e2e/interrupted-hook.test.js': `
describe('an interrupted hook', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
  }, 500);

  it('never gets to run', () => {});
});
`,
  });

  const result = await runDetoxCli(['test', '-c', 'ios.sim.release'], {
    cwd: project.dir,
    signal: t.signal,
  });
  assert.equal(result.exitCode, 1, `expected the hook's failure, output:\n${result.output}`);
  assert.match(
    result.output,
    /Interrupted: launchApp — (spawning|awaiting-login|awaiting-ready) for \d+ms/,
    `a hook's failure carries the same line a test's does, output:\n${result.output}`,
  );

  const lane = dialConnectionLog(server.address);
  const runs = await lane.index();
  const logs = await Promise.all(runs.map((run) => lane.fetch(run.runId)));
  const lines = logs
    .map((log) => parseNdjson(log))
    .find((ls) => ls.some((l) => l.kind === 'begin' && l.fields?.method === 'launchApp'));
  assert.ok(lines, 'one of the runs on this server launched the app');

  const launchBegin = lines.find((l) => l.kind === 'begin' && l.node.type === 'rpc' && l.fields?.method === 'launchApp');
  assert.ok(launchBegin, 'launchApp begins as an rpc node');
  const launchEnd = lines.find((l) => l.kind === 'end' && l.node.id === launchBegin.node.id);
  assert.ok(launchEnd, 'the cancelled launch ends');
  assert.equal(launchEnd.fields?.ok, false, 'a cancelled call ends failed');
  assert.equal(launchEnd.fields?.reason, 'hook-failed', 'the end line names why the call was cancelled');
  const waiting = launchEnd.fields?.waiting as { on?: unknown } | undefined;
  assert.ok(
    ['spawning', 'awaiting-login', 'awaiting-ready'].includes(String(waiting?.on)),
    `the end line names what the call was waiting for, got ${JSON.stringify(waiting)}`,
  );

  assert.ok(launchBegin.node.parent, 'the launch was begun inside a step');
  const hookEnd = lines.find((l) => l.kind === 'end' && l.node.id === launchBegin.node.parent);
  assert.ok(hookEnd, "the launch's parent step — the hook — ends");
  assert.equal(hookEnd.node.type, 'step');
  assert.equal(hookEnd.fields?.ok, false, 'the hook ended failed');
  assert.ok(launchEnd.seq < hookEnd.seq, 'child before parent: the launch ends before the hook that cancelled it');
});
