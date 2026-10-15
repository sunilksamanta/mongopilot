# MongoPilot

**Self-hosted MongoDB installer & management panel for Linux servers.**

One command installs a web UI from which you can install MongoDB Community versions, run multiple native instances side by side (no Docker), manage authentication, users and databases, control firewall access, monitor everything live, and back up to AWS S3.

Works on Ubuntu, Debian, CentOS, RHEL, Rocky, AlmaLinux, Amazon Linux and Fedora.

---

## Install

Run this on your server — that's it:

```bash
curl -fsSL https://raw.githubusercontent.com/sunilksamanta/mongopilot/main/install.sh | sudo bash
```

The installer detects your distro, installs Node.js if needed, fetches MongoPilot, registers a systemd service, opens the panel port in your firewall and prints your login URL:

```
    __  __                         ____  _ _       _
   |  \/  | ___  _ __   __ _  ___ |  _ \(_) | ___ | |_
   | |\/| |/ _ \| '_ \ / _` |/ _ \| |_) | | |/ _ \| __|
   | |  | | (_) | | | | (_| | (_) |  __/| | | (_) | |_
   |_|  |_|\___/|_| |_|\__, |\___/|_|   |_|_|\___/ \__|
                       |___/
   self-hosted MongoDB installer & management panel

[1/7] Detecting operating system
      ✓ Ubuntu 24.04 LTS (debian family, x86_64)
[2/7] Configuration
      ✓ Panel: user 'admin', port 8455
...
  ┌──────────────────────────────────────────────────────┐
  │ MongoPilot is up and running                         │
  │ URL       http://203.0.113.10:8455                   │
  │ Username  admin                                      │
  │ Service   systemctl status mongopilot                │
  └──────────────────────────────────────────────────────┘
```

It prompts for the admin username, password and port. When no terminal is attached (CI, cloud-init), it falls back to sane defaults and generates a random password, printed once at the end.

**Non-interactive / scripted install:**

```bash
curl -fsSL https://raw.githubusercontent.com/sunilksamanta/mongopilot/main/install.sh \
  | sudo MONGOPILOT_ADMIN_USER=admin MONGOPILOT_ADMIN_PASS='S3cureP@ss' MONGOPILOT_PORT=8455 bash
```

**From a clone:**

```bash
git clone https://github.com/sunilksamanta/mongopilot.git
cd mongopilot
sudo ./install.sh
```

Then open `http://<server-ip>:8455`, log in, go to **Versions** → install a MongoDB version → **Instances** → create an instance → enable auth on its **Security** tab.

## Features

- **One-command install** — a single script sets up Node.js, the panel and a systemd service on any major Linux distro.
- **MongoDB version catalog** — lists Community releases (5.0 → 8.x) that have builds for your exact distro/arch, installed from official MongoDB tarballs.
- **Multiple versions & instances, natively** — versions live in `/opt/mongopilot/mongodb/<version>/`; each instance gets its own data dir, `mongod.conf`, port and systemd unit (`mongopilot-<name>.service`). Run 6.0 and 8.0 side by side.
- **Replica sets**: create a 3/5/7-member replica set in one click (keyfile auth, root user, initiate, election and initial sync all handled), convert an existing instance into a replica set without losing data, add/remove members, step down the primary, and see live member state, lag and sync source. Sets can span servers: prepare a member on another MongoPilot server with **Join a replica set**, then add it from the primary's server.
- **Security** — one-click enable auth (creates the root user via the localhost exception, flips `security.authorization`, restarts), user CRUD with roles, database create/drop.
- **Network access** — per-instance `bindIp` management plus IP allowlisting through `ufw` or `firewalld` (port + source CIDR).
- **Monitoring** — CPU/memory/disk for the server; connections, ops/sec and resident memory per instance (15 s sampling, 1 h window, live charts).
- **Backups to S3** — `mongodump --archive --gzip` → multipart upload to your bucket, cron scheduling per instance, retention (keep last N), full history.

## Replica sets

From **Replica Sets** in the panel:

| Goal | What to pick |
|---|---|
| Transactions / change streams for apps on this server | Create, 1 or 3 members, bind and advertised host `127.0.0.1` |
| High availability, apps on other machines | Create, 3 members, bind `0.0.0.0`, advertised host = this server's private IP or DNS name, auth on, open the ports on **Firewall** |
| Started local-only, now need outside access | Replica set page → **Network access**: bind `0.0.0.0`, advertised host = the server's IP. Members restart one at a time, no downtime |
| Keep an existing instance's data | Convert an existing instance, then **Add member** |
| Members on several servers | On server A: create the set (advertise a reachable address). On server B: **Join a replica set** with the same set name, A's keyfile (shown on the set's page) and the same admin credentials. Back on A: **Add member → On another server** with `B-address:port`. |

The *advertised host* is the address written into the replica set config; drivers and other members connect to it, so it must be reachable from them and belong to this server (cloud public/elastic IPs are usually NAT'ed: use the private IP or a DNS name). MongoPilot checks reachability before initiating and rolls back cleanly if anything fails.

## Layout on the server

| Path | Purpose |
|---|---|
| `/opt/mongopilot/` | app + `mongodb/<version>/` binaries + `mongodb/tools/` (mongodump) |
| `/etc/mongopilot/config.json` | panel credentials (bcrypt), JWT secret, paths — mode 600 |
| `/var/lib/mongopilot/instances/<name>/` | per-instance data, `mongod.conf`, `mongod.log`, `keyfile` (replica set members with auth) |
| `/var/lib/mongopilot/state.json` | instance and replica set registry, S3 settings (secrets AES-256-GCM encrypted), backup history |
| `/etc/systemd/system/mongopilot.service` | the panel itself |
| `/etc/systemd/system/mongopilot-<name>.service` | one per MongoDB instance (runs as user `mongopilot`) |

## Updating

Re-run the installer. It replaces the application files and keeps `/etc/mongopilot/config.json`, your instances and all data untouched:

```bash
curl -fsSL https://raw.githubusercontent.com/sunilksamanta/mongopilot/main/install.sh | sudo bash
```

## Uninstall

```bash
sudo systemctl disable --now mongopilot
sudo rm -f /etc/systemd/system/mongopilot.service
sudo rm -rf /opt/mongopilot /etc/mongopilot
# Your MongoDB instances and data live in /var/lib/mongopilot — remove only if you are sure:
# sudo rm -rf /var/lib/mongopilot && sudo userdel mongopilot
```

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

## Roadmap

- Arbiters and member priority/hidden/delayed settings
- Restore-from-S3 flow (mongorestore)
- TLS for mongod instances, alerting (email/Slack), slow query views

## License

MIT
