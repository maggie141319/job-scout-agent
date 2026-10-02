type ClaudeContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export type ClaudeMessage = {
  role: 'user' | 'assistant';
  content: string | ClaudeContent[];
};

export type ClaudeReply = { content: ClaudeContent[]; stop_reason: string | null };

function requiredKey(name: 'ANTHROPIC_API_KEY' | 'TAVILY_API_KEY' | 'FIRECRAWL_API_KEY') {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured. Add it to .env.local and Vercel Environment Variables.`);
  return value;
}

async function jsonRequest<T>(url: string, body: object, headers: Record<string, string>, timeoutMs = 30000): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new HttpError(response.status, response.headers.get('retry-after'));
  }
  return response.json() as Promise<T>;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly retryAfter: string | null) {
    super(`External service returned ${status}. Check the API key and service quota.`);
  }
}

// Firecrawl's free plan rate-limits per minute, so scrapes share a small concurrency limit
// and a rate-limited (429) request is retried at most twice. A 429 does not use credits.
const FIRECRAWL_CONCURRENCY = 2;
const FIRECRAWL_MAX_RETRIES = 2;
let firecrawlActive = 0;
const firecrawlQueue: (() => void)[] = [];

async function withFirecrawlSlot<T>(task: () => Promise<T>): Promise<T> {
  if (firecrawlActive >= FIRECRAWL_CONCURRENCY) await new Promise<void>((resolve) => firecrawlQueue.push(resolve));
  firecrawlActive += 1;
  try {
    return await task();
  } finally {
    firecrawlActive -= 1;
    firecrawlQueue.shift()?.();
  }
}

/** Wait before retry: the server's Retry-After (capped at 30s), else 10s then 20s. */
export function retryDelayMs(retryAfter: string | null, attempt: number) {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 30) * 1000 : 10000 * (attempt + 1);
}

async function firecrawlRequest<T>(body: object): Promise<T> {
  const key = requiredKey('FIRECRAWL_API_KEY');
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withFirecrawlSlot(() => jsonRequest<T>('https://api.firecrawl.dev/v2/scrape', body, { Authorization: `Bearer ${key}` }, 25000));
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 429 || attempt >= FIRECRAWL_MAX_RETRIES) throw error;
      // Wait outside the slot so other scrapes can proceed.
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(error.retryAfter, attempt)));
    }
  }
}

export async function claudeMessage(
  messages: ClaudeMessage[],
  system: string,
  tools?: object[],
): Promise<ClaudeReply> {
  const body: Record<string, unknown> = {
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    max_tokens: 1200,
    system,
    messages,
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
  }
  return jsonRequest<ClaudeReply>(
    'https://api.anthropic.com/v1/messages',
    body,
    { 'x-api-key': requiredKey('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
    45000,
  );
}

export type SearchResult = { title: string; url: string; content?: string };

export async function tavilySearch(query: string, maxResults = 6): Promise<SearchResult[]> {
  const response = await jsonRequest<{ results?: SearchResult[] }>(
    'https://api.tavily.com/search',
    { query, search_depth: 'basic', max_results: maxResults, include_answer: false },
    { Authorization: `Bearer ${requiredKey('TAVILY_API_KEY')}` },
  );
  return Array.isArray(response.results) ? response.results : [];
}

export async function firecrawlScrape(url: string): Promise<string> {
  const response = await firecrawlRequest<{ success?: boolean; data?: { markdown?: string } }>(
    { url, formats: ['markdown'], onlyMainContent: true, timeout: 15000 },
  );
  if (!response.success || !response.data?.markdown) throw new Error('This posting could not be read.');
  return response.data.markdown;
}

export async function firecrawlLinks(url: string): Promise<string[]> {
  const response = await firecrawlRequest<{ success?: boolean; data?: { links?: string[] } }>(
    { url, formats: ['links'], timeout: 15000 },
  );
  return response.success && Array.isArray(response.data?.links) ? response.data.links : [];
}
