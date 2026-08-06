# ⏱️ BuzzShell: Real-Time WebRTC Quiz Buzzer Engine (P2P Edition)

A high-performance, lightweight, and event-driven multiplayer quiz buzzer system designed for competitive trivia games. Built with vanilla JavaScript, HTML5, and CSS3, it leverages **WebRTC DataChannels over PeerJS** with **NTP-style Clocksync** to provide sub-millisecond, near-zero latency state synchronization across all connected clients without needing a dedicated backend server.

---

## ✨ Features

* **🔒 Authoritative Host Architecture:** The Host browser tab acts as the central authoritative peer. Players connect directly to the Host using a unique Room ID. Initial signaling uses PeerJS public brokers (`0.peerjs.com`), while subsequent gameplay data streams over direct WebRTC UDP data channels.
* **🌐 NAT, Firewall & Custom Broker Support:** Built-in support for STUN and public TURN relay servers (`openrelay.metered.ca`) to ensure seamless P2P connectivity across cellular networks and symmetric NATs. Features an **Advanced Signaling Broker Settings** drawer to customize connection hosts, ports, paths, and secure WSS flags for corporate proxy traversal or offline local servers.
* **🎛️ Interactive Tabbed Lobby:** Re-architected the entry screens into a responsive, 4-tab card (Host, Reclaim, Play, Spectate) utilizing a smooth 0.35s vertical slide-and-fade animation to eliminate desktop layout scrollbars.
* **⏱️ NTP Clocksync & Sub-Millisecond Delta Tracking:** Continual network RTT and clock offset ($\theta$) calculations stamp player buzz events at the millisecond layer. Resolves true first-place buzzes and displays exact millisecond deltas for backup queued players on both Host and Player dashboards.
* **👥 Shared Real-Time Buzz Queue:** Players can view the active buzz order and sub-millisecond deltas relative to the hotseat in real-time on their screens, matching the Quizmaster's queue view for increased transparency and suspense.
* **🔑 Host Disconnect Recovery & Secret Reclaim Key:** Every room generates a unique **Host Reclaim Key** (6-character alphanumeric code, e.g. `J8X9W2`). If the Host tab crashes, reloads, or loses Wi-Fi, the Host can reclaim control from the same tab or any device. Players automatically lock buzzers, show `"HOST DISCONNECTED (RECONNECTING...)"`, and silently re-establish P2P channels when the Host returns—without annoying alert popups or broken states across repeat disconnects!
* **⚙️ Configurable Reward & Penalty Rules:** Host can dynamically configure base points for correct answers (`CORRECT (+PTS)`) and penalty deductions for wrong answers (`INCORRECT (-PTS)`). Inputs automatically lock during active rounds and auto-save for host recovery.
* **🙈 Hide Scores / Suspense Mode:** Host can toggle score visibility (`HIDE SCORES (SUSPENSE)`) on or off. When enabled, player scores on the Player HUD and Lobby Directory are masked with glowing amber **`???`** for extra tension, while the Host retains full authoritative visibility on the Quizmaster Dashboard.
* **🏆 Session Statistics & Awards (Post-Game):** Host can trigger a detailed "Session Stats" overlay. Automatically calculates funny/insightful achievements (Speed Demon, Streak Lord, Ice Sculptor, High Roller, Edge Lord, Silent Assassin) and displays final leaderboard stats (accuracy, average speed, Double Down usage) across all clients.
* **🎨 Terminal Theme Customization (Cosmetic):** Players can choose their preferred terminal accent color (Classic Green, Amber Alert, Cyber Crimson, Cobalt Blue, Neon Magenta) upon joining. The selection dynamically restyles their entire local HUD (panels, buttons, and switches) and glows their name on the Host Dashboard and other players' screens for a personalized P2P terminal feel.
* **🥾 Player Kick & Persistent Device Ban:** The Host can kick unwanted players directly from the scoreboard. Bans are enforced using persistent device identifiers (`localStorage`) and username registries, preventing kicked players from rejoining even if they reload or open new tabs on the same device.
* **🔑 Optional Dynamic Room Password:** Host can set, change, or clear a Room Password on the fly. Players joining must provide the matching password via an interactive modal if enabled.
* **✏️ Host Score & Streak Editing:** Host can manually adjust any player's score (positive/negative) and streak count via an inline modal to easily correct host evaluation mistakes without resetting the game. (Streak editing automatically locks when Streak Multipliers are disabled).
* **🛡️ 3-Second Lockout Window & Player Isolation:** The first buzz locks the hotseat, starts the answering countdown, and opens a 3-second backup buzz window. Idle players who miss the window receive an explicit `"LOCKED OUT"` HUD banner, keeping player alerts isolated from the Host dashboard.
* **💥 Strategy Modifiers (Double Down):** Players can toggle Double Down before buzzing during **STANDBY** (`roundStatus === 'idle'`) to double both reward and penalty risks for the upcoming question. Modifiers automatically lock once buzzers are armed and auto-reset at round conclusion.
* **🛡️ Defensive Modifiers (Shield Mode):** Players can toggle Shield Mode during **STANDBY**. When active, a correct answer yields only 50% points, but an incorrect answer results in **0 points penalty**. However, getting an answer wrong with a shield causes the shield to burn out (2-round cooldown lock) and still worsens their cold streak, increasing future risk. Mutual exclusion ensures players can only select either Double Down or Shield per round.
* **🔥 / ❄️ Streak Multipliers & Cold Streaks:** Automatic tracking of consecutive correct answers with dynamic linear point multipliers (`x2`, `x3`, etc., marked by `🔥`). Cold/losing streaks ($\le -1$, marked by `❄️`) accumulate on consecutive wrong answers and scale penalty magnitude when Streak Multipliers are enabled.
* **💯 Negative Score Support:** Scores are allowed to drop below zero on incorrect answers or expired time limits, providing authentic penalty mechanics for competitive play.
* **⏱️ Host-Driven Timeout Decisions:** When the answering timer expires (`0.00s`), the engine halts countdown and awaits manual Host evaluation (`CORRECT` or `INCORRECT`).
* **🔊 Synthesized Audio:** Uses the native HTML5 `AudioContext` API to programmatically generate retro arcade sound effects for buzzer hits, countdown ticks, correct arpeggios, and incorrect sweeps.
* **⚡ Dual-Channel WebRTC DataChannels:** Establishes both a reliable DataChannel for room state updates and an unordered/unreliable fast UDP channel for `BUZZ`, `PING`, and `TIME_SYNC` packets, completely eliminating Head-of-Line (HOL) network blocking.
* **📈 Linear Regression Clock Drift Compensation:** Calculates a dynamic linear regression model over lowest-RTT NTP samples to compensate for client clock drift ($\frac{d\theta}{dt}$), maintaining sub-millisecond timestamp accuracy (`<0.1ms`).
* **📲 Instant Room Invite & QR Code Generator:** Host can open an **INVITE / QR** modal to display a mobile-scannable QR Code and direct share link (`?room=XXXXX`). Automatically prefills Room IDs on join without exposing room passwords in plain text URLs.
* **⌨️ Desktop Accessibility Keyboard Shortcuts:** Players can press **Spacebar** or **Enter** to trigger the Buzzer; Hosts can press **Spacebar** to arm/start rounds and **C** to clear buzzers.
* **🔄 Automatic Lobby & Theme Prefill:** Persists player display names, team names, room IDs, and theme color choices in `localStorage`, automatically restoring form fields and UI theme accents on tab refresh.
* **📡 Heartbeat & 5-Minute Reconnection Grace:** 100ms heartbeat scanning detects disconnected peers. Offline players retain their profile, score, and streak for 5 minutes before automatic purging.
* **📺 Spectator Mode (TV-Dashboard View):** A non-interactive role that connects to the game room to watch standings, timer countdowns, and active buzz queues in real-time. Displays a custom, large-screen optimized dashboard with real-time millisecond deltas, and propagates spectator lists/counts back to players and hosts so active competitors see who is watching.
* **👥 P2P Team Mode & Scoreboards:** Host can toggle "Allow Team Mode" on/off. When active, players select a custom team name on join. Standings tables automatically shift to group and sum scores by team. Features a Fair Play Buzz lock (only the fastest buzzer per team enters the queue) and updates the post-game modal to show 6 symmetric Team-wide achievements (Powerhouse, Fortress, Blitzkrieg, Syndicate, Lagoon, and Kamikaze).

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

3. **(Optional) Run a local Signaling Server:**
   *If you are behind a corporate firewall/proxy that blocks WebSockets to the public cloud broker (e.g. `0.peerjs.com`), you can run a local signaling server on `localhost`:*
   ```bash
   npm install -g peerjs
   peerjs --port 9000
   ```
   *Then, open the **⚙️ Advanced Signaling Broker Settings** panel at the bottom of the Lobby screen and configure:*
   * **Host:** `localhost`
   * **Port:** `9000`
   * **Secure (WSS):** *Unchecked*
   * **Path:** `/`

4. **Open the application:**
   * **Host:** Navigate to `http://localhost:8000`, select the **HOST** tab and click **LAUNCH AS HOST (NEW ROOM)** (or enter details in **RECLAIM** tab).
   * **Players:** Navigate to `http://localhost:8000`, select the **PLAY** tab, enter name and Host's **ROOM ID**, and click **CONNECT PEER-TO-PEER**.
   * **Spectators:** Select the **SPECTATE** tab, enter details, and click **SPECTATE ROOM**.

---

## ⚙️ Game Rules & Configuration

* **Timed / Untimed Rounds:** Host can toggle countdown timers on or off. Timer duration inputs automatically lock during active rounds.
* **Correct & Incorrect Points:** Host can set custom base reward (e.g. `+10`, `+20`) and penalty (e.g. `-5`, `0`) points.
* **Hide Scores (Suspense):** Host can mask player scores with `???` on all player screens for dramatic reveals.
* **Room Password:** Optional host-configured password to restrict lobby entry.
* **Double Down Mode:** Can be globally enabled/disabled by the Host. Players opt in during Standby.
* **Streak Multipliers & Cold Streaks:** Can be toggled on/off to enable linear score scaling for winning streaks and penalty scaling for cold streaks.
* **Allow Team Mode:** Host can group scoreboard results by Team names, enforcing single-buzzer team queues and displaying 6 dedicated team achievements.
* **Score & Streak Editing:** Click ✏️ next to any player in the Host Scoreboard to edit points or streak.
* **Kick & Ban:** Click ❌ next to any player in the Host Scoreboard to kick and ban them from the session.
* **Host Reclaim:** Re-enter Room ID + Reclaim Key from any device/browser to resume host control without losing room scores.
* **Session Stats:** Click **GENERATE GAME STATS** during Standby to calculate and display the achievements and leaderboard modal to all connected clients.
