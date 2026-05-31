'use client';

import { memo, useMemo } from 'react';
import { motion } from 'framer-motion';
import { ExternalLink, MapPin, Server, ShieldCheck, Signal, WifiOff } from 'lucide-react';

type Service = {
  id?: string;
  name?: string;
  type?: string;
  url?: string | null;
  target?: string | null;
  ip?: string | null;
  status_label?: 'UP' | 'DOWN' | 'PENDING' | 'MAINTENANCE' | 'UNKNOWN';
  response_ms?: number | null;
  cert_days_remaining?: number | null;
  risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  geo_kind?: 'edge' | 'host' | 'unknown';
  city?: string | null;
  region?: string | null;
  country?: string | null;
  lat?: number | null;
  lng?: number | null;
};

type Summary = {
  total?: number;
  up?: number;
  down?: number;
  degraded?: number;
  critical?: number;
  avg_response_ms?: number;
};

function riskColor(risk?: Service['risk']) {
  if (risk === 'CRITICAL') return '#FF1744';
  if (risk === 'HIGH') return '#FF9500';
  if (risk === 'MEDIUM') return '#D4AF37';
  return '#00E5FF';
}

function locationKey(service: Service) {
  const label = [service.city, service.region, service.country].filter(Boolean).join(', ');
  return label || service.ip || service.target || 'Unknown location';
}

function shortTarget(service: Service) {
  return service.target || service.ip || service.url?.replace(/^https?:\/\//, '') || 'unknown target';
}

function ServiceMonitorPanel({ data, onLocate }: { data: any; onLocate: (lat: number, lng: number, zoom?: number) => void }) {
  const services: Service[] = Array.isArray(data?.uptime_services) ? data.uptime_services : [];
  const summary: Summary = data?.uptime_summary || {};

  const grouped = useMemo(() => {
    const groups = new Map<string, Service[]>();
    services.forEach(service => {
      const key = locationKey(service);
      const current = groups.get(key) || [];
      current.push(service);
      groups.set(key, current);
    });
    return Array.from(groups.entries()).map(([label, items]) => ({
      label,
      items: items.sort((a, b) => (a.risk || 'LOW').localeCompare(b.risk || 'LOW') || (a.name || '').localeCompare(b.name || '')),
      lat: items.find(i => typeof i.lat === 'number')?.lat,
      lng: items.find(i => typeof i.lng === 'number')?.lng,
      edge: items.filter(i => i.geo_kind === 'edge').length,
      host: items.filter(i => i.geo_kind === 'host').length,
    })).sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
  }, [services]);

  return (
    <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.35 }} className="glass-panel p-3 pointer-events-auto">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Server className="w-3.5 h-3.5 text-[var(--cyan-primary)]" />
            <div className="absolute -right-1 -top-1 w-2 h-2 rounded-full bg-[var(--alert-green)] shadow-[0_0_10px_var(--alert-green)]" />
          </div>
          <div>
            <div className="hud-text text-[12px] text-[var(--text-primary)] tracking-widest">公司服务监测</div>
            <div className="text-[7px] font-mono tracking-[0.18em] text-[var(--text-muted)]">UPTIME KUMA SERVICE LAYER</div>
          </div>
        </div>
        <span className="gotham-tag gotham-tag--info" style={{ fontSize: '8px', padding: '2px 7px' }}>
          {summary.total ?? services.length} SVC
        </span>
      </div>

      <div className="grid grid-cols-4 gap-1.5 mb-3">
        <div className="rounded border border-[var(--alert-green)]/20 bg-[var(--alert-green)]/[0.04] px-2 py-1.5">
          <div className="hud-label">UP</div>
          <div className="hud-value text-[11px] text-[var(--alert-green)]">{summary.up ?? 0}</div>
        </div>
        <div className="rounded border border-[var(--alert-red)]/20 bg-[var(--alert-red)]/[0.04] px-2 py-1.5">
          <div className="hud-label">DOWN</div>
          <div className="hud-value text-[11px] text-[var(--alert-red)]">{summary.down ?? 0}</div>
        </div>
        <div className="rounded border border-[#D4AF37]/20 bg-[#D4AF37]/[0.04] px-2 py-1.5">
          <div className="hud-label">RISK</div>
          <div className="hud-value text-[11px] text-[#D4AF37]">{(summary.degraded ?? 0) + (summary.critical ?? 0)}</div>
        </div>
        <div className="rounded border border-[var(--cyan-primary)]/20 bg-[var(--cyan-primary)]/[0.04] px-2 py-1.5">
          <div className="hud-label">AVG</div>
          <div className="hud-value text-[11px] text-[var(--cyan-primary)]">{Math.round(summary.avg_response_ms ?? 0)}ms</div>
        </div>
      </div>

      <div className="space-y-2 max-h-[440px] overflow-y-auto styled-scrollbar pr-1">
        {grouped.map(group => (
          <div key={group.label} className="rounded-md border border-[var(--border-primary)] bg-black/20 overflow-hidden">
            <button
              className="w-full flex items-center justify-between gap-2 px-2.5 py-2 hover:bg-white/[0.03] transition-colors"
              onClick={() => typeof group.lat === 'number' && typeof group.lng === 'number' && onLocate(group.lat, group.lng, 7)}
            >
              <div className="min-w-0 flex items-center gap-2">
                <MapPin className="w-3 h-3 text-[var(--gold-primary)] flex-shrink-0" />
                <span className="text-[10px] font-mono font-bold text-[var(--text-secondary)] truncate">{group.label}</span>
              </div>
              <div className="flex items-center gap-1.5 text-[8px] font-mono text-[var(--text-muted)] flex-shrink-0">
                <span>{group.items.length}</span>
                <span className="text-[var(--cyan-primary)]">EDGE {group.edge}</span>
                <span className="text-white/70">HOST {group.host}</span>
              </div>
            </button>
            <div className="divide-y divide-white/[0.04]">
              {group.items.map(service => {
                const color = riskColor(service.risk);
                const isDown = service.status_label === 'DOWN' || service.risk === 'CRITICAL';
                return (
                  <div key={service.id || `${group.label}-${service.name}`} className="px-2.5 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          {isDown ? <WifiOff className="w-3 h-3 text-[var(--alert-red)] flex-shrink-0" /> : <Signal className="w-3 h-3 text-[var(--alert-green)] flex-shrink-0" />}
                          <span className="text-[10px] font-mono text-[var(--text-primary)] truncate">{service.name || 'Unnamed service'}</span>
                        </div>
                        <div className="mt-1 text-[8px] font-mono text-[var(--text-muted)] truncate">{shortTarget(service)}</div>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <span className="text-[8px] font-mono font-bold tabular-nums" style={{ color }}>{Math.round(service.response_ms ?? 0)}ms</span>
                        {service.url && (
                          <a href={service.url} target="_blank" className="p-1 rounded hover:bg-white/[0.06]" title="Open service">
                            <ExternalLink className="w-3 h-3 text-[var(--text-muted)]" />
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2 text-[7px] font-mono tracking-[0.12em]">
                      <span style={{ color }}>{service.risk || 'LOW'}</span>
                      <span className="text-[var(--text-muted)]">{service.status_label || 'UNKNOWN'}</span>
                      <span className={service.geo_kind === 'host' ? 'text-white/70' : 'text-[var(--cyan-primary)]'}>{service.geo_kind === 'host' ? 'HOST GEO' : service.geo_kind === 'edge' ? 'EDGE GEO' : 'GEO'}</span>
                      {typeof service.cert_days_remaining === 'number' && (
                        <span className="inline-flex items-center gap-1 text-[var(--text-muted)]">
                          <ShieldCheck className="w-2.5 h-2.5" />
                          {Math.round(service.cert_days_remaining)}D
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {services.length === 0 && (
          <div className="rounded-md border border-[var(--border-primary)] bg-black/20 px-3 py-6 text-center text-[9px] font-mono tracking-[0.16em] text-[var(--text-muted)]">
            WAITING FOR SERVICE TELEMETRY
          </div>
        )}
      </div>
    </motion.div>
  );
}

export default memo(ServiceMonitorPanel);
