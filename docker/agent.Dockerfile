# Bouncer agent container image.
# Based on the Claude Code sandbox template; adds Rust toolchain and removes
# the real `gh` CLI so that only the Bouncer shim can serve GitHub operations.

FROM docker/sandbox-templates:claude-code

# Switch to root for system-level changes
USER root

# Remove the real gh binary so agents must use the Bouncer shim
RUN rm -f $(which gh 2>/dev/null) || true && \
    rm -f /usr/bin/gh /usr/local/bin/gh 2>/dev/null || true

# Install C toolchain (needed by Rust as a linker)
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && \
    rm -rf /var/lib/apt/lists/*

# Switch to agent user for Rust install (rustup installs per-user)
USER agent

# Install Rust toolchain (stable) with common components
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain stable --component rust-analyzer,rustfmt,clippy

ENV PATH="/home/agent/.cargo/bin:${PATH}"

# Prepare CA trust store, iptables (for proxy enforcement), and entrypoint
USER root
RUN apt-get update && apt-get install -y --no-install-recommends gosu iptables && \
    rm -rf /var/lib/apt/lists/*
# Install global-agent so we can force all Node.js HTTP traffic through the proxy,
# regardless of whether individual libraries (e.g., got) respect HTTP_PROXY env vars.
# global-agent v4 exports a bootstrap function (doesn't auto-call), so we create
# a small wrapper that --require can load to auto-bootstrap.
RUN npm install --prefix /usr/local/lib/bouncer global-agent undici && \
    echo 'require("/usr/local/lib/bouncer/node_modules/global-agent/dist/routines/bootstrap.js").default();' \
      > /usr/local/lib/bouncer/global-agent-bootstrap.cjs && \
    # Patch global-agent's HttpsProxyAgent to pass servername to tls.connect().
    # Without this, TLS verification checks the cert against the proxy hostname
    # (host.docker.internal) instead of the target hostname (e.g. github.com),
    # causing ERR_TLS_CERT_ALTNAME_MISMATCH when using a MITM proxy.
    sed -i 's/const secureSocket = tls_1.default.connect({/const secureSocket = tls_1.default.connect({ servername: configuration.host,/' \
      /usr/local/lib/bouncer/node_modules/global-agent/dist/classes/HttpsProxyAgent.js
RUN mkdir -p /usr/local/share/ca-certificates/bouncer
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Entrypoint runs as root to install CA cert, then drops to agent user
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
