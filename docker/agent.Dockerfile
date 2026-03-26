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

# Prepare CA trust store directory for runtime injection
USER root
RUN mkdir -p /usr/local/share/ca-certificates/bouncer
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER agent
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
