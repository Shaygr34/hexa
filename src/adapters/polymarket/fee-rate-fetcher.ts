// ═══════════════════════════════════════════════════════════════
// ZVI v1 — On-Chain NegRisk Fee Rate Fetcher
// THE SINGLE MOST IMPORTANT UNKNOWN per the decision map.
// Fetches feeRate from the NegRiskAdapter contract on Polygon.
// ═══════════════════════════════════════════════════════════════

import { ethers } from 'ethers';

// NegRiskAdapter ABI — only the functions we need
const NEGRISK_ADAPTER_ABI = [
  'function feeRate() view returns (uint256)',
  'function FEE_DENOMINATOR() view returns (uint256)',
  'function getFeeDenominator() view returns (uint256)',
];

// NegRiskExchange ABI — alternative location for fee info
const NEGRISK_EXCHANGE_ABI = [
  'function negRiskAdapter() view returns (address)',
];

const DEFAULT_ADAPTER = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const DEFAULT_RPC = 'https://polygon-rpc.com';

export interface FeeRateResult {
  feeRate: number;           // Decimal fee rate (e.g., 0.02 = 2%)
  rawFeeRate: bigint;        // Raw on-chain value
  feeDenominator: bigint;    // Denominator for fee calculation
  adapterAddress: string;
  fetchedAt: string;
  source: 'on-chain';
}

export interface FeeRateError {
  error: string;
  adapterAddress: string;
  rpcUrl: string;
  fetchedAt: string;
}

/**
 * Fetch the feeRate from the NegRiskAdapter contract.
 * This is the critical unknown — we hard-fail with explicit error
 * rather than silently defaulting.
 */
export async function fetchFeeRate(
  rpcUrl?: string,
  adapterAddress?: string,
): Promise<FeeRateResult | FeeRateError> {
  const rpc = rpcUrl || process.env.POLYGON_RPC_URL || DEFAULT_RPC;
  const adapter = adapterAddress || process.env.NEGRISK_ADAPTER_ADDRESS || DEFAULT_ADAPTER;

  try {
    const provider = new ethers.JsonRpcProvider(rpc);

    // Verify connection
    const network = await provider.getNetwork();
    if (network.chainId !== 137n) {
      return {
        error: `Wrong chain: expected Polygon (137), got ${network.chainId}`,
        adapterAddress: adapter,
        rpcUrl: rpc,
        fetchedAt: new Date().toISOString(),
      };
    }

    const contract = new ethers.Contract(adapter, NEGRISK_ADAPTER_ABI, provider);

    // Try feeRate()
    let rawFeeRate: bigint;
    try {
      rawFeeRate = await contract.feeRate();
    } catch (e: any) {
      return {
        error: `feeRate() call failed: ${e.message}. Contract may use different ABI.`,
        adapterAddress: adapter,
        rpcUrl: rpc,
        fetchedAt: new Date().toISOString(),
      };
    }

    // Try to get denominator — common patterns
    let feeDenominator = 10000n; // Default: basis points
    try {
      feeDenominator = await contract.FEE_DENOMINATOR();
    } catch {
      try {
        feeDenominator = await contract.getFeeDenominator();
      } catch {
        // Use default of 10000 (basis points)
      }
    }

    const feeRate = Number(rawFeeRate) / Number(feeDenominator);

    return {
      feeRate,
      rawFeeRate,
      feeDenominator,
      adapterAddress: adapter,
      fetchedAt: new Date().toISOString(),
      source: 'on-chain',
    };
  } catch (e: any) {
    return {
      error: `RPC connection failed: ${e.message}`,
      adapterAddress: adapter,
      rpcUrl: rpc,
      fetchedAt: new Date().toISOString(),
    };
  }
}

/**
 * Type guard to check if result is an error.
 */
export function isFeeRateError(result: FeeRateResult | FeeRateError): result is FeeRateError {
  return 'error' in result;
}

/**
 * Fetch feeRate with caching. Cache for 5 minutes.
 */
let _cache: { result: FeeRateResult | FeeRateError; expiry: number } | null = null;

export async function fetchFeeRateCached(
  rpcUrl?: string,
  adapterAddress?: string,
  cacheTtlMs: number = 300_000,
): Promise<FeeRateResult | FeeRateError> {
  if (_cache && Date.now() < _cache.expiry) {
    return _cache.result;
  }

  const result = await fetchFeeRate(rpcUrl, adapterAddress);
  _cache = { result, expiry: Date.now() + cacheTtlMs };
  return result;
}
