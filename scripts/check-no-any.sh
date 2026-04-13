#!/bin/sh
# Block explicit `any` type annotations in src/, unless marked with no-any-guard-ignore.
hits=$(grep -rn ': any\b\|<any>' src/ --include='*.ts' | grep -v 'no-any-guard-ignore')
if [ -n "$hits" ]; then
  echo "ERROR: explicit 'any' found (add '// no-any-guard-ignore' to exempt):"
  echo "$hits"
  exit 1
fi
