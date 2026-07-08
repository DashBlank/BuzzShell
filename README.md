# ⏱️ Real-Time WebRTC Quiz Buzzer Engine (P2P Edition)

A high-performance, lightweight, and event-driven multiplayer quiz buzzer system designed for competitive trivia games. Built with vanilla JavaScript, HTML5, and CSS3, it leverages **WebRTC DataChannels over PeerJS** with **NTP-style Clocksync** to provide sub-millisecond, near-zero latency state synchronization across all connected clients without needing a dedicated backend server.

---

## ✨ Features

* **🔒 Authoritative Host Architecture:** The Host browser tab acts as the central authoritative peer. Players connect directly to the Host using a unique Room ID. Initial signaling uses PeerJS public brokers (`0.peerjs.com`), while subsequent gameplay data streams over direct WebRTC UDP data channels.
* **🌐 NAT & Firewall Traversal:** Built-in support for STUN and public TURN relay servers (`openrelay.metered.ca`) to ensure seamless P2P connectivity across cellular networks, corporate Wi-Fi, and symmetric NATs.
* **⏱️ NTP Clocksync & Sub-Millisecond Delta Tracking:** Continual network RTT and clock offset ($\theta$) calculations stamp player buzz events at the millisecond layer. Resolves true first-place buzzes and displays exact millisecond deltas for backup queued players.
* **🔑 Host Disconnect Recovery & Secret Reclaim Key:** Every room generates a unique **Host Reclaim Key** (`SEC-XXXXXX`). If the Host tab crashes, reloads, or loses Wi-Fi, the Host can reclaim control from the same tab or any device. Players automatically lock buzzers, show `"HOST DISCONNECTED (RECONNECTING...)"`, and silently re-establish P2P channels when the Host returns—without annoying alert popups or broken states across repeat disconnects!
* **⚙️ Configurable Reward & Penalty Rules:** Host can dynamically configure base points for correct answers (`CORRECT (+PTS)`) and penalty deductions for wrong answers (`INCORRECT (-PTS)`). Inputs automatically lock during active rounds and auto-save for host recovery.
* **🙈 Hide Scores / Suspense Mode:** Host can toggle score visibility (`HIDE SCORES (SUSPENSE)`) on or off. When enabled, player scores on the Player HUD and Lobby Directory are masked with glowing amber **`???`** for extra tension, while the Host retains full authoritative visibility on the Quizmaster Dashboard.
* **🥾 Player Kick & Persistent Device Ban:** The Host can kick unwanted players directly from the scoreboard. Bans are enforced using persistent device identifiers (`localStorage`) and username registries, preventing kicked players from rejoining even if they reload or open new tabs on the same device.
* **🔑 Optional Dynamic Room Password:** Host can set, change, or clear a Room Password on the fly. Players joining must provide the matching password via an interactive modal if enabled.
* **✏️ Host Score & Streak Editing:** Host can manually adjust any player's score (positive/negative) and streak count via an inline modal to easily correct host evaluation mistakes without resetting the game. (Streak editing automatically locks when Streak Multipliers are disabled).
* **🛡️ 3-Second Lockout Window & Player Isolation:** The first buzz locks the hotseat, starts the answering countdown, and opens a 3-second backup buzz window. Idle players who miss the window receive an explicit `"LOCKED OUT"` HUD banner, keeping player alerts isolated from the Host dashboard.
* **💥 Strategy Modifiers (Double Down):** Players can toggle Double Down before buzzing during **STANDBY** (`roundStatus === 'idle'`) to double both reward and penalty risks for the upcoming question. Modifiers automatically lock once buzzers are armed and auto-reset at round conclusion.
* **🔥 / ❄️ Streak Multipliers & Cold Streaks:** Automatic tracking of consecutive correct answers with dynamic linear point multipliers (`x2`, `x3`, etc., marked by `🔥`). Cold/losing streaks ($\le -1$, marked by `❄️`) accumulate on consecutive wrong answers and scale penalty magnitude when Streak Multipliers are enabled.
* **💯 Negative Score Support:** Scores are allowed to drop below zero on incorrect answers or expired time limits, providing authentic penalty mechanics for competitive play.
* **⏱️ Host-Driven Timeout Decisions:** When the answering timer expires (`0.00s`), the engine halts countdown and awaits manual Host evaluation (`CORRECT` or `INCORRECT`).
* **🔊 Synthesized Audio:** Uses the native HTML5 `AudioContext` API to programmatically generate retro arcade sound effects for buzzer hits, countdown ticks, correct arpeggios, and incorrect sweeps.
* **📡 Heartbeat & 2-Minute Reconnection Grace:** 100ms heartbeat scanning detects disconnected peers. Offline players retain their profile, score, and streak for 2 minutes before automatic purging.

---

## 🛠️ Project Structure

The codebase is organized into modular files:

```
quiz-buzzer-webrtc/
├── index.html   # Clean HTML5 markup, screen layouts (Role Entry, Host Dashboard, Player View, Edit Modal, Password Modal)
├── style.css    # Techno-Terminal / Cyberpunk HUD styling, glowing badges, animated banners, modal overlays
├── app.js       # Complete P2P engine logic, WebAudio synthesizer, NTP clocksync, state machine, host reclaim registry
└── README.md    # Documentation and quick start manual
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
   * **Host:** Navigate to `http://localhost:8000`, click **LAUNCH AS HOST (NEW ROOM)** or enter Room ID + Reclaim Key and click **RECLAIM CONTROL ROOM**.
   * **Players:** Open `http://localhost:8000` in new tabs or separate devices, enter a Username and the Host's **ROOM ID**, and click **CONNECT PEER-TO-PEER**.

---

## ⚙️ Game Rules & Configuration

* **Timed / Untimed Rounds:** Host can toggle countdown timers on or off. Timer duration inputs automatically lock during active rounds.
* **Correct & Incorrect Points:** Host can set custom base reward (e.g. `+10`, `+20`) and penalty (e.g. `-5`, `0`) points.
* **Hide Scores (Suspense):** Host can mask player scores with `???` on all player screens for dramatic reveals.
* **Room Password:** Optional host-configured password to restrict lobby entry.
* **Double Down Mode:** Can be globally enabled/disabled by the Host. Players opt in during Standby.
* **Streak Multipliers & Cold Streaks:** Can be toggled on/off to enable linear score scaling for winning streaks and penalty scaling for cold streaks.
* **Score & Streak Editing:** Click ✏️ next to any player in the Host Scoreboard to edit points or streak.
* **Kick & Ban:** Click ❌ next to any player in the Host Scoreboard to kick and ban them from the session.
* **Host Reclaim:** Re-enter Room ID + Reclaim Key from any device/browser to resume host control without losing room scores.
