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
 * Git invokes credential helpers with "get", "store", or "erase" as argv[1].
 * We only respond to "get" and only when the input includes host=github.com.
 */

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}

async function main(): Promise<void> {
  // Only respond to "get" requests
  if (process.argv[2] !== "get") {
    process.exit(0);
  }

  const input = await readStdin();
  if (!input.includes("host=github.com")) {
    process.exit(0);
  }

  const token = process.env.GH_TOKEN;
  if (!token) {
    process.exit(1);
  }

  process.stdout.write(
    `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${token}\n\n`,
  );
}

main().catch(() => process.exit(1));
