import type { ProviderRequest, ProviderResult, ReviewProvider } from './types.js';

export type FakeBehaviour =
  | { reply: string }
  | { result: ProviderResult }
  | { throws: string }
  | { hang: true }
  | { respond: (req: ProviderRequest) => ProviderResult };

export interface FakeProvider extends ReviewProvider {
  readonly calls: ProviderRequest[];
}

/** A provider for tests and dry runs: no network, records every request it receives. */
export function createFakeProvider(behaviour: FakeBehaviour): FakeProvider {
  const calls: ProviderRequest[] = [];
  return {
    name: 'fake',
    calls,
    complete(req: ProviderRequest, signal: AbortSignal): Promise<ProviderResult> {
      calls.push(req);
      if ('reply' in behaviour) return Promise.resolve({ ok: true, text: behaviour.reply });
      if ('result' in behaviour) return Promise.resolve(behaviour.result);
      if ('throws' in behaviour) return Promise.reject(new Error(behaviour.throws));
      if ('respond' in behaviour) return Promise.resolve(behaviour.respond(req));
      return new Promise<ProviderResult>((resolve) => {
        signal.addEventListener('abort', () => resolve({ ok: false, kind: 'network', error: 'aborted' }), { once: true });
      });
    },
  };
}
