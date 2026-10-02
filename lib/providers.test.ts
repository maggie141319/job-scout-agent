import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firecrawlScrape, retryDelayMs } from './providers';

function reply(status: number, retryAfter?: string) {
  const headers = new Headers(retryAfter === undefined ? {} : { 'retry-after': retryAfter });
  const body = status === 200 ? { success: true, data: { markdown: '# Mechanical Engineer' } } : { error: 'Rate limit exceeded' };
  return new Response(JSON.stringify(body), { status, headers });
}

describe('retryDelayMs', () => {
  it('uses the server Retry-After, capped at 30 seconds', () => {
    expect(retryDelayMs('5', 0)).toBe(5000);
    expect(retryDelayMs('120', 0)).toBe(30000);
  });

  it('falls back to 10s then 20s without a Retry-After header', () => {
    expect(retryDelayMs(null, 0)).toBe(10000);
    expect(retryDelayMs(null, 1)).toBe(20000);
  });
});

describe('firecrawlScrape rate-limit handling', () => {
  beforeEach(() => vi.stubEnv('FIRECRAWL_API_KEY', 'test-key'));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('retries a 429 and then succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(429, '0')).mockResolvedValueOnce(reply(200));
    vi.stubGlobal('fetch', fetchMock);
    await expect(firecrawlScrape('https://careers.flowserve.com/x/1234/job')).resolves.toBe('# Mechanical Engineer');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after two retries so credits and time are not wasted', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => reply(429, '0'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(firecrawlScrape('https://careers.flowserve.com/x/1234/job')).rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry other errors', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => reply(401));
    vi.stubGlobal('fetch', fetchMock);
    await expect(firecrawlScrape('https://careers.flowserve.com/x/1234/job')).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never runs more than two scrapes at once', async () => {
    let active = 0;
    let peak = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return reply(200);
    }));
    await Promise.all(Array.from({ length: 6 }, (_, i) => firecrawlScrape(`https://careers.flowserve.com/x/${1000 + i}/job`)));
    expect(peak).toBe(2);
  });
});
