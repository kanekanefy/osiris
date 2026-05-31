import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { NextResponse } from 'next/server';
import { classifyGeoKind, parseUptimeMetrics, summarizeUptimeServices, type UptimeService } from '@/lib/uptime-metrics';

export const runtime = 'nodejs';

type GeoResult = {
  status?: string;
  country?: string;
  countryCode?: string;
  regionName?: string;
  city?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
  isp?: string;
  org?: string;
  as?: string;
  hosting?: boolean;
  query?: string;
};

type UptimeResponse = {
  services: Array<UptimeService & {
    ip: string | null;
    lat: number | null;
    lng: number | null;
    city: string | null;
    region: string | null;
    country: string | null;
    isp: string | null;
    asn: string | null;
    geo_kind: 'edge' | 'host' | 'unknown';
  }>;
  summary: ReturnType<typeof summarizeUptimeServices>;
  source: string;
  generated_at: string;
};

let cache: { expires: number; payload: UptimeResponse } | null = null;

function getConfig() {
  return {
    baseUrl: (process.env.UPTIME_KUMA_URL || 'https://uptime.onenorthdev.com').replace(/\/+$/, ''),
    apiKey: process.env.UPTIME_KUMA_API_KEY || process.env.OSIRIS_UPTIME_API_KEY || '',
  };
}

async function resolveTarget(target: string | null): Promise<string | null> {
  if (!target) return null;
  if (net.isIP(target)) return target;
  try {
    const url = new URL('https://cloudflare-dns.com/dns-query');
    url.searchParams.set('name', target);
    url.searchParams.set('type', 'A');
    const res = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(5000),
      next: { revalidate: 300 },
    });
    if (res.ok) {
      const data = await res.json();
      const answer = data.Answer?.find((item: { type?: number; data?: string }) => item.type === 1 && item.data && net.isIP(item.data));
      if (answer?.data) return answer.data;
    }
  } catch {
    // Fall back to the host resolver below. This keeps local proxy DNS quirks from being the first choice.
  }
  try {
    const result = await lookup(target, { family: 4 });
    return result.address;
  } catch {
    return null;
  }
}

async function lookupGeo(ip: string | null): Promise<GeoResult | null> {
  if (!ip) return null;
  try {
    const fields = 'status,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as,hosting,query';
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=${fields}`, {
      signal: AbortSignal.timeout(5000),
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    const geo = await res.json();
    return geo.status === 'success' ? geo : null;
  } catch {
    return null;
  }
}

async function getMetrics(baseUrl: string, apiKey: string) {
  const auth = Buffer.from(`:${apiKey}`).toString('base64');
  const res = await fetch(`${baseUrl}/metrics`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(10000),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Uptime metrics returned ${res.status}`);
  return res.text();
}

export async function GET() {
  const now = Date.now();
  if (cache && cache.expires > now) {
    return NextResponse.json(cache.payload, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=180' },
    });
  }

  const { baseUrl, apiKey } = getConfig();
  if (!apiKey) {
    return NextResponse.json({
      services: [],
      summary: summarizeUptimeServices([]),
      source: baseUrl,
      generated_at: new Date().toISOString(),
      error: 'UPTIME_KUMA_API_KEY is not configured',
    }, { status: 503 });
  }

  try {
    const services = parseUptimeMetrics(await getMetrics(baseUrl, apiKey)).slice(0, 80);
    const geoCache = new Map<string, GeoResult | null>();

    const enriched = await Promise.all(services.map(async (service) => {
      const ip = await resolveTarget(service.target);
      let geo = ip ? geoCache.get(ip) : null;
      if (ip && !geoCache.has(ip)) {
        geo = await lookupGeo(ip);
        geoCache.set(ip, geo);
      }

      return {
        ...service,
        ip,
        lat: typeof geo?.lat === 'number' ? geo.lat : null,
        lng: typeof geo?.lon === 'number' ? geo.lon : null,
        city: geo?.city || null,
        region: geo?.regionName || null,
        country: geo?.country || null,
        isp: geo?.isp || geo?.org || null,
        asn: geo?.as || null,
        geo_kind: classifyGeoKind(service, geo),
      };
    }));

    const payload = {
      services: enriched.filter(service => typeof service.lat === 'number' && typeof service.lng === 'number'),
      summary: summarizeUptimeServices(services),
      source: baseUrl,
      generated_at: new Date().toISOString(),
    };
    cache = { expires: now + 60_000, payload };

    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=180' },
    });
  } catch (error) {
    return NextResponse.json({
      services: [],
      summary: summarizeUptimeServices([]),
      source: baseUrl,
      generated_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Failed to load uptime data',
    }, { status: 502 });
  }
}
