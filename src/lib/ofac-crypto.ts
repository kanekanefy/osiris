/**
 * OFAC sanctioned crypto address lookup.
 *
 * Source: the community-maintained mirror at
 * https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses, which
 * tracks the Treasury SDN list additions/removals as flat per-chain JSON
 * arrays. The raw lists are small (low-tens of KB) so we load them whole and
 * keep a lowercased `Set` for O(1) membership checks.
 *
 * The cache is filled lazily on the first lookup per chain and refreshed
 * every 24h. A second concurrent request that arrives while a fetch is in
 * flight waits on the same promise (single-flight) to avoid duplicate work.
 * If a refresh fails after the cache has gone stale we keep serving the
 * previous snapshot rather than blinding the route — a false negative on
 * brand-new sanctions is preferable to a sudden gap in coverage.
 */

const SOURCES: Record<string, string> = {
  BTC: 'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_BTC.json',
  ETH: 'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.json',
};

const TTL_MS = 24 * 60 * 60 * 1000;

type ChainList = { fetchedAt: number; set: Set<string> };
const cache: Record<string, ChainList> = {};
const inflight: Record<string, Promise<ChainList> | undefined> = {};

async function loadList(chain: 'BTC' | 'ETH'): Promise<ChainList> {
  const cached = cache[chain];
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
  if (inflight[chain]) return inflight[chain]!;

  inflight[chain] = (async () => {
    try {
      const res = await fetch(SOURCES[chain], { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`OFAC list ${chain} HTTP ${res.status}`);
      const arr = (await res.json()) as string[];
      const set = new Set(arr.map((a) => a.toLowerCase()));
      const entry = { fetchedAt: Date.now(), set };
      cache[chain] = entry;
      return entry;
    } catch (e) {
      // On failure, keep stale data if any to avoid leaving the route blind.
      if (cached) return cached;
      throw e;
    } finally {
      inflight[chain] = undefined;
    }
  })();

  return inflight[chain]!;
}

export async function isSanctioned(
  address: string,
  chain: 'BTC' | 'ETH'
): Promise<{ sanctioned: boolean; source?: string }> {
  try {
    const list = await loadList(chain);
    if (list.set.has(address.toLowerCase())) {
      return { sanctioned: true, source: 'OFAC SDN' };
    }
    return { sanctioned: false };
  } catch {
    return { sanctioned: false };
  }
}
