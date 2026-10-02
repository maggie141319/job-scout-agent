import { claudeMessage, type ClaudeMessage } from './providers';
import { findOpenRoles, updateEmployerList } from './tools';
import type { ChatMessage, ChatResponse, Employer, Role } from './types';

const tools = [
  {
    name: 'update_employer_list',
    description: 'Call when the user names two or more employers to watch. Find and save each employer’s careers or job board URL from the names alone. Do not call for general career advice.',
    input_schema: {
      type: 'object',
      properties: { companies: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5, description: 'At least two company names from the user.' } },
      required: ['companies'],
    },
  },
  {
    name: 'find_open_roles',
    description: 'Call when the user asks for current jobs of a type at the saved employers. Search their job boards and return specific roles with original links. Do not call for general career advice.',
    input_schema: {
      type: 'object',
      properties: { role: { type: 'string', description: 'The type of job or title the user wants, such as supply chain analyst.' } },
      required: ['role'],
    },
  },
];

const personality = `You are Job Scout, a clear, practical career coach. Be warm and concise without hype. Answer in the user's language. Never claim to have searched unless a tool was called. Use update_employer_list when the user names at least two employers to watch. Use find_open_roles when the user requests current jobs and employers have been saved. You may call both tools in sequence when needed. Answer general career questions directly without a tool. Never invent jobs, pay, or links. If a pay figure is absent, say pay was not provided in the posting. If no roles are verified, say so and suggest checking the employer board links. Do not fabricate a comparison table.`;

export async function runAgent(history: ChatMessage[], savedEmployers: Employer[]): Promise<ChatResponse> {
  let employers = savedEmployers;
  let roles: Role[] = [];
  const toolsUsed: string[] = [];
  const messages: ClaudeMessage[] = history.map(({ role, content }) => ({ role, content }));

  for (let step = 0; step < 5; step += 1) {
    const watched = employers.length ? employers.map((item) => {
      const platform = item.hiringPlatformUrl ? ` (hiring platform linked from this official careers page: ${item.hiringPlatformUrl})` : '';
      return `${item.name}: ${item.boardUrl ?? 'board not found'}${platform}`;
    }).join('; ') : 'none';
    const reply = await claudeMessage(messages, `${personality}\nSaved employers: ${watched}`, tools);
    const calls = reply.content.filter((item) => item.type === 'tool_use');
    if (!calls.length) {
      const answer = reply.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n').trim();
      return { answer: answer || 'I could not complete that response. Please try again.', employers, roles, toolsUsed };
    }
    messages.push({ role: 'assistant', content: reply.content });
    const results: { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }[] = [];
    for (const call of calls) {
      try {
        if (call.name === 'update_employer_list') {
          const companies = Array.isArray(call.input.companies) ? call.input.companies.filter((name): name is string => typeof name === 'string') : [];
          employers = await updateEmployerList(companies);
          toolsUsed.push(call.name);
          results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ employers }) });
        } else if (call.name === 'find_open_roles') {
          roles = await findOpenRoles(typeof call.input.role === 'string' ? call.input.role : '', employers);
          toolsUsed.push(call.name);
          results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify({ roles }) });
        } else {
          results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Unknown tool.', is_error: true });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Tool failed.';
        results.push({ type: 'tool_result', tool_use_id: call.id, content: message, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'I reached the tool limit for this request. Please try a shorter question.', employers, roles, toolsUsed };
}
