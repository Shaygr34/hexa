import { NextResponse } from 'next/server';
import { crypto15mPreset } from '@/niche/presets/crypto15m';

export const dynamic = 'force-dynamic';

const PRESETS = [crypto15mPreset];

export async function GET() {
  return NextResponse.json(PRESETS);
}
