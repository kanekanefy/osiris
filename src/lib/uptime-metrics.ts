export type UptimeMetricValue = {
  monitor_name?: string;
  monitor_type?: string;
  monitor_url?: string;
  monitor_hostname?: string;
  monitor_port?: string;
  value: number;
};

export type UptimeService = {
  id: string;
  name: string;
  type: string;
  url: string | null;
  hostname: string | null;
  port: string | null;
  target: string | null;
  status: number | null;
  status_label: 'UP' | 'DOWN' | 'PENDING' | 'MAINTENANCE' | 'UNKNOWN';
  response_ms: number | null;
  cert_days_remaining: number | null;
  cert_valid: boolean | null;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
};

const METRIC_PREFIX = 'monitor_';

function parseLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {};
  const re = /(\w+)="((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    labels[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return labels;
}

function normalizeNullable(value?: string): string | null {
  if (!value || value === 'null') return null;
  return value;
}

function getTarget(url: string | null, hostname: string | null): string | null {
  if (url) {
    try {
      return new URL(url).hostname || null;
    } catch {
      return null;
    }
  }
  return hostname;
}

function statusLabel(status: number | null): UptimeService['status_label'] {
  if (status === 1) return 'UP';
  if (status === 0) return 'DOWN';
  if (status === 2) return 'PENDING';
  if (status === 3) return 'MAINTENANCE';
  return 'UNKNOWN';
}

function riskFor(service: Pick<UptimeService, 'status' | 'response_ms' | 'cert_days_remaining' | 'cert_valid'>): UptimeService['risk'] {
  if (service.status === 0 || service.cert_valid === false) return 'CRITICAL';
  if (service.status === 2 || service.status === 3) return 'HIGH';
  if (service.cert_days_remaining !== null && service.cert_days_remaining <= 14) return 'HIGH';
  if (service.response_ms !== null && service.response_ms >= 1000) return 'MEDIUM';
  return 'LOW';
}

function keyFor(labels: Record<string, string>): string {
  return [
    labels.monitor_name || '',
    labels.monitor_type || '',
    labels.monitor_url || '',
    labels.monitor_hostname || '',
    labels.monitor_port || '',
  ].join('\u001f');
}

export function parseUptimeMetrics(text: string): UptimeService[] {
  const rows = new Map<string, Record<string, string | number | null>>();
  const re = /^(monitor_[a-z_]+)\{([^}]*)\}\s+([-+0-9.eE]+)$/;

  for (const line of text.split(/\r?\n/)) {
    const match = re.exec(line.trim());
    if (!match) continue;
    const [, metricName, rawLabels, rawValue] = match;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;

    const labels = parseLabels(rawLabels);
    const key = keyFor(labels);
    const row = rows.get(key) || {
      name: labels.monitor_name || 'Unknown service',
      type: labels.monitor_type || 'unknown',
      url: normalizeNullable(labels.monitor_url),
      hostname: normalizeNullable(labels.monitor_hostname),
      port: normalizeNullable(labels.monitor_port),
    };
    row[metricName.slice(METRIC_PREFIX.length)] = value;
    rows.set(key, row);
  }

  return Array.from(rows.values()).map((row, index) => {
    const url = row.url as string | null;
    const hostname = row.hostname as string | null;
    const status = typeof row.status === 'number' ? row.status : null;
    const response_ms = typeof row.response_time === 'number' ? row.response_time : null;
    const cert_days_remaining = typeof row.cert_days_remaining === 'number' ? row.cert_days_remaining : null;
    const cert_valid = typeof row.cert_is_valid === 'number' ? row.cert_is_valid === 1 : null;
    const service = {
      id: `uptime-${index}-${String(row.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      name: String(row.name),
      type: String(row.type || 'unknown'),
      url,
      hostname,
      port: row.port as string | null,
      target: getTarget(url, hostname),
      status,
      status_label: statusLabel(status),
      response_ms,
      cert_days_remaining,
      cert_valid,
      risk: 'LOW' as UptimeService['risk'],
    };
    service.risk = riskFor(service);
    return service;
  }).sort((a, b) => {
    const riskOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    return riskOrder[a.risk] - riskOrder[b.risk] || a.name.localeCompare(b.name);
  });
}

export function summarizeUptimeServices(services: UptimeService[]) {
  return {
    total: services.length,
    up: services.filter(s => s.status_label === 'UP').length,
    down: services.filter(s => s.status_label === 'DOWN').length,
    degraded: services.filter(s => s.risk === 'MEDIUM' || s.risk === 'HIGH').length,
    critical: services.filter(s => s.risk === 'CRITICAL').length,
    avg_response_ms: services.length
      ? Math.round(services.reduce((sum, s) => sum + (s.response_ms || 0), 0) / services.length)
      : 0,
  };
}

export function classifyGeoKind(
  service: Pick<UptimeService, 'type' | 'target'>,
  geo: { isp?: string | null; org?: string | null; hosting?: boolean | null } | null,
): 'edge' | 'host' | 'unknown' {
  if (!service.target || !geo) return 'unknown';
  if (service.type === 'ping' || /^\d{1,3}(\.\d{1,3}){3}$/.test(service.target)) return 'host';

  const operator = `${geo.isp || ''} ${geo.org || ''}`.toLowerCase();
  if (operator.includes('cloudflare') || operator.includes('akamai') || operator.includes('fastly')) return 'edge';
  if (geo.hosting) return 'edge';
  return 'host';
}
