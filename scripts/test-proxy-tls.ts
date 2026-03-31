// scripts/test-proxy-tls.ts
//
// Unit tests for proxy-tls.ts: CA generation, host cert minting, TLS chain verification.
// Does NOT require Electron — uses a temp directory for CA storage.
//
// Usage: npx tsx scripts/test-proxy-tls.ts

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import tls from 'node:tls'
import https from 'node:https'
import { X509Certificate } from 'node:crypto'
import {
  ensureCA,
  generateHostCert,
  clearHostCertCache,
  type BouncerCA,
} from '../src/main/proxy-tls.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn())
    .then(() => {
      console.log(`  ✓ ${name}`)
      passed++
    })
    .catch((err) => {
      console.log(`  ✗ ${name}`)
      console.log(`    ${err}`)
      failed++
    })
}

// --- Temp directory for tests ---

let tempDir: string

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bouncer-tls-test-'))
}

// --- Tests ---

console.log('\nproxy-tls tests\n')

// Generate a CA once for reuse across tests
tempDir = freshTempDir()
let ca: BouncerCA

await test('ensureCA() generates a valid CA certificate', async () => {
  ca = await ensureCA(tempDir)

  assert.ok(ca.cert.includes('BEGIN CERTIFICATE'), 'cert is PEM-encoded')
  assert.ok(ca.key.includes('BEGIN RSA PRIVATE KEY'), 'key is PEM-encoded')
  assert.equal(ca.certPath, join(tempDir, 'bouncer-ca.crt'))

  // Parse and verify it's a CA
  const x509 = new X509Certificate(ca.cert)
  assert.ok(x509.ca, 'certificate should have CA flag set')
  assert.ok(x509.subject.includes('CN=Bouncer Proxy CA'), 'subject has correct CN')
  assert.ok(x509.issuer.includes('CN=Bouncer Proxy CA'), 'self-signed: issuer matches subject')
})

await test('ensureCA() persists files to disk', async () => {
  assert.ok(existsSync(join(tempDir, 'bouncer-ca.crt')), 'cert file exists')
  assert.ok(existsSync(join(tempDir, 'bouncer-ca.key')), 'key file exists')
})

await test('ensureCA() is idempotent — loads from disk on second call', async () => {
  const ca2 = await ensureCA(tempDir)
  assert.equal(ca2.cert, ca.cert, 'same cert on second call')
  assert.equal(ca2.key, ca.key, 'same key on second call')
})

await test('generateHostCert() returns a cert signed by the CA', () => {
  clearHostCertCache()
  const host = generateHostCert('api.github.com', ca)

  assert.ok(host.cert.includes('BEGIN CERTIFICATE'), 'host cert is PEM-encoded')
  assert.ok(host.key.includes('BEGIN RSA PRIVATE KEY'), 'host key is PEM-encoded')

  const x509 = new X509Certificate(host.cert)
  assert.ok(x509.subject.includes('CN=api.github.com'), 'correct subject CN')
  assert.ok(x509.issuer.includes('CN=Bouncer Proxy CA'), 'issuer is our CA')
  assert.ok(!x509.ca, 'host cert is not a CA')

  // Verify SAN
  const san = x509.subjectAltName
  assert.ok(
    san?.includes('DNS:api.github.com'),
    `SAN should include DNS:api.github.com, got: ${san}`,
  )
})

await test('generateHostCert() caches — same hostname returns cached cert', () => {
  clearHostCertCache()
  const first = generateHostCert('example.com', ca)
  const second = generateHostCert('example.com', ca)
  assert.equal(first.cert, second.cert, 'cached cert returned')
  assert.equal(first.key, second.key, 'cached key returned')
})

await test('generateHostCert() — different hostnames produce different certs', () => {
  clearHostCertCache()
  const a = generateHostCert('a.example.com', ca)
  const b = generateHostCert('b.example.com', ca)
  assert.notEqual(a.cert, b.cert, 'different hostnames get different certs')
})

await test('TLS chain verification: tls.connect trusts host cert when CA is provided', async () => {
  clearHostCertCache()
  const hostname = 'test.bouncer.local'
  const hostCert = generateHostCert(hostname, ca)

  // Start a minimal HTTPS server using the host cert
  const server = https.createServer({ cert: hostCert.cert, key: hostCert.key }, (_req, res) => {
    res.writeHead(200)
    res.end('ok')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  try {
    // Connect with our CA as trusted — should succeed
    await new Promise<void>((resolve, reject) => {
      const socket = tls.connect(
        { host: '127.0.0.1', port, ca: ca.cert, servername: hostname },
        () => {
          assert.ok(socket.authorized, 'connection should be authorized')
          socket.end()
          resolve()
        },
      )
      socket.on('error', reject)
    })

    // Connect WITHOUT our CA — should fail verification
    await new Promise<void>((resolve, reject) => {
      const socket = tls.connect(
        { host: '127.0.0.1', port, servername: hostname, rejectUnauthorized: true },
        () => {
          // If we get here, it unexpectedly succeeded
          socket.end()
          reject(new Error('Expected TLS verification to fail without CA'))
        },
      )
      socket.on('error', (err: NodeJS.ErrnoException) => {
        const expectedCodes = [
          'SELF_SIGNED_CERT_IN_CHAIN',
          'DEPTH_ZERO_SELF_SIGNED_CERT',
          'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
          'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        ]
        assert.ok(
          (err.code && expectedCodes.includes(err.code)) ||
            /self[- ]signed/i.test(err.message) ||
            /unable to verify/i.test(err.message),
          `expected cert verification error, got code=${err.code ?? 'N/A'} message=${err.message}`,
        )
        resolve()
      })
    })
  } finally {
    server.close()
  }
})

await test('ensureCA() in a fresh directory generates a new CA', async () => {
  const dir2 = freshTempDir()
  try {
    const ca2 = await ensureCA(dir2)
    assert.notEqual(ca2.cert, ca.cert, 'different directory = different CA')
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }
})

// --- Cleanup ---
rmSync(tempDir, { recursive: true, force: true })

console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
