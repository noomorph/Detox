/**
 * Spec 020: a cancellation carries a typed reason across the wire, and the
 * `-32800` answer says what the cancelled handler was waiting for.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AbortError,
  AbortReason,
  abortKindOf,
  connectionLostReason,
  memoryChannel,
  Peer,
  readAbortKind,
} from '..';
import type { RequestContext } from '..';

/** What a parked handler saw. */
interface Seen {
  reason?: unknown;
  ctx?: RequestContext;
}

/** A handler that states its wait and parks until aborted. */
function parkedHandler(seen: Seen, state?: (ctx: RequestContext) => void) {
  return (_params: unknown, ctx: RequestContext): Promise<never> => {
    seen.ctx = ctx;
    state?.(ctx);
    return new Promise((_resolve, reject) => {
      ctx.signal.addEventListener('abort', () => {
        seen.reason = ctx.signal.reason;
        // A statement after the abort does not rewrite what was interrupted.
        ctx.waiting('rolling back');
        reject(new Error('stopped'));
      });
    });
  };
}

function pair() {
  const [clientCh, serverCh] = memoryChannel();
  const sent: unknown[] = [];
  const send = clientCh.send.bind(clientCh);
  clientCh.send = (msg) => {
    sent.push(msg);
    send(msg);
  };
  return { client: Peer.create(clientCh), server: Peer.create(serverCh), sent };
}

/** The slice of a `-32800` answer's `data` these tests read. */
interface CancelledData {
  reason?: unknown;
}

/** The slice of an incoming frame the hand-rolled responder reads. */
interface CancelFrame {
  method?: string;
  params?: { id: string };
}

/** Resolves once the handler is running — a cancel sent earlier would never reach it. */
const parked = (seen: Seen) => vi.waitFor(() => expect(seen.ctx).toBeDefined());

describe('the abort kind vocabulary', () => {
  it('reads our own reason by brand, a lost connection by code, anything else as caller', () => {
    expect(abortKindOf(new AbortReason('hook-failed'))).toBe('hook-failed');
    expect(new AbortReason('file-ended').message).toBe('aborted: file-ended');
    expect(abortKindOf({ name: 'AbortReason', kind: 'made-up' })).toBe('caller');
    expect(abortKindOf(connectionLostReason())).toBe('connection-closed');
    expect(abortKindOf(new Error('mine'))).toBe('caller');
    expect(abortKindOf(undefined)).toBe('caller');
  });

  it('validates a wire value against the closed vocabulary', () => {
    expect(readAbortKind('ready-timeout')).toBe('ready-timeout');
    expect(readAbortKind('bogus')).toBeUndefined();
    expect(readAbortKind(7)).toBeUndefined();
  });
});

describe('a cancellation crosses the wire with its kind', () => {
  it('$/cancelRequest carries the kind, and the handler is aborted with a typed reason of it', async () => {
    const { client, server, sent } = pair();
    const seen: Seen = {};
    server.onRequest({ method: 'slow', handler: parkedHandler(seen) });

    const ac = new AbortController();
    const call = client.request({ method: 'slow', signal: ac.signal });
    await parked(seen);
    ac.abort(new AbortReason('test-failed'));

    await expect(call).rejects.toBeInstanceOf(AbortError);
    expect(sent).toContainEqual(
      expect.objectContaining({ method: '$/cancelRequest', params: { id: '1', reason: 'test-failed' } }),
    );
    expect(abortKindOf(seen.reason)).toBe('test-failed');
  });

  it('a caller signal of its own is sent, and read, as caller', async () => {
    const { client, server, sent } = pair();
    const seen: Seen = {};
    server.onRequest({ method: 'slow', handler: parkedHandler(seen) });

    const ac = new AbortController();
    const call = client.request({ method: 'slow', signal: ac.signal });
    await parked(seen);
    ac.abort();
    await expect(call).rejects.toBeInstanceOf(AbortError);
    expect(sent).toContainEqual(expect.objectContaining({ params: { id: '1', reason: 'caller' } }));
    expect(abortKindOf(seen.reason)).toBe('caller');
  });
});

describe('the handling side reads an absent or unknown kind — or one only it could know — as caller', () => {
  it.each([
    [{ id: '1' }],
    [{ id: '1', reason: 'bogus' }],
    [{ id: '1', reason: 'ready-timeout' }],
    [{ id: '1', reason: 'connection-closed' }],
  ])('$/cancelRequest %j', async (params) => {
    const { client, server } = pair();
    const seen: Seen = {};
    server.onRequest({ method: 'slow', handler: parkedHandler(seen) });
    const reasons: unknown[] = [];
    server.observe({ onRequestEnd: (end) => reasons.push((end.error?.data as CancelledData).reason) });
    const call = client.request({ method: 'slow' });
    call.catch(() => undefined);
    await parked(seen);
    client.notify({ method: '$/cancelRequest', params });
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortKindOf(seen.reason)).toBe('caller');
    expect(reasons).toEqual(['caller']);
  });
});

describe('ctx.waiting lands in the -32800 answer', () => {
  it('the last stated wait reaches AbortError.details.waiting with forMs and its fields', async () => {
    const { client, server } = pair();
    const seen: Seen = {};
    server.onRequest({
      method: 'slow',
      handler: parkedHandler(seen, (ctx) => {
        ctx.waiting('first');
        ctx.waiting('second', { attempt: 2 });
      }),
    });
    const ends: unknown[] = [];
    server.observe({ onRequestEnd: (end) => ends.push(end.error) });

    const ac = new AbortController();
    const call = client.request({ method: 'slow', signal: ac.signal });
    await parked(seen);
    ac.abort(new AbortReason('hook-failed'));

    const error = (await call.catch((e: unknown) => e)) as AbortError;
    expect(error.details).toEqual({
      outcome: 'nothing-to-undo',
      waiting: { on: 'second', attempt: 2, forMs: expect.any(Number) as number },
    });
    expect(ends[0]).toMatchObject({
      code: -32800,
      data: { outcome: 'nothing-to-undo', reason: 'hook-failed', waiting: { on: 'second' } },
    });
  });

  it('a handler that states nothing reports no waiting', async () => {
    const { client, server } = pair();
    const seen: Seen = {};
    server.onRequest({ method: 'slow', handler: parkedHandler(seen) });
    const ac = new AbortController();
    const call = client.request({ method: 'slow', signal: ac.signal });
    await parked(seen);
    ac.abort();
    const error = (await call.catch((e: unknown) => e)) as AbortError;
    expect(error.details).toEqual({ outcome: 'nothing-to-undo' });
  });

  it('a malformed waiting on the answer is dropped; a waiting alone still reaches the caller', async () => {
    const [clientCh, serverCh] = memoryChannel();
    const client = Peer.create(clientCh);
    serverCh.onMessage((msg) => {
      const frame = msg as CancelFrame;
      if (frame.method === 'slow') return;
      if (frame.method === '$/cancelRequest' && frame.params?.id === '1') {
        serverCh.send({ jsonrpc: '2.0', id: '1', error: { code: -32800, message: 'x', data: { waiting: { on: 7 } } } });
      }
      if (frame.method === '$/cancelRequest' && frame.params?.id === '2') {
        serverCh.send({
          jsonrpc: '2.0',
          id: '2',
          error: { code: -32800, message: 'x', data: { waiting: { on: 'x', forMs: 3 } } },
        });
      }
    });
    const first = new AbortController();
    const second = new AbortController();
    const one = client.request({ method: 'slow', signal: first.signal });
    const two = client.request({ method: 'slow', signal: second.signal });
    first.abort();
    second.abort();
    expect(((await one.catch((e: unknown) => e)) as AbortError).details).toBeUndefined();
    expect(((await two.catch((e: unknown) => e)) as AbortError).details).toEqual({ waiting: { on: 'x', forMs: 3 } });
  });
});
