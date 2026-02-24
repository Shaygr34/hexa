import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  let gitHash = 'unknown';
  try {
    gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch (_) {}

  const url = new URL(req.url);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');

  return NextResponse.json({
    cwd: process.cwd(),
    gitHash,
    port,
  });
}
