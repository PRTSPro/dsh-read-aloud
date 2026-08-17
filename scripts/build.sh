#!/bin/bash
# Build: compile src/ → lib/ with the dsh checkout's tsc (run via node tsc.js).
# Supports two checkout shapes:
#   src mode  — a dsh source checkout with packages/ (DSH_CHECKOUT or common paths)
#   prebuilt  — an npx cache checkout with node_modules/ only (auto-probed, incl. WSL mounts)
# WSL/bash quirk: HOME may be /root while the real Windows profile is elsewhere;
# probes USERPROFILE, HOME, /mnt/c/Users/*, /c/Users/* in that order.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
MODE=""
USER_HOME="${USERPROFILE:-$HOME}"
# 本机当前运行中的 harness checkout（npx cache hash，优先锁定保证类型一致）
PREFERRED_HASH="1e7f6d9597241db0"

if [ -z "$CHECKOUT" ]; then
  for candidate in "$USER_HOME/dsh-harness" "$USER_HOME/dsh" "$USER_HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi
if [ -z "$CHECKOUT" ]; then
  for base in "${USERPROFILE:-}" "$HOME" /mnt/c/Users/* /c/Users/*; do
    [ -n "$base" ] && [ -d "$base" ] || continue
    for candidate in "$base/AppData/Local/npm-cache/_npx/$PREFERRED_HASH" "$base/AppData/Local/npm-cache/_npx"/*; do
      [ -e "$candidate/node_modules/@deepseek-ai/dsh-session" ] || continue
      CHECKOUT="$candidate"; break 2
    done
  done
fi
if [ -z "$CHECKOUT" ]; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi
if [ -d "$CHECKOUT/packages" ]; then MODE=src; elif [ -d "$CHECKOUT/node_modules" ]; then MODE=prebuilt; else
  echo "build: checkout at $CHECKOUT has neither packages/ nor node_modules/" >&2
  exit 1
fi

# tsc.js：选中 checkout 的根 node_modules → 其 .pnpm → 任意 npx cache
TSC_JS=""
if [ -f "$CHECKOUT/node_modules/typescript/lib/tsc.js" ]; then
  TSC_JS="$CHECKOUT/node_modules/typescript/lib/tsc.js"
else
  TSC_JS=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 3 -path '*/node_modules/typescript/lib/tsc.js' 2>/dev/null | head -1 || true)
fi
if [ -z "$TSC_JS" ] || [ ! -f "$TSC_JS" ]; then
  for base in "${USERPROFILE:-}" "$HOME" /mnt/c/Users/* /c/Users/*; do
    [ -n "$base" ] && [ -d "$base" ] || continue
    for c in "$base/AppData/Local/npm-cache/_npx"/*; do
      if [ -f "$c/node_modules/typescript/lib/tsc.js" ]; then TSC_JS="$c/node_modules/typescript/lib/tsc.js"; break 2; fi
    done
  done
fi
if [ -z "$TSC_JS" ] || [ ! -f "$TSC_JS" ]; then
  echo "build: tsc.js not found under $CHECKOUT" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "build: node not on PATH" >&2
  exit 1
fi

# $1 = package name, $2 = src-mode relative path under checkout
# symlink 失败（drvfs 权限）时复制实体目录兜底
link_pkg() {
  local target
  if [ "$MODE" = "src" ]; then
    target="$CHECKOUT/$2"
  else
    target="$CHECKOUT/node_modules/$1"
  fi
  if [ ! -e "$target" ]; then
    echo "build: skipping missing dep target: $1 ($target)" >&2
    return 0
  fi
  if ! node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$1" "$target" 2>/dev/null; then
    echo "build: symlink failed, copying $1"
    rm -rf "node_modules/$1"
    mkdir -p "$(dirname "node_modules/$1")"
    cp -r "$target" "node_modules/$1"
  fi
}

echo "=== Linking build dependencies (mode: $MODE, checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai
node -e "const fs=require('fs');fs.rmSync('node_modules/@standard-schema',{recursive:true,force:true})"
link_pkg @deepseek-ai/cordis vendor/cordis
link_pkg @deepseek-ai/schemastery vendor/schemastery
link_pkg @deepseek-ai/dsh-tools packages/core/tools
link_pkg @deepseek-ai/dsh-llm packages/llm/llm
link_pkg @deepseek-ai/dsh-system-prompt packages/core/system-prompt
link_pkg @deepseek-ai/dsh-session packages/core/session
link_pkg @deepseek-ai/dsh-scope packages/core/scope
# @types/node（编译类型；checkout 自带）
link_pkg @types/node node_modules/@types/node

echo "=== Compiling src → lib ==="
node "$TSC_JS" -p tsconfig.json
echo "=== Build complete ==="
