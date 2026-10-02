import { describe, expect, it } from 'vitest';
import {
  boardScore, findOpenRoles, isNonPostingPage, namesEmployer, parseJsonObject, pickHiringPlatform, postingKey, roleSearchQuery, sameBoardHost,
  tiedToEmployer, updateEmployerList, verifiedPay,
} from './tools';
import type { SearchResult } from './providers';

describe('boardScore', () => {
  it('rejects blocked job-board aggregators', () => {
    const result: SearchResult = { title: 'Flowserve Careers', url: 'https://www.linkedin.com/company/flowserve' };
    expect(boardScore(result, 'Flowserve')).toBe(-1);
  });

  it('rejects non-https URLs', () => {
    const result: SearchResult = { title: 'Flowserve Careers', url: 'http://flowserve.com/careers' };
    expect(boardScore(result, 'Flowserve')).toBe(-1);
  });

  it('scores an official careers page with matching company slug highest', () => {
    const official: SearchResult = { title: 'Flowserve Official Careers', url: 'https://www.flowserve.com/en/careers' };
    const unrelated: SearchResult = { title: 'Some blog post', url: 'https://example.com/blog/flowserve-review' };
    expect(boardScore(official, 'Flowserve')).toBeGreaterThan(boardScore(unrelated, 'Flowserve'));
  });

  it('gives credit to known applicant-tracking-system hosts', () => {
    const ats: SearchResult = { title: 'Emerson Jobs', url: 'https://emerson.wd5.myworkdayjobs.com/en-US/Careers' };
    expect(boardScore(ats, 'Emerson')).toBeGreaterThanOrEqual(4);
  });

  it('rejects third-party aggregators such as Built In even when the page is about the employer', () => {
    const builtIn: SearchResult = { title: 'Flowserve Corporation Jobs + Careers | Built In', url: 'https://builtin.com/company/flowserve-corporation/jobs' };
    expect(boardScore(builtIn, 'Flowserve')).toBe(-1);
  });

  it('rejects unknown sites that are neither the employer domain nor a hiring platform', () => {
    const unknown: SearchResult = { title: 'Flowserve careers and jobs', url: 'https://jobs-aggregator.example/flowserve-careers' };
    expect(boardScore(unknown, 'Flowserve')).toBe(-1);
  });

  it('prefers the employer careers subdomain over its marketing site', () => {
    const subdomain: SearchResult = { title: 'Jobs | Flowserve', url: 'https://careers.flowserve.com/jobs' };
    const marketing: SearchResult = { title: 'Careers | Flowserve', url: 'https://www.flowserve.com/en/careers' };
    expect(boardScore(subdomain, 'Flowserve')).toBeGreaterThan(boardScore(marketing, 'Flowserve'));
  });

  it('accepts a hiring platform only when it is labelled as the employer', () => {
    const url = 'https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs';
    expect(boardScore({ title: 'Emerson Career Site', url }, 'Emerson')).toBeGreaterThanOrEqual(4);
    expect(boardScore({ title: 'Career Site', url }, 'Emerson')).toBe(-1);
  });
});

describe('pickHiringPlatform', () => {
  it('returns the first linked hiring platform without query parameters', () => {
    const links = [
      'https://www.instagram.com/emersoncareers/',
      'https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs?keyword=Software+Development',
    ];
    expect(pickHiringPlatform(links)).toBe('https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs');
  });

  it('ignores non-job Oracle Cloud apps and aggregators', () => {
    expect(pickHiringPlatform(['https://foo.oraclecloud.com/analytics', 'https://www.indeed.com/cmp/Emerson'])).toBeNull();
  });
});

describe('sameBoardHost', () => {
  const board = 'https://www.flowserve.com/en/careers';

  it('matches an exact hostname', () => {
    expect(sameBoardHost('https://www.flowserve.com/jobs/12345', board)).toBe(true);
  });

  it('matches a subdomain of the board host', () => {
    expect(sameBoardHost('https://careers.www.flowserve.com/jobs/12345', board)).toBe(true);
  });

  it('rejects a different hostname', () => {
    expect(sameBoardHost('https://www.emerson.com/jobs/12345', board)).toBe(false);
  });

  it('rejects blocked aggregator hosts even if otherwise similar', () => {
    expect(sameBoardHost('https://www.indeed.com/viewjob?jk=1', 'https://www.indeed.com')).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(sameBoardHost('not-a-url', board)).toBe(false);
  });

  it('on shared platforms, requires the same employer path segment', () => {
    const greenhouse = 'https://boards.greenhouse.io/acme';
    expect(sameBoardHost('https://boards.greenhouse.io/acme/jobs/123', greenhouse)).toBe(true);
    expect(sameBoardHost('https://boards.greenhouse.io/othercorp/jobs/456', greenhouse)).toBe(false);
  });
});

describe('tiedToEmployer', () => {
  const emerson = {
    name: 'Emerson',
    boardUrl: 'https://www.emerson.com/en/corporate/careers/career-opportunities',
    hiringPlatformUrl: 'https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs',
  };

  it('accepts postings on the hiring platform linked from the official careers page', () => {
    expect(tiedToEmployer('https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26007570', emerson)).toBe(true);
  });

  it('rejects postings on aggregators or unrelated hosts', () => {
    expect(tiedToEmployer('https://builtin.com/job/engineer/10480582', emerson)).toBe(false);
    expect(tiedToEmployer('https://other.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/1', emerson)).toBe(false);
  });

  it('works when no hiring platform was found', () => {
    const flowserve = { name: 'Flowserve', boardUrl: 'https://careers.flowserve.com/jobs', hiringPlatformUrl: null };
    expect(tiedToEmployer('https://careers.flowserve.com/raleigh-nc/project-engineer/CAA13F04/job', flowserve)).toBe(true);
  });
});

describe('isNonPostingPage', () => {
  it('skips careers homepages, program, category, and search pages', () => {
    for (const url of [
      'https://careers.flowserve.com',
      'https://careers.flowserve.com/career-programs/internship',
      'https://careers.flowserve.com/job-category/engineering/jobs',
      'https://www.emerson.com/en/corporate/careers/meet-our-engineers',
      'https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs?keyword=engineer',
    ]) expect(isNonPostingPage(url), url).toBe(true);
  });

  it('keeps individual postings that carry a job ID', () => {
    for (const url of [
      'https://careers.flowserve.com/bengaluru-ind/mechanical-engineer/D8D975772149444CA8594D44C6EBFA4A/job',
      'https://careers.flowserve.com/budapest-hun/internship-opportunities/1833357F41254C93B951DD715790EB48/job',
      'https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26007570?mode=location',
      'https://emerson.wd5.myworkdayjobs.com/en-US/Careers/job/Austin-TX/Mechanical-Engineer_R12345',
      'https://boards.greenhouse.io/acme/jobs/4567890',
    ]) expect(isNonPostingPage(url), url).toBe(false);
  });

  it('keeps unrecognised pages without an ID for the posting check to decide', () => {
    expect(isNonPostingPage('https://www.emerson.com/en/automation-systems/ovation-distributed-control-system')).toBe(false);
  });
});

describe('postingKey', () => {
  it('treats locale and query variants of one posting as the same posting', () => {
    const base = 'https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience';
    expect(postingKey(`${base}/en/sites/CX_1/job/26008907`)).toBe(postingKey(`${base}/de/sites/CX_1/job/26008907?mode=location`));
  });
});

describe('roleSearchQuery', () => {
  it('scopes the search to the source host without extra words that weaken the site filter', () => {
    const query = roleSearchQuery('https://hdjq.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1', 'Emerson', 'mechanical engineer');
    expect(query).toBe('site:hdjq.fa.us2.oraclecloud.com Emerson mechanical engineer');
  });
});

describe('verifiedPay', () => {
  const source = 'The pay range for this role is $85,000 - $110,000 per year.';

  it('keeps a pay range whose numbers appear in the posting', () => {
    expect(verifiedPay('$85,000 - $110,000 per year', source)).toBe('$85,000 - $110,000 per year');
  });

  it('drops pay figures that are not in the posting text', () => {
    expect(verifiedPay('$95,000 - $120,000', source)).toBeNull();
  });

  it('drops vague wording without figures, and missing pay', () => {
    expect(verifiedPay('Competitive base salary', 'We pay a competitive base salary.')).toBeNull();
    expect(verifiedPay(null, source)).toBeNull();
  });
});

describe('namesEmployer', () => {
  it('matches the employer named in the posting', () => {
    expect(namesEmployer('Emerson Electric Co.', 'Emerson')).toBe(true);
    expect(namesEmployer('Flowserve', 'Flowserve')).toBe(true);
  });

  it('rejects a different or missing employer', () => {
    expect(namesEmployer('Acme Valves', 'Flowserve')).toBe(false);
    expect(namesEmployer(null, 'Flowserve')).toBe(false);
  });
});

describe('parseJsonObject', () => {
  it('extracts a JSON object embedded in surrounding text', () => {
    const text = 'Here is the result:\n{"title": "Mechanical Engineer", "location": null}\nThanks.';
    expect(parseJsonObject(text)).toEqual({ title: 'Mechanical Engineer', location: null });
  });

  it('returns null when no braces are present', () => {
    expect(parseJsonObject('no json here')).toBeNull();
  });

  it('returns null for a JSON array instead of an object', () => {
    expect(parseJsonObject('[1, 2, 3]')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseJsonObject('{title: missing quotes}')).toBeNull();
  });
});

describe('updateEmployerList validation', () => {
  it('rejects fewer than two distinct company names without making network calls', async () => {
    await expect(updateEmployerList(['Flowserve'])).rejects.toThrow(/at least two/i);
  });

  it('rejects when the same company name is repeated', async () => {
    await expect(updateEmployerList(['Flowserve', ' Flowserve '])).rejects.toThrow(/at least two/i);
  });
});

describe('findOpenRoles validation', () => {
  it('rejects an empty role', async () => {
    const employers = [
      { name: 'Flowserve', boardUrl: 'https://www.flowserve.com/en/careers' },
      { name: 'Emerson', boardUrl: 'https://www.emerson.com/en-us/careers' },
    ];
    await expect(findOpenRoles('   ', employers)).rejects.toThrow(/name a job title/i);
  });

  it('rejects fewer than two saved employers', async () => {
    const employers = [{ name: 'Flowserve', boardUrl: 'https://www.flowserve.com/en/careers' }];
    await expect(findOpenRoles('mechanical engineer', employers)).rejects.toThrow(/at least two companies/i);
  });
});
