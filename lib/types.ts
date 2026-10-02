export type Employer = {
  name: string;
  boardUrl: string | null;
  /** Hiring platform (e.g. Workday, Oracle) linked from the employer's official careers page. */
  hiringPlatformUrl?: string | null;
};

export type Role = {
  company: string;
  title: string;
  location: string;
  pay: string | null;
  url: string;
};

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  roles?: Role[];
};

export type ChatResponse = {
  answer: string;
  employers: Employer[];
  roles: Role[];
  toolsUsed: string[];
};
