// INTEGRATION 007 — SSRF hardening of the engine page fetch. Fully offline: DNS is an injected fake resolver and every
// socket the engine asks for is opened through a recording dial that only ever reaches an in-process server on loopback.
// The dial records the address the ENGINE chose (always a validated public address), proving what it would connect to.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import fs from 'node:fs';
import { createEngineFetch, defaultDial, MAX_REDIRECTS } from '../research/fetch.js';
import { checkAddress, engineUrlError, v6ToBig } from '../research/net-policy.js';
import { domainGuardedFetch } from '../research/case-adapter.js';
import { wireCaseResearchWorker } from '../research/case-wiring.js';
import { testCertificate } from './support/test-cert.js';

const T = (name, fn) => test(name, { timeout: 20000 }, fn);
// Self-signed test certificate for pagina.test, generated locally at run time (no key material in the repository).
const { key: KEY, cert: CA } = testCertificate('pagina.test');
const PUBLIC = '93.184.216.34';
const PUBLIC6 = '2606:4700:4700::1111';

// ---------------- in-process servers (loopback only) ----------------
const routes = {
  '/ok': (q, s) => { s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); s.end('<html><title>Pagina</title><p>Hola desde la página</p></html>'); },
  '/404': (q, s) => { s.writeHead(404); s.end('no'); },
  '/redir-relative': (q, s) => { s.writeHead(302, { location: '/ok' }); s.end(); },
  '/loop': (q, s) => { s.writeHead(302, { location: '/loop' }); s.end(); },
  '/gzip': (q, s) => { s.writeHead(200, { 'content-encoding': 'gzip' }); s.end(zlib.gzipSync('comprimido correcto')); },
  '/weird-encoding': (q, s) => { s.writeHead(200, { 'content-encoding': 'compress' }); s.end('x'); },
  '/big': (q, s) => { s.writeHead(200); s.end(Buffer.alloc(3_000_000, 97)); },
  '/bomb': (q, s) => { s.writeHead(200, { 'content-encoding': 'gzip' }); s.end(zlib.gzipSync(Buffer.alloc(50_000_000, 0))); },
  '/slow': () => { /* never answers */ },
};
const redirectTo = (target) => (q, s) => { s.writeHead(302, { location: target }); s.end(); };
for (const [k, v] of Object.entries({
  '/r-private-ip': 'http://10.0.0.1/x', '/r-metadata-ip': 'http://169.254.169.254/latest/meta-data/', '/r-loopback': 'http://127.0.0.1/',
  '/r-decimal': 'http://2130706433/', '/r-hex': 'http://0x7f.1/', '/r-v6-loopback': 'http://[::1]/', '/r-v6-mapped': 'http://[::ffff:127.0.0.1]/',
  '/r-v6-ula': 'http://[fd00:ec2::254]/', '/r-v6-linklocal': 'http://[fe80::1]/', '/r-meta-name': 'http://meta.attacker.test/',
  '/r-localhost': 'http://localhost/', '/r-internal': 'http://metadata.google.internal/', '/r-ftp': 'ftp://pagina.test/x', '/r-file': 'file:///etc/passwd',
  '/r-port': 'http://pagina.test:8080/', '/r-creds': 'http://user:pw@pagina.test/', '/r-offdomain': 'http://otro.test/ok', '/r-https': 'https://pagina.test/ok',
})) routes[k] = redirectTo(v);
const handler = (q, s) => (routes[q.url] ?? routes['/404'])(q, s);
let HTTP_PORT; let HTTPS_PORT; let srv; let srvTls; const seen = [];
before(async () => {
  srv = http.createServer((q, s) => { seen.push({ tls: false, host: q.headers.host, url: q.url }); handler(q, s); });
  srvTls = https.createServer({ key: KEY, cert: CA }, (q, s) => { seen.push({ tls: true, host: q.headers.host, url: q.url }); handler(q, s); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); await new Promise((r) => srvTls.listen(0, '127.0.0.1', r));
  HTTP_PORT = srv.address().port; HTTPS_PORT = srvTls.address().port;
});
after(() => { srv.closeAllConnections(); srvTls.closeAllConnections(); srv.close(); srvTls.close(); });

/** Engine with a fake DNS table and a recording dial that reaches the loopback server whatever (validated) IP was chosen. */
function harness({ dnsTable = {}, resolver, timeoutMs = 3000, maxBytes, failFirstDial = false } = {}) {
  const dials = []; const lookups = [];
  const res = resolver ?? (async (h) => { lookups.push(h); if (!(h in dnsTable)) { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; } return dnsTable[h]; });
  const wrapped = resolver ? async (h) => { lookups.push(h); return resolver(h); } : res;
  const dial = (o) => {
    dials.push({ address: o.address, family: o.family, port: o.port, secure: o.secure, servername: o.servername });
    if (failFirstDial && dials.length === 1) { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; }
    return defaultDial({ ...o, address: '127.0.0.1', family: 4, port: o.secure ? HTTPS_PORT : HTTP_PORT });
  };
  const fetch = createEngineFetch({ resolver: wrapped, dial, ca: CA, timeoutMs, ...(maxBytes ? { maxBytes } : {}) });
  return { fetch, dials, lookups };
}
const SAFE_DNS = { 'pagina.test': [{ address: PUBLIC, family: 4 }], 'otro.test': [{ address: '93.184.216.35', family: 4 }], 'meta.attacker.test': [{ address: '169.254.169.254', family: 4 }] };
const blocked = (code) => (e) => { assert.match(e.message, new RegExp(`^SSRF_BLOCKED:${code}`)); return true; };

// ---------------- address policy ----------------
T('policy: every private, local, reserved and internal IPv4 range is refused; public IPv4 is accepted', () => {
  for (const a of ['0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.100.100.200', '127.0.0.1', '127.255.255.254', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.0.0.192', '192.0.2.1', '192.31.196.1', '192.52.193.1', '192.88.99.1', '192.168.1.1', '192.175.48.1',
    '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255']) {
    assert.equal(checkAddress(a).ok, false, a);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', PUBLIC, '9.255.255.255', '11.0.0.1', '100.63.255.255', '100.128.0.1', '126.255.255.255', '128.0.0.1',
    '169.253.255.255', '172.15.255.255', '172.32.0.1', '192.167.255.255', '192.169.0.1', '198.17.255.255', '198.20.0.1', '223.255.255.255']) {
    assert.deepEqual(checkAddress(a), { ok: true, address: a, family: 4 }, a);
  }
});

T('policy IPv6: loopback, unspecified, mapped/compatible private IPv4, ULA, link/site-local, multicast, NAT64, 6to4, Teredo and documentation are refused', () => {
  for (const a of ['::', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '::ffff:192.168.0.1',
    '::127.0.0.1', '::a00:1', 'fe80::1', 'fe80::1%eth0', 'febf::1', 'fec0::1', 'fc00::1', 'fd00:ec2::254', 'fdff:ffff::1', 'ff02::1', 'ff05::1:3',
    '64:ff9b::a9fe:a9fe', '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '64:ff9b:1::1', '100::1', '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2001:db8::1', '2002:7f00:1::1', '2002:c0a8:101::1', '3ffe::1', '3fff::1', '2620:4f:8000::1', '1::1', '4000::1', 'e000::1']) {
    assert.equal(checkAddress(a).ok, false, a);
  }
  assert.equal(checkAddress('fe80::1%eth0').reason, 'IPV6_ZONE_ID');
  // The diagnostic reason names the range (defence in depth: these are also outside the 2000::/3 allowlist).
  for (const [a, why] of [['::1', 'IPV6_LOOPBACK'], ['::', 'IPV6_UNSPECIFIED'], ['::a00:1', 'IPV6_IPV4_COMPATIBLE'], ['fd00:ec2::254', 'IPV6_UNIQUE_LOCAL'],
    ['fe80::1', 'IPV6_LINK_LOCAL'], ['fec0::1', 'IPV6_SITE_LOCAL'], ['ff02::1', 'IPV6_MULTICAST'], ['100::1', 'IPV6_DISCARD'], ['64:ff9b:1::1', 'IPV6_NAT64_LOCAL'],
    ['4000::1', 'IPV6_NOT_GLOBAL_UNICAST'], ['::ffff:127.0.0.1', 'MAPPED_IPV4_LOOPBACK'], ['64:ff9b::a9fe:a9fe', 'NAT64_IPV4_LINK_LOCAL'], ['169.254.169.254', 'IPV4_LINK_LOCAL']])
    assert.equal(checkAddress(a).reason, why, a);
  assert.deepEqual(checkAddress(PUBLIC6), { ok: true, address: PUBLIC6, family: 6 });
  for (const a of ['2001:4860:4860::8888', '2a00:1450:4001:80b::200e', '2001:200::1', '2c0f:fb50:4002::1']) assert.equal(checkAddress(a).ok, true, a);
  assert.deepEqual(checkAddress('::ffff:8.8.8.8'), { ok: true, address: '8.8.8.8', family: 4 }, 'mapped public is dialled as plain IPv4');
  assert.equal(checkAddress('64:ff9b::808:808').ok, true, 'NAT64 of a public IPv4');
});

T('policy: anything that is not a well-formed address is refused', () => {
  for (const a of [null, undefined, '', 'abc', '1.2.3', '1.2.3.4.5', '999.1.1.1', '01.2.3.4x', '::ffff:999.1.1.1', '1:2:3:4:5:6:7:8:9', 'gggg::1', ' ', 42]) {
    assert.equal(checkAddress(a).ok, false, String(a));
  }
  assert.equal(v6ToBig('::1'), 1n);
  assert.equal(v6ToBig('::ffff:1.2.3.4'), (0xffffn << 32n) | 0x01020304n);
});

T('policy URL: non-http schemes, credentials, non-standard ports and local/internal host names are refused', () => {
  const cases = { 'ftp://pagina.test/': 'URL_SCHEME_NOT_HTTP', 'file:///etc/passwd': 'URL_SCHEME_NOT_HTTP', 'gopher://pagina.test/': 'URL_SCHEME_NOT_HTTP',
    'javascript:alert(1)': 'URL_SCHEME_NOT_HTTP', 'http://user:pw@pagina.test/': 'URL_HAS_CREDENTIALS', 'http://pagina.test:8080/': 'URL_NON_STANDARD_PORT',
    'https://pagina.test:80/': 'URL_NON_STANDARD_PORT', 'http://pagina.test:443/': 'URL_NON_STANDARD_PORT', 'http://localhost/': 'URL_PRIVATE_HOST',
    'http://localhost./': 'URL_PRIVATE_HOST', 'http://a.localhost/': 'URL_PRIVATE_HOST', 'http://metadata.google.internal/': 'URL_PRIVATE_HOST',
    'http://db.internal/': 'URL_PRIVATE_HOST', 'http://printer.local/': 'URL_PRIVATE_HOST', 'http://router.home.arpa/': 'URL_PRIVATE_HOST',
    'http://1.0.0.127.in-addr.arpa/': 'URL_PRIVATE_HOST', 'http://intranet/': 'URL_PRIVATE_HOST', 'http://pagina.test/a b': 'URL_HAS_WHITESPACE',
    'http://pagina.test/\u0000': 'URL_HAS_WHITESPACE', '': 'URL_REQUIRED', [`http://pagina.test/${'a'.repeat(2100)}`]: 'URL_TOO_LONG' };
  for (const [u, why] of Object.entries(cases)) assert.equal(engineUrlError(u), why, u);
  for (const u of ['http://pagina.test/', 'https://pagina.test/a?b=1', 'http://pagina.test:80/', 'https://pagina.test:443/', 'http://127.0.0.1/', 'http://[::1]/'])
    assert.equal(engineUrlError(u), null, `${u} passes the URL gate (IP literals are judged by the address gate)`);
});

// ---------------- engine: happy paths and pinning ----------------
T('engine: resolves once, validates, and connects to the validated IP (Host header and path preserved)', async () => {
  const h = harness({ dnsTable: SAFE_DNS }); seen.length = 0;
  const r = await h.fetch('http://pagina.test/ok');
  assert.equal(r.ok, true); assert.equal(r.status, 200); assert.equal(r.finalUrl, 'http://pagina.test/ok'); assert.match(r.text, /Hola desde la página/);
  assert.deepEqual(h.lookups, ['pagina.test']);
  assert.deepEqual(h.dials, [{ address: PUBLIC, family: 4, port: 80, secure: false, servername: 'pagina.test' }]);
  assert.deepEqual(seen, [{ tls: false, host: 'pagina.test', url: '/ok' }]);
  const r404 = await h.fetch('http://pagina.test/404'); assert.equal(r404.ok, false); assert.equal(r404.status, 404);
});

T('engine: HTTPS connects to the pinned IP but still verifies the certificate against the host name (SNI)', async () => {
  const h = harness({ dnsTable: SAFE_DNS });
  const r = await h.fetch('https://pagina.test/ok');
  assert.equal(r.ok, true); assert.match(r.text, /Hola/);
  assert.deepEqual(h.dials, [{ address: PUBLIC, family: 4, port: 443, secure: true, servername: 'pagina.test' }]);
  // otro.test resolves to a public IP, but the server there presents a certificate for pagina.test: refused by TLS.
  await assert.rejects(h.fetch('https://otro.test/ok'), (e) => /altnames|ERR_TLS_CERT_ALTNAME_INVALID|Hostname\/IP does not match/i.test(`${e.code} ${e.message}`));
  // A certificate the engine does not trust is refused (no CA injected -> system store only).
  const strict = createEngineFetch({ resolver: async () => [{ address: PUBLIC, family: 4 }], dial: (o) => defaultDial({ ...o, address: '127.0.0.1', port: HTTPS_PORT }), timeoutMs: 3000 });
  await assert.rejects(strict('https://pagina.test/ok'), (e) => /self[- ]signed|SELF_SIGNED|unable to verify/i.test(`${e.code} ${e.message}`));
});

T('engine IPv6: public IPv6 answers are dialled as IPv6; IPv4-mapped public answers are dialled as plain IPv4', async () => {
  const h6 = harness({ dnsTable: { 'pagina.test': [{ address: PUBLIC6, family: 6 }] } });
  assert.equal((await h6.fetch('http://pagina.test/ok')).ok, true);
  assert.deepEqual(h6.dials.map((d) => [d.address, d.family]), [[PUBLIC6, 6]]);
  const hm = harness({ dnsTable: { 'pagina.test': [{ address: `::ffff:${PUBLIC}`, family: 6 }] } });
  assert.equal((await hm.fetch('http://pagina.test/ok')).ok, true);
  assert.deepEqual(hm.dials.map((d) => [d.address, d.family]), [[PUBLIC, 4]]);
  const both = harness({ dnsTable: { 'pagina.test': [{ address: PUBLIC6, family: 6 }, { address: PUBLIC, family: 4 }] } });
  await both.fetch('http://pagina.test/ok'); assert.equal(both.dials[0].address, PUBLIC, 'IPv4 tried first');
});

T('engine: a refused connection falls back to the next VALIDATED address only', async () => {
  const h = harness({ dnsTable: { 'pagina.test': [{ address: PUBLIC, family: 4 }, { address: '93.184.216.35', family: 4 }] }, failFirstDial: true });
  const r = await h.fetch('http://pagina.test/ok');
  assert.equal(r.ok, true); assert.deepEqual(h.dials.map((d) => d.address), [PUBLIC, '93.184.216.35']); assert.equal(r.address, '93.184.216.35');
  // Only connection-level failures move on to the next address: a TLS identity failure ends the hop at once.
  const t = harness({ dnsTable: { 'otro.test': [{ address: PUBLIC, family: 4 }, { address: '93.184.216.35', family: 4 }] } });
  await assert.rejects(t.fetch('https://otro.test/ok'), (e) => /ERR_TLS_CERT_ALTNAME_INVALID/.test(e.code));
  assert.equal(t.dials.length, 1);
});

// ---------------- engine: malicious DNS ----------------
T('DNS: a host resolving to any private/local/reserved address is refused before any connection (IPv4 and IPv6)', async () => {
  for (const bad of ['127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.0.10', '169.254.169.254', '100.100.100.200', '0.0.0.0', '255.255.255.255',
    '::1', '::', 'fd00:ec2::254', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2002:a00:1::1', 'ff02::1']) {
    const h = harness({ dnsTable: { 'evil.test': [{ address: bad, family: bad.includes(':') ? 6 : 4 }] } });
    await assert.rejects(h.fetch('http://evil.test/ok'), blocked('DNS_ADDRESS_BLOCKED'), bad);
    assert.equal(h.dials.length, 0, `no connection for ${bad}`);
  }
});

T('DNS: one blocked answer among public ones refuses the host (no mixing); empty, failing or malformed answers are refused', async () => {
  const mixed = harness({ dnsTable: { 'evil.test': [{ address: PUBLIC, family: 4 }, { address: '127.0.0.1', family: 4 }] } });
  await assert.rejects(mixed.fetch('http://evil.test/ok'), blocked('DNS_ADDRESS_BLOCKED')); assert.equal(mixed.dials.length, 0);
  const mixed6 = harness({ dnsTable: { 'evil.test': [{ address: PUBLIC, family: 4 }, { address: '::1', family: 6 }] } });
  await assert.rejects(mixed6.fetch('http://evil.test/ok'), blocked('DNS_ADDRESS_BLOCKED')); assert.equal(mixed6.dials.length, 0);
  const empty = harness({ dnsTable: { 'evil.test': [] } });
  await assert.rejects(empty.fetch('http://evil.test/ok'), blocked('DNS_NO_ADDRESS')); assert.equal(empty.dials.length, 0);
  const nx = harness({ dnsTable: {} });
  await assert.rejects(nx.fetch('http://nadie.test/ok'), blocked('DNS_FAILED')); assert.equal(nx.dials.length, 0);
  const junk = harness({ dnsTable: { 'evil.test': [{ address: 'localhost' }, { address: PUBLIC }] } });
  await assert.rejects(junk.fetch('http://evil.test/ok'), blocked('DNS_ADDRESS_BLOCKED')); assert.equal(junk.dials.length, 0);
  const zone = harness({ dnsTable: { 'evil.test': [{ address: 'fe80::1%eth0', family: 6 }] } });
  await assert.rejects(zone.fetch('http://evil.test/ok'), blocked('DNS_ADDRESS_BLOCKED')); assert.equal(zone.dials.length, 0);
});

T('DNS rebinding: the engine resolves once per hop and connects only to the address it validated', async () => {
  // Attacker DNS: first answer public, every later answer loopback (the classic TOCTOU rebinding pattern).
  let n = 0; const rebinding = async () => (n++ === 0 ? [{ address: PUBLIC, family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
  const h = harness({ resolver: rebinding });
  const r = await h.fetch('http://pagina.test/ok');
  assert.equal(r.ok, true); assert.equal(h.lookups.length, 1, 'exactly one resolution for one hop');
  assert.deepEqual(h.dials.map((d) => d.address), [PUBLIC], 'connected to the validated address, not to a second answer');
  // The next request re-resolves and now meets the rebound answer: refused, nothing dialled.
  await assert.rejects(h.fetch('http://pagina.test/ok'), blocked('DNS_ADDRESS_BLOCKED')); assert.equal(h.dials.length, 1);
  // Same-host redirect: the second hop is resolved and validated again; the rebound answer is refused.
  n = 0; const h2 = harness({ resolver: rebinding });
  await assert.rejects(h2.fetch('http://pagina.test/redir-relative'), blocked('DNS_ADDRESS_BLOCKED'));
  assert.equal(h2.lookups.length, 2); assert.deepEqual(h2.dials.map((d) => d.address), [PUBLIC]);
});

T('IP literals: private/local IPv4 and IPv6 literals (decimal, hex, short, bracketed, mapped) are refused without DNS or connection', async () => {
  const h = harness({ dnsTable: SAFE_DNS });
  for (const u of ['http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0/', 'http://[::1]/', 'http://[::]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/',
    'http://[fd00:ec2::254]/', 'http://[fe80::1]/', 'https://[64:ff9b::a9fe:a9fe]/']) {
    await assert.rejects(h.fetch(u), blocked('ADDRESS_BLOCKED'), u);
  }
  assert.equal(h.lookups.length, 0); assert.equal(h.dials.length, 0);
  const ok = await h.fetch(`http://${PUBLIC}/ok`); assert.equal(ok.ok, true);
  assert.deepEqual(h.dials.map((d) => [d.address, d.servername]), [[PUBLIC, undefined]], 'public literal: no DNS, no SNI');
  const ok6 = await h.fetch(`http://[${PUBLIC6}]/ok`); assert.equal(ok6.ok, true); assert.equal(h.lookups.length, 0);
});

T('URL gate in the engine: local names, schemes, ports and credentials are refused without DNS or connection', async () => {
  const h = harness({ dnsTable: SAFE_DNS });
  for (const [u, code] of [['http://localhost/', 'URL_PRIVATE_HOST'], ['http://metadata.google.internal/', 'URL_PRIVATE_HOST'], ['http://intranet/', 'URL_PRIVATE_HOST'],
    ['ftp://pagina.test/', 'URL_SCHEME_NOT_HTTP'], ['file:///etc/passwd', 'URL_SCHEME_NOT_HTTP'], ['http://pagina.test:8080/', 'URL_NON_STANDARD_PORT'],
    ['http://u:p@pagina.test/', 'URL_HAS_CREDENTIALS']]) await assert.rejects(h.fetch(u), blocked(code), u);
  assert.equal(h.lookups.length, 0); assert.equal(h.dials.length, 0);
});

// ---------------- engine: redirects ----------------
T('redirects: every redirect target is revalidated BEFORE connecting; blocked targets are never contacted', async () => {
  const expect = { '/r-private-ip': 'ADDRESS_BLOCKED', '/r-metadata-ip': 'ADDRESS_BLOCKED', '/r-loopback': 'ADDRESS_BLOCKED', '/r-decimal': 'ADDRESS_BLOCKED',
    '/r-hex': 'ADDRESS_BLOCKED', '/r-v6-loopback': 'ADDRESS_BLOCKED', '/r-v6-mapped': 'ADDRESS_BLOCKED', '/r-v6-ula': 'ADDRESS_BLOCKED',
    '/r-v6-linklocal': 'ADDRESS_BLOCKED', '/r-meta-name': 'DNS_ADDRESS_BLOCKED', '/r-localhost': 'URL_PRIVATE_HOST', '/r-internal': 'URL_PRIVATE_HOST',
    '/r-ftp': 'URL_SCHEME_NOT_HTTP', '/r-file': 'URL_SCHEME_NOT_HTTP', '/r-port': 'URL_NON_STANDARD_PORT', '/r-creds': 'URL_HAS_CREDENTIALS' };
  for (const [path, code] of Object.entries(expect)) {
    const h = harness({ dnsTable: SAFE_DNS });
    await assert.rejects(h.fetch(`http://pagina.test${path}`), blocked(code), path);
    assert.equal(h.dials.length, 1, `${path}: only the first hop was dialled`);
  }
});

T('redirects: relative and cross-scheme redirects are followed through validated hops; loops stop at the limit', async () => {
  const h = harness({ dnsTable: SAFE_DNS });
  const r = await h.fetch('http://pagina.test/redir-relative');
  assert.equal(r.finalUrl, 'http://pagina.test/ok'); assert.equal(r.redirects, 1); assert.equal(h.dials.length, 2); assert.deepEqual(h.lookups, ['pagina.test', 'pagina.test']);
  const hs = harness({ dnsTable: SAFE_DNS });
  const rs = await hs.fetch('http://pagina.test/r-https');
  assert.equal(rs.ok, true); assert.deepEqual(hs.dials.map((d) => [d.port, d.secure]), [[80, false], [443, true]]);
  const hl = harness({ dnsTable: SAFE_DNS });
  await assert.rejects(hl.fetch('http://pagina.test/loop'), blocked('TOO_MANY_REDIRECTS'));
  assert.equal(hl.dials.length, MAX_REDIRECTS + 1);
});

T('redirects + domain scope: the caller gate runs on every hop, so an off-domain target is never contacted', async () => {
  const h = harness({ dnsTable: SAFE_DNS });
  const allowUrl = (u) => (new URL(u).hostname === 'pagina.test' ? null : 'DOMAIN_NOT_ALLOWED');
  await assert.rejects(h.fetch('http://pagina.test/r-offdomain', { allowUrl }), blocked('URL_NOT_ALLOWED'));
  assert.equal(h.dials.length, 1); assert.deepEqual(h.lookups, ['pagina.test']);
  // Through the real case-research guard (prospect domain only): recorded as REDIRECT_OUT_OF_SCOPE, otro.test never dialled.
  const g = harness({ dnsTable: SAFE_DNS }); const rejections = [];
  const guarded = domainGuardedFetch(g.fetch, ['pagina.test'], rejections);
  await assert.rejects(guarded('http://pagina.test/r-offdomain'), /DOMAIN_NOT_ALLOWED after redirect \(otro\.test\)/);
  assert.equal(g.dials.length, 1); assert.deepEqual(g.lookups, ['pagina.test']);
  assert.deepEqual(rejections, [{ url: 'http://pagina.test/r-offdomain', final_url: 'http://otro.test/ok', domain: 'otro.test', reason: 'REDIRECT_OUT_OF_SCOPE' }]);
  // The case guard still refuses IP-literal redirects inside scope rules (URL_IP_LITERAL) before the engine connects.
  const g2 = harness({ dnsTable: SAFE_DNS }); const rej2 = [];
  await assert.rejects(domainGuardedFetch(g2.fetch, ['pagina.test'], rej2)('http://pagina.test/r-metadata-ip'), /DOMAIN_NOT_ALLOWED after redirect/);
  assert.equal(g2.dials.length, 1); assert.equal(rej2[0].reason, 'URL_IP_LITERAL');
  // In-scope redirects still work through the guard.
  const g3 = harness({ dnsTable: SAFE_DNS });
  const ok = await domainGuardedFetch(g3.fetch, ['pagina.test'], [])('http://pagina.test/redir-relative');
  assert.equal(ok.finalUrl, 'http://pagina.test/ok');
});

// ---------------- engine: limits ----------------
T('limits: body capped at maxBytes (plain and decompressed), unknown encodings refused, overall timeout enforced', async () => {
  const h = harness({ dnsTable: SAFE_DNS, maxBytes: 1_000_000 });
  const big = await h.fetch('http://pagina.test/big'); assert.equal(big.text.length, 1_000_000); assert.equal(big.truncated, true);
  const bomb = await h.fetch('http://pagina.test/bomb'); assert.equal(bomb.text.length, 1_000_000); assert.equal(bomb.truncated, true);
  const gz = await h.fetch('http://pagina.test/gzip'); assert.equal(gz.text, 'comprimido correcto'); assert.equal(gz.truncated, false);
  await assert.rejects(h.fetch('http://pagina.test/weird-encoding'), blocked('UNSUPPORTED_CONTENT_ENCODING'));
  const slow = harness({ dnsTable: SAFE_DNS, timeoutMs: 300 }); const t0 = Date.now();
  await assert.rejects(slow.fetch('http://pagina.test/slow'), /^Error: FETCH_TIMEOUT/); assert.ok(Date.now() - t0 < 2000);
  const slowDns = harness({ resolver: () => new Promise(() => {}), timeoutMs: 200 });
  await assert.rejects(slowDns.fetch('http://pagina.test/ok'), /^Error: FETCH_TIMEOUT/); assert.equal(slowDns.dials.length, 0);
});

// ---------------- production wiring ----------------
T('wiring: the server, the VS003 worker and the CLI all build the hardened engine (internal targets refused with no DNS and no connection)', async () => {
  for (const f of ['research/case-wiring.js', 'research/worker.js', 'research/cli.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, /import \{ createEngineFetch \} from '\.\/fetch\.js';/, f);
  }
  const engine = createEngineFetch(); // defaults: system resolver + real dial, exactly as in production
  for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://localhost/', 'http://2130706433/', 'http://[::ffff:10.0.0.1]/'])
    await assert.rejects(engine(u), /^Error: SSRF_BLOCKED:/, u);
});
