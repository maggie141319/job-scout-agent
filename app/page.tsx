'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Briefcase,
  Building2,
  ExternalLink,
  Loader2,
  MapPin,
  Send,
  Wallet,
} from 'lucide-react';
import type { ChatMessage, ChatResponse, Employer, Role } from '@/lib/types';

const EXAMPLE_PROMPTS = [
  'Track Flowserve and Emerson for me',
  'Find open mechanical engineer roles at my saved employers',
  'What should I highlight in a resume for a valve engineering role?',
];

const MAX_HISTORY = 20;

function groupRolesByCompany(roles: Role[]): [string, Role[]][] {
  const grouped = new Map<string, Role[]>();
  for (const role of roles) {
    const existing = grouped.get(role.company);
    if (existing) existing.push(role);
    else grouped.set(role.company, [role]);
  }
  return [...grouped.entries()];
}

function RoleResults({ roles }: { roles: Role[] }) {
  return (
    <div className="mt-3 space-y-5">
      {groupRolesByCompany(roles).map(([company, companyRoles]) => (
        <div key={company}>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <Building2 className="h-4 w-4 text-brand-600" aria-hidden="true" />
            {company}
            <span className="font-normal text-slate-500">
              ({companyRoles.length} role{companyRoles.length === 1 ? '' : 's'})
            </span>
          </h3>

          {/* Desktop / wide view: comparison table */}
          <table className="hidden w-full table-fixed border-collapse overflow-hidden rounded-lg border border-slate-200 text-left text-sm md:table">
            <caption className="sr-only">Open roles at {company}</caption>
            <thead>
              <tr className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600">
                <th scope="col" className="w-2/5 px-3 py-2 font-semibold">Title</th>
                <th scope="col" className="w-1/4 px-3 py-2 font-semibold">Location</th>
                <th scope="col" className="w-1/5 px-3 py-2 font-semibold">Pay</th>
                <th scope="col" className="w-auto px-3 py-2 font-semibold">Posting</th>
              </tr>
            </thead>
            <tbody>
              {companyRoles.map((role) => (
                <tr key={role.url} className="border-t border-slate-200 odd:bg-white even:bg-slate-50">
                  <td className="px-3 py-2 align-top font-medium text-slate-900">{role.title}</td>
                  <td className="px-3 py-2 align-top text-slate-700">{role.location}</td>
                  <td className="px-3 py-2 align-top text-slate-700">{role.pay ?? 'Not provided'}</td>
                  <td className="px-3 py-2 align-top">
                    <a
                      href={role.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-brand-600 hover:text-brand-700 hover:underline"
                    >
                      View original
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Mobile view: stacked cards */}
          <ul className="space-y-2 md:hidden">
            {companyRoles.map((role) => (
              <li key={role.url} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                <p className="font-medium text-slate-900">{role.title}</p>
                <p className="mt-1 flex items-center gap-1 text-sm text-slate-600">
                  <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {role.location}
                </p>
                <p className="mt-1 flex items-center gap-1 text-sm text-slate-600">
                  <Wallet className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {role.pay ?? 'Not provided'}
                </p>
                <a
                  href={role.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline"
                >
                  View original posting
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function EmployerChips({ employers }: { employers: Employer[] }) {
  if (employers.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1">
      {employers.map((employer) => (
        <span
          key={employer.name}
          className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 shadow-sm"
        >
          <Building2 className="h-3.5 w-3.5 text-brand-600" aria-hidden="true" />
          {employer.name}
          {employer.boardUrl ? (
            <a
              href={employer.boardUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-600 hover:text-brand-700"
              aria-label={`Open ${employer.name} careers board`}
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          ) : (
            <span className="text-slate-400">board not found</span>
          )}
        </span>
      ))}
    </div>
  );
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [employers, setEmployers] = useState<Employer[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMessage: ChatMessage = { role: 'user', content: trimmed };
    const nextMessages = [...messages, userMessage].slice(-MAX_HISTORY);

    setMessages(nextMessages);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: nextMessages.map(({ role, content }) => ({ role, content })),
          employers,
        }),
      });

      const data: ChatResponse | { error: string } = await response.json();

      if (!response.ok || 'error' in data) {
        const message = 'error' in data ? data.error : 'Something went wrong. Please try again.';
        setError(message);
        return;
      }

      setEmployers(data.employers);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: data.answer, roles: data.roles.length ? data.roles : undefined },
      ]);
    } catch {
      setError('Could not reach Job Scout. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    sendMessage(input);
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 py-6 sm:px-6">
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
          <Briefcase className="h-7 w-7 text-brand-600" aria-hidden="true" />
          Job Scout
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Your practical career coach. Name employers to watch, then ask for open roles — every
          result links back to the original posting.
        </p>
      </header>

      <EmployerChips employers={employers} />

      <div
        role="log"
        aria-live="polite"
        aria-label="Conversation with Job Scout"
        className="mt-4 flex-1 space-y-4 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        style={{ minHeight: '50vh' }}
      >
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 py-10 text-center">
            <p className="max-w-sm text-sm text-slate-500">
              Ask a general career question, or name two or more employers to start tracking their
              job boards — for example, valve manufacturers like Flowserve and Emerson.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => sendMessage(prompt)}
                  className="rounded-full border border-brand-200 bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 transition hover:bg-brand-100"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message, index) => (
          <div
            key={index}
            className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
                message.role === 'user'
                  ? 'bg-brand-600 text-white'
                  : 'border border-slate-200 bg-slate-50 text-slate-800'
              }`}
            >
              <p className="whitespace-pre-wrap">{message.content}</p>
              {message.role === 'assistant' && message.roles && <RoleResults roles={message.roles} />}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Job Scout is checking the boards…
            </div>
          </div>
        )}

        <div ref={logEndRef} />
      </div>

      {error && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-4 flex items-end gap-2">
        <label htmlFor="message" className="sr-only">
          Message Job Scout
        </label>
        <input
          id="message"
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask about roles, employers, or your career…"
          disabled={loading}
          autoComplete="off"
          maxLength={4000}
          className="flex-1 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-brand-500 disabled:bg-slate-100"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
          Send
        </button>
      </form>
    </div>
  );
}
