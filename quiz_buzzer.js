// ==========================================================================
// ⚙️ GLOBAL GAME ENGINE CONFIGURATION (MODIFIERS & CONSTANTS)
// ==========================================================================

const ROOM_ID = "my_secret_lobby_12345"; 
const SECRET_HOST_PASSWORD = "quizmaster123"; 
const PING_INTERVAL_MS = 3000;
const CLEANUP_INTERVAL_MS = 3000;
const PLAYER_DISCONNECT_TIMEOUT_MS = 4000;

const BASE_POINTS_CORRECT = 10;
const BASE_POINTS_DOUBLE_DOWN = 20;
const BASE_PENALTY_WRONG = 5;
const BASE_PENALTY_DOUBLE_DOWN = 15;

const STREAK_MULTIPLIER_STEP = 0.5; 
const STREAK_PENALTY_STEP = 0.5;    
const LOCKOUT_WINDOW_MS = 3000;     
const DEFAULT_COUNTDOWN_LIMIT_SEC = 10;
const AUDIO_TICK_THRESHOLD_SEC = 3;

const TOPIC_STATUS = "buzzer/" + ROOM_ID + "/status";
const TOPIC_ACTION = "buzzer/" + ROOM_ID + "/action";

// ==========================================================================
// 🌀 LIVE ARENA STATE VARIABLES
// ==========================================================================
let myName = "";
let isHost = false;
let currentHostSetTime = DEFAULT_COUNTDOWN_LIMIT_SEC;
let streakModeActive = true; 
let doubleDownModeActive = true; 
let timerModeActive = true; 
let client = null;

let playerScores = {}; 
let playerStreaks = {}; 
let lastSeenPlayers = {}; 
let buzzList = []; 
let burnedPlayers = []; 
let missedWindowPlayers = []; 
let activeAtRoundStart = []; 
let queueLocked = false; 
let countdownInterval = null;
let cleanupInterval = null;
let lockoutTimeout = null; // 🌟 TRACKS THE ANTI-SPAM WINDOW BACKGROUND THREAD

let activeTimerDuration = 0;
let activeTimerStartedAt = 0;

// ==========================================================================
// 🔊 SOUND SYNTHESIS ENGINE
// ==========================================================================
function playSound(type) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    
    if (type === 'buzz') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, ctx.currentTime);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(); osc.stop(ctx.currentTime + 0.4);
    } 
    else if (type === 'correct') {
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();
        osc1.type = 'sine'; osc1.frequency.setValueAtTime(587.33, ctx.currentTime); 
        osc2.type = 'sine'; osc2.frequency.setValueAtTime(880, ctx.currentTime + 0.1); 
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
        osc1.connect(gain); osc2.connect(gain); gain.connect(ctx.destination);
        osc1.start(); osc1.stop(ctx.currentTime + 0.5);
        osc2.start(); osc2.stop(ctx.currentTime + 0.5);
    } 
    else if (type === 'wrong') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(90, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(70, ctx.currentTime + 0.6);
        gain.gain.setValueAtTime(0.4, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(); osc.stop(ctx.currentTime + 0.6);
    }
    else if (type === 'tick') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1200, ctx.currentTime);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.05);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(); osc.stop(ctx.currentTime + 0.05);
    }
}

// ==========================================================================
// 🔌 NETWORK CONNECTIONS & GAME ENTRY
// ==========================================================================
function joinGame() {
    const nameInput = document.getElementById('username');
    const passInput = document.getElementById('host-password');
    
    myName = nameInput.value.trim();
    if (!myName) return;

    if (passInput.value === SECRET_HOST_PASSWORD) {
        isHost = true;
        myName = "👑 " + myName;
    }

    client = mqtt.connect('wss://broker.emqx.io:8084/mqtt');

    client.on('connect', () => {
        client.subscribe(TOPIC_STATUS);
        client.subscribe(TOPIC_ACTION);

        sendAction('join', myName);

        document.getElementById('setup').classList.add('hidden');
        document.getElementById('game').classList.remove('hidden');

        if (isHost) {
            document.getElementById('host-controls').classList.remove('hidden');
            document.getElementById('clear-btn').classList.remove('hidden');
            
            document.getElementById('time-input').addEventListener('input', (e) => {
                currentHostSetTime = parseInt(e.target.value) || DEFAULT_COUNTDOWN_LIMIT_SEC;
                syncGlobalState();
            });

            document.getElementById('streak-toggle').addEventListener('change', (e) => {
                streakModeActive = e.target.checked;
                syncGlobalState();
            });

            document.getElementById('doubledown-toggle').addEventListener('change', (e) => {
                doubleDownModeActive = e.target.checked;
                syncGlobalState();
            });

            document.getElementById('timer-toggle').addEventListener('change', (e) => {
                timerModeActive = e.target.checked;
                syncGlobalState();
            });

            startDisconnectCleanupLoop();
        }

        setInterval(() => sendAction('ping', myName), PING_INTERVAL_MS);
    });

    client.on('message', (topic, message) => {
        const data = JSON.parse(message.toString());

        if (topic === TOPIC_ACTION) {
            handleUserActions(data);
        } else if (topic === TOPIC_STATUS) {
            buzzList = data.buzzers || [];
            burnedPlayers = data.burned || []; 
            missedWindowPlayers = data.missedWindow || []; 
            activeAtRoundStart = data.activeAtRoundStart || []; 
            queueLocked = data.locked || false; 
            playerScores = data.scores || {};
            playerStreaks = data.streaks || {}; 
            
            if (data.syncTime !== undefined) currentHostSetTime = data.syncTime;
            if (data.streakMode !== undefined) streakModeActive = data.streakMode;
            if (data.ddMode !== undefined) doubleDownModeActive = data.ddMode;
            if (data.timerMode !== undefined) timerModeActive = data.timerMode;

            if (timerModeActive && data.activeDuration > 0 && data.activeStartedAt > 0) {
                const elapsedSeconds = Math.floor((Date.now() - data.activeStartedAt) / 1000);
                const remainingTime = data.activeDuration - elapsedSeconds;
                
                const display = document.getElementById('timer-display');
                if (remainingTime > 0) {
                    startCountdown(remainingTime);
                } else {
                    document.getElementById('timer-display');
                    clearInterval(countdownInterval);
                    display.textContent = "⏱️ Time's Up! Awaiting Verdict...";
                }
            } else if (buzzList.length === 0 && !queueLocked) {
                clearInterval(countdownInterval);
                countdownInterval = null;
                resetCountdownDisplay();
            }
            
            updateLists();
            checkHostValidationUI();
        }
    });
}

// ==========================================================================
// 🛰️ DISPATCH PROCESSING SYSTEM
// ==========================================================================
function handleUserActions(data) {
    if (data.type === 'join' || data.type === 'ping') {
        if (isHost) {
            lastSeenPlayers[data.user] = Date.now();
        }

        if (!playerScores.hasOwnProperty(data.user)) {
            playerScores[data.user] = 0; 
            playerStreaks[data.user] = 0; 
            updateLists();
            if (isHost) syncGlobalState();
        } else {
            if (isHost) syncGlobalState();
        }
    } else if (data.type === 'buzz') {
        const alreadyInQueue = buzzList.some(item => item.user === data.user);
        const isBlacklisted = burnedPlayers.includes(data.user); 
        const isWindowMissed = missedWindowPlayers.includes(data.user);
        
        // 🔒 HISTORICAL SNAPSHOT INTERCEPT
        const structuralQueueActive = buzzList.length > 0;
        const isMidRoundJoiner = (structuralQueueActive || queueLocked) && 
                                 activeAtRoundStart.length > 0 && 
                                 !activeAtRoundStart.includes(data.user);
        
        if (!alreadyInQueue && !isBlacklisted && !queueLocked && !isWindowMissed && !isMidRoundJoiner) {
            if (buzzList.length === 0) {
                if (timerModeActive) {
                    activeTimerDuration = data.timeLimit;
                    activeTimerStartedAt = Date.now();
                    startCountdown(data.timeLimit);
                } else {
                    const display = document.getElementById('timer-display');
                    display.textContent = "⏱️ Active Player Turn";
                }
                
                if (isHost) {
                    // Capture active players at the exact millisecond the round begins
                    activeAtRoundStart = Object.keys(playerScores);

                    if (lockoutTimeout) clearTimeout(lockoutTimeout);

                    lockoutTimeout = setTimeout(() => {
                        queueLocked = true;
                        Object.keys(playerScores).forEach(player => {
                            const madeItIn = buzzList.some(item => item.user === player);
                            if (!madeItIn && !missedWindowPlayers.includes(player)) {
                                missedWindowPlayers.push(player);
                            }
                        });
                        syncGlobalState();
                        lockoutTimeout = null;
                    }, LOCKOUT_WINDOW_MS); 
                }
            }
            buzzList.push({ user: data.user, doubleDown: data.doubleDown, timestamp: data.timestamp || Date.now() });
            playSound('buzz');
            updateLists();
            checkHostValidationUI();
            if (isHost) syncGlobalState();
        }
    } else if (data.type === 'start-new-timer') {
        if (timerModeActive) {
            activeTimerDuration = data.timeLimit;
            activeTimerStartedAt = Date.now();
            startCountdown(data.timeLimit);
            if (isHost) syncGlobalState();
        }
    } else if (data.type === 'clear') {
        buzzList = [];
        burnedPlayers = []; 
        missedWindowPlayers = []; 
        activeAtRoundStart = []; 
        queueLocked = false; 
        activeTimerDuration = 0;
        activeTimerStartedAt = 0;
        resetCountdownDisplay(); 
        updateLists();
        checkHostValidationUI();
    } else if (data.type === 'reset-scores') {
        buzzList = [];
        burnedPlayers = [];
        missedWindowPlayers = [];
        activeAtRoundStart = [];
        queueLocked = false;
        activeTimerDuration = 0;
        activeTimerStartedAt = 0;

        Object.keys(playerScores).forEach(player => {
            playerScores[player] = 0;
            playerStreaks[player] = 0;
        });

        resetCountdownDisplay();
        updateLists();
        checkHostValidationUI();
    }
}

function startDisconnectCleanupLoop() {
    clearInterval(cleanupInterval);
    cleanupInterval = setInterval(() => {
        const now = Date.now();
        let boardChanged = false;

        for (const player in lastSeenPlayers) {
            if (now - lastSeenPlayers[player] > PLAYER_DISCONNECT_TIMEOUT_MS) {
                delete lastSeenPlayers[player];
                delete playerScores[player];
                delete playerStreaks[player]; 
                buzzList = buzzList.filter(item => item.user !== player);
                burnedPlayers = burnedPlayers.filter(p => p !== player);
                missedWindowPlayers = missedWindowPlayers.filter(p => p !== player);
                activeAtRoundStart = activeAtRoundStart.filter(p => p !== player);
                boardChanged = true;
            }
        }

        if (boardChanged) {
            syncGlobalState();
            updateLists();
            checkHostValidationUI();
        }
    }, CLEANUP_INTERVAL_MS);
}

// ==========================================================================
// 👑 HOST VERIFICATION HOTSEAT ARCHITECTURE
// ==========================================================================
function checkHostValidationUI() {
    if (!isHost) return;
    
    const validationBox = document.getElementById('host-validation-box');
    const nameSpan = document.getElementById('active-player-name');
    
    if (buzzList.length > 0) {
        validationBox.classList.remove('hidden');
        
        const activeItem = buzzList[0];
        const currentStreak = playerStreaks[activeItem.user] || 0;
        
        let multiplierText = "";
        if (streakModeActive) {
            if (currentStreak >= 1) multiplierText += ` (🔥 ${(1 + currentStreak * STREAK_MULTIPLIER_STEP)}x Multiplier)`;
            if (currentStreak <= -1) multiplierText += ` (❄️ ${(1 + Math.abs(currentStreak) * STREAK_PENALTY_STEP)}x Penalty)`;
        }
        
        if (activeItem.doubleDown && doubleDownModeActive) {
            multiplierText += " 💥 [DOUBLE DOWN]";
        }
        
        nameSpan.textContent = `${activeItem.user}${multiplierText}`;
    } else {
        validationBox.classList.add('hidden');
    }
}

function validateAnswer(isCorrect) {
    if (!isHost || buzzList.length === 0) return;
    
    const activeItem = buzzList[0];
    const activePlayer = activeItem.user;
    let currentStreak = playerStreaks[activePlayer] || 0;
    
    const dynamicDDActive = doubleDownModeActive && activeItem.doubleDown;
    
    if (isCorrect) {
        playSound('correct');
        if (currentStreak < 0) currentStreak = 0;
        
        let basePoints = dynamicDDActive ? BASE_POINTS_DOUBLE_DOWN : BASE_POINTS_CORRECT;
        const multiplier = streakModeActive ? (1 + currentStreak * STREAK_MULTIPLIER_STEP) : 1;
        const pointsEarned = Math.round(basePoints * multiplier);
        
        playerScores[activePlayer] = (playerScores[activePlayer] || 0) + pointsEarned;
        playerStreaks[activePlayer] = currentStreak + 1; 
        
        if (lockoutTimeout) {
            clearTimeout(lockoutTimeout);
            lockoutTimeout = null;
        }
        
        buzzList = []; 
        burnedPlayers = []; 
        missedWindowPlayers = [];
        activeAtRoundStart = [];
        queueLocked = false; 
        activeTimerDuration = 0;
        activeTimerStartedAt = 0;
        
        if (client) {
            client.publish(TOPIC_ACTION, JSON.stringify({ type: 'clear', user: myName }));
        }
    } else {
        playSound('wrong');
        if (currentStreak > 0) currentStreak = 0;
        
        let basePenalty = dynamicDDActive ? BASE_PENALTY_DOUBLE_DOWN : BASE_PENALTY_WRONG;
        const multiplier = streakModeActive ? (1 + Math.abs(currentStreak) * STREAK_PENALTY_STEP) : 1;
        const penaltyCost = Math.round(basePenalty * multiplier);
        
        playerScores[activePlayer] = (playerScores[activePlayer] || 0) - penaltyCost;
        playerStreaks[activePlayer] = currentStreak - 1; 
        
        if (!burnedPlayers.includes(activePlayer)) {
            burnedPlayers.push(activePlayer);
        }
        
        buzzList.shift(); 
        
        if (buzzList.length > 0) {
            activeTimerDuration = currentHostSetTime;
            activeTimerStartedAt = Date.now();
            syncGlobalState();
            if (client) {
                client.publish(TOPIC_ACTION, JSON.stringify({ 
                    type: 'start-new-timer', 
                    user: myName, 
                    timeLimit: currentHostSetTime 
                }));
            }
            return; 
        } else {
            if (lockoutTimeout) {
                clearTimeout(lockoutTimeout);
                lockoutTimeout = null;
            }
            
            queueLocked = true; 
            activeTimerDuration = 0;
            activeTimerStartedAt = Date.now();
            
            clearInterval(countdownInterval);
            countdownInterval = null;
            const display = document.getElementById('timer-display');
            if (display) display.textContent = "❌ Incorrect. Round locked down.";
        }
    }
    
    syncGlobalState();
}

// ==========================================================================
// ⏱️ TIMING OPERATIONS SYSTEM
// ==========================================================================
function startCountdown(duration) {
    clearInterval(countdownInterval);
    const display = document.getElementById('timer-display');
    
    let timeLeft = duration;
    display.textContent = `Time Left: ${timeLeft}s`;

    countdownInterval = setInterval(() => {
        timeLeft--;
        
        if (timeLeft <= AUDIO_TICK_THRESHOLD_SEC && timeLeft > 0) {
            playSound('tick');
        }

        if (timeLeft <= 0) {
            clearInterval(countdownInterval);
            display.textContent = "⏱️ Time's Up! Awaiting Verdict...";
            playSound('wrong');
        } else {
            display.textContent = `Time Left: ${timeLeft}s`;
        }
    }, 1000);
}

// ==========================================================================
// 🚨 INTERACTIVE USER PANEL EVENTS
// ==========================================================================
function pressBuzzer() {
    if (client) {
        // 🔒 SECURITY INTERCEPT: Evaluated immediately on local click before MQTT transmission
        const structuralQueueActive = buzzList.length > 0;
        const isMidRoundJoiner = (structuralQueueActive || queueLocked) && 
                                 activeAtRoundStart.length > 0 && 
                                 !activeAtRoundStart.includes(myName);

        if (queueLocked || burnedPlayers.includes(myName) || missedWindowPlayers.includes(myName) || buzzList.some(item => item.user === myName) || isMidRoundJoiner) return;

        const ddBox = document.getElementById('player-dd-checkbox');
        const wantsDoubleDown = ddBox ? ddBox.checked : false;
        
        client.publish(TOPIC_ACTION, JSON.stringify({ 
            type: 'buzz', 
            user: myName, 
            timeLimit: currentHostSetTime,
            doubleDown: wantsDoubleDown,
            timestamp: Date.now() 
        }));
        
        if (ddBox) ddBox.checked = false;
    }
}

function clearBuzzers() {
    if (isHost) {
        if (lockoutTimeout) {
            clearTimeout(lockoutTimeout);
            lockoutTimeout = null;
        }

        buzzList = [];
        burnedPlayers = []; 
        missedWindowPlayers = [];
        activeAtRoundStart = [];
        queueLocked = false; 
        activeTimerDuration = 0;
        activeTimerStartedAt = 0;
        if (client) {
            client.publish(TOPIC_ACTION, JSON.stringify({ type: 'clear', user: myName }));
        }
        syncGlobalState();
    }
}

function resetCountdownDisplay() {
    clearInterval(countdownInterval); 
    const display = document.getElementById('timer-display');
    if (display) display.textContent = "Timer: Ready";
}

// ==========================================================================
// 🚨 ADMINISTRATIVE RESETS
// ==========================================================================
function resetScoreboard() {
    if (isHost) {
        if (!confirm("Are you sure you want to reset all player scores and streaks to zero?")) return;

        if (lockoutTimeout) {
            clearTimeout(lockoutTimeout);
            lockoutTimeout = null;
        }

        buzzList = [];
        burnedPlayers = [];
        missedWindowPlayers = [];
        activeAtRoundStart = [];
        queueLocked = false;
        activeTimerDuration = 0;
        activeTimerStartedAt = 0;

        Object.keys(playerScores).forEach(player => {
            playerScores[player] = 0;
            playerStreaks[player] = 0;
        });

        if (client) {
            client.publish(TOPIC_ACTION, JSON.stringify({ type: 'reset-scores', user: myName }));
        }
        syncGlobalState();
    }
}

// ==========================================================================
// 📡 STATE SYNCHRONIZATION MATRIX
// ==========================================================================
function syncGlobalState() {
    if (client) {
        client.publish(TOPIC_STATUS, JSON.stringify({ 
            buzzers: buzzList, 
            burned: burnedPlayers, 
            missedWindow: missedWindowPlayers, 
            activeAtRoundStart: activeAtRoundStart, 
            locked: queueLocked, 
            scores: playerScores, 
            streaks: playerStreaks, 
            syncTime: currentHostSetTime,
            streakMode: streakModeActive,
            ddMode: doubleDownModeActive,
            timerMode: timerModeActive,
            activeDuration: activeTimerDuration,
            activeStartedAt: activeTimerStartedAt
        }));
    }
}

function sendAction(type, user) {
    if (client) {
        client.publish(TOPIC_ACTION, JSON.stringify({ type, user }));
    }
}

// ==========================================================================
// 🎨 ENGINE RENDERING & UI SYNC MATRIX
// ==========================================================================
function updateLists() {
    const badgeStreaks = document.getElementById('badge-streaks');
    const badgeDoubleDown = document.getElementById('badge-doubledown');
    const badgeTimer = document.getElementById('badge-timer');

    if (badgeStreaks) {
        badgeStreaks.className = streakModeActive ? "rule-status-badge badge-on" : "rule-status-badge badge-off";
        badgeStreaks.textContent = streakModeActive ? "🔥 ON" : "OFF";
    }
    if (badgeDoubleDown) {
        badgeDoubleDown.className = doubleDownModeActive ? "rule-status-badge badge-on" : "rule-status-badge badge-off";
        badgeDoubleDown.textContent = doubleDownModeActive ? "💥 ON" : "OFF";
    }
    if (badgeTimer) {
        badgeTimer.className = timerModeActive ? "rule-status-badge badge-on" : "rule-status-badge badge-off";
        badgeTimer.textContent = timerModeActive ? "⏱️ ON" : "OFF";
    }

    const timerDisplayCard = document.getElementById('timer-display');
    if (timerDisplayCard) {
        if (timerModeActive) {
            timerDisplayCard.classList.remove('hidden');
        } else {
            timerDisplayCard.classList.add('hidden');
        }
    }

    const strategyBox = document.getElementById('player-strategy-box');
    if (strategyBox) {
        if (doubleDownModeActive) strategyBox.classList.remove('hidden');
        else strategyBox.classList.add('hidden');
    }

    const deckInputsWrapper = document.getElementById('deck-interactive-fields');
    const deckHeader = document.getElementById('deck-headline');
    const isRoundActive = buzzList.length > 0;

    if (isHost && deckInputsWrapper && deckHeader) {
        if (isRoundActive) {
            deckInputsWrapper.classList.add('disabled-deck');
            deckHeader.textContent = "🔒 ADMINISTRATIVE DECK (LOCKED MID-ROUND)";
            deckHeader.style.color = "#ff4757";
        } else {
            deckInputsWrapper.classList.remove('disabled-deck');
            deckHeader.textContent = "👑 QUIZMASTER ADMINISTRATIVE DECK";
            deckHeader.style.color = "#2ed573";
        }
    }

    const buzzerBtn = document.getElementById('buzzer-btn');
    if (buzzerBtn) {
        const structuralQueueActive = buzzList.length > 0;
        const iAmAlreadyInQueue = buzzList.some(item => item.user === myName);
        const iAmBurned = burnedPlayers.includes(myName);

        // 🌟 ARCHITECTURE CORRECTION: Checked locally to lock visual status elements
        const isMidRoundJoiner = (structuralQueueActive || queueLocked) && 
                                 activeAtRoundStart.length > 0 && 
                                 !activeAtRoundStart.includes(myName);

        if (iAmBurned) {
            buzzerBtn.classList.add('disabled-state');
            buzzerBtn.textContent = "LOCKED";
        } else if (isMidRoundJoiner) {
            buzzerBtn.classList.add('disabled-state');
            buzzerBtn.textContent = "ROUND IN PROGRESS";
        } else if (iAmAlreadyInQueue) {
            buzzerBtn.classList.add('disabled-state');
            buzzerBtn.textContent = "BUZZED";
        } else if (queueLocked) {
            buzzerBtn.classList.add('disabled-state');
            buzzerBtn.textContent = "TOO LATE";
        } else {
            buzzerBtn.classList.remove('disabled-state');
            buzzerBtn.textContent = "BUZZ";
        }
    }

    const tbody = document.getElementById('scores-tbody');
    const sortedPlayers = Object.entries(playerScores).sort((a, b) => b[1] - a[1]);
    const topBuzzerUser = buzzList.length > 0 ? buzzList[0].user : null;

    tbody.innerHTML = sortedPlayers.map(([user, score]) => {
        const streakVal = playerStreaks[user] || 0;
        let streakDisplay = "";
        
        if (streakModeActive) {
            if (streakVal > 0) {
                streakDisplay = ` <span style="color: #ff9f43; font-size: 12px; white-space: nowrap;">🔥${streakVal}</span>`;
            } else if (streakVal < 0) {
                streakDisplay = ` <span style="color: #00d2d3; font-size: 12px; white-space: nowrap;">❄️${Math.abs(streakVal)}</span>`;
            }
        }

        const hotSeatClass = (user === topBuzzerUser) ? 'style="background-color: rgba(234, 179, 8, 0.15); font-weight: bold;"' : '';
        const cleanName = user.startsWith('👑') ? user : '👤 ' + user;

        return `<tr ${hotSeatClass}>
            <td style="padding: 10px 8px;">
                <span style="font-weight: 600; color: ${user === topBuzzerUser ? '#eab308' : '#f8fafc'};">${cleanName}</span>${streakDisplay}
            </td>
            <td style="text-align: right; padding: 10px 8px; font-weight: 800; color: ${user === topBuzzerUser ? '#eab308' : '#f8fafc'};">${score}</td>
        </tr>`;
    }).join('');

    const buzzOl = document.getElementById('buzz-list');
    if (buzzList.length === 0) {
        buzzOl.innerHTML = "";
    } else {
        const baseTimestamp = buzzList[0].timestamp;
        buzzOl.innerHTML = buzzList.map((item, index) => {
            const iconBadge = (item.doubleDown && doubleDownModeActive) ? " 💥" : "";
            let timingDeltaStr = "";
            if (index > 0) {
                const deltaSeconds = ((item.timestamp - baseTimestamp) / 1000).toFixed(3);
                timingDeltaStr = ` <span style="color: #64748b; font-size: 12px;">(+${deltaSeconds}s)</span>`;
            }
            const itemStyle = (index === 0) ? 'style="color: #eab308; font-weight: 700;"' : '';
            return `<li ${itemStyle} style="padding: 4px 0;">${item.user}${iconBadge}${timingDeltaStr}</li>`;
        }).join('');
    }
}