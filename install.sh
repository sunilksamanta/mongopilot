#!/usr/bin/env bash
#
# MongoPilot installer
#
#   One-liner:
#     curl -fsSL https://raw.githubusercontent.com/sunilksamanta/mongopilot/main/install.sh | sudo bash
#
#   From a clone:
#     sudo ./install.sh
#
#   Non-interactive:
#     curl -fsSL https://raw.githubusercontent.com/sunilksamanta/mongopilot/main/install.sh \
#       | sudo MONGOPILOT_ADMIN_USER=admin MONGOPILOT_ADMIN_PASS='S3cureP@ss' MONGOPILOT_PORT=8455 bash
#
set -euo pipefail

REPO="sunilksamanta/mongopilot"
BRANCH="${MONGOPILOT_BRANCH:-main}"
APP_DIR="/opt/mongopilot"
ETC_DIR="/etc/mongopilot"
DATA_DIR="/var/lib/mongopilot"
NODE_MAJOR=20
DEFAULT_PORT=8455
STEPS=7

# ---------- terminal helpers ----------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[38;5;42m'; CYAN=$'\033[36m'
  YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; GREEN=""; CYAN=""; YELLOW=""; RED=""; RESET=""
fi

STEP_NO=0
step() { STEP_NO=$((STEP_NO + 1)); printf '\n%s[%d/%d]%s %s%s%s\n' "$CYAN" "$STEP_NO" "$STEPS" "$RESET" "$BOLD" "$*" "$RESET"; }
info() { printf '      %s\n' "$*"; }
ok()   { printf '      %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '      %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '\n%sERROR:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

banner() {
  printf '\n'
  printf '%s' "$GREEN"
  cat <<'EOF'
    __  __                         ____  _ _       _
   |  \/  | ___  _ __   __ _  ___ |  _ \(_) | ___ | |_
   | |\/| |/ _ \| '_ \ / _` |/ _ \| |_) | | |/ _ \| __|
   | |  | | (_) | | | | (_| | (_) |  __/| | | (_) | |_
   |_|  |_|\___/|_| |_|\__, |\___/|_|   |_|_|\___/ \__|
                       |___/
EOF
  printf '%s' "$RESET"
  printf '   %sself-hosted MongoDB installer & management panel%s\n' "$DIM" "$RESET"
  printf '   %shttps://github.com/%s%s\n' "$DIM" "$REPO" "$RESET"
}

# read from the terminal even when the script itself is piped into bash;
# opening /dev/tty is the only reliable test (the node can exist yet be unusable)
HAS_TTY=0
if { exec 3< /dev/tty; } 2>/dev/null; then HAS_TTY=1; exec 3<&-; fi

ask() { # ask <prompt> <default> -> REPLY
  local prompt="$1" default="$2"
  if [ "$HAS_TTY" -eq 1 ]; then
    read -rp "  ${prompt} [${default}]: " REPLY < /dev/tty || REPLY=""
    REPLY="${REPLY:-$default}"
  else
    REPLY="$default"
  fi
}

banner

[ "$(id -u)" -eq 0 ] || die "Run as root: curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/install.sh | sudo bash"
[ -f /etc/os-release ] || die "Unsupported OS (no /etc/os-release)"

# ---------- 1. operating system ----------
step "Detecting operating system"
. /etc/os-release
case "${ID}" in
  ubuntu|debian) FAMILY=debian ;;
  centos|rhel|rocky|almalinux|amzn|fedora) FAMILY=rhel ;;
  *)
    case "${ID_LIKE:-}" in
      *debian*) FAMILY=debian ;;
      *rhel*|*fedora*|*centos*) FAMILY=rhel ;;
      *) die "Unsupported distro: ${ID}" ;;
    esac
    ;;
esac
ok "${PRETTY_NAME} (${FAMILY} family, $(uname -m))"

# ---------- 2. configuration ----------
step "Configuration"
ADMIN_USER="${MONGOPILOT_ADMIN_USER:-}"
ADMIN_PASS="${MONGOPILOT_ADMIN_PASS:-}"
PORT="${MONGOPILOT_PORT:-}"
GENERATED_PASS=0

if [ -z "$ADMIN_USER" ]; then
  ask "Web UI admin username" "admin"
  ADMIN_USER="$REPLY"
fi
if [ -z "$ADMIN_PASS" ]; then
  if [ "$HAS_TTY" -eq 1 ]; then
    while true; do
      read -rsp "  Web UI admin password (min 8 chars): " ADMIN_PASS < /dev/tty; echo
      [ ${#ADMIN_PASS} -ge 8 ] && break
      echo "  Password too short, try again."
    done
  else
    ADMIN_PASS="$(od -An -tx1 -N9 /dev/urandom | tr -d ' \n')"
    GENERATED_PASS=1
    warn "No terminal available — generated a random admin password (shown at the end)"
  fi
fi
if [ -z "$PORT" ]; then
  ask "Web UI port" "$DEFAULT_PORT"
  PORT="$REPLY"
fi
ok "Panel: user '${ADMIN_USER}', port ${PORT}"

# ---------- 3. base packages & source ----------
step "Installing base packages"
if [ "$FAMILY" = debian ]; then
  apt-get update -y -qq
  apt-get install -y -qq curl ca-certificates gnupg tar >/dev/null
else
  (dnf install -y -q curl ca-certificates tar 2>/dev/null || yum install -y -q curl ca-certificates tar) >/dev/null
fi
ok "curl, ca-certificates, tar"

# figure out where the source is: next to this script, or fetched from GitHub
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ] && [ -f "$SCRIPT_DIR/server/index.js" ]; then
  SRC_DIR="$SCRIPT_DIR"
  ok "Using local source: ${SRC_DIR}"
else
  info "Downloading MongoPilot (${BRANCH}) from GitHub..."
  TMP_DIR="$(mktemp -d /tmp/mongopilot.XXXXXX)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}" \
    | tar -xz -C "$TMP_DIR" || die "Failed to download https://github.com/${REPO} (branch ${BRANCH})"
  SRC_DIR="$(find "$TMP_DIR" -maxdepth 1 -mindepth 1 -type d | head -n1)"
  [ -f "$SRC_DIR/package.json" ] || die "Downloaded archive looks wrong (no package.json)"
  ok "Fetched source to ${SRC_DIR}"
fi

# ---------- 4. Node.js ----------
step "Installing Node.js"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  CUR_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
  [ "$CUR_MAJOR" -ge 18 ] && NEED_NODE=0
fi
if [ "$NEED_NODE" -eq 1 ]; then
  info "Adding NodeSource repository for Node.js ${NODE_MAJOR}.x..."
  if [ "$FAMILY" = debian ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  else
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    (dnf install -y -q nodejs 2>/dev/null || yum install -y -q nodejs) >/dev/null
  fi
fi
ok "Node.js $(node -v)"

# ---------- 5. application ----------
step "Installing application to ${APP_DIR}"
if ! id -u mongopilot >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin mongopilot 2>/dev/null \
    || useradd -r -d "$DATA_DIR" -s /sbin/nologin mongopilot
  ok "Created service user 'mongopilot'"
fi
mkdir -p "$APP_DIR" "$ETC_DIR" "$DATA_DIR/instances" "$DATA_DIR/backups" "$APP_DIR/mongodb"
cp -r "$SRC_DIR/server" "$SRC_DIR/public" "$SRC_DIR/package.json" "$APP_DIR/"
[ -f "$SRC_DIR/package-lock.json" ] && cp "$SRC_DIR/package-lock.json" "$APP_DIR/"
chown -R mongopilot:mongopilot "$DATA_DIR"
info "Installing Node dependencies (this can take a minute)..."
(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error)
ok "Application files and dependencies in place"

# ---------- 6. configuration file ----------
step "Writing configuration"
if [ ! -f "$ETC_DIR/config.json" ]; then
  HASH=$(node -e "console.log(require('$APP_DIR/node_modules/bcryptjs').hashSync(process.argv[1],10))" "$ADMIN_PASS")
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  cat > "$ETC_DIR/config.json" <<EOF
{
  "host": "0.0.0.0",
  "port": ${PORT},
  "adminUser": "${ADMIN_USER}",
  "adminPassHash": "${HASH}",
  "jwtSecret": "${SECRET}",
  "dataDir": "${DATA_DIR}",
  "binDir": "${APP_DIR}/mongodb"
}
EOF
  chmod 600 "$ETC_DIR/config.json"
  ok "${ETC_DIR}/config.json (mode 600)"
else
  warn "Keeping existing ${ETC_DIR}/config.json (delete it and re-run to reset credentials)"
  PORT="$(node -e "console.log(require('$ETC_DIR/config.json').port)" 2>/dev/null || echo "$PORT")"
fi

# ---------- 7. service & firewall ----------
step "Registering systemd service"
cat > /etc/systemd/system/mongopilot.service <<EOF
[Unit]
Description=MongoPilot - MongoDB installer & management UI
After=network.target

[Service]
Type=simple
ExecStart=$(command -v node) ${APP_DIR}/server/index.js
Restart=on-failure
RestartSec=3
User=root
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now mongopilot
ok "mongopilot.service enabled and started"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${PORT}/tcp" >/dev/null || true
  ok "Opened ${PORT}/tcp in ufw"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null && firewall-cmd --reload >/dev/null || true
  ok "Opened ${PORT}/tcp in firewalld"
fi

# ---------- summary ----------
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
line() { printf '  %s│%s %-52s %s│%s\n' "$DIM" "$RESET" "$1" "$DIM" "$RESET"; }
printf '\n  %s┌──────────────────────────────────────────────────────┐%s\n' "$DIM" "$RESET"
line ""
line "MongoPilot is up and running"
line ""
line "URL       http://${IP:-<server-ip>}:${PORT}"
line "Username  ${ADMIN_USER}"
if [ "$GENERATED_PASS" -eq 1 ]; then
  line "Password  ${ADMIN_PASS}"
fi
line "Service   systemctl status mongopilot"
line ""
printf '  %s└──────────────────────────────────────────────────────┘%s\n\n' "$DIM" "$RESET"
if [ "$GENERATED_PASS" -eq 1 ]; then
  printf '  %s!%s Save the generated password now — it is not stored in plain text anywhere.\n\n' "$YELLOW" "$RESET"
fi
