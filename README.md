# 🚀 Hermes Cockpit

<div align="center">

**A retro-tech, mobile-first PWA cockpit and client for [Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent).**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Web / PWA / Android](https://img.shields.io/badge/Platform-Web%20%7C%20PWA%20%7C%20Android-0052ff.svg)](#installation)
[![Runtime: Node.js 22+](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![Docker: Ready](https://img.shields.io/badge/Docker-Ready-2496ed.svg)](#-quick-start-with-docker)

</div>

---

## ⚡ What is Hermes Cockpit?

**Hermes Cockpit** is an open-source, mobile-first personal control center designed specifically for running and conversing with **Hermes Agent** from your smartphone or tablet. 

While the official Hermes Agent provides powerful CLI and desktop dashboard interfaces, **Hermes Cockpit** brings a dedicated, responsive, and standalone Progressive Web App (PWA) experience to your pocket — featuring real-time WebSocket token streaming, interactive reasoning accordions, profile isolation, and multi-turn message management.

```text
 ┌────────────────────────────────────────────────────────┐
 │                   HERMES COCKPIT                       │
 │  ● ONLINE       👤 hermes-cockpit ⌄      ✨ MODEL ⌄    │
 ├────────────────────────────────────────────────────────┤
 │ [User] Debug the WebSocket reconnect logic            │
 │                                                        │
 │ [Hermes Agent]                                         │
 │  ┌──────────────────────────────────────────────────┐  │
 │  │ 🧠 Thought process · 4 steps                   ⌄ │  │
 │  └──────────────────────────────────────────────────┘  │
 │  Analyzing the backoff loop and session state...       │
 │                                                        │
 ├────────────────────────────────────────────────────────┤
 │ [ / commands ]  [ 📎 ] [ Type a message... ]    [ ➤ ]  │
 └────────────────────────────────────────────────────────┘
```

---

## ✨ Features

- **📱 True Mobile-First PWA & WebAPK**: Install directly to your home screen on Android and iOS. Operates in standalone full-screen window mode without browser address bars.
- **⚡ Real-Time WebSocket Streaming**: Instant token-by-token streaming with optimistic reconnects and seamless tab-switching backoff.
- **🧠 Collapsible Thought Process Accordion**: Live streaming reasoning that folds cleanly into permanent `🧠 Thought process · X steps ⌄` cards stored in session history.
- **🔒 Dedicated Profile Isolation**: Works out-of-the-box with dedicated Hermes profiles (e.g. `hermes-cockpit`), keeping your mobile chat database completely isolated from cron jobs, CLI terminal sessions, and Telegram/WhatsApp bots.
- **🪟 Turn-Based Windowing & Strict ID Ordering**: Guarantees prompts and assistant responses are chronologically ordered by database row IDs, preventing tool logs from consuming chat history.
- **🎨 Retro-Tech / Cyberpunk Aesthetic**: Engineered with official Nous Research typography (*Rules Expanded*, *Collapse*, *Mondwest*), obsidian dark glow palette, and responsive viewport zoom scaling.
- **📊 Built-in Zero-Dependency Proxy**: High-performance reverse proxy (`server.mjs`) featuring on-the-fly Brotli/Gzip compression, automatic profile scoping, and optional multi-provider quota telemetry.
- **🔊 Audio Cues & Announces**: Cyberpunk audio feedback on completion, attention requests, and background task handoffs.
- **📎 Multi-Modal Attachments**: Fast file uploads and media inspection directly from mobile devices.

---

## 🏗️ Architecture

```text
 [ Smartphone / Tablet / Desktop ]  (PWA / Browser)
                 │
                 ▼  (HTTPS via Tailscale / Local Network / Reverse Proxy)
 ┌──────────────────────────────────────────────────────────────┐
 │  HERMES COCKPIT SERVER (Port 8088)                           │
 │  • node server.mjs (Zero external production dependencies)   │
 │  • Serves Pre-compressed PWA Static Assets (Brotli / Gzip)   │
 │  • Proxies REST API & upgrades WebSocket (/api/ws)           │
 │  • Auto-injects target profile (?profile=hermes-cockpit)     │
 └───────────────┬──────────────────────────────────────────────┘
                 │ (Internal HTTP & WS)
                 ▼
 ┌──────────────────────────────────────────────────────────────┐
 │  HERMES AGENT BACKEND (Port 9119)                            │
 │  • hermes dashboard --host 127.0.0.1 --port 9119             │
 │  • Isolated Profile Database (~/.hermes/profiles/.../state.db)│
 │  • Multi-turn execution, skills, memory, and tools           │
 └──────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start with Docker

The fastest way to deploy Hermes Cockpit alongside your Hermes Agent:

```bash
# 1. Clone the repository
git clone https://github.com/Marcel-mux/hermes-cockpit.git
cd hermes-cockpit

# 2. Launch with Docker Compose
docker compose up -d
```

Access Cockpit in your browser at `http://<your-server-ip>:8088`.

---

## 🛠️ Manual Installation (Node.js)

### Prerequisites

- **Node.js** >= 22.0.0 (uses native `node:sqlite`)
- An active **Hermes Agent** installation running the gateway dashboard.

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/Marcel-mux/hermes-cockpit.git
cd hermes-cockpit

# 2. Install dependencies & build static assets
npm install
npm run build:web

# 3. Start Cockpit
npm start
```

### Running as a systemd Service (Linux)

Create `/etc/systemd/system/hermes-cockpit.service`:

```ini
[Unit]
Description=Hermes Cockpit Web Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/hermes-cockpit
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=3
Environment=PORT=8088
Environment=HERMES_HOST=127.0.0.1
Environment=HERMES_PORT=9119
Environment=HERMES_PROFILE=hermes-cockpit

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-cockpit.service
```

---

## ⚙️ Configuration & Environment Variables

Copy `.env.example` to `.env` or pass variables via Docker / systemd:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8088` | Port for the Cockpit web server |
| `HOST` | `0.0.0.0` | Bind host address |
| `HERMES_HOST` | `127.0.0.1` | Host where Hermes Agent dashboard is running |
| `HERMES_PORT` | `9119` | Port where Hermes Agent dashboard is listening |
| `HERMES_PROFILE` | `hermes-cockpit` | Default profile name used for mobile chat isolation |
| `HERMES_HOME` | `~/.hermes` | Path to Hermes home directory (for SQLite state inspection) |
| `NINEROUTER_HOME` | `~/.9router` | *(Optional)* Path to 9Router directory for live quota metrics |

---

## 🔒 Recommended: Secure Access via Tailscale

To access Hermes Cockpit securely from your phone anywhere in the world without exposing public ports:

1. Install and join [Tailscale](https://tailscale.com/) on your host machine and mobile device.
2. Enable HTTPS via Tailscale Serve:
   ```bash
   sudo tailscale serve --bg 8088
   ```
3. Open `https://<your-node-name>.<your-tailnet>.ts.net` in your mobile browser.
4. Tap **"Add to Home Screen"** or **"Install App"** to install the native full-screen PWA!

---

## 💡 Setting Up an Isolated Profile in Hermes

To ensure your mobile chat history stays separate from your terminal or messaging bot channels:

```bash
# Create a dedicated mobile profile cloned from your default config
hermes profile create hermes-cockpit --clone --description "Dedicated Mobile Cockpit"
```

Hermes Cockpit will automatically direct all mobile sessions to this profile.

---

## 🤝 Contributing

Contributions, bug reports, and pull requests are welcome!

```bash
# Run type check
npm run typecheck

# Rebuild web bundle
npm run build:web
```

---

## 📄 License

Licensed under the [MIT License](LICENSE).

---

<div align="center">
<sub>Crafted with passion for the Hermes Agent ecosystem.</sub>
</div>
