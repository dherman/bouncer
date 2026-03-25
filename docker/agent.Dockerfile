# Bouncer agent container image.
# Based on the Claude Code sandbox template; adds Rust toolchain and removes
# the real `gh` CLI so that only the Bouncer shim can serve GitHub operations.

FROM docker/sandbox-templates:claude-code

# Remove the real gh binary so agents must use the Bouncer shim
RUN rm -f $(which gh 2>/dev/null) || true && \
    rm -f /usr/bin/gh /usr/local/bin/gh 2>/dev/null || true

# Install Rust toolchain (stable) with common components
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain stable --component rust-analyzer,rustfmt,clippy && \
    echo 'source $HOME/.cargo/env' >> /etc/profile.d/rust.sh

ENV PATH="/root/.cargo/bin:${PATH}"

# Switch to non-root agent user (created in base image)
USER agent
WORKDIR /workspace
