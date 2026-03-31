#!/bin/bash
set -e

# Install Bouncer CA certificate if present (bind-mounted at runtime).
# Entrypoint runs as root (set in Dockerfile) so update-ca-certificates
# has permission to write to /etc/ssl/certs.
CA_CERT="/usr/local/share/ca-certificates/bouncer/bouncer-ca.crt"
if [ -f "$CA_CERT" ]; then
  update-ca-certificates >/dev/null 2>&1 || true
  export NODE_EXTRA_CA_CERTS="$CA_CERT"
fi

# Enforce proxy usage via iptables — prevent the agent from bypassing
# the HTTP proxy by connecting directly to external hosts. Only HTTP/HTTPS
# traffic through the proxy is allowed; direct outbound connections are dropped.
if [ -n "$BOUNCER_PROXY_HOST" ] && [ -n "$BOUNCER_PROXY_PORT" ] && command -v iptables >/dev/null 2>&1; then
  AGENT_UID=$(id -u agent 2>/dev/null || echo 1000)
  # Allow traffic to the proxy host itself
  iptables -A OUTPUT -m owner --uid-owner "$AGENT_UID" -d "$BOUNCER_PROXY_HOST" -j ACCEPT 2>/dev/null || true
  # Allow loopback
  iptables -A OUTPUT -m owner --uid-owner "$AGENT_UID" -o lo -j ACCEPT 2>/dev/null || true
  # Allow DNS (UDP 53) — needed for proxy hostname resolution
  iptables -A OUTPUT -m owner --uid-owner "$AGENT_UID" -p udp --dport 53 -j ACCEPT 2>/dev/null || true
  # Drop direct HTTP/HTTPS connections from the agent user
  iptables -A OUTPUT -m owner --uid-owner "$AGENT_UID" -p tcp --dport 80 -j DROP 2>/dev/null || true
  iptables -A OUTPUT -m owner --uid-owner "$AGENT_UID" -p tcp --dport 443 -j DROP 2>/dev/null || true
  # Also block git:// protocol (port 9418)
  iptables -A OUTPUT -m owner --uid-owner "$AGENT_UID" -p tcp --dport 9418 -j DROP 2>/dev/null || true
fi

# Force all Node.js HTTP/HTTPS traffic through the proxy via global-agent.
# This covers libraries like `got` (v11+) that don't respect HTTP_PROXY env vars.
# global-agent patches http.globalAgent/https.globalAgent at require time.
# The wrapper script calls global-agent v4's bootstrap() function on load.
#
# We can't rely on NODE_OPTIONS because Claude Code strips it from child
# processes. Instead, we wrap the `node` binary with a shim that re-injects
# the --require flag on every invocation.
GLOBAL_AGENT_BOOTSTRAP="/usr/local/lib/bouncer/global-agent-bootstrap.cjs"
if [ -n "$HTTP_PROXY" ] && [ -f "$GLOBAL_AGENT_BOOTSTRAP" ]; then
  export GLOBAL_AGENT_HTTP_PROXY="$HTTP_PROXY"
  export GLOBAL_AGENT_HTTPS_PROXY="${HTTPS_PROXY:-$HTTP_PROXY}"
  export GLOBAL_AGENT_NO_PROXY="${NO_PROXY:-localhost,127.0.0.1}"

  # Wrap the node binary so global-agent loads in every node process,
  # even those spawned by tools that strip NODE_OPTIONS.
  NODE_BIN=$(which node 2>/dev/null)
  if [ -n "$NODE_BIN" ] && [ ! -f "${NODE_BIN}.real" ]; then
    mv "$NODE_BIN" "${NODE_BIN}.real"
    cat > "$NODE_BIN" << WRAPPER
#!/bin/sh
export NODE_OPTIONS="\${NODE_OPTIONS:+\$NODE_OPTIONS }--require ${GLOBAL_AGENT_BOOTSTRAP}"
exec "${NODE_BIN}.real" "\$@"
WRAPPER
    chmod +x "$NODE_BIN"
  fi
fi

# Lock down policy files (bind-mounted at /etc/bouncer/).
# The agent needs to READ the policy (gh shim) and EXECUTE hooks (pre-push),
# but should not be able to WRITE/modify its own sandbox policy.
if [ -d /etc/bouncer ]; then
  chown -R root:root /etc/bouncer 2>/dev/null || true
  # Directories: world-readable + executable (traversable)
  find /etc/bouncer -type d -exec chmod 755 {} \; 2>/dev/null || true
  # Regular files: world-readable, not writable by agent
  find /etc/bouncer -type f -exec chmod 644 {} \; 2>/dev/null || true
  # Hook scripts: must be executable for git to run them
  find /etc/bouncer -type f -name "pre-*" -exec chmod 755 {} \; 2>/dev/null || true
fi

# Drop privileges to the agent user for the actual command
exec gosu agent "$@"
