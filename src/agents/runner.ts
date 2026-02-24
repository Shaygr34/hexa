// ═══════════════════════════════════════════════════════════════
// ZVI v1 — Multi-Agent Runner
// Runs all agents in a single process (or spawn separately).
// ═══════════════════════════════════════════════════════════════

import { initDb } from '@/lib/db';

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  ZVI v2 — Agent Runner');
  console.log('═══════════════════════════════════════════');
  console.log('');

  // Initialize database
  initDb();
  console.log('[Runner] Database initialized');

  // Determine which agents to run
  const agents = process.argv.slice(2);
  const runAll = agents.length === 0 || agents.includes('all');

  const tasks: Promise<void>[] = [];

  if (runAll || agents.includes('negrisk')) {
    console.log('[Runner] Starting NegRisk Observatory...');
    const { runAgent } = await import('./negrisk-agent');
    tasks.push(runAgent());
  }

  if (runAll || agents.includes('signals')) {
    console.log('[Runner] Starting Signal Watcher...');
    const { runAgent } = await import('./signal-watcher-agent');
    tasks.push(runAgent());
  }

  if (runAll || agents.includes('llm')) {
    console.log('[Runner] Starting LLM Probability Engine...');
    const { runAgent } = await import('./llm-probability-agent');
    tasks.push(runAgent());
  }

  if (tasks.length === 0) {
    console.log('[Runner] No agents specified. Use: npm run agents [all|negrisk|signals|llm]');
    process.exit(0);
  }

  console.log(`[Runner] ${tasks.length} agent(s) running. Press Ctrl+C to stop.`);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[Runner] Shutting down agents...');
    process.exit(0);
  });

  await Promise.all(tasks);
}

main().catch(e => {
  console.error('[Runner] Fatal:', e);
  process.exit(1);
});
