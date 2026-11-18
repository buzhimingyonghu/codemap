#!/usr/bin/env bash
# Codemap 开发脚本：环境检查、安装、启动、测试、打包、安装到“应用程序”、清理。
# 用法：./scripts/codemap.sh <命令>，不带参数时显示帮助。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_NAME="Codemap"
APP_PATH="$ROOT/release/mac-arm64/$APP_NAME.app"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
fail() {
  printf '\033[31m✗\033[0m %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Codemap 开发脚本

用法：./scripts/codemap.sh <命令>

  doctor     检查 macOS、Node、git、Xcode 命令行工具、lldb-dap
  setup      安装依赖并确保 Electron 运行时已下载
  dev        以开发模式启动（界面代码热更新）
  start      构建后以生产模式预览（不打包）
  check      类型检查 + 单元测试
  codemap    校验代码地图节点库：./scripts/codemap.sh codemap [节点库目录] [--index] [--all]
  e2e        构建并运行端到端测试（会真实启动 App）
  icon       重新生成应用图标 build/icon.icns
  package    打包 arm64 版本：.app、.dmg、.zip（输出到 release/）
  app        只打包 .app 目录（最快，适合自测）
  install    打包并安装到 /Applications，然后打开
  open       打开已打包的 Codemap.app
  clean      删除构建产物（out/ release/）
  reset      clean + 删除 node_modules（之后需要重新 setup）
EOF
}

ensure_electron() {
  local marker="node_modules/electron/path.txt"
  local binary="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  if [[ -f "$marker" && -x "$binary" ]]; then
    return
  fi
  info "下载 Electron 运行时"
  node node_modules/electron/install.js
  [[ -x "$binary" ]] || fail "Electron 下载失败，请检查网络后重试：node node_modules/electron/install.js"
  ok "Electron 已就绪"
}

ensure_deps() {
  if [[ ! -d node_modules ]]; then
    info "首次运行，安装依赖"
    npm install --no-audit --no-fund
  fi
  ensure_electron
}

cmd_doctor() {
  bold "环境检查"
  local problems=0
  [[ "$(uname -s)" == "Darwin" ]] && ok "macOS $(sw_vers -productVersion)" || {
    warn "需要 macOS"
    problems=$((problems + 1))
  }
  [[ "$(uname -m)" == "arm64" ]] && ok "Apple Silicon (arm64)" || warn "当前不是 arm64，打包配置只产出 arm64"

  if command -v node >/dev/null; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if ((major >= 22)); then ok "Node $(node -v)"; else
      warn "Node $(node -v) 版本偏低，需要 22 或更高"
      problems=$((problems + 1))
    fi
  else
    warn "未安装 Node.js（推荐 brew install node）"
    problems=$((problems + 1))
  fi

  command -v npm >/dev/null && ok "npm $(npm -v)" || problems=$((problems + 1))
  command -v git >/dev/null && ok "$(git --version)" || {
    warn "未安装 git"
    problems=$((problems + 1))
  }

  if xcode-select -p >/dev/null 2>&1; then ok "Xcode 命令行工具：$(xcode-select -p)"; else
    warn "未安装 Xcode 命令行工具，运行 xcode-select --install"
    problems=$((problems + 1))
  fi

  if dap="$(xcrun -f lldb-dap 2>/dev/null)"; then ok "lldb-dap：$dap"; else warn "找不到 lldb-dap，调试功能不可用"; fi
  command -v clang >/dev/null && ok "clang 可用" || warn "找不到 clang"

  if [[ -x node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ]]; then ok "Electron 运行时已下载"; else warn "Electron 运行时未下载，运行 ./scripts/codemap.sh setup"; fi

  if ((problems > 0)); then fail "有 $problems 项需要处理"; fi
  ok "环境正常"
}

cmd_setup() {
  info "安装依赖"
  npm install --no-audit --no-fund
  ensure_electron
  ok "安装完成，运行 ./scripts/codemap.sh dev 启动"
}

cmd_dev() {
  ensure_deps
  npm run dev
}

cmd_start() {
  ensure_deps
  npm run build
  npm run start
}

cmd_check() {
  ensure_deps
  info "类型检查"
  npm run typecheck
  info "单元测试"
  npm test
  ok "检查通过"
}

cmd_e2e() {
  ensure_deps
  npm run build
  npm run test:e2e
}

cmd_codemap() {
  [[ -d node_modules/js-yaml ]] || npm install --no-audit --no-fund
  node scripts/codemap-validate.mjs "$@"
}

cmd_icon() {
  ensure_deps
  npm run icon
}

ensure_icon() {
  [[ -f build/icon.icns ]] || cmd_icon
}

cmd_package() {
  ensure_deps
  ensure_icon
  npm run package
  ok "打包完成："
  ls -1 release/*.dmg release/*.zip 2>/dev/null | sed 's/^/   /'
  echo "   $APP_PATH"
}

cmd_app() {
  ensure_deps
  ensure_icon
  npm run package:dir
  ok "已生成 $APP_PATH"
}

cmd_install() {
  cmd_app
  local target="/Applications/$APP_NAME.app"
  if [[ -d "$target" ]]; then
    info "移除旧版本 $target"
    osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
    if command -v trash >/dev/null; then trash "$target"; else rm -rf "$target"; fi
  fi
  info "安装到 $target"
  ditto "$APP_PATH" "$target"
  ok "已安装"
  open "$target"
}

cmd_open() {
  [[ -d "$APP_PATH" ]] || fail "还没有打包，先运行 ./scripts/codemap.sh app"
  open "$APP_PATH"
}

cmd_clean() {
  info "删除 out/ release/ 和 TypeScript 增量缓存"
  rm -rf out release ./*.tsbuildinfo tests/e2e/artifacts
  ok "已清理"
}

cmd_reset() {
  cmd_clean
  info "删除 node_modules/"
  rm -rf node_modules
  ok "已重置，运行 ./scripts/codemap.sh setup 重新安装"
}

case "${1:-help}" in
  doctor) cmd_doctor ;;
  setup) cmd_setup ;;
  dev) cmd_dev ;;
  start) cmd_start ;;
  check) cmd_check ;;
  codemap)
    shift
    cmd_codemap "$@"
    ;;
  e2e) cmd_e2e ;;
  icon) cmd_icon ;;
  package) cmd_package ;;
  app) cmd_app ;;
  install) cmd_install ;;
  open) cmd_open ;;
  clean) cmd_clean ;;
  reset) cmd_reset ;;
  help | -h | --help) usage ;;
  *)
    warn "未知命令：$1"
    usage
    exit 1
    ;;
esac
