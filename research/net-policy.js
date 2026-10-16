// MI08 / Agency OS — network policy of the engine page fetch (INTEGRATION 007, SSRF hardening).
// Pure functions, no I/O. Two gates applied to EVERY hop (first URL and each redirect):
//   engineUrlError(url)   the URL itself: http(s) only, no credentials, default port only, no local/internal host names;
//   checkAddress(ip)      every address the host resolves to (or the IP literal): public unicast only, IPv4 and IPv6.
// Policy is an ALLOWLIST for IPv6 (global unicast 2000::/3 minus special-purpose blocks) and a DENYLIST of every IANA
// special-purpose IPv4 block. IPv4-mapped / NAT64 IPv6 forms are unwrapped and judged by the embedded IPv4 address.
import net from 'node:net';

export class SsrfError extends Error {
  constructor(code, detail = '') { super(`SSRF_BLOCKED:${code}${detail ? ` ${detail}` : ''}`); this.code = code; this.ssrf = true; }
}

const MAX_URL_CHARS = 2048;
const BLOCKED_HOST = /(^localhost$|\.localhost$|\.local$|\.internal$|\.intranet$|\.lan$|\.home\.arpa$|\.arpa$|\.onion$|^metadata\.google\.internal$)/i;

// ---------------- IPv4 ----------------
const V4_BLOCKED = [
  ['0.0.0.0', 8, 'THIS_NETWORK'], ['10.0.0.0', 8, 'PRIVATE'], ['100.64.0.0', 10, 'SHARED_CGNAT'], ['127.0.0.0', 8, 'LOOPBACK'],
  ['169.254.0.0', 16, 'LINK_LOCAL'], ['172.16.0.0', 12, 'PRIVATE'], ['192.0.0.0', 24, 'IETF_PROTOCOL'], ['192.0.2.0', 24, 'DOCUMENTATION'],
  ['192.31.196.0', 24, 'AS112'], ['192.52.193.0', 24, 'AMT'], ['192.88.99.0', 24, 'RELAY_6TO4'], ['192.168.0.0', 16, 'PRIVATE'],
  ['192.175.48.0', 24, 'AS112'], ['198.18.0.0', 15, 'BENCHMARKING'], ['198.51.100.0', 24, 'DOCUMENTATION'], ['203.0.113.0', 24, 'DOCUMENTATION'],
  ['224.0.0.0', 4, 'MULTICAST'], ['240.0.0.0', 4, 'RESERVED'],
];

/** Strict dotted-quad parser (resolver answers and URL hosts are already canonical). Null when not an IPv4 address. */
export function v4ToInt(s) {
  if (typeof s !== 'string') return null;
  const p = s.split('.'); if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) { if (!/^\d{1,3}$/.test(x) || Number(x) > 255) return null; n = n * 256 + Number(x); }
  return n;
}
const intToV4 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const V4_NETS = V4_BLOCKED.map(([base, bits, label]) => ({ base: v4ToInt(base), bits, label }));
function v4Reason(n) {
  for (const { base, bits, label } of V4_NETS) { const div = 2 ** (32 - bits); if (Math.floor(n / div) === Math.floor(base / div)) return `IPV4_${label}`; }
  return null;
}

// ---------------- IPv6 ----------------
/** 128-bit BigInt of an IPv6 address; null when invalid or carrying a zone id (fe80::1%eth0 is never acceptable). */
export function v6ToBig(s) {
  if (typeof s !== 'string' || s.includes('%') || !net.isIPv6(s)) return null;
  const halves = s.split('::');
  const conv = (part) => (part ? part.split(':') : []).flatMap((x) => {
    if (x.includes('.')) { const n = v4ToInt(x); return n === null ? [NaN] : [n >>> 16, n & 0xffff]; }
    return [parseInt(x, 16)];
  });
  const head = conv(halves[0]); const tail = halves.length > 1 ? conv(halves[1]) : [];
  const groups = halves.length > 1 ? [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail] : head;
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n);
}
const V6 = (s) => v6ToBig(s);
const inNet6 = (big, base, bits) => (big >> BigInt(128 - bits)) === (V6(base) >> BigInt(128 - bits));
const V6_GLOBAL = ['2000::', 3];
const V6_BLOCKED_IN_GLOBAL = [
  ['2001::', 23, 'IETF_PROTOCOL_TEREDO'], ['2001:db8::', 32, 'DOCUMENTATION'], ['2002::', 16, 'RELAY_6TO4'],
  ['3ffe::', 16, 'OLD_6BONE'], ['3fff::', 20, 'DOCUMENTATION'], ['2620:4f:8000::', 48, 'AS112'],
];
const V6_LABELS = [['::', 128, 'UNSPECIFIED'], ['::1', 128, 'LOOPBACK'], ['::', 96, 'IPV4_COMPATIBLE'], ['64:ff9b:1::', 48, 'NAT64_LOCAL'],
  ['100::', 64, 'DISCARD'], ['fc00::', 7, 'UNIQUE_LOCAL'], ['fe80::', 10, 'LINK_LOCAL'], ['fec0::', 10, 'SITE_LOCAL'], ['ff00::', 8, 'MULTICAST']];

/**
 * Judges one address. Returns { ok:true, address, family } with the address to DIAL (IPv4-mapped forms are dialled as
 * plain IPv4), or { ok:false, reason, input }.
 */
export function checkAddress(input) {
  const raw = typeof input === 'string' ? input.trim() : input;
  const v4 = v4ToInt(raw);
  if (v4 !== null) { const why = v4Reason(v4); return why ? { ok: false, reason: why, input } : { ok: true, address: intToV4(v4), family: 4 }; }
  const big = v6ToBig(raw);
  if (big === null) return { ok: false, reason: typeof raw === 'string' && raw.includes('%') ? 'IPV6_ZONE_ID' : 'ADDRESS_INVALID', input };
  const low32 = Number(big & 0xffffffffn);
  if (inNet6(big, '::ffff:0:0', 96)) { // IPv4-mapped: judged and dialled as IPv4
    const why = v4Reason(low32); return why ? { ok: false, reason: `MAPPED_${why}`, input } : { ok: true, address: intToV4(low32), family: 4 };
  }
  if (inNet6(big, '64:ff9b::', 96)) { // NAT64 well-known prefix: the translator would reach the embedded IPv4 address
    const why = v4Reason(low32); return why ? { ok: false, reason: `NAT64_${why}`, input } : { ok: true, address: raw.toLowerCase(), family: 6 };
  }
  for (const [base, bits, label] of V6_LABELS) if (inNet6(big, base, bits)) return { ok: false, reason: `IPV6_${label}`, input };
  if (!inNet6(big, ...V6_GLOBAL)) return { ok: false, reason: 'IPV6_NOT_GLOBAL_UNICAST', input };
  for (const [base, bits, label] of V6_BLOCKED_IN_GLOBAL) if (inNet6(big, base, bits)) return { ok: false, reason: `IPV6_${label}`, input };
  return { ok: true, address: raw.toLowerCase(), family: 6 };
}

/** Host as the URL parser canonicalised it, without IPv6 brackets or a trailing dot, lower-case. */
export const bareHost = (hostname) => String(hostname ?? '').replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '').toLowerCase();

/**
 * URL gate of the engine (applied to every hop). Null when acceptable. IP literals pass this gate and are judged by
 * checkAddress (the WHATWG parser has already turned 2130706433 / 0x7f.1 / 127.1 into 127.0.0.1).
 */
export function engineUrlError(url) {
  if (typeof url !== 'string' || !url.trim()) return 'URL_REQUIRED';
  const raw = url.trim();
  if (raw.length > MAX_URL_CHARS) return 'URL_TOO_LONG';
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return 'URL_HAS_WHITESPACE';
  if (!/^https?:\/\//i.test(raw)) return 'URL_SCHEME_NOT_HTTP';
  let u; try { u = new URL(raw); } catch { return 'URL_UNPARSEABLE'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'URL_SCHEME_NOT_HTTP';
  if (u.username || u.password) return 'URL_HAS_CREDENTIALS';
  if (u.port) return 'URL_NON_STANDARD_PORT'; // the parser drops :80 on http and :443 on https; anything left is non-standard
  const host = bareHost(u.hostname);
  if (!host) return 'URL_NO_HOST';
  if (net.isIP(host)) return null;
  if (!host.includes('.') || BLOCKED_HOST.test(host)) return 'URL_PRIVATE_HOST';
  return null;
}
