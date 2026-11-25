/**
 * The interrupted-call report (spec 020): when jest fails a test or a hook
 * while a Detox call is in flight, the call is cancelled and its answer says
 * what it was waiting for. One line per such call is appended to the failure
 * jest is about to print — jest's own text stays first and intact.
 */
import { DetoxErrorCode } from 'detox/client';

/** How long a failed unit waits for its cancelled calls to answer before jest moves on without the report. */
export const INTERRUPTED_ANSWER_BOUND_MS = 10_000;

/** A wire call made during a unit, as the session's call tracker reported it. */
export interface TrackedCall {
  method: string;
  call: Promise<unknown>;
}

/**
 * `Interrupted: <method> — <on> for <N>ms` for a cancelled call whose answer
 * carried `details.waiting`; `undefined` for anything else. Duck-typed: the
 * rejection may come from another bundle's `AbortError`.
 */
export function interruptedLine(method: string, error: unknown): string | undefined {
  const carrier = error as { code?: unknown; details?: { waiting?: { on?: unknown; forMs?: unknown } } } | null;
  const waiting = carrier?.code === DetoxErrorCode.DETOX_ABORTED ? carrier.details?.waiting : undefined;
  if (typeof waiting?.on !== 'string' || typeof waiting.forMs !== 'number') return undefined;
  return `Interrupted: ${method} — ${waiting.on} for ${String(Math.round(waiting.forMs))}ms`;
}

/**
 * The lines for every call among `calls` that answered within the bound;
 * a call that does not answer in time contributes nothing.
 */
export async function collectInterrupted(calls: readonly TrackedCall[], boundMs = INTERRUPTED_ANSWER_BOUND_MS): Promise<string[]> {
  const lines: string[] = [];
  const answers = calls.map(({ method, call }) =>
    call.then(
      () => undefined,
      (error: unknown) => {
        const line = interruptedLine(method, error);
        if (line !== undefined) lines.push(line);
      },
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, boundMs);
  });
  await Promise.race([Promise.all(answers), bound]);
  clearTimeout(timer);
  return [...lines];
}

/** The slices of circus objects whose `errors` hold `[error, asyncError]` tuples. */
interface ErrorsCarrier {
  type?: unknown;
  errors?: unknown[];
  children?: ErrorsCarrier[];
}

/** Every test's `errors` list under a describe block — where circus copies a failed `beforeAll`'s error. */
export function errorListsUnder(block: unknown): unknown[][] {
  const lists: unknown[][] = [];
  for (const child of (block as ErrorsCarrier | undefined)?.children ?? []) {
    if (child.type === 'describeBlock') lists.push(...errorListsUnder(child));
    else if (child.type === 'test' && Array.isArray(child.errors)) lists.push(child.errors);
  }
  return lists;
}

/**
 * Appends `text` to the failure jest will print. An error object is amended
 * in place (message, and the stack's copy of it — V8 renders `.stack` lazily,
 * so it is read first); a string — jest's own timeout verdict — cannot be,
 * so the latest `[error, asyncError]` tuple carrying it in each list is
 * replaced with one carrying the longer string.
 */
export function appendToFailure(error: unknown, lists: readonly unknown[][], text: string): void {
  if (typeof error === 'string') {
    for (const list of lists) {
      for (let at = list.length - 1; at >= 0; at -= 1) {
        const entry = list[at];
        if (!Array.isArray(entry) || entry[0] !== error) continue;
        list[at] = [`${error}\n\n${text}`, ...(entry.slice(1) as unknown[])];
        break;
      }
    }
    return;
  }
  const carrier = error as { message?: unknown; stack?: unknown } | null;
  if (carrier === null || typeof carrier !== 'object' || typeof carrier.message !== 'string') return;
  const original = carrier.message;
  const amended = `${original}\n\n${text}`;
  try {
    const stack = carrier.stack;
    carrier.message = amended;
    if (typeof stack === 'string' && original.length > 0 && stack.includes(original)) {
      // A replacer function: the message is literal text, never a `$&` pattern.
      carrier.stack = stack.replace(original, () => amended);
    }
  } catch {
    // A frozen error keeps its message: the report is best-effort.
  }
}
