// scripts/test-proxy.ts
//
// Tests for the HTTP proxy: domain matching, domain filtering, and TLS MITM.
// Requires the CA from proxy-tls.ts (uses a temp directory, no Electron needed).
//
// Usage: npx tsx scripts/test-proxy.ts

import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { X509Certificate } from 'node:crypto'
import { ensureCA, type BouncerCA } from '../src/main/proxy-tls.js'
import { domainMatches, startProxy, type ProxyConfig, type ProxyHandle } from '../src/main/proxy.js'
import type { PolicyEvent } from '../src/main/types.js'

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

// --- Helpers ---

const tempDir = mkdtempSync(join(tmpdir(), 'bouncer-proxy-test-'))
let ca: BouncerCA

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  const events: PolicyEvent[] = []
  return {
    sessionId: 'test-session',
    port: 0,
    listenHost: '127.0.0.1',
    allowedDomains: ['*'],
    inspectedDomains: [],
    githubPolicy: null,
    ca,
    onPolicyEvent: (e) => events.push(e),
    insecureUpstreamTls: true,
    ...overrides,
  }
}

/** Make an HTTP request through the proxy (plain HTTP). */
function httpViaProxy(
  proxyPort: number,
  targetUrl: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // For HTTP proxies, the full URL must be sent as the request path
    const url = new URL(targetUrl)
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        path: targetUrl,
        method: 'GET',
        headers: { host: url.host },
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => (body += chunk.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** Make an HTTP CONNECT request through the proxy and return the raw socket. */
function connectViaProxy(
  proxyPort: number,
  host: string,
  port: number = 443,
): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${host}:${port}`,
    })
    req.on('connect', (res, socket) => {
      resolve({ status: res.statusCode ?? 0, socket })
    })
    req.on('error', reject)
    req.end()
  })
}

// =========================================================================
// Tests
// =========================================================================

console.log('\nproxy tests\n')

// --- Setup ---
ca = await ensureCA(tempDir)

// --- domainMatches unit tests ---

console.log('  domainMatches:')

await test('* matches any hostname', () => {
  assert.ok(domainMatches('anything.example.com', '*'))
  assert.ok(domainMatches('localhost', '*'))
})

await test('exact match', () => {
  assert.ok(domainMatches('example.com', 'example.com'))
  assert.ok(!domainMatches('other.com', 'example.com'))
})

await test('wildcard *.example.com matches subdomains', () => {
  assert.ok(domainMatches('foo.example.com', '*.example.com'))
  assert.ok(domainMatches('bar.baz.example.com', '*.example.com'))
})

await test('wildcard *.example.com does NOT match bare domain', () => {
  assert.ok(!domainMatches('example.com', '*.example.com'))
})

await test('no match returns false', () => {
  assert.ok(!domainMatches('evil.com', 'example.com'))
  assert.ok(!domainMatches('evil.com', '*.example.com'))
})

await test('matching is case-insensitive', () => {
  assert.ok(domainMatches('Example.COM', 'example.com'))
  assert.ok(domainMatches('FOO.example.com', '*.Example.COM'))
})

await test('trailing dots are ignored', () => {
  assert.ok(domainMatches('example.com.', 'example.com'))
  assert.ok(domainMatches('example.com', 'example.com.'))
})

// --- Proxy: plain HTTP domain filtering ---

console.log('\n  plain HTTP filtering:')

// Start a simple upstream HTTP server for testing
const upstream = http.createServer((_req, res) => {
  res.writeHead(200)
  res.end('upstream ok')
})
await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = (upstream.address() as net.AddressInfo).port

await test('allowed domain: plain HTTP request is forwarded', async () => {
  const events: PolicyEvent[] = []
  const proxy = await startProxy(
    makeConfig({
      allowedDomains: ['127.0.0.1'],
      onPolicyEvent: (e) => events.push(e),
    }),
  )
  try {
    const res = await httpViaProxy(proxy.port, `http://127.0.0.1:${upstreamPort}/test`)
    assert.equal(res.status, 200)
    assert.equal(res.body, 'upstream ok')
    assert.equal(events.length, 0, 'no deny events for allowed domain')
  } finally {
    await proxy.stop()
  }
})

await test('denied domain: plain HTTP request gets 403', async () => {
  const events: PolicyEvent[] = []
  const proxy = await startProxy(
    makeConfig({
      allowedDomains: ['other.com'],
      onPolicyEvent: (e) => events.push(e),
    }),
  )
  try {
    const res = await httpViaProxy(proxy.port, `http://127.0.0.1:${upstreamPort}/test`)
    assert.equal(res.status, 403)
    assert.ok(res.body.includes('not in the allowed domain list'))
    assert.equal(events.length, 1)
    assert.equal(events[0].decision, 'deny')
    assert.equal(events[0].tool, 'proxy')
  } finally {
    await proxy.stop()
  }
})

// --- Proxy: CONNECT domain filtering ---

console.log('\n  CONNECT filtering:')

await test('CONNECT to allowed non-inspected domain: tunnel established', async () => {
  // Start a TCP server that echoes back what it receives.
  // Using echo (wait for data) instead of immediate write avoids a race
  // where the server sends before the proxy tunnel is fully piped.
  const echo = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      socket.write(`echo: ${chunk.toString()}`)
      socket.end()
    })
  })
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
  const echoPort = (echo.address() as net.AddressInfo).port

  const proxy = await startProxy(makeConfig({ allowedDomains: ['127.0.0.1'] }))
  try {
    const { status, socket } = await connectViaProxy(proxy.port, '127.0.0.1', echoPort)
    assert.equal(status, 200)

    // Send data through the tunnel and wait for the echo
    socket.write('ping')
    const data = await new Promise<string>((resolve) => {
      let buf = ''
      socket.on('data', (chunk: Buffer) => (buf += chunk.toString()))
      socket.on('end', () => resolve(buf))
    })
    assert.equal(data, 'echo: ping')
  } finally {
    await proxy.stop()
    echo.close()
  }
})

await test('CONNECT to denied domain: gets 403', async () => {
  const events: PolicyEvent[] = []
  const proxy = await startProxy(
    makeConfig({
      allowedDomains: ['allowed.com'],
      onPolicyEvent: (e) => events.push(e),
    }),
  )
  try {
    const { status, socket } = await connectViaProxy(proxy.port, 'denied.example.com', 443)
    assert.equal(status, 403)
    socket.destroy()
    assert.equal(events.length, 1)
    assert.equal(events[0].decision, 'deny')
  } finally {
    await proxy.stop()
  }
})

// --- Proxy: TLS MITM ---

console.log('\n  TLS MITM:')

await test("MITM'd domain: client sees cert signed by Bouncer CA", async () => {
  // Start a real HTTPS upstream server
  const upstreamCert = (await import('../src/main/proxy-tls.js')).generateHostCert('localhost', ca)
  const httpsUpstream = https.createServer(
    { cert: upstreamCert.cert, key: upstreamCert.key },
    (_req, res) => {
      res.writeHead(200)
      res.end('mitm upstream ok')
    },
  )
  await new Promise<void>((resolve) => httpsUpstream.listen(0, '127.0.0.1', resolve))
  const httpsPort = (httpsUpstream.address() as net.AddressInfo).port

  const proxy = await startProxy(
    makeConfig({
      allowedDomains: ['localhost'],
      inspectedDomains: ['localhost'],
    }),
  )

  try {
    // CONNECT through the proxy
    const { status, socket } = await connectViaProxy(proxy.port, 'localhost', httpsPort)
    assert.equal(status, 200)

    // Upgrade to TLS and verify the cert chain
    const tlsSocket = tls.connect({
      socket,
      ca: ca.cert,
      servername: 'localhost',
    })

    await new Promise<void>((resolve, reject) => {
      tlsSocket.on('secureConnect', () => {
        assert.ok(tlsSocket.authorized, 'TLS connection should be authorized')

        // Verify cert is signed by our CA
        const peerCert = tlsSocket.getPeerX509Certificate()
        assert.ok(peerCert, 'should have peer certificate')
        assert.ok(
          peerCert.issuer.includes('Bouncer Proxy CA'),
          'cert should be issued by Bouncer CA',
        )
        assert.ok(peerCert.subject.includes('CN=localhost'), 'cert CN should match hostname')

        // Make an HTTP request through the MITM'd connection
        const req = http.request(
          {
            createConnection: () => tlsSocket as unknown as net.Socket,
            hostname: 'localhost',
            path: '/test',
            method: 'GET',
            headers: { host: 'localhost' },
          },
          (res) => {
            let body = ''
            res.on('data', (chunk: Buffer) => (body += chunk.toString()))
            res.on('end', () => {
              try {
                assert.equal(res.statusCode, 200)
                assert.equal(body, 'mitm upstream ok')
                resolve()
              } catch (e) {
                reject(e)
              }
            })
          },
        )
        req.on('error', reject)
        req.end()
      })
      tlsSocket.on('error', reject)
    })
  } finally {
    await proxy.stop()
    httpsUpstream.close()
  }
})

await test("MITM'd domain with onMitmRequest handler: handler is called", async () => {
  // Simple upstream HTTPS server
  const upstreamCert = (await import('../src/main/proxy-tls.js')).generateHostCert(
    'handler-test.local',
    ca,
  )
  const httpsUpstream = https.createServer(
    { cert: upstreamCert.cert, key: upstreamCert.key },
    (_req, res) => {
      res.writeHead(200)
      res.end('should not see this')
    },
  )
  await new Promise<void>((resolve) => httpsUpstream.listen(0, '127.0.0.1', resolve))
  const httpsPort = (httpsUpstream.address() as net.AddressInfo).port

  let handlerCalled = false
  const proxy = await startProxy(
    makeConfig({
      allowedDomains: ['handler-test.local'],
      inspectedDomains: ['handler-test.local'],
      onMitmRequest: (req, res, hostname, _upstream) => {
        handlerCalled = true
        assert.equal(hostname, 'handler-test.local')
        // Return a custom response instead of forwarding
        res.writeHead(403)
        res.end('blocked by handler')
      },
    }),
  )

  try {
    const { socket } = await connectViaProxy(proxy.port, 'handler-test.local', httpsPort)

    const tlsSocket = tls.connect({
      socket,
      ca: ca.cert,
      servername: 'handler-test.local',
    })

    await new Promise<void>((resolve, reject) => {
      tlsSocket.on('secureConnect', () => {
        const req = http.request(
          {
            createConnection: () => tlsSocket as unknown as net.Socket,
            hostname: 'handler-test.local',
            path: '/test',
            method: 'GET',
            headers: { host: 'handler-test.local' },
          },
          (res) => {
            let body = ''
            res.on('data', (chunk: Buffer) => (body += chunk.toString()))
            res.on('end', () => {
              try {
                assert.equal(res.statusCode, 403)
                assert.equal(body, 'blocked by handler')
                assert.ok(handlerCalled, 'handler should have been called')
                resolve()
              } catch (e) {
                reject(e)
              }
            })
          },
        )
        req.on('error', reject)
        req.end()
      })
      tlsSocket.on('error', reject)
    })
  } finally {
    await proxy.stop()
    httpsUpstream.close()
  }
})

await test('updatePolicy() updates the config', async () => {
  const proxy = await startProxy(makeConfig({ githubPolicy: null }))
  try {
    const newPolicy = {
      repo: 'owner/repo',
      allowedPushRefs: ['feature'],
      ownedPrNumber: 42,
      canCreatePr: false,
    }
    proxy.updatePolicy(newPolicy)
    // If we could inspect config.githubPolicy, it should be updated.
    // Since config is internal, we just verify updatePolicy doesn't throw.
  } finally {
    await proxy.stop()
  }
})

await test('stop() cleans up all connections', async () => {
  // Start a TCP server that holds connections open
  const holder = net.createServer((socket) => {
    // Just hold the connection open
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve))
  const holderPort = (holder.address() as net.AddressInfo).port

  const proxy = await startProxy(makeConfig({ allowedDomains: ['127.0.0.1'] }))

  // Open a CONNECT tunnel to the holder
  const { socket } = await connectViaProxy(proxy.port, '127.0.0.1', holderPort)

  await proxy.stop()

  // Wait for socket close to propagate
  if (!socket.destroyed) {
    await new Promise<void>((resolve) => {
      socket.on('close', resolve)
      // Timeout safety — if it doesn't close in 500ms, proceed
      setTimeout(resolve, 500)
    })
  }
  assert.ok(
    socket.destroyed || socket.readableEnded || !socket.writable,
    'socket should be closed after stop()',
  )
  holder.close()
})

// --- Cleanup ---
upstream.close()
rmSync(tempDir, { recursive: true, force: true })

console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
