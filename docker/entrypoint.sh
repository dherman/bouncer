#!/bin/bash
set -e

# Install Bouncer CA certificate if present (bind-mounted at runtime).
# Entrypoint runs as root (set in Dockerfile) so update-ca-certificates
# has permission to write to /etc/ssl/certs.
CA_CERT="/usr/local/share/ca-certificates/bouncer/bouncer-ca.crt"
if [ -f "$CA_CERT" ]; then
  update-ca-certificates 2>/dev/null || true
  export NODE_EXTRA_CA_CERTS="$CA_CERT"
fi

# Drop privileges to the agent user for the actual command
exec gosu agent "$@"
