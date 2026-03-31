// src/main/proxy-tls.ts
//
// TLS primitives for Bouncer's MITM proxy: CA generation and per-host certificate minting.

import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import forge from 'node-forge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BouncerCA {
  cert: string; // PEM-encoded CA certificate
  key: string; // PEM-encoded CA private key
  certPath: string; // Path to cert file on disk (for container bind-mount)
}

interface CachedHostCert {
  cert: string;
  key: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// In-memory host-cert cache
// ---------------------------------------------------------------------------

const hostCertCache = new Map<string, CachedHostCert>();

// ---------------------------------------------------------------------------
// ensureCA()
// ---------------------------------------------------------------------------

/**
 * Return the default CA directory path (requires Electron `app` to be ready).
 * Lazily imports `electron` so this module can be loaded outside Electron for testing.
 */
export async function defaultCADir(): Promise<string> {
  const { app } = await import('electron');
  return join(app.getPath('userData'), 'bouncer-ca');
}

/**
 * Load the Bouncer CA from disk, or generate a new one if it doesn't exist.
 * @param caDir - Directory to store the CA. Defaults to `{userData}/bouncer-ca/`.
 */
export async function ensureCA(caDir?: string): Promise<BouncerCA> {
  caDir ??= await defaultCADir();
  const certPath = join(caDir, 'bouncer-ca.crt');
  const keyPath = join(caDir, 'bouncer-ca.key');

  // Load existing CA if present
  if (existsSync(certPath) && existsSync(keyPath)) {
    return {
      cert: readFileSync(certPath, 'utf-8'),
      key: readFileSync(keyPath, 'utf-8'),
      certPath,
    };
  }

  // Generate new CA (async to avoid blocking the event loop)
  const keys = await new Promise<forge.pki.rsa.KeyPair>((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (err, keypair) => {
      if (err || !keypair) {
        reject(err ?? new Error('Failed to generate RSA key pair'));
        return;
      }
      resolve(keypair);
    });
  });
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = generateSerialNumber();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: 'commonName', value: 'Bouncer Proxy CA' },
    { name: 'organizationName', value: 'Bouncer' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    {
      name: 'keyUsage',
      keyCertSign: true,
      cRLSign: true,
      critical: true,
    },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  // Persist to disk
  mkdirSync(caDir, { recursive: true });
  writeFileSync(certPath, certPem, { mode: 0o644 });
  writeFileSync(keyPath, keyPem, { mode: 0o600 });

  return { cert: certPem, key: keyPem, certPath };
}

// ---------------------------------------------------------------------------
// generateHostCert()
// ---------------------------------------------------------------------------

/**
 * Generate (or return cached) a TLS certificate for `hostname`, signed by `ca`.
 * Certificates are cached in memory with a 24-hour TTL.
 */
export function generateHostCert(hostname: string, ca: BouncerCA): { cert: string; key: string } {
  const now = Date.now();
  const cached = hostCertCache.get(hostname);
  if (cached) {
    if (cached.expiresAt > now) {
      return { cert: cached.cert, key: cached.key };
    }
    hostCertCache.delete(hostname);
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.certificateFromPem(ca.cert);
  const caKey = forge.pki.privateKeyFromPem(ca.key);

  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = generateSerialNumber();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setTime(cert.validity.notBefore.getTime() + 24 * 60 * 60 * 1000);

  cert.setSubject([{ name: 'commonName', value: hostname }]);
  cert.setIssuer(caCert.subject.attributes);

  cert.setExtensions([
    {
      name: 'subjectAltName',
      altNames: [{ type: 2 /* DNS */, value: hostname }],
    },
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  // Cache with 24h TTL
  const ttlMs = 24 * 60 * 60 * 1000;
  hostCertCache.set(hostname, {
    cert: certPem,
    key: keyPem,
    expiresAt: now + ttlMs,
  });

  return { cert: certPem, key: keyPem };
}

// ---------------------------------------------------------------------------
// clearHostCertCache() — exposed for testing
// ---------------------------------------------------------------------------

export function clearHostCertCache(): void {
  hostCertCache.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateSerialNumber(): string {
  // 16-byte random hex serial number
  const bytes = forge.random.getBytesSync(16);
  return forge.util.bytesToHex(bytes);
}
