// Engine-side page fetch (read-only GET; no cookies, forms or logins; timeout and size cap).
// INTEGRATION 007 — SSRF hardening. For EVERY hop (the first URL and each redirect, followed manually, at most
// maxRedirects):
//   1. URL gate (net-policy.engineUrlError) and the caller's optional per-hop gate (allowUrl: domain allowlist);
//   2. the host is resolved ONCE and EVERY answer is judged by net-policy.checkAddress; one blocked answer refuses the host;
//   3. the connection is opened to one of those validated IP addresses (never to the host name), so no second DNS lookup
//      happens and DNS rebinding cannot swap the address; TLS still verifies the certificate against the host name (SNI);
//   4. no connection pooling (no socket reuse across hosts); body read with a hard cap on decoded bytes.
// Return shape is unchanged: { ok, status, finalUrl, text } (plus address/redirects for diagnostics).
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import zlib from 'node:zlib';
import { SsrfError, checkAddress, engineUrlError, bareHost } from './net-policy.js';

export { SsrfError } from './net-policy.js';
/** Not a policy refusal: the overall deadline (all hops, DNS included) ran out. */
export class FetchTimeoutError extends Error { constructor(d = '') { super(`FETCH_TIMEOUT ${d}`.trim()); this.code = 'FETCH_TIMEOUT'; this.engine = true; } }
export const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_CONNECT = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ECONNRESET']);
const MAX_ADDRESSES_TRIED = 3;

/** System resolver (getaddrinfo), every address. Its answers are validated before use; it is never asked twice per hop. */
export const systemResolver = async (host) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));

/** Opens the socket to an already-validated IP address. `servername` keeps SNI + certificate checks bound to the host name. */
export function defaultDial({ address, family, port, secure, servername, ca }) {
  return secure
    ? tls.connect({ host: address, port, family, servername, ca, ALPNProtocols: ['http/1.1'], rejectUnauthorized: true })
    : net.connect({ host: address, port, family });
}

const withAbort = (p, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const on = () => reject(signal.reason); signal.addEventListener('abort', on, { once: true });
  p.then((v) => { signal.removeEventListener('abort', on); resolve(v); }, (e) => { signal.removeEventListener('abort', on); reject(e); });
});

/** Resolves and validates one hop's host. Returns the validated, de-duplicated targets (IPv4 first). */
async function validatedTargets(u, resolver, signal) {
  const host = bareHost(u.hostname);
  if (net.isIP(host)) {
    const c = checkAddress(host);
    if (!c.ok) throw new SsrfError('ADDRESS_BLOCKED', `${host} (${c.reason})`);
    return [c];
  }
  let answers;
  try { answers = await withAbort(Promise.resolve().then(() => resolver(host)), signal); }
  catch (e) { if (signal.aborted) throw new FetchTimeoutError('during DNS resolution'); throw new SsrfError('DNS_FAILED', `${host}: ${String(e?.code || e?.message || e).slice(0, 80)}`); }
  if (!Array.isArray(answers) || answers.length === 0) throw new SsrfError('DNS_NO_ADDRESS', host);
  const checked = answers.map((a) => checkAddress(typeof a === 'string' ? a : a?.address));
  const bad = checked.find((c) => !c.ok);
  if (bad) throw new SsrfError('DNS_ADDRESS_BLOCKED', `${host} -> ${bad.input} (${bad.reason})`);
  const seen = new Set();
  return checked.filter((c) => !seen.has(c.address) && seen.add(c.address)).sort((a, b) => a.family - b.family);
}

function decoderFor(encoding) {
  const e = String(encoding || 'identity').trim().toLowerCase();
  if (e === 'identity' || e === '') return null;
  if (e === 'gzip' || e === 'x-gzip') return zlib.createGunzip();
  if (e === 'deflate') return zlib.createInflate();
  if (e === 'br') return zlib.createBrotliDecompress();
  throw new SsrfError('UNSUPPORTED_CONTENT_ENCODING', e.slice(0, 40));
}

/** One GET to one validated address. Resolves { status, location } for a redirect, else { status, text }. */
function requestOnce({ u, target, dial, ca, userAgent, signal, maxBytes }) {
  return new Promise((resolve, reject) => {
    const secure = u.protocol === 'https:';
    const host = bareHost(u.hostname);
    const port = secure ? 443 : 80;
    let settled = false; const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const req = http.request({
      method: 'GET', path: `${u.pathname}${u.search}`, signal, maxHeaderSize: 32 * 1024,
      headers: { host: u.host, 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'accept-encoding': 'gzip, deflate, br', connection: 'close' },
      createConnection: () => dial({ address: target.address, family: target.family, port, secure, servername: net.isIP(host) ? undefined : host, ca, host }),
    });
    req.on('error', (e) => done(reject, e));
    req.on('response', (res) => {
      const status = res.statusCode;
      if (REDIRECT_STATUSES.has(status) && res.headers.location) { res.resume(); req.destroy(); return done(resolve, { status, location: String(res.headers.location) }); }
      let decoder; try { decoder = decoderFor(res.headers['content-encoding']); } catch (e) { req.destroy(); return done(reject, e); }
      const body = decoder ? res.pipe(decoder) : res;
      const chunks = []; let size = 0; let truncated = false;
      const finish = () => done(resolve, { status, text: new TextDecoder('utf-8').decode(Buffer.concat(chunks)), truncated });
      body.on('data', (c) => {
        if (truncated) return;
        const room = maxBytes - size;
        if (c.length >= room) { chunks.push(c.subarray(0, room)); size = maxBytes; truncated = true; finish(); req.destroy(); body.destroy?.(); return; }
        chunks.push(c); size += c.length;
      });
      body.on('end', finish);
      body.on('error', (e) => done(reject, e));
      res.on('error', (e) => done(reject, e));
    });
    req.end();
  });
}

async function fetchHop(u, targets, opts) {
  let last;
  for (const target of targets.slice(0, MAX_ADDRESSES_TRIED)) {
    try { return { ...(await requestOnce({ u, target, ...opts })), address: target.address }; }
    catch (e) {
      if (opts.signal.aborted) throw new FetchTimeoutError(u.host);
      if (e?.ssrf || e?.engine || !RETRYABLE_CONNECT.has(e?.code)) throw e;
      last = e;
    }
  }
  throw last;
}

/**
 * @param {object} [o]
 * @param {(host:string)=>Promise<Array<{address:string,family:number}|string>>} [o.resolver] injectable resolver (tests)
 * @param {Function} [o.dial] injectable socket opener (tests); receives only validated addresses
 * @returns {(url:string, opts?:{allowUrl?:(url:string, hop:number)=>string|null})=>Promise<{ok,status,finalUrl,text}>}
 */
export function createEngineFetch({ timeoutMs = 15000, maxBytes = 2_000_000, userAgent = 'ATLAS-research-verifier/0.3 (read-only)',
  maxRedirects = MAX_REDIRECTS, resolver = systemResolver, dial = defaultDial, ca } = {}) {
  return async (url, { allowUrl } = {}) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(new FetchTimeoutError(`${timeoutMs}ms`)), timeoutMs);
    try {
      let current = typeof url === 'string' ? url.trim() : url;
      for (let hop = 0; ; hop++) {
        const why = engineUrlError(current);
        if (why) throw new SsrfError(why, hop ? `redirect #${hop}` : '');
        const scope = allowUrl ? allowUrl(current, hop) : null;
        if (scope) throw new SsrfError('URL_NOT_ALLOWED', String(scope));
        const u = new URL(current);
        const targets = await validatedTargets(u, resolver, ctl.signal);
        const r = await fetchHop(u, targets, { dial, ca, userAgent, signal: ctl.signal, maxBytes });
        if (r.location !== undefined) {
          if (hop >= maxRedirects) throw new SsrfError('TOO_MANY_REDIRECTS', `${maxRedirects}`);
          try { current = new URL(r.location, current).toString(); } catch { throw new SsrfError('REDIRECT_UNPARSEABLE'); }
          continue;
        }
        return { ok: r.status >= 200 && r.status < 300, status: r.status, finalUrl: current, text: r.text, truncated: r.truncated, address: r.address, redirects: hop };
      }
    } catch (e) {
      if (ctl.signal.aborted && !e?.ssrf && !e?.engine) throw new FetchTimeoutError(`${timeoutMs}ms`);
      throw e;
    } finally { clearTimeout(t); }
  };
}
