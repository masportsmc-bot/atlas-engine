// Test-only TLS material for the SSRF tests, generated locally at run time and never committed: a throwaway
// self-signed certificate for one test host name, created with openssl in a private temporary directory that is
// deleted immediately (the key only lives in this process's memory). Requires the `openssl` command.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cache = new Map();
/** @returns {{ key: Buffer, cert: Buffer }} */
export function testCertificate(name = 'pagina.test') {
  if (cache.has(name)) return cache.get(name);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-test-cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${name}`,
      '-addext', `subjectAltName=DNS:${name}`, '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'pipe' });
    const pair = { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
    cache.set(name, pair);
    return pair;
  } catch (e) {
    throw new Error(`The SSRF tests generate a local test certificate with openssl, which failed: ${String(e?.message || e).slice(0, 200)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
