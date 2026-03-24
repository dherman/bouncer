#!/bin/bash
# Bouncer gh shim — delegates to gh-shim.ts with policy enforcement.
# __NODE__ and __GH_SHIM_TS__ are replaced by SessionManager at session creation.
exec "__NODE__" --import tsx/esm "__GH_SHIM_TS__" "$@"
