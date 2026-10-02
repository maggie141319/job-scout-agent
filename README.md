# Job Scout

A Next.js + Tailwind chat app with a consistent, practical career-coach personality. Job Scout
can hold general career conversations, and can call two tools when you ask it to:

- **`update_employer_list`** — give it two or more employer names and it searches the web to find
  and save each employer's official careers/job-board URL.
- **`find_open_roles`** — ask for a type of role and it searches the saved job boards, reads each
  candidate posting, and returns only postings that are confirmed to be a real, currently open
  match — company, title, location, pay (if published), and the original clickable link, grouped
  by company.

General career questions (resume advice, interview prep, negotiation, etc.) are answered directly,
without calling a tool.

The sample employers used throughout the UI are valve manufacturers — **Flowserve** and
**Emerson** — as a stand-in for the user's business context. This is a general job-search tool,
not a valve/trade assistant; any employer names work.

## How it works

- `app/page.tsx` — the chat UI (client component). Renders the conversation, saved-employer chips,
  and job results as a comparison table on desktop / stacked cards on mobile.
- `app/api/chat/route.ts` — the API route. Validates the request body and calls the agent.
- `lib/agent.ts` — the tool-use loop. Sends the conversation + tool definitions to Claude, executes
  any requested tool, feeds the result back, and repeats until Claude replies with plain text.
- `lib/tools.ts` — the two tools. `updateEmployerList` uses Tavily search to rank candidate URLs
  and picks each employer's official careers page (rejecting third-party aggregators like
  LinkedIn/Indeed/Glassdoor). `findOpenRoles` searches each saved board, scrapes candidate postings
  with Firecrawl, and asks Claude to extract structured facts from the posting text only — a
  posting is only returned if Claude confirms it matches the requested role **and** appears open.
- `lib/providers.ts` — thin fetch wrappers for the Anthropic Messages API, Tavily search, and
  Firecrawl scrape. Each throws a clear "not configured" error if its API key is missing.

The app never invents jobs, employers, pay, or links. If a tool can't verify something, it says so
instead of guessing.

## Requirements

- Node.js 20+
- API keys for:
  - **Anthropic** (`ANTHROPIC_API_KEY`) — powers the chat/tool-calling model
  - **Tavily** (`TAVILY_API_KEY`) — web search used to find employer boards and candidate postings
  - **Firecrawl** (`FIRECRAWL_API_KEY`) — scrapes individual job postings for Claude to read

None of these keys are included in this repo. Without them, the app runs and the UI works, but any
message that needs a tool (or any chat reply at all, since even plain replies call Claude) will
return a clear "not configured" error instead of a fabricated result.

## Setup

This project uses **pnpm** (`pnpm-lock.yaml`).

```bash
pnpm install
cp .env.example .env.local
# edit .env.local and fill in ANTHROPIC_API_KEY, TAVILY_API_KEY, FIRECRAWL_API_KEY
# set ANTHROPIC_MODEL=claude-sonnet-5-5 (current Sonnet model ID)
pnpm build && pnpm start
```

Open http://localhost:3000. (`pnpm dev` also works, but `next dev` hit `EMFILE` file-watcher errors
on the original development machine; `build` + `start` is the reliable path.)

## Scripts

```bash
pnpm dev         # start the dev server
pnpm build       # production build
pnpm start       # run a production build locally
pnpm typecheck   # tsc --noEmit
pnpm test        # run the unit tests (vitest)
```

## How employers and postings are verified

- **Saved board:** must be the employer's own site (e.g. `careers.flowserve.com`) or a hiring platform
  labelled as theirs. Third-party aggregators (LinkedIn, Indeed, Glassdoor, Built In, Naukri, and
  others) are rejected.
- **Hiring platform:** if the official careers page links to a hiring platform (Workday, Oracle,
  Greenhouse, Lever, iCIMS, etc.), that platform is saved too and searched first. Emerson, for
  example, hosts its postings on an Oracle platform linked from `emerson.com`.
- **Postings:** must live on the saved board or linked platform, be a single specific opening (not a
  homepage, program, category, or search page), name the employer in the posting text, match the
  requested job type, and appear open.
- **Pay:** shown only when the posting states an explicit amount, and every number must appear in the
  posting text. Otherwise the UI shows "Not provided".
- **Original links:** each result links to the original posting URL exactly as found.
- **Firecrawl free-plan limits:** scrapes run at most two at a time; a rate-limited (HTTP 429)
  request is retried at most twice, honouring the server's `Retry-After`.

## Testing notes

`lib/tools.test.ts` and `lib/providers.test.ts` cover the logic that doesn't need live keys: board
scoring and aggregator rejection, hiring-platform discovery, tying postings to employers,
non-posting page filtering, pay verification, JSON parsing, input validation, and Firecrawl
concurrency/retry behaviour (with a mocked `fetch`).

Live end-to-end tests were run locally on 2026-10-01 with real Anthropic, Tavily, and Firecrawl keys:

- A general career question was answered without calling a tool.
- `update_employer_list` for Flowserve and Emerson saved `https://careers.flowserve.com/jobs` and
  Emerson's official careers page plus its linked Oracle hiring platform.
- `find_open_roles` for "mechanical engineer" returned real, open postings from both employers with
  original links; one Emerson posting showed its published pay range and the rest showed
  "Not provided".

Job boards change daily, so live results will differ over time.

## Deploying to Vercel

1. Push this directory to a Git repository (GitHub is easiest) and import it in Vercel. Vercel
   detects Next.js and pnpm automatically.
2. In the Vercel project's **Settings → Environment Variables**, add for Production and Preview:
   - `ANTHROPIC_API_KEY`
   - `TAVILY_API_KEY`
   - `FIRECRAWL_API_KEY`
   - `ANTHROPIC_MODEL` = `claude-sonnet-5-5` (without it the code falls back to the older
     `claude-sonnet-5`)
3. Deploy. `runtime = 'nodejs'` is already set on the API route. `.env.local` is gitignored and must
   never be committed.
