// Lever B — the refcounted document lease (withDocument) in LspClient.
//
// This is the load-bearing footgun fix: didOpen/didClose bypass the request
// semaphore, and open state is keyed by URI. Without refcounting, parallel
// enrichment would (a) flush every didOpen past the cap and OOM the server, and
// (b) let one file's didClose close a URI another op is mid-request on. These
// tests exercise the lease directly, stubbing sendNotification (no real server).

import { describe, it, expect, vi } from 'vitest';
import { LspClient, type LspClientOptions } from '../client.js';

/** A ready LspClient whose didOpen/didClose notifications are recorded, not sent. */
function makeClient(opts?: Partial<LspClientOptions>) {
  const client = new LspClient({ serverCommand: 'noop', ...opts });
  // Mark ready without spawning a server (assertReady only checks these flags).
  (client as unknown as { _initialized: boolean })._initialized = true;

  const opens: string[] = [];
  const closes: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  vi.spyOn(
    client as unknown as { sendNotification: (m: string, p: unknown) => void },
    'sendNotification'
  ).mockImplementation((method: string, params: unknown) => {
    const uri = (params as { textDocument?: { uri?: string } })?.textDocument?.uri ?? '';
    if (method === 'textDocument/didOpen') {
      opens.push(uri);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
    } else if (method === 'textDocument/didClose') {
      closes.push(uri);
      inFlight--;
    }
  });

  return {
    client,
    opens,
    closes,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

/** Flush pending microtasks + one macrotask turn (semaphore resolves via microtasks). */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('LspClient.withDocument — refcounted lease', () => {
  it('sends exactly one didOpen and one didClose for two concurrent same-URI leases', async () => {
    const { client, opens, closes } = makeClient();
    const uri = 'file:///a.ts';

    let release1!: () => void;
    let release2!: () => void;
    const held1 = new Promise<void>((r) => (release1 = r));
    const held2 = new Promise<void>((r) => (release2 = r));

    const p1 = client.withDocument(uri, 'typescript', 'x', () => held1);
    const p2 = client.withDocument(uri, 'typescript', 'x', () => held2);
    await flush();

    // Both leases active, but only ONE physical open.
    expect(opens).toEqual([uri]);
    expect(closes).toEqual([]);

    release1();
    await flush();
    // First holder released, but the second still holds — no close yet.
    expect(closes).toEqual([]);

    release2();
    await Promise.all([p1, p2]);
    expect(opens).toEqual([uri]);
    expect(closes).toEqual([uri]);
  });

  it('never exceeds maxOpenDocuments open documents in flight', async () => {
    const client = makeClient({ maxOpenDocuments: 2 });
    const uris = ['file:///1', 'file:///2', 'file:///3', 'file:///4', 'file:///5'];
    const releases: Array<() => void> = [];

    const ps = uris.map((u) =>
      client.client.withDocument(
        u,
        'typescript',
        'x',
        () => new Promise<void>((r) => releases.push(r))
      )
    );

    await flush();
    // Only the cap should have opened so far; the rest wait on the semaphore.
    expect(client.opens).toHaveLength(2);

    // Drain: release each opened holder; freeing a permit lets the next one open.
    while (releases.length > 0) {
      releases.shift()!();
      await flush();
    }
    await Promise.all(ps);

    expect(client.maxInFlight).toBeLessThanOrEqual(2);
    expect(client.opens).toHaveLength(5);
    expect(client.closes).toHaveLength(5);
  });

  it('keeps a document open while a sibling lease on another URI opens and closes', async () => {
    const { client, closes } = makeClient({ maxOpenDocuments: 4 });

    let releaseA!: () => void;
    const heldA = new Promise<void>((r) => (releaseA = r));
    let aResult = 'pending';

    const pA = client.withDocument('file:///A.ts', 'typescript', 'x', async () => {
      await heldA;
      aResult = 'done';
      return 'A';
    });
    await flush();

    // A full sibling lease on B runs to completion while A is still held.
    const rB = await client.withDocument('file:///B.ts', 'typescript', 'x', () =>
      Promise.resolve('B')
    );
    expect(rB).toBe('B');
    expect(closes).toContain('file:///B.ts');
    expect(closes).not.toContain('file:///A.ts'); // A untouched by B's close
    expect(aResult).toBe('pending');

    releaseA();
    expect(await pA).toBe('A');
    expect(aResult).toBe('done');
    expect(closes).toContain('file:///A.ts');
  });
});
