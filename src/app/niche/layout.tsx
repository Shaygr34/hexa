import type { Metadata } from 'next';
import '../globals.css';

export const metadata: Metadata = {
  title: 'ZVI — Niche Strategy Platform',
  description: 'AI-powered niche prediction market trading',
};

export default function NicheLayout({ children }: { children: React.ReactNode }) {
  return children;
}
