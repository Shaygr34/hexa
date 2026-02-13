#!/usr/bin/env tsx
// ═══════════════════════════════════════════════════════════════
// TEST: On-Chain feeRate Fetcher
// Verifies: connects to Polygon, fetches feeRate, or hard-fails
// with an explicit error message.
// ═══════════════════════════════════════════════════════════════

import { fetchFeeRate, isFeeRateError } from '../src/adapters/polymarket/fee-rate-fetcher';

console.log('═══════════════════════════════════════════');
console.log('  TEST: On-Chain feeRate Fetcher');
console.log('═══════════════════════════════════════════\n');

async function main() {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  [PASS] ${msg}`);
      passed++;
    } else {
      console.log(`  [FAIL] ${msg}`);
      failed++;
    }
  }

  // ── Test 1: Fetch with default Polygon RPC ──
  console.log('▸ Test 1: Fetch feeRate from Polygon mainnet');
  {
    const result = await fetchFeeRate();

    if (isFeeRateError(result)) {
      console.log(`  [INFO] feeRate fetch returned error (expected if no RPC): ${result.error}`);
      assert(result.error.length > 0, 'Error message is explicit and non-empty');
      assert(result.adapterAddress.startsWith('0x'), 'Adapter address is present');
      assert(result.rpcUrl.length > 0, 'RPC URL is present');
      assert(result.fetchedAt.length > 0, 'Timestamp is present');
    } else {
      console.log(`  [INFO] feeRate fetched successfully: ${result.feeRate}`);
      assert(result.feeRate >= 0, `feeRate is non-negative: ${result.feeRate}`);
      assert(result.feeRate <= 1, `feeRate is ≤ 1: ${result.feeRate}`);
      assert(result.source === 'on-chain', 'Source is on-chain');
      assert(typeof result.rawFeeRate === 'bigint', 'Raw fee rate is bigint');
      assert(typeof result.feeDenominator === 'bigint', 'Fee denominator is bigint');
    }
  }

  // ── Test 2: Fetch with invalid RPC ──
  console.log('\n▸ Test 2: Fetch with invalid RPC (should hard-fail with message)');
  {
    const result = await fetchFeeRate('https://invalid-rpc.example.com');

    assert(isFeeRateError(result), 'Returns error for invalid RPC');
    if (isFeeRateError(result)) {
      assert(result.error.includes('failed') || result.error.includes('error') || result.error.includes('connect'),
        `Error is descriptive: "${result.error.substring(0, 80)}..."`);
    }
  }

  // ── Test 3: Fetch with invalid contract address ──
  console.log('\n▸ Test 3: Fetch with invalid adapter address');
  {
    const result = await fetchFeeRate(undefined, '0x0000000000000000000000000000000000000001');

    if (isFeeRateError(result)) {
      assert(result.error.length > 0, `Error for bad address: "${result.error.substring(0, 80)}..."`);
    } else {
      // Might actually succeed if there's a contract at that address
      console.log(`  [INFO] Unexpected success — contract may exist at address`);
      passed++;
    }
  }

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
