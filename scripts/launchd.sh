#!/bin/zsh
# Optional: run Ollama and the Telegram bot in the background at login (macOS launchd user agents).
# Usage: scripts/launchd.sh install | uninstall | status | logs
# Installs two plists in ~/Library/LaunchAgents; logs go to ~/Library/Logs/sf-copilot/.
# Nothing runs while the Mac is asleep.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/sf-copilot"
UID_NUM="$(id -u)"
OLLAMA_LABEL="local.sf-copilot.ollama"
BOT_LABEL="local.sf-copilot.bot"
NODE_BIN="$(command -v node)"
OLLAMA_BIN="$(command -v ollama)"

plist() { # label, workdir, program args...
  local label="$1" workdir="$2"; shift 2
  local args=""
  for a in "$@"; do args+="    <string>${a}</string>"$'\n'; done
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}  </array>
  <key>WorkingDirectory</key><string>${workdir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OLLAMA_HOST</key><string>127.0.0.1:11434</string>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${LOGS}/${label##*.}.log</string>
  <key>StandardErrorPath</key><string>${LOGS}/${label##*.}.log</string>
</dict>
</plist>
EOF
}

case "${1:-}" in
  install)
    [[ -x "$NODE_BIN" && -x "$OLLAMA_BIN" ]] || { echo "node or ollama not found on PATH"; exit 1; }
    mkdir -p "$AGENTS" "$LOGS"
    plist "$OLLAMA_LABEL" "$HOME" "$OLLAMA_BIN" serve > "$AGENTS/$OLLAMA_LABEL.plist"
    plist "$BOT_LABEL" "$PROJECT_DIR" "$NODE_BIN" "$PROJECT_DIR/src/bot.js" > "$AGENTS/$BOT_LABEL.plist"
    for l in "$OLLAMA_LABEL" "$BOT_LABEL"; do
      launchctl bootout "gui/$UID_NUM/$l" 2>/dev/null || true
      # bootout is asynchronous; bootstrapping before it finishes fails with "5: Input/output error"
      for _ in {1..20}; do launchctl print "gui/$UID_NUM/$l" >/dev/null 2>&1 || break; sleep 0.5; done
      launchctl bootstrap "gui/$UID_NUM" "$AGENTS/$l.plist"
    done
    echo "Installed and started. Logs: $LOGS (scripts/launchd.sh logs)"
    ;;
  uninstall)
    for l in "$BOT_LABEL" "$OLLAMA_LABEL"; do
      launchctl bootout "gui/$UID_NUM/$l" 2>/dev/null || true
      rm -f "$AGENTS/$l.plist"
    done
    echo "Stopped and removed."
    ;;
  status)
    for l in "$OLLAMA_LABEL" "$BOT_LABEL"; do
      if launchctl print "gui/$UID_NUM/$l" >/dev/null 2>&1; then
        echo "$l: $(launchctl print "gui/$UID_NUM/$l" | awk -F'= ' '/^\tstate/{print $2; exit}')"
      else
        echo "$l: not installed"
      fi
    done
    ;;
  logs)
    tail -n 50 -f "$LOGS"/*.log
    ;;
  *)
    echo "Usage: $0 install | uninstall | status | logs"; exit 2 ;;
esac
