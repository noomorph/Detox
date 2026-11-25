/**
 * Acceptance: spec 019 — the launch handshake in the run's own log.
 *
 * This file speaks only the public dialect: `detox/client`, never
 * `@detox-remote/*`; the only other import is `./helpers/*`.
 *
 * Style is part of the contract: straight-line awaits, no function
 * definitions in this file. The ground truth is the JSONL the server serves
 * for the run, read by the raw client in `./helpers/session-log`.
 *
 * What is being proven: a launch has two actors — the `launchApp` request and
 * the app's own socket — and the run's log tells both. The app's login and
 * its `ready` land under the request that launched it, naming the device and
 * the session; a launch that never completes says which half it was waiting
 * for, in the error and in the log.
 *
 * The testee policy is spec 003's: a real stub process is launched and its
 * wire role is played by the protocol-faithful fake, which logs in and says
 * `ready` only when told to.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { connect, DetoxErrorCode } from 'detox/client';

import { startServer } from './helpers/server';
import { assertDetoxError, rejectionOf } from './helpers/errors';
import { buildStubAppExternally } from './helpers/apps';
import { impersonateLaunchedApp } from './helpers/fake-app';
import { dialConnectionLog, parseNdjson } from './helpers/session-log';
import {
  createSimulatorExternally,
  deleteSimulatorExternally,
  shutdownSimulatorExternally,
} from './helpers/simctl';

/**
 * Test 1 — the handshake is told in the run's own log.
 *
 * After an ordinary launch, the run's log holds — under the `launchApp`
 * request's own node, between its begin and its end — a line for the app's
 * socket connecting, one for its accepted login and one for its `ready`, in
 * that order. Each names the device (`fields.deviceId`, the udid), and from
 * the login on the session too (`fields.sessionId`), so a reader with two
 * simulators and one bundle id knows whose app spoke — and a launch that
 * hangs before login shows whether the app ever dialed in at all.
 */
void test('a launch tells its handshake in the run log: connected, login, ready, under the launchApp node', async (t) => {
  const probe = await createSimulatorExternally('detox-spec019-told', t.signal);
  const bundleId = 'com.detox.spec019.told';
  try {
    await using server = await startServer({ dedicated: true, isolatedLogRoot: true, signal: t.signal });
    await using detox = await connect({ server: server.address, signal: t.signal });
    await using device = await detox.allocateDevice({ type: 'ios.simulator', device: { deviceId: probe.udid } });
    const lane = dialConnectionLog(server.address);
    const appPath = await buildStubAppExternally(bundleId, t.signal);
    await device.installApp(appPath);

    const launching = device.launchApp(bundleId, { signal: t.signal });
    await using fake = await impersonateLaunchedApp(probe.udid, bundleId, { signal: t.signal });
    await fake.handshake();
    await launching;

    const lines = parseNdjson(await lane.fetch(detox.runId));
    const launchBegin = lines.find((l) => l.kind === 'begin' && l.node.type === 'rpc' && l.fields?.method === 'launchApp');
    assert.ok(launchBegin, 'launchApp begins as an rpc node');
    const launchEnd = lines.find((l) => l.kind === 'end' && l.node.id === launchBegin.node.id);
    assert.ok(launchEnd, 'launchApp ends');

    const connected = lines.find((l) => l.kind === 'log' && l.node.id === launchBegin.node.id && l.fields?.handshake === 'connected');
    assert.ok(connected, "the app's socket connecting is a line under the launchApp node");
    assert.equal(connected.fields?.deviceId, probe.udid, 'the connected line names the device');

    const login = lines.find((l) => l.kind === 'log' && l.node.id === launchBegin.node.id && l.fields?.handshake === 'login');
    assert.ok(login, "the app's accepted login is a line under the launchApp node");
    assert.equal(login.fields?.deviceId, probe.udid, 'the login line names the device');
    assert.equal(login.fields?.sessionId, bundleId, 'the login line names the session');

    const ready = lines.find((l) => l.kind === 'log' && l.node.id === launchBegin.node.id && l.fields?.handshake === 'ready');
    assert.ok(ready, "the app's ready is a line under the launchApp node");
    assert.equal(ready.fields?.deviceId, probe.udid, 'the ready line names the device');
    assert.equal(ready.fields?.sessionId, bundleId, 'the ready line names the session');

    assert.ok(
      launchBegin.seq < connected.seq && connected.seq < login.seq && login.seq < ready.seq && ready.seq < launchEnd.seq,
      'begin, connected, login, ready, end — in that order',
    );
  } finally {
    await shutdownSimulatorExternally(probe.udid).catch(() => undefined);
    await deleteSimulatorExternally(probe.udid).catch(() => undefined);
  }
});

/**
 * Test 2 — a launch that never becomes ready says where it stopped.
 *
 * The fake logs in and withholds `ready`. Two exits, one answer:
 *  - the caller walks away (`readyTimeoutMs: 0`, its own signal): the outcome
 *    is the abort, and the run log holds a line under the `launchApp` node
 *    with `fields.stage === 'awaiting-ready'` — the trace a torn-down test
 *    run leaves behind;
 *  - the server's own timeout expires: the typed verdict (`DETOX_APP_DIED`)
 *    carries `details.stage === 'awaiting-ready'`.
 */
void test('a launch that never becomes ready names its stage: in the log when cancelled, in the error when timed out', async (t) => {
  const probe = await createSimulatorExternally('detox-spec019-stage', t.signal);
  const bundleId = 'com.detox.spec019.stage';
  try {
    await using server = await startServer({ dedicated: true, isolatedLogRoot: true, signal: t.signal });
    await using detox = await connect({ server: server.address, signal: t.signal });
    await using device = await detox.allocateDevice({ type: 'ios.simulator', device: { deviceId: probe.udid } });
    const lane = dialConnectionLog(server.address);
    const appPath = await buildStubAppExternally(bundleId, t.signal);
    await device.installApp(appPath);

    const walkAway = new AbortController();
    const abandoned = device.launchApp(bundleId, {
      readyTimeoutMs: 0,
      signal: AbortSignal.any([t.signal, walkAway.signal]),
    });
    await using first = await impersonateLaunchedApp(probe.udid, bundleId, { signal: t.signal });
    await first.nextMessage((message) => message.type === 'isReady');
    walkAway.abort();
    const abortErr = assertDetoxError(await rejectionOf(abandoned, 'abandoned launch'), 'abandoned launch');
    assert.equal(abortErr.code, DetoxErrorCode.DETOX_ABORTED, 'walking away is the abort, not a timeout verdict');

    const lines = parseNdjson(
      await lane.fetchUntil(detox.runId, (ls) => ls.some((l) => l.fields?.stage !== undefined), {
        signal: t.signal,
        timeoutMs: 10_000,
      }),
    );
    const launchBegin = lines.find((l) => l.kind === 'begin' && l.node.type === 'rpc' && l.fields?.method === 'launchApp');
    assert.ok(launchBegin, 'launchApp begins as an rpc node');
    const stopped = lines.find((l) => l.kind === 'log' && l.fields?.stage !== undefined);
    assert.ok(stopped, 'the cancelled launch leaves a line saying where it stopped');
    assert.equal(stopped.node.id, launchBegin.node.id, 'the line sits under the launchApp node');
    assert.equal(stopped.fields?.stage, 'awaiting-ready', 'the app had logged in; ready was what the launch was waiting for');

    const expiring = device.launchApp(bundleId, { readyTimeoutMs: 20_000, signal: t.signal });
    await using second = await impersonateLaunchedApp(probe.udid, bundleId, {
      signal: t.signal,
      excludePid: first.process.pid,
    });
    await second.nextMessage((message) => message.type === 'isReady');
    const err = assertDetoxError(await rejectionOf(expiring, 'ready-timeout expiry'), 'ready-timeout expiry');
    assert.equal(err.code, DetoxErrorCode.DETOX_APP_DIED, 'expiry is the typed handshake verdict');
    assert.equal(err.details?.stage, 'awaiting-ready', 'the verdict names the half of the handshake that never came');
  } finally {
    await shutdownSimulatorExternally(probe.udid).catch(() => undefined);
    await deleteSimulatorExternally(probe.udid).catch(() => undefined);
  }
});
