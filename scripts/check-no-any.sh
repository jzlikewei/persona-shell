#!/bin/sh
# Block explicit `any` type annotations in src/, unless marked with no-any-guard-ignore.
# Uses word-boundary matching and excludes comments (lines starting with optional whitespace + //).
hits=$(grep -rn --include='*.ts' -E ':\s*any\b|<any>' src/ | grep -v 'no-any-guard-ignore' | grep -v '^\s*//')
if [ -n "$hits" ]; then
  echo "ERROR: explicit 'any' found (add '// no-any-guard-ignore' to exempt):"
  echo "$hits"
  exit 1
fi
