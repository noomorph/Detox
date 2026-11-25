/**
 * Acceptance: spec 021 — the imported `device` is the global `device`.
 *
 * This file speaks only the `detox` CLI; the only other import is
 * `./helpers/*`. Straight-line awaits, no function definitions in this file.
 *
 * What is being proven: a v20 suite wraps a method on the global `device`
 * once, in a setup file, and expects every test file to go through the
 * wrapper — whether the file uses the global or `require('detox').device`.
 * Under jest the two must be one object, as they were in v20.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from './helpers/server';
import { runDetoxCli } from './helpers/cli';
import { tokenOf } from './helpers/project';
import { exampleDevice, readReceipt, writeJestProject } from './helpers/jest-project';

/**
 * A setup file wraps `device.sendToHome` on the global. A test file calls
 * `sendToHome` on the `device` it imported from `detox`: the wrapper fires,
 * and the imported `device`, `element`, `by` and `waitFor` are the globals
 * themselves. The run is green and the receipt records one wrapped call.
 */
void test('a wrapper installed on the global device is there for a file that imports device from detox', async (t) => {
  await using server = await startServer({ dedicated: true, signal: t.signal });
  const project = await writeJestProject({
    '.detoxrc.js': {
      testRunner: { args: { $0: 'jest', config: 'e2e/jest.config.js' } },
      client: { server: server.address.url, token: tokenOf(server.address) },
      devices: { sim: { type: 'ios.simulator', device: { type: exampleDevice() } } },
      apps: { app: { type: 'ios.app', name: 'app', bundleId: 'com.example.fixture' } },
      configurations: { 'ios.sim': { device: 'sim', app: 'app' } },
    },
    'e2e/jest.config.js': {
      rootDir: '..',
      testMatch: ['<rootDir>/e2e/**/*.test.js'],
      testEnvironment: 'detox/runners/jest/testEnvironment',
      globalSetup: 'detox/runners/jest/globalSetup',
      globalTeardown: 'detox/runners/jest/globalTeardown',
      reporters: ['detox/runners/jest/reporter'],
      setupFilesAfterEnv: ['<rootDir>/e2e/setup.js'],
      maxWorkers: 1,
      testTimeout: 120_000,
    },
    'e2e/setup.js': `
const sendToHome = device.sendToHome;
globalThis.wrappedCalls = 0;
device.sendToHome = function wrapped(...args) {
  globalThis.wrappedCalls += 1;
  return sendToHome.apply(this, args);
};
`,
    'e2e/imported.test.js': `
const { writeFileSync } = require('node:fs');
const detox = require('detox');

it('goes through the wrapper the setup file put on the global', async () => {
  await detox.device.sendToHome();
  writeFileSync('receipt-imported.json', JSON.stringify({
    wrappedCalls: globalThis.wrappedCalls,
    device: detox.device === device,
    element: detox.element === element,
    by: detox.by === by,
    waitFor: detox.waitFor === waitFor,
  }));
});
`,
  });

  const result = await runDetoxCli(['test', '-c', 'ios.sim'], {
    cwd: project.dir,
    signal: t.signal,
  });

  assert.equal(result.exitCode, 0, `expected a green run, output:\n${result.output}`);
  const receipt = await readReceipt<Record<string, unknown>>(project.path('receipt-imported.json'));
  assert.equal(receipt.wrappedCalls, 1, 'the imported device.sendToHome went through the wrapper on the global');
  assert.deepEqual(
    { device: receipt.device, element: receipt.element, by: receipt.by, waitFor: receipt.waitFor },
    { device: true, element: true, by: true, waitFor: true },
    'each imported surface object is the global itself',
  );
});
