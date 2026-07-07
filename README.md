# ⏱️ Real-Time WebRTC Quiz Buzzer Engine (P2P Edition)

A high-performance, lightweight, and event-driven multiplayer quiz buzzer system designed for competitive trivia games. Built with vanilla JavaScript, HTML5, and CSS3, it leverages **WebRTC DataChannels over PeerJS** with **NTP-style Clocksync** to provide sub-millisecond, near-zero latency state synchronization across all connected clients without needing a dedicated backend server.

---

## ✨ Features

* **🔒 Authoritative Host Architecture:** The Host browser tab acts as the central authoritative peer. Players connect directly to the Host using a unique Room ID. Initial signaling uses PeerJS public brokers (`0.peerjs.com`), while subsequent gameplay data streams over direct WebRTC UDP data channels.
* **🌐 NAT & Firewall Traversal:** Built-in support for STUN and public TURN relay servers (`openrelay.metered.ca`) to ensure seamless P2P connectivity across cellular networks, corporate Wi-Fi, and symmetric NATs.
* **⏱️ NTP Clocksync & Sub-Millisecond Delta Tracking:** Continual network RTT and clock offset ($\theta$) calculations stamp player buzz events at the millisecond layer. Resolves true first-place buzzes and displays exact millisecond deltas for backup queued players.
* **🛡️ 3-Second Lockout Window & Player Isolation:** The first buzz locks the hotseat, starts the answering countdown, and opens a 3-second backup buzz window. Idle players who miss the window receive an explicit `"LOCKED OUT"` HUD banner, keeping player alerts isolated from the Host dashboard.
* **💥 Strategy Modifiers (Double Down):** Players can toggle Double Down before buzzing during active rounds to double both reward and penalty risks. Modifiers automatically lock after buzzing and auto-reset at the start of every round.
* **🔥 Streak Multipliers:** Automatic tracking of consecutive correct answers, rewarding dominant players with dynamic linear point multipliers (`x2`, `x3`, etc.).
* **💯 Negative Score Support:** Scores are allowed to drop below zero on incorrect answers or expired time limits, providing authentic penalty mechanics for competitive play.
* **⏱️ Host-Driven Timeout Decisions:** When the answering timer expires (`0.00s`), the engine halts countdown and awaits manual Host evaluation (`CORRECT` or `INCORRECT`).
* **🔊 Synthesized Audio:** Uses the native HTML5 `AudioContext` API to programmatically generate retro arcade sound effects for buzzer hits, countdown ticks, correct arpeggios, and incorrect sweeps.
* **📡 Heartbeat & 2-Minute Reconnection Grace:** 100ms heartbeat scanning detects disconnected peers. Offline players retain their profile, score, and streak for 2 minutes before automatic purging.

---

## 🛠️ Project Structure

The codebase is organized into modular files:

```
quiz-buzzer-webrtc/
├── quiz_buzzer.html   # Clean HTML5 markup, screen layouts (Role Entry, Host Dashboard, Player View)
├── quiz_buzzer.css    # Techno-Terminal / Cyberpunk HUD styling, glowing badges, animated banners
├── quiz_buzzer.js     # Complete P2P engine logic, WebAudio synthesizer, NTP clocksync, state machine
└── README.md          # Documentation and quick start manual
```

---

## 🚀 Quick Start (Local Development)

1. **Clone or navigate to the repository:**
   ```bash
   cd quiz-buzzer-webrtc
   ```

2. **Launch a local HTTP server:**
   *(Note: Browsers require a secure context such as `localhost` or `https://` to enable WebRTC APIs)*
   ```bash
   python3 -m http.server 8000
   ```

3. **Open the application:**
   * **Host:** Navigate to `http://localhost:8000`, click **LAUNCH AS HOST**, and copy the generated **ROOM ID**.
   * **Players:** Open `http://localhost:8000` in new tabs or separate devices, enter a Username and the Host's **ROOM ID**, and click **CONNECT PEER-TO-PEER**.

---

## ⚙️ Game Rules & Configuration

* **Timed / Untimed Rounds:** Host can toggle countdown timers on or off. Timer duration inputs automatically lock during active rounds.
* **Double Down Mode:** Can be globally enabled/disabled by the Host.
* **Streak Multipliers:** Can be toggled on/off to enable linear score scaling.
* **Scoreboard Reset:** Clears player scores and streaks while preserving player directory and connection states.
