#!/usr/bin/env bash
#
# MongoPilot installer
# Usage: sudo ./install.sh
# Non-interactive: MONGOPILOT_ADMIN_USER=x MONGOPILOT_ADMIN_PASS=y MONGOPILOT_PORT=8455 sudo -E ./install.sh
#
set -euo pipefail

APP_DIR="/opt/mongopilot"
ETC_DIR="/etc/mongopilot"
DATA_DIR="/var/lib/mongopilot"
NODE_MAJOR=20
DEFAULT_PORT=8455

log() { echo -e "\033[1;36m[mongopilot]\033[0m $*"; }
die() { echo -e "\033[1;31m[mongopilot] ERROR:\033[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo ./install.sh"
[ -f /etc/os-release ] || die "Unsupported OS (no /etc/os-release)"

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
log "Detected ${PRETTY_NAME} (${FAMILY} family)"

# ---------- credentials & port ----------
ADMIN_USER="${MONGOPILOT_ADMIN_USER:-}"
ADMIN_PASS="${MONGOPILOT_ADMIN_PASS:-}"
PORT="${MONGOPILOT_PORT:-}"

if [ -z "$ADMIN_USER" ]; then
  read -rp "Web UI admin username [admin]: " ADMIN_USER
  ADMIN_USER=${ADMIN_USER:-admin}
fi
if [ -z "$ADMIN_PASS" ]; then
  while true; do
    read -rsp "Web UI admin password (min 8 chars): " ADMIN_PASS; echo
    [ ${#ADMIN_PASS} -ge 8 ] && break
    echo "Password too short, try again."
  done
fi
if [ -z "$PORT" ]; then
  read -rp "Web UI port [${DEFAULT_PORT}]: " PORT
  PORT=${PORT:-$DEFAULT_PORT}
fi

# ---------- base packages ----------
log "Installing base packages..."
if [ "$FAMILY" = debian ]; then
  apt-get update -y -qq
  apt-get install -y -qq curl ca-certificates gnupg tar >/dev/null
else
  (dnf install -y -q curl ca-certificates tar 2>/dev/null || yum install -y -q curl ca-certificates tar) >/dev/null
fi

# ---------- Node.js ----------
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  CUR_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
  [ "$CUR_MAJOR" -ge 18 ] && NEED_NODE=0
fi
if [ "$NEED_NODE" -eq 1 ]; then
  log "Installing Node.js ${NODE_MAJOR}.x ..."
  if [ "$FAMILY" = debian ]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  else
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
    (dnf install -y -q nodejs 2>/dev/null || yum install -y -q nodejs) >/dev/null
  fi
fi
log "Node.js $(node -v)"

# ---------- service user for mongod processes ----------
if ! id -u mongopilot >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin mongopilot 2>/dev/null \
    || useradd -r -d "$DATA_DIR" -s /sbin/nologin mongopilot
fi

# ---------- app files ----------
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$SRC_DIR/package.json" ] || die "Run this script from the mongopilot source directory"

log "Installing application to ${APP_DIR} ..."
mkdir -p "$APP_DIR" "$ETC_DIR" "$DATA_DIR/instances" "$DATA_DIR/backups" "$APP_DIR/mongodb"
cp -r "$SRC_DIR/server" "$SRC_DIR/public" "$SRC_DIR/package.json" "$APP_DIR/"
[ -f "$SRC_DIR/package-lock.json" ] && cp "$SRC_DIR/package-lock.json" "$APP_DIR/"
chown -R mongopilot:mongopilot "$DATA_DIR"

log "Installing Node dependencies (this can take a minute) ..."
(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error)

# ---------- config ----------
if [ ! -f "$ETC_DIR/config.json" ]; then
  log "Writing ${ETC_DIR}/config.json"
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
else
  log "Keeping existing ${ETC_DIR}/config.json (delete it and re-run to reset credentials)"
fi

# ---------- systemd service ----------
log "Creating systemd service mongopilot.service"
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

# ---------- open the UI port ----------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${PORT}/tcp" >/dev/null || true
  log "Opened ${PORT}/tcp in ufw"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null && firewall-cmd --reload >/dev/null || true
  log "Opened ${PORT}/tcp in firewalld"
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
log "Done!"
log "Open  http://${IP:-<server-ip>}:${PORT}  and log in as '${ADMIN_USER}'."
log "Service control: systemctl {status|restart} mongopilot"
