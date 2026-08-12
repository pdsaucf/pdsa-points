#!/usr/bin/env bash
# House rule from CLAUDE.md: no em dash anywhere in this project.
#
# The pattern is the raw UTF-8 bytes for U+2014. It is written as an escape
# rather than as a literal character so this file itself passes the check, and
# so the check behaves the same in bash and zsh.
#
# Do not rewrite this as printf. On a shell where printf handles the escape
# differently the pattern collapses to the empty string, which matches every
# line of every file, and a broken check then looks identical to a catastrophic
# failure.

set -euo pipefail

cd "$(dirname "$0")/.."

if grep -rn $'\xe2\x80\x94' . --exclude-dir=.git --exclude-dir=node_modules; then
  echo ""
  echo "FAIL: em dashes found above. Use a colon, a comma, parentheses, or a second sentence."
  exit 1
fi

echo "OK: no em dashes."
