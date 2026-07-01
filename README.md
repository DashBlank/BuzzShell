# ⏱️ Real-Time MQTT Quiz Buzzer Engine

A high-performance, lightweight, and event-driven multiplayer quiz buzzer system designed for competitive trivia games. Built entirely with vanilla JavaScript, it leverages **MQTT over WebSockets** to provide near-zero latency state synchronization across all connected clients without needing a dedicated backend server.

---

## ✨ Features

* **🔒 Anti-Race-Condition Engine:** Hardened synchronization matrix. When a round starts, the engine snapshots the active player pool to instantly freeze out mid-round late joiners—even if they attempt to buzz within the initial lockout window.
* **⚡ Sub-Millisecond Delta Tracking:** The board registers timestamps at the millisecond layer, showing exactly how many fractions of a second later a player buzzed compared to the top "Hotseat" player.
* **🔥 Streak Multipliers:** Automatic tracking of correct and incorrect streaks, rewarding dominant players with dynamic point multipliers and penalizing cold streaks.
* **💥 Strategy Modifiers (Double Down):** Built-in support for high-stakes point modifiers, scaling both the reward and penalty risks dynamically based on the current streak.
* **⏱️ Host Hotseat Architecture:** Unified control panel for the Quizmaster to validate answers, spin up new countdown timers, track player disconnect cleanups, and manage game states on the fly.
* **🔊 Synthesized Audio:** Uses the native web `AudioContext` API to programmatically generate arcade-style retro sound effects for clicks, ticks, successes, and errors without bloating your codebase with external audio files.

---

## ⚙️ Global Game Configuration

The app uses standard primitives at the top of the file for quick structural modification:

```javascript
const ROOM_ID = "my_secret_lobby_12345"; 
const SECRET_HOST_PASSWORD = "quizmaster123"; 
const LOCKOUT_WINDOW_MS = 3000;     // Lockout window after the first buzz
const DEFAULT_COUNTDOWN_LIMIT_SEC = 10;`
```

---

## 🚀 Quick Start Guide

### 1. Requirements
The game runs directly in any modern browser. You only need to include the standard MQTT library via a CDN script tag in your companion HTML file. Add this script tag to your HTML:

<script src="https://unpkg.com/mqtt/dist/mqtt.min.js"></script>

### 2. Deployment
1. Copy the JavaScript code into your script pipeline (app.js).
2. Bind your UI text input fields and buttons to match the standard element IDs expected by the engine (#username, #host-password, #timer-display, #buzzer-btn, etc.).
3. Open the application across multiple browser windows or devices.
4. Log in with the matching SECRET_HOST_PASSWORD on one device to gain administrative control over the board as the Quizmaster.

---

## 📡 Topic Architecture

The system operates over a lightweight broadcast canvas using a public sandbox MQTT broker:

* **Action Channel:** buzzer/[ROOM_ID]/action — For client dispatches (join, buzz, ping, clear, reset-scores, start-new-timer).
* **Status Channel:** buzzer/[ROOM_ID]/status — For host authoritative state broadcast frames containing player queues, streaks, and scoring payloads.

---
