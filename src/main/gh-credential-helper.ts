#!/usr/bin/env node
/**
 * Git credential helper that echoes GH_TOKEN for github.com.
 *
 * Used inside containers where the real `gh auth git-credential` isn't
 * available. Mounted into the container and referenced from /etc/gitconfig:
 *
 *   [credential "https://github.com"]
 *       helper = !node /usr/local/lib/bouncer/gh-credential-helper.js
 *
 * Git invokes credential helpers with "get", "store", or "erase" as the
 * first argument. For this Node-based helper (run as `node <script> <action>`),
 * the action is process.argv[2]. We only respond to "get" and only when
 * the parsed input has host=github.com and protocol=https.
 */

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk: string) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
  })
}

function parseCredentialInput(input: string): Record<string, string> {
  const kv: Record<string, string> = {}
  for (const line of input.split(/\r?\n/)) {
    const idx = line.indexOf('=')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) kv[key] = value
  }
  return kv
}

async function main(): Promise<void> {
  // Only respond to "get" requests
  if (process.argv[2] !== 'get') {
    process.exit(0)
  }

  const input = await readStdin()
  const kv = parseCredentialInput(input)

  // Exact host match — prevent github.com.evil.com from matching
  if (kv['host'] !== 'github.com') {
    process.exit(0)
  }
  if (kv['protocol'] && kv['protocol'] !== 'https') {
    process.exit(0)
  }

  const token = process.env.GH_TOKEN
  if (!token) {
    // Exit 0 with no output so git can fall back to other helpers
    process.stderr.write('gh-credential-helper: GH_TOKEN is not set\n')
    process.exit(0)
  }

  process.stdout.write(`protocol=https\nhost=github.com\nusername=x-access-token\npassword=${token}\n\n`)
}

main().catch(() => process.exit(1))
