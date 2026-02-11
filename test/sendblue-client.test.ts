import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendblueClient } from '../src/sendblue/client.js';

function createClient(overrides: Partial<ConstructorParameters<typeof SendblueClient>[0]> = {}): SendblueClient {
  return new SendblueClient({
    apiBase: 'https://api.sendblue.test/api',
    apiKey: 'k',
    apiSecret: 's',
    fromPhoneNumber: '+15550001111',
    inboundRequestTimeoutMs: 10,
    inboundMaxAttempts: 3,
    inboundInitialBackoffMs: 0,
    inboundMaxBackoffMs: 0,
    ...overrides,
  });
}

describe('SendblueClient.getInboundMessages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('retries transient 502 and succeeds on next attempt', async () => {
    const fetchMock = vi
      .fn<(...args: [RequestInfo | URL, RequestInit?]) => Promise<Response>>()
      .mockResolvedValueOnce(new Response('<html><h1>502</h1></html>', { status: 502 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                message_handle: 'm1',
                content: 'hello',
                from_number: '(555) 333-4444',
                to_number: '(555) 000-1111',
                is_outbound: false,
              },
              {
                message_handle: 'm2',
                content: 'outbound',
                from_number: '(555) 000-1111',
                to_number: '(555) 333-4444',
                is_outbound: true,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient();
    const messages = await client.getInboundMessages(50);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(messages).toEqual([
      expect.objectContaining({
        message_handle: 'm1',
        content: 'hello',
        from_number: '+5553334444',
        to_number: '+5550001111',
      }),
    ]);
  });

  it('fails after max attempts for repeated transient failures', async () => {
    const fetchMock = vi
      .fn<(...args: [RequestInfo | URL, RequestInit?]) => Promise<Response>>()
      .mockImplementation(async () => new Response('<html><h1>504</h1></html>', { status: 504 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient({ inboundMaxAttempts: 3 });

    await expect(client.getInboundMessages()).rejects.toThrow(/Sendblue fetch failed: 504/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries timed-out requests and then surfaces timeout error', async () => {
    const fetchMock = vi.fn<(...args: [RequestInfo | URL, RequestInit?]) => Promise<Response>>((_url, init) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient({
      inboundRequestTimeoutMs: 5,
      inboundMaxAttempts: 2,
      inboundInitialBackoffMs: 0,
      inboundMaxBackoffMs: 0,
    });

    await expect(client.getInboundMessages()).rejects.toThrow(/timed out/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
