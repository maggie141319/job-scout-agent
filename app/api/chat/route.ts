import { runAgent } from '@/lib/agent';
import type { ChatMessage, Employer } from '@/lib/types';

export const runtime = 'nodejs';

function validHistory(value: unknown): value is ChatMessage[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every((item) =>
    item && typeof item === 'object' && (item.role === 'user' || item.role === 'assistant') &&
    typeof item.content === 'string' && item.content.length <= 4000,
  ) && value[value.length - 1].role === 'user';
}

function validEmployers(value: unknown): value is Employer[] {
  return Array.isArray(value) && value.length <= 5 && value.every((item) =>
    item && typeof item === 'object' && typeof item.name === 'string' && item.name.length <= 100 &&
    (item.boardUrl === null || (typeof item.boardUrl === 'string' && /^https:\/\//.test(item.boardUrl) && item.boardUrl.length <= 500)) &&
    (item.hiringPlatformUrl == null || (typeof item.hiringPlatformUrl === 'string' && /^https:\/\//.test(item.hiringPlatformUrl) && item.hiringPlatformUrl.length <= 500)),
  );
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object') return Response.json({ error: 'Invalid request.' }, { status: 400 });
    const { messages, employers } = body as Record<string, unknown>;
    if (!validHistory(messages) || !validEmployers(employers)) {
      return Response.json({ error: 'Invalid conversation or employer list.' }, { status: 400 });
    }
    const result = await runAgent(messages, employers);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Something went wrong.';
    const status = message.includes('not configured') ? 503 : 500;
    return Response.json({ error: message }, { status });
  }
}
