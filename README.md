# 🍃 MongoPilot

Self-hosted **MongoDB installer & management panel** for Linux servers (Ubuntu, Debian, CentOS/RHEL/Rocky/Alma, Amazon Linux). One shell script installs a web UI from which you can install MongoDB Community versions, run **multiple native instances** side by side (no Docker), manage auth/users/databases, control firewall access, monitor everything, and back up to AWS S3.

## Features

- **One-command install** — `sudo ./install.sh` prompts for panel credentials + port, installs Node.js, and registers a systemd service.
- **MongoDB version catalog** — lists Community releases (5.0 → 8.x) that have builds for your exact distro/arch, installed from official MongoDB tarballs.
- **Multiple versions & instances natively** — versions live in `/opt/mongopilot/mongodb/<version>/`; each instance gets its own data dir, `mongod.conf`, port and systemd unit (`mongopilot-<name>.service`). Run 6.0 and 8.0 side by side.
- **Security** — one-click enable auth (creates root user via localhost exception, flips `security.authorization`, restarts), user CRUD with roles, database create/drop.
- **Network access** — per-instance `bindIp` management + IP allowlisting through `ufw` or `firewalld` (port + source CIDR).
- **Monitoring** — CPU/memory/disk for the server; connections, ops/sec, resident memory per instance (15s sampling, 1h window, live charts).
- **Backups to S3** — `mongodump --archive --gzip` → multipart upload to your bucket, cron scheduling per instance, retention (keep last N), history.

## Install (on the server)

```bash
git clone <your-repo-url> mongopilot   # or scp the folder to the server
cd mongopilot
sudo ./install.sh
```

Non-interactive:

```bash
MONGOPILOT_ADMIN_USER=admin MONGOPILOT_ADMIN_PASS='S3cureP@ss' MONGOPILOT_PORT=8455 sudo -E ./install.sh
```

Then open `http://<server-ip>:8455`, log in, go to **Versions** → install a MongoDB version → **Instances** → create an instance → enable auth on its **Security** tab.

## Layout on the server

| Path | Purpose |
|---|---|
| `/opt/mongopilot/` | app + `mongodb/<version>/` binaries + `mongodb/tools/` (mongodump) |
| `/etc/mongopilot/config.json` | panel credentials (bcrypt), JWT secret, paths — mode 600 |
| `/var/lib/mongopilot/instances/<name>/` | per-instance data, `mongod.conf`, `mongod.log` |
| `/var/lib/mongopilot/state.json` | instance registry, S3 settings (secrets AES-256-GCM encrypted), backup history |
| `/etc/systemd/system/mongopilot.service` | the panel itself |
| `/etc/systemd/system/mongopilot-<name>.service` | one per MongoDB instance (runs as user `mongopilot`) |

## Local development (any OS)

```bash
npm install
npm run dev      # http://127.0.0.1:8455 — login admin / admin
```

Without `/etc/mongopilot/config.json` the app runs in **dev mode** (state under `./dev-data/`). Anything that needs systemd/firewall requires a real Linux server; the UI and API still work for development.

## Security notes

- The panel runs as **root** (it writes systemd units, installs binaries, edits firewall rules); the `mongod` instances themselves run as the unprivileged `mongopilot` user.
- The panel port is plain HTTP. For internet-facing servers put it behind a reverse proxy with TLS (Caddy/nginx + Let's Encrypt) or restrict the port to your IP in the firewall.
- New instances bind to `127.0.0.1` by default. Enable auth **before** widening `bindIp`.

## Roadmap ideas

- Replica set setup across instances/servers
- Restore-from-S3 flow (mongorestore)
- TLS for mongod instances, alerting (email/Slack), slow query views
