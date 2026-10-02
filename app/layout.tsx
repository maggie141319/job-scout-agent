import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Job Scout | Career search with a plan',
  description: 'Track employers, find current roles, and compare original job postings.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
