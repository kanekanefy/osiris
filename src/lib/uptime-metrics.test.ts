import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGeoKind, parseUptimeMetrics, summarizeUptimeServices } from './uptime-metrics.ts';

const SAMPLE = `
# HELP monitor_response_time Monitor Response Time (ms)
# TYPE monitor_response_time gauge
monitor_response_time{monitor_name="Dokploy Panel",monitor_type="http",monitor_url="https://dokploy.onenorthdev.com",monitor_hostname="null",monitor_port="null"} 138
monitor_response_time{monitor_name="origin-ping",monitor_type="ping",monitor_url="null",monitor_hostname="74.48.114.232",monitor_port="null"} 0.8
# HELP monitor_status Monitor Status (1 = UP, 0 = DOWN)
# TYPE monitor_status gauge
monitor_status{monitor_name="Dokploy Panel",monitor_type="http",monitor_url="https://dokploy.onenorthdev.com",monitor_hostname="null",monitor_port="null"} 1
monitor_status{monitor_name="origin-ping",monitor_type="ping",monitor_url="null",monitor_hostname="74.48.114.232",monitor_port="null"} 0
# HELP monitor_cert_days_remaining The number of days remaining until the certificate expires
# TYPE monitor_cert_days_remaining gauge
monitor_cert_days_remaining{monitor_name="Dokploy Panel",monitor_type="http",monitor_url="https://dokploy.onenorthdev.com",monitor_hostname="null",monitor_port="null"} 82
# HELP monitor_cert_is_valid Is the certificate still valid? (1 = Yes, 0= No)
# TYPE monitor_cert_is_valid gauge
monitor_cert_is_valid{monitor_name="Dokploy Panel",monitor_type="http",monitor_url="https://dokploy.onenorthdev.com",monitor_hostname="null",monitor_port="null"} 1
`;

test('parseUptimeMetrics groups Prometheus monitor samples by service target', () => {
  const services = parseUptimeMetrics(SAMPLE);

  assert.equal(services.length, 2);
  assert.equal(services[0].name, 'origin-ping');
  assert.equal(services[0].status_label, 'DOWN');
  assert.equal(services[0].risk, 'CRITICAL');
  assert.equal(services[0].target, '74.48.114.232');

  const dokploy = services.find(service => service.name === 'Dokploy Panel');
  assert.ok(dokploy);
  assert.equal(dokploy.target, 'dokploy.onenorthdev.com');
  assert.equal(dokploy.response_ms, 138);
  assert.equal(dokploy.cert_days_remaining, 82);
  assert.equal(dokploy.cert_valid, true);
});

test('summarizeUptimeServices returns compact operational totals', () => {
  const summary = summarizeUptimeServices(parseUptimeMetrics(SAMPLE));

  assert.deepEqual(summary, {
    total: 2,
    up: 1,
    down: 1,
    degraded: 0,
    critical: 1,
    avg_response_ms: 69,
  });
});

test('classifyGeoKind distinguishes CDN edge locations from direct host locations', () => {
  assert.equal(
    classifyGeoKind({ type: 'http', target: 'dokploy.onenorthdev.com' }, { isp: 'Cloudflare, Inc.', hosting: true }),
    'edge',
  );
  assert.equal(
    classifyGeoKind({ type: 'ping', target: '74.48.114.232' }, { isp: 'Multacom Corporation', hosting: true }),
    'host',
  );
});
