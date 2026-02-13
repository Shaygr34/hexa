import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ZVI v1 — Polymarket Fund OS',
  description: 'NegRisk Observatory + LLM Probability Engine + Signal Watcher',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
