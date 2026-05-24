import { NextResponse } from 'next/server';
import { isRateLimited, getClientIp } from '@/lib/ssrf-guard';
import { isSanctioned } from '@/lib/ofac-crypto';

// Crypto wallet intelligence — BTC via blockstream.info, ETH via Blockscout
// (free, no key for either). Cross-checks the OFAC SDN sanctioned crypto
// address lists and flags hits with the source so the UI can warn the user.

const BTC_RE = /^([13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[ac-hj-np-z02-9]{11,87})$/;
const ETH_RE = /^0x[a-fA-F0-9]{40}$/;

type Chain = 'BTC' | 'ETH';

function detectChain(addr: string): Chain | null {
  if (ETH_RE.test(addr)) return 'ETH';
  if (BTC_RE.test(addr)) return 'BTC';
  return null;
}

async function lookupBTC(address: string) {
  const res = await fetch(`https://blockstream.info/api/address/${address}`, {
    signal: AbortSignal.timeout(8000),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`blockstream HTTP ${res.status}`);
  const d = await res.json();

  const chainStats = d.chain_stats || {};
  const memStats = d.mempool_stats || {};
  const funded = (chainStats.funded_txo_sum || 0) + (memStats.funded_txo_sum || 0);
  const spent = (chainStats.spent_txo_sum || 0) + (memStats.spent_txo_sum || 0);
  const txCount = (chainStats.tx_count || 0) + (memStats.tx_count || 0);
  const balanceSats = funded - spent;

  // Blockstream `/txs` returns at most the latest 25 confirmed txs per call.
  // For high-volume addresses this means `first_seen` reflects the start of
  // the most recent activity window rather than the absolute first tx —
  // good enough for a quick lookup, full history is a future enhancement.
  let firstSeen: string | undefined;
  let lastSeen: string | undefined;
  try {
    const txRes = await fetch(`https://blockstream.info/api/address/${address}/txs`, {
      signal: AbortSignal.timeout(8000),
    });
    if (txRes.ok) {
      const txs = (await txRes.json()) as Array<{ status?: { block_time?: number } }>;
      const times = txs.map((t) => t.status?.block_time).filter((t): t is number => !!t);
      if (times.length) {
        lastSeen = new Date(Math.max(...times) * 1000).toISOString();
        firstSeen = new Date(Math.min(...times) * 1000).toISOString();
      }
    }
  } catch (e) {
    console.warn('[OSIRIS] BTC tx history fetch failed:', e instanceof Error ? e.message : e);
  }

  return {
    chain: 'BTC' as const,
    balance: (balanceSats / 1e8).toFixed(8),
    balance_unit: 'BTC',
    balance_satoshis: balanceSats,
    tx_count: txCount,
    total_received: (funded / 1e8).toFixed(8),
    total_sent: (spent / 1e8).toFixed(8),
    first_seen: firstSeen,
    last_seen: lastSeen,
    explorer: `https://blockstream.info/address/${address}`,
  };
}

// ETH lookup via Blockscout — open source, keyless explorer
// (https://github.com/blockscout/blockscout). Uses the Etherscan-compatible
// v1 API for balance + tx history and the v2 counters endpoint for tx_count.
const BLOCKSCOUT_BASE = 'https://eth.blockscout.com';

async function lookupETH(address: string) {
  const [balRes, firstTxRes, lastTxRes, countersRes] = await Promise.all([
    fetch(`${BLOCKSCOUT_BASE}/api?module=account&action=balance&address=${address}`, {
      signal: AbortSignal.timeout(8000),
    }),
    fetch(`${BLOCKSCOUT_BASE}/api?module=account&action=txlist&address=${address}&page=1&offset=1&sort=asc`, {
      signal: AbortSignal.timeout(8000),
    }),
    fetch(`${BLOCKSCOUT_BASE}/api?module=account&action=txlist&address=${address}&page=1&offset=1&sort=desc`, {
      signal: AbortSignal.timeout(8000),
    }),
    fetch(`${BLOCKSCOUT_BASE}/api/v2/addresses/${address}/counters`, {
      signal: AbortSignal.timeout(8000),
    }),
  ]);

  if (!balRes.ok) throw new Error(`blockscout balance HTTP ${balRes.status}`);
  const balData = await balRes.json();
  const weiStr: string = balData?.result || '0';
  const wei = BigInt(/^\d+$/.test(weiStr) ? weiStr : '0');
  const eth = Number(wei) / 1e18;

  let firstSeen: string | undefined;
  let lastSeen: string | undefined;
  if (firstTxRes.ok) {
    const d = await firstTxRes.json();
    const ts = d?.result?.[0]?.timeStamp;
    if (ts) firstSeen = new Date(Number(ts) * 1000).toISOString();
  }
  if (lastTxRes.ok) {
    const d = await lastTxRes.json();
    const ts = d?.result?.[0]?.timeStamp;
    if (ts) lastSeen = new Date(Number(ts) * 1000).toISOString();
  }

  let txCount = 0;
  if (countersRes.ok) {
    const d = await countersRes.json();
    if (d?.transactions_count) txCount = parseInt(d.transactions_count, 10) || 0;
  }

  return {
    chain: 'ETH' as const,
    balance: eth.toFixed(8),
    balance_unit: 'ETH',
    balance_wei: wei.toString(),
    tx_count: txCount,
    first_seen: firstSeen,
    last_seen: lastSeen,
    explorer: `${BLOCKSCOUT_BASE}/address/${address}`,
  };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const address = (searchParams.get('address') || '').trim();
  const chainParam = (searchParams.get('chain') || 'auto').toUpperCase();

  if (!address) {
    return NextResponse.json({ error: 'Missing address parameter' }, { status: 400 });
  }

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp, 20, 60_000)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  let chain: Chain | null;
  if (chainParam === 'AUTO') {
    chain = detectChain(address);
  } else if (chainParam === 'BTC' || chainParam === 'ETH') {
    chain = chainParam;
    const valid = chain === 'BTC' ? BTC_RE.test(address) : ETH_RE.test(address);
    if (!valid) {
      return NextResponse.json({ error: `Invalid ${chain} address format` }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: 'Unsupported chain (use BTC, ETH, or auto)' }, { status: 400 });
  }

  if (!chain) {
    return NextResponse.json({ error: 'Unrecognized address format' }, { status: 400 });
  }

  try {
    const [data, sanctions] = await Promise.all([
      chain === 'BTC' ? lookupBTC(address) : lookupETH(address),
      isSanctioned(address, chain),
    ]);

    return NextResponse.json({
      address,
      ...data,
      sanctioned: sanctions.sanctioned,
      sanctions: sanctions.sanctioned ? { source: sanctions.source, list: chain } : null,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json(
      { error: 'Crypto lookup failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
