#!/bin/bash
set -e

# Install Bouncer CA certificate if present (bind-mounted at runtime)
CA_CERT="/usr/local/share/ca-certificates/bouncer/bouncer-ca.crt"
if [ -f "$CA_CERT" ]; then
  update-ca-certificates 2>/dev/null || true
  export NODE_EXTRA_CA_CERTS="$CA_CERT"
fi

exec "$@"
