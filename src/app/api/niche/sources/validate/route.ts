import { NextResponse } from 'next/server';
import { pollApiSource } from '@/niche/sources/api-source';
import { pollPolymarketSource } from '@/niche/sources/polymarket-source';
import { pollLLMSource } from '@/niche/sources/llm-source';
import type { ApiSourceConfig, PolymarketSourceConfig, LLMSourceConfig } from '@/niche/types';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { type, config } = await req.json();

    if (!type || !config) {
      return NextResponse.json({ error: 'type and config are required' }, { status: 400 });
    }

    const start = Date.now();
    let result: any;

    switch (type) {
      case 'api':
        result = await pollApiSource('test', 'test', config as ApiSourceConfig);
        break;
      case 'polymarket':
        result = await pollPolymarketSource('test', 'test', config as PolymarketSourceConfig);
        break;
      case 'llm':
        result = await pollLLMSource('test', 'test', config as LLMSourceConfig);
        break;
      default:
        return NextResponse.json({ error: `Unknown source type: ${type}` }, { status: 400 });
    }

    return NextResponse.json({
      valid: true,
      latencyMs: Date.now() - start,
      sample: {
        value: result.value,
        numericValue: result.numericValue,
        direction: result.direction,
      },
    });
  } catch (e: any) {
    return NextResponse.json({
      valid: false,
      error: e.message,
    }, { status: 200 }); // 200 — validation result, not server error
  }
}
