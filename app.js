/**
 * BuzzShell Quiz Buzzer Game Engine
 * Authoritative WebRTC Edition (via PeerJS)
 * 
 * Features:
 * - Peer-to-Peer direct connection (signaling bypassed after handshake).
 * - Dual-channel WebRTC DataChannels (Reliable Control + Unordered Fast UDP Channel).
 * - NTP-style clocksync algorithm with Linear Regression Clock Drift Compensation.
 * - Browser-synthesized Web Audio oscillators (Sawtooth/Sine) for latency-free sounds.
 * - Heartbeat scanning (100ms) with 5-minute reconnection grace periods.
 * - One-Tap QR Code Room Invites & auto-filled Room parameters.
 * - Desktop Accessibility Keyboard Shortcuts (Space/Enter to buzz, Space/C for host).
 * - Fully isolated warnings on player tabs, clean Host dashboards.
 */

// ==========================================
// GLOBAL STATE & SYSTEM VARIABLES
// ==========================================
let isHost = false;          // Tracks if this tab is the Authoritative Host (Quizmaster)
let peer = null;            // Holds the PeerJS Peer instance
let activeRoomId = null;    // The Room ID (Host Peer ID) generated upon launching the room
let myClientId = null;      // AUTHORITATIVE persistent unique ID stored in sessionStorage
let myUsername = '';        // Player's registered display name (Player role only)
let myTeamName = '';        // Player's registered team name (optional)
let activeDirectoryTab = 'players'; // Directory view state ('players' | 'teams')

/**
 * Connection Registries
 * - Host role: maps player ClientId -> active PeerJS DataConnection
 * - Player role: holds the single connection to the Host
 */
let playerConnections = {}; 
let fastConnections = {};     // Maps ClientId -> fast UDP-style DataConnection on Host side
let spectatorConnections = {}; // Maps spectator ClientId -> active PeerJS DataConnection
let spectators = {};          // Spectator metadata profile registry (holds display names)
let hostConnection = null; 
let hostFastConnection = null; // Fast UDP-style unordered DataChannel for low-latency buzz/ntp
let isSpectator = false;      // True if this tab is spectating the lobby (read-only TV dashboard role) 

/**
 * PeerJS ICE Server Configuration (ICE = Interactive Connectivity Establishment)
 * - Includes a standard public Google STUN server for normal NAT mappings.
 * - Includes Metered.ca public TURN servers to act as relays when players are behind strict 
 *   Symmetric NATs (common in cellular networks, colleges, or corporate environments).
 */
function getPeerOptions() {
    const hostInput = document.getElementById('cfg-sig-host').value.trim();
    const portInput = parseInt(document.getElementById('cfg-sig-port').value.trim()) || 443;
    const pathInput = document.getElementById('cfg-sig-path').value.trim();
    const secureInput = document.getElementById('cfg-sig-secure').checked;

    const baseConfig = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:openrelay.metered.ca:80' },
            {
                urls: 'turn:openrelay.metered.ca:80',
                username: 'openrelay',
                credential: 'openrelay'
            },
            {
                urls: 'turn:openrelay.metered.ca:443',
                username: 'openrelay',
                credential: 'openrelay'
            },
            {
                urls: 'turn:openrelay.metered.ca:443?transport=tcp',
                username: 'openrelay',
                credential: 'openrelay'
            }
        ]
    };

    return {
        host: hostInput || '0.peerjs.com',
        port: portInput,
        path: pathInput || '/',
        secure: secureInput,
        debug: 1,
        config: baseConfig
    };
} 

// ==========================================
// BROWSER-SYNTHESIZED AUDIO MODULE
// ==========================================
let audioCtx = null; // Browser Audio Context initialized lazily to satisfy browser autoplay policies

/**
 * Initializes the Audio Context on user interaction.
 */
function initAudio() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

/**
 * Synthesizes a heavy Sawtooth buzzer hit sound.
 * Plays when a player presses the buzzer button.
 */
function playBuzzerHit() {
    initAudio(); if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(140, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(70, audioCtx.currentTime + 0.35); // Fast sweep down
    
    gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.01, audioCtx.currentTime + 0.35); // Fade out
    
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + 0.35);
}

/**
 * Synthesizes a high-pitched Sine wave tick.
 * Plays during the final 3 seconds of the answering countdown.
 */
function playAnsweringTick() {
    initAudio(); if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1100, audioCtx.currentTime);
    
    gain.gain.setValueAtTime(0.03, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.005, audioCtx.currentTime + 0.04); // Quick blip
    
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + 0.04);
}

/**
 * Synthesizes a pleasant ascending sine wave arpeggio (C4-E4-G4-C5).
 * Plays when the Host marks a player's answer as Correct.
 */
function playCorrect() {
    initAudio(); if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const notes = [261.63, 329.63, 392.00, 523.25]; // C4, E4, G4, C5 frequencies
    
    notes.forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + i * 0.07); // Arpeggiated offset
        gain.gain.setValueAtTime(0.12, now + i * 0.07);
        gain.gain.exponentialRampToValueAtTime(0.005, now + i * 0.07 + 0.25);
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start(now + i * 0.07); osc.stop(now + i * 0.07 + 0.25);
    });
}

/**
 * Synthesizes a harsh descending sawtooth frequency sweep.
 * Plays when the Host marks a player's answer as Incorrect.
 */
function playIncorrect() {
    initAudio(); if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(280, now);
    osc.frequency.linearRampToValueAtTime(75, now + 0.45); // Aggressive drop
    
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.linearRampToValueAtTime(0.005, now + 0.45);
    
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(now); osc.stop(now + 0.45);
}


// ==========================================
// TIMING & CLOCKSYNC MECHANICS
// ==========================================
let clockOffset = 0;   // NTP calculated time difference (Host Time - Player Time)
let clockDriftRate = 0; // Linear regression drift rate compensation
let lastSyncSampleTime = 0; // Anchor timestamp for drift calculation
let currentRtt = 0;     // Network Round Trip Time (RTT) in milliseconds
let syncHistory = [];   // Array of { timestamp, offset, rtt } to filter network jitter
let lastPlayerRoster = null; // Caches latest roster for instant UI re-renders
let roundStartTime = 0;      // Authoritative round start time (Host clocksync anchor)

function getSynchronizedTimestamp() {
    if (lastSyncSampleTime && clockDriftRate) {
        const driftCorrection = (Date.now() - lastSyncSampleTime) * clockDriftRate;
        return Date.now() + clockOffset + driftCorrection;
    }
    return Date.now() + clockOffset;
}

// ==========================================
// GAME STATE MANAGEMENT
// ==========================================
let roundStatus = 'idle'; // Game states: 'idle', 'active' (armed), 'hotseat', 'lockout'
let currentRound = 1;     // Active game round counter
let timeRemaining = 0;    // Tracks active countdown seconds (supports fractions)
let timerInterval = null; // Countdown setInterval reference
let lastTickTime = 0;     // Used to compute delta time accurately regardless of interval lag

// Authoritative settings broadcasted by Host
let settings = {
    timed: true,
    duration: 10,
    doubleDown: false,
    shieldMode: false,
    streakMultipliers: false,
    correctPoints: 10,
    incorrectPenalty: 5,
    password: '',
    hideScores: false,
    teamMode: false
};

/**
 * Scoreboard & Player profiles (Host authoritatively holds this)
 * Key: clientId -> Value: { 
 *   username: string, 
 *   score: number, 
 *   streak: number (consecutive correct/incorrect correct answers count), 
 *   status: string ('online' | 'offline'), 
 *   lastPing: timestamp (milliseconds), 
 *   disconnectTime: timestamp or null, 
 *   doubleDownActive: boolean, 
 *   shieldActive: boolean, 
 *   shieldCooldown: number (cooldown rounds remaining), 
 *   color: string (selected color accent theme name),
 *   stats: { correctCount, incorrectCount, maxStreak, maxColdStreak, doubleDownCount, buzzReactionTimes[], backupDeltas[] }
 * }
 */
let scores = {}; 

/**
 * Buzz Queue (Host authoritative list)
 * Sorted list containing player buzz information: { clientId, username, buzzTime }
 * `buzzTime` is the absolute clocksync time of when the player clicked the buzzer.
 */
let buzzQueue = [];
let lockoutActive = false; // Indicates if the 3-second backup buzz window is open
let lockoutTimer = null;   // Backup window setTimeout reference

let myDeviceId = null;

// Host Ban Registries
let bannedClients = {};
let bannedDevices = {};
let bannedUsernames = {};

// ==========================================
// SESSION PERSISTENCE (sessionStorage & localStorage)
// ==========================================
/**
 * Retrieves the client's ID (per-tab) and device ID (per-browser instance).
 * Storing clientId in sessionStorage isolates IDs across duplicate tabs.
 * Storing deviceId in localStorage persists across tabs/sessions to enforce device bans.
 */
function getOrCreateClientId() {
    let id = sessionStorage.getItem('quiz_buzzer_client_id');
    if (!id) {
        id = 'c-' + Math.random().toString(36).substring(2, 11);
        sessionStorage.setItem('quiz_buzzer_client_id', id);
    }
    myClientId = id;

    let devId = localStorage.getItem('quiz_buzzer_device_id');
    if (!devId) {
        devId = 'd-' + Math.random().toString(36).substring(2, 11) + Math.random().toString(36).substring(2, 11);
        localStorage.setItem('quiz_buzzer_device_id', devId);
    }
    myDeviceId = devId;

    return id;
}

let myHostReclaimKey = '';
let hostReconnectInterval = null;

/**
 * Persists current Host room state to localStorage for disconnection recovery.
 */
function saveHostStateToStorage() {
    if (!isHost) return;
    if (activeRoomId) localStorage.setItem('quiz_buzzer_host_room_id', activeRoomId);
    if (myHostReclaimKey) localStorage.setItem('quiz_buzzer_host_reclaim_key', myHostReclaimKey);
    localStorage.setItem('quiz_buzzer_host_scores', JSON.stringify(scores));
    localStorage.setItem('quiz_buzzer_host_settings', JSON.stringify(settings));
    localStorage.setItem('quiz_buzzer_host_round', currentRound);
}

window.addEventListener('load', () => {
    getOrCreateClientId();

    // Register PWA Service Worker for offline asset caching
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("./sw.js")
            .then((reg) => console.log("Service Worker registered. Scope:", reg.scope))
            .catch((err) => console.warn("Service Worker registration failed:", err));
    }

    // Auto-fill reclaim input fields if previous host session exists in localStorage
    const savedRoom = localStorage.getItem('quiz_buzzer_host_room_id');
    const savedKey = localStorage.getItem('quiz_buzzer_host_reclaim_key');
    if (savedRoom && savedKey) {
        const rEl = document.getElementById('input-reclaim-room-id');
        const kEl = document.getElementById('input-reclaim-key');
        if (rEl) rEl.value = savedRoom;
        if (kEl) kEl.value = savedKey;
    }

    // Auto-fill player lobby inputs if previous player session exists in localStorage
    const savedPlayerName = localStorage.getItem('quiz_buzzer_player_name');
    const savedPlayerTeam = localStorage.getItem('quiz_buzzer_player_team');
    const savedPlayerRoom = localStorage.getItem('quiz_buzzer_player_room');
    const savedPlayerColor = localStorage.getItem('quiz_buzzer_player_color') || sessionStorage.getItem('quiz_buzzer_player_color');
    
    if (savedPlayerName) {
        const pNameEl = document.getElementById('input-player-name');
        if (pNameEl) pNameEl.value = savedPlayerName;
    }
    if (savedPlayerTeam) {
        const pTeamEl = document.getElementById('input-player-team');
        if (pTeamEl) pTeamEl.value = savedPlayerTeam;
    }
    if (savedPlayerRoom) {
        const pRoomEl = document.getElementById('input-room-id');
        if (pRoomEl) pRoomEl.value = savedPlayerRoom;
    }
    if (savedPlayerColor) {
        const radio = document.querySelector(`input[name="player-theme-color"][value="${savedPlayerColor}"]`);
        if (radio) radio.checked = true;
    }

    // Auto-fill from URL invite params (?room=XXXXX)
    const urlParams = new URLSearchParams(window.location.search);
    const paramRoom = urlParams.get('room');
    if (paramRoom) {
        const pRoomEl = document.getElementById('input-room-id');
        if (pRoomEl) pRoomEl.value = paramRoom.trim().toUpperCase();
    }
});

// ==========================================
// ROLE CREATION: HOST INITIALIZATION & RECLAIM
// ==========================================
document.getElementById('btn-init-host').addEventListener('click', () => {
    initHostRoom();
});

const reclaimBtn = document.getElementById('btn-reclaim-host');
if (reclaimBtn) {
    reclaimBtn.addEventListener('click', () => {
        reclaimHostRoom();
    });
}

function initHostRoom() {
    initAudio();
    if (typeof Peer === 'undefined') {
        alert("PeerJS signaling library failed to load from CDN. Please check your network connection or try reloading the page.");
        return;
    }
    if (!window.RTCPeerConnection) {
        alert("WebRTC is not supported in this browser or context.");
        return;
    }

    isHost = true;
    const btn = document.getElementById('btn-init-host');
    const originalText = btn.innerText;
    btn.innerText = 'REGISTERING ROOM...';
    btn.disabled = true;

    const targetRoomId = String(Math.floor(10000 + Math.random() * 90000));
    myHostReclaimKey = Math.random().toString(36).substring(2, 8).toUpperCase();

    // 10-second signaling connection timeout
    let connectionTimeout = setTimeout(() => {
        alert('Signaling connection timed out.\n\nCould not connect to PeerJS broker server. This usually happens if you are behind a corporate firewall/proxy that blocks WebSockets, or if the signaling server is temporarily offline.');
        btn.innerText = originalText;
        btn.disabled = false;
        if (peer) peer.destroy();
    }, 10000);

    peer = new Peer(targetRoomId, getPeerOptions());

    peer.on('open', (id) => {
        clearTimeout(connectionTimeout);
        activeRoomId = id;
        document.getElementById('host-room-id-val').innerText = id;
        document.getElementById('host-reclaim-key-val').innerText = myHostReclaimKey;
        switchScreen('host-screen');
        logTerminal('INIT', `Room initiated [${id}] (Reclaim Key: ${myHostReclaimKey})`);
        
        saveHostStateToStorage();
        setInterval(hostHeartbeatLoop, 100);
    });

    bindHostPeerEvents(btn, originalText, () => clearTimeout(connectionTimeout));
}

function reclaimHostRoom() {
    initAudio();
    if (typeof Peer === 'undefined') {
        alert("PeerJS signaling library failed to load from CDN. Please check your network connection or try reloading the page.");
        return;
    }
    if (!window.RTCPeerConnection) {
        alert("WebRTC is not supported in this browser or context.");
        return;
    }

    const roomIdInput = document.getElementById('input-reclaim-room-id').value.trim().toUpperCase();
    const reclaimKeyInput = document.getElementById('input-reclaim-key').value.trim().toUpperCase();

    if (!roomIdInput || !reclaimKeyInput) {
        alert("Please enter both Room ID and Reclaim Key to recover control of a room.");
        return;
    }

    const btn = document.getElementById('btn-reclaim-host');
    const originalText = btn.innerText;
    btn.innerText = 'RECLAIMING ROOM...';
    btn.disabled = true;

    isHost = true;
    activeRoomId = roomIdInput;
    myHostReclaimKey = reclaimKeyInput;

    // Restore saved host state from localStorage if available
    const savedRoom = (localStorage.getItem('quiz_buzzer_host_room_id') || '').trim().toUpperCase();
    const savedKey = (localStorage.getItem('quiz_buzzer_host_reclaim_key') || '').trim().toUpperCase();
    const savedScores = localStorage.getItem('quiz_buzzer_host_scores');
    const savedSettings = localStorage.getItem('quiz_buzzer_host_settings');
    const savedRound = localStorage.getItem('quiz_buzzer_host_round');

    const isSameDeviceSession = (savedRoom === roomIdInput) || (savedKey === reclaimKeyInput);

    if (isSameDeviceSession || savedSettings) {
        if (savedSettings) {
            try {
                settings = JSON.parse(savedSettings);
            } catch(e) {
                console.error('Error parsing saved settings:', e);
            }
        }
        if (savedScores) {
            try {
                scores = JSON.parse(savedScores);
                // Mark all restored players as offline initially until they re-establish WebRTC connections
                for (let cid in scores) {
                    scores[cid].status = 'offline';
                    scores[cid].lastPing = Date.now();
                    if (scores[cid].doubleDownActive === undefined) scores[cid].doubleDownActive = false;
                    if (scores[cid].shieldActive === undefined) scores[cid].shieldActive = false;
                    if (scores[cid].shieldCooldown === undefined) scores[cid].shieldCooldown = 0;
                    if (scores[cid].team === undefined) scores[cid].team = '';
                    if (!scores[cid].stats) {
                        scores[cid].stats = {
                            buzzReactionTimes: [],
                            correctCount: 0,
                            incorrectCount: 0,
                            maxStreak: 0,
                            maxColdStreak: 0,
                            doubleDownCount: 0,
                            firstPlaceBuzzCount: 0,
                            shieldBlocks: 0,
                            pointsLost: 0,
                            backupDeltas: []
                        };
                    } else {
                        if (scores[cid].stats.firstPlaceBuzzCount === undefined) scores[cid].stats.firstPlaceBuzzCount = 0;
                        if (scores[cid].stats.shieldBlocks === undefined) scores[cid].stats.shieldBlocks = 0;
                        if (scores[cid].stats.pointsLost === undefined) scores[cid].stats.pointsLost = 0;
                    }
                }
            } catch (e) {
                console.error('Error parsing saved scores:', e);
                scores = {};
            }
        }
        if (savedRound) {
            currentRound = parseInt(savedRound) || 1;
        }
    }

    syncHostSettingsUI();
    roundStatus = 'idle'; // Engine set to STANDBY per user requirements

    // 10-second signaling connection timeout
    let connectionTimeout = setTimeout(() => {
        alert('Signaling connection timed out.\n\nCould not recover Room on signaling broker. Ensure the Room ID is correct or wait a few seconds and try again.');
        btn.innerText = originalText;
        btn.disabled = false;
        if (peer) peer.destroy();
    }, 10000);

    peer = new Peer(activeRoomId, getPeerOptions());

    peer.on('open', (id) => {
        clearTimeout(connectionTimeout);
        document.getElementById('host-room-id-val').innerText = id;
        document.getElementById('host-reclaim-key-val').innerText = myHostReclaimKey;
        switchScreen('host-screen');
        
        logTerminal('RECOVER', `Reclaimed control room [${id}]. Engine set to STANDBY.`);
        
        saveHostStateToStorage();
        updateHostDirectoryUI();
        syncHostSettingsUI();

        setInterval(hostHeartbeatLoop, 100);
    });

    bindHostPeerEvents(btn, originalText, () => clearTimeout(connectionTimeout));
}

function bindHostPeerEvents(btn, originalText, clearTimerCallback) {
    peer.on('connection', (conn) => {
        if (conn.label === 'fast') {
            conn.on('data', (data) => {
                if (data && data.clientId) {
                    fastConnections[data.clientId] = conn;
                }
                handleHostIncomingData(conn, data);
            });
            conn.on('close', () => {
                for (let cid in fastConnections) {
                    if (fastConnections[cid] === conn) delete fastConnections[cid];
                }
            });
            return;
        }
        conn.on('data', (data) => {
            handleHostIncomingData(conn, data);
        });
        conn.on('close', () => {
            handleHostConnectionClose(conn);
        });
        conn.on('error', (err) => {
            logTerminal('CONN_ERR', `Connection error with peer: ${err}`);
        });
    });

    peer.on('error', (err) => {
        if (clearTimerCallback) clearTimerCallback();
        btn.innerText = originalText;
        btn.disabled = false;
        if (err.type === 'unavailable-id') {
            logTerminal('RETRY', `Room ID [${activeRoomId}] is currently registered or in use.`);
            alert(`Room ID [${activeRoomId}] is unavailable on broker server. If host tab was just closed, wait 5 seconds and click Reclaim again.`);
        } else {
            logTerminal('PEER_ERR', `Global peer error: ${err.message}`);
            alert(`Failed to initialize room peer session: ${err.message}`);
        }
    });
}

// ==========================================
// ROLE CREATION: PLAYER INITIALIZATION
// ==========================================
document.getElementById('btn-init-player').addEventListener('click', () => {
    initAudio();
    if (typeof Peer === 'undefined') {
        alert("PeerJS signaling library failed to load from CDN. Please check your network connection or try reloading the page.");
        return;
    }
    if (!window.RTCPeerConnection) {
        alert("WebRTC is not supported in this browser or context. Note: WebRTC requires a secure context (HTTPS or localhost) to function.");
        return;
    }

    const usernameInput = document.getElementById('input-player-name').value.trim();
    const teamInput = document.getElementById('input-player-team').value.trim();
    const roomIdInput = document.getElementById('input-room-id').value.trim().toUpperCase();

    if (!usernameInput) {
        alert('Please enter a username.'); return;
    }
    if (!roomIdInput) {
        alert('Please enter a valid Room ID.'); return;
    }

    // Save selected color and inputs to storage for refresh prefill
    const selectedColorEl = document.querySelector('input[name="player-theme-color"]:checked');
    const selectedColor = selectedColorEl ? selectedColorEl.value : 'amber';
    sessionStorage.setItem('quiz_buzzer_player_color', selectedColor);
    localStorage.setItem('quiz_buzzer_player_color', selectedColor);
    localStorage.setItem('quiz_buzzer_player_name', usernameInput);
    localStorage.setItem('quiz_buzzer_player_team', teamInput);
    localStorage.setItem('quiz_buzzer_player_room', roomIdInput);

    myUsername = usernameInput;
    isHost = false;

    const btn = document.getElementById('btn-init-player');
    const originalText = btn.innerText;
    btn.innerText = 'CONNECTING...';
    btn.disabled = true;

    // Generate random transient Peer ID for player's signaling session
    peer = new Peer(null, getPeerOptions());

    // 10-second timeout warning in case of Symmetric NAT blocking or invalid Host Room ID
    let connectionTimeout = setTimeout(() => {
        alert('Connection timed out.\n\n1. Ensure the Host Room ID is correct and the Host is active.\n2. If you are on separate networks (cellular vs corporate wifi), a firewall or symmetric NAT may be blocking WebRTC direct channels. Try connecting via a VPN, local network, or testing on mobile data.');
        btn.innerText = originalText;
        btn.disabled = false;
        if (peer) peer.destroy();
    }, 10000);

    peer.on('open', (myPeerId) => {
        console.log(`Local Peer created: ${myPeerId}`);
        
        // Initiate data channel connection
        const conn = peer.connect(roomIdInput, { reliable: true });
        hostConnection = conn;

        // Safety: Ensure subscription handlers are bound BEFORE sending the JOIN handshake
        conn.on('open', () => {
            clearTimeout(connectionTimeout); // Cancel connection timeout
            
            try {
                hostFastConnection = peer.connect(roomIdInput, { label: 'fast', reliable: false });
            } catch(e) { console.warn("UDP DataChannel not available, using reliable fallback."); }

            myTeamName = teamInput; // Set global team name
            
            const savedColor = sessionStorage.getItem('quiz_buzzer_player_color') || 'amber';
            conn.send({
                type: 'JOIN',
                role: 'player',
                username: myUsername,
                teamName: myTeamName,
                clientId: myClientId,
                deviceId: myDeviceId,
                password: null,
                color: savedColor
            });
        });

        conn.on('data', (data) => {
            handlePlayerIncomingData(data);
        });

        conn.on('close', () => {
            handlePlayerHostDisconnect();
        });

        conn.on('error', (err) => {
            clearTimeout(connectionTimeout);
            console.error('Connection error:', err);
            alert(`Connection error: ${err.message}`);
            btn.innerText = originalText;
            btn.disabled = false;
        });
    });

    peer.on('error', (err) => {
        clearTimeout(connectionTimeout);
        alert(`Signaling connection error: ${err.message}`);
        btn.innerText = originalText;
        btn.disabled = false;
    });
});

document.getElementById('btn-init-spectator').addEventListener('click', () => {
    initAudio();
    if (typeof Peer === 'undefined') {
        alert("PeerJS signaling library failed to load from CDN. Please check your network connection or try reloading the page.");
        return;
    }
    if (!window.RTCPeerConnection) {
        alert("WebRTC is not supported in this browser.");
        return;
    }

    const nameInput = document.getElementById('input-spectator-name').value.trim();
    const roomIdInput = document.getElementById('input-spectator-room-id').value.trim().toUpperCase();

    if (!roomIdInput) {
        alert('Please enter a valid Room ID.');
        return;
    }

    myUsername = nameInput || `Viewer-${Math.floor(1000 + Math.random() * 9000)}`;
    isHost = false;
    isSpectator = true;

    const btn = document.getElementById('btn-init-spectator');
    const originalText = btn.innerText;
    btn.innerText = 'CONNECTING AS SPECTATOR...';
    btn.disabled = true;

    peer = new Peer(null, getPeerOptions());

    let connectionTimeout = setTimeout(() => {
        alert('Connection timed out. Check Room ID or Host status.');
        btn.innerText = originalText;
        btn.disabled = false;
        if (peer) peer.destroy();
    }, 10000);

    peer.on('open', (myPeerId) => {
        console.log(`Local Spectator Peer created: ${myPeerId}`);
        const conn = peer.connect(roomIdInput, { reliable: true });
        hostConnection = conn;

        conn.on('open', () => {
            clearTimeout(connectionTimeout);
            conn.send({
                type: 'JOIN',
                role: 'spectator',
                username: myUsername,
                clientId: myClientId,
                deviceId: myDeviceId,
                password: null
            });
        });

        conn.on('data', (data) => {
            handlePlayerIncomingData(data);
        });

        conn.on('close', () => {
            handlePlayerHostDisconnect();
        });

        conn.on('error', (err) => {
            clearTimeout(connectionTimeout);
            console.error('Connection error:', err);
            alert(`Spectator connection error: ${err.message}`);
            btn.innerText = originalText;
            btn.disabled = false;
        });
    });

    peer.on('error', (err) => {
        clearTimeout(connectionTimeout);
        alert(`Signaling error: ${err.message}`);
        btn.innerText = originalText;
        btn.disabled = false;
    });
});

// ==========================================
// USER INTERFACE UTILITIES
// ==========================================
function switchScreen(screenId) {
    document.querySelectorAll('.screen-container').forEach(el => {
        el.classList.remove('screen-active');
    });
    document.getElementById(screenId).classList.add('screen-active');
}

function switchHostDirectoryTab(tab) {
    activeDirectoryTab = tab;
    const pBtn = document.getElementById('tab-host-players');
    const tBtn = document.getElementById('tab-host-teams');
    const pTable = document.getElementById('host-players-table');
    const tTable = document.getElementById('host-teams-table');
    if (!pBtn || !tBtn || !pTable || !tTable) return;

    if (tab === 'players') {
        pBtn.classList.add('tab-active');
        tBtn.classList.remove('tab-active');
        pTable.style.display = 'table';
        tTable.style.display = 'none';
    } else {
        pBtn.classList.remove('tab-active');
        tBtn.classList.add('tab-active');
        pTable.style.display = 'none';
        tTable.style.display = 'table';
    }
}

function switchPlayerDirectoryTab(tab) {
    activeDirectoryTab = tab;
    const pBtn = document.getElementById('tab-player-players');
    const tBtn = document.getElementById('tab-player-teams');
    const pTable = document.getElementById('player-players-table');
    const tTable = document.getElementById('player-teams-table');
    if (!pBtn || !tBtn || !pTable || !tTable) return;

    if (tab === 'players') {
        pBtn.classList.add('tab-active');
        tBtn.classList.remove('tab-active');
        pTable.style.display = 'table';
        tTable.style.display = 'none';
    } else {
        pBtn.classList.remove('tab-active');
        tBtn.classList.add('tab-active');
        pTable.style.display = 'none';
        tTable.style.display = 'table';
    }
}

function switchSpectatorDirectoryTab(tab) {
    activeDirectoryTab = tab;
    const pBtn = document.getElementById('tab-spectator-players');
    const tBtn = document.getElementById('tab-spectator-teams');
    const pTable = document.getElementById('spectator-players-table');
    const tTable = document.getElementById('spectator-teams-table');
    if (!pBtn || !tBtn || !pTable || !tTable) return;

    if (tab === 'players') {
        pBtn.classList.add('tab-active');
        tBtn.classList.remove('tab-active');
        pTable.style.display = 'table';
        tTable.style.display = 'none';
    } else {
        pBtn.classList.remove('tab-active');
        tBtn.classList.add('tab-active');
        pTable.style.display = 'none';
        tTable.style.display = 'table';
    }
}

function syncDirectoryTabsVisibility() {
    const displayStyle = settings.teamMode ? 'flex' : 'none';
    const hostTabs = document.getElementById('host-directory-tabs');
    const playerTabs = document.getElementById('player-directory-tabs');
    const specTabs = document.getElementById('spectator-directory-tabs');
    
    if (hostTabs) hostTabs.style.display = displayStyle;
    if (playerTabs) playerTabs.style.display = displayStyle;
    if (specTabs) specTabs.style.display = displayStyle;

    if (!settings.teamMode) {
        switchHostDirectoryTab('players');
        switchPlayerDirectoryTab('players');
        switchSpectatorDirectoryTab('players');
    }
}

let spectatorRotationInterval = null;
function startSpectatorTabRotation() {
    if (spectatorRotationInterval) clearInterval(spectatorRotationInterval);
    spectatorRotationInterval = setInterval(() => {
        if (!isSpectator || !settings.teamMode) return;
        const nextTab = activeDirectoryTab === 'players' ? 'teams' : 'players';
        switchSpectatorDirectoryTab(nextTab);
    }, 8000);
}

function switchRoleTab(tab) {
    const roles = ['host', 'reclaim', 'play', 'spectate'];
    roles.forEach(r => {
        const btn = document.getElementById(`btn-role-tab-${r}`);
        const content = document.getElementById(`role-tab-${r}`);
        if (r === tab) {
            if (btn) btn.classList.add('tab-active');
            if (content) content.classList.add('tab-content-active');
        } else {
            if (btn) btn.classList.remove('tab-active');
            if (content) content.classList.remove('tab-content-active');
        }
    });
}

function toggleAdvancedSignaling() {
    const panel = document.getElementById('advanced-sig-panel');
    const arrow = document.getElementById('advanced-sig-arrow');
    if (!panel) return;
    if (panel.style.display === 'none') {
        panel.style.display = 'flex';
        if (arrow) arrow.innerText = '▼';
    } else {
        panel.style.display = 'none';
        if (arrow) arrow.innerText = '▶';
    }
}

function applyPlayerTheme(colorName) {
    const playerScreen = document.getElementById('player-screen');
    if (!playerScreen) return;
    
    const colors = {
        green: { primary: '#00ff66', dim: 'rgba(0, 255, 102, 0.08)', glow: 'rgba(0, 255, 102, 0.35)' },
        amber: { primary: '#ffb300', dim: 'rgba(255, 179, 0, 0.08)', glow: 'rgba(255, 179, 0, 0.25)' },
        red: { primary: '#ff3333', dim: 'rgba(255, 51, 51, 0.08)', glow: 'rgba(255, 51, 51, 0.25)' },
        cyan: { primary: '#00f0ff', dim: 'rgba(0, 240, 255, 0.08)', glow: 'rgba(0, 240, 255, 0.35)' },
        magenta: { primary: '#ff00f0', dim: 'rgba(255, 0, 240, 0.08)', glow: 'rgba(255, 0, 240, 0.35)' }
    };
    
    const theme = colors[colorName] || colors.amber;
    
    playerScreen.style.setProperty('--player-accent', theme.primary);
    playerScreen.style.setProperty('--player-accent-dim', theme.dim);
    playerScreen.style.setProperty('--player-accent-glow', theme.glow);
}

/**
 * Appends entries to the Host's dashboard terminal logs.
 * Excludes heartbeat traffic (Ping/Pong) to keep logs clean and readable.
 */
function logTerminal(tag, message) {
    const container = document.getElementById('host-terminal-log');
    if (!container) return;

    const timeStr = new Date().toTimeString().split(' ')[0];
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    
    let tagColor = 'var(--text-muted)';
    if (tag === 'JOIN' || tag === 'CORRECT') tagColor = 'var(--accent-green)';
    if (tag === 'LEAVE' || tag === 'INCORRECT' || tag === 'CONN_ERR' || tag === 'CONFLICT') tagColor = 'var(--accent-red)';
    if (tag === 'BUZZ') tagColor = 'var(--accent-amber)';

    entry.innerHTML = `
        <span class="log-time">[${timeStr}]</span>
        <span class="log-tag" style="color: ${tagColor};">[${tag}]</span>
        <span class="log-body">${escapeHTML(message)}</span>
    `;
    
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;
}

function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, 
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
}

function copyRoomId() {
    if (!activeRoomId) return;
    navigator.clipboard.writeText(activeRoomId).then(() => {
        const tooltip = document.getElementById('copy-tooltip');
        tooltip.style.display = 'inline';
        setTimeout(() => { tooltip.style.display = 'none'; }, 2000);
    });
}

function showInviteModal() {
    if (!activeRoomId) return;
    const modal = document.getElementById('modal-room-invite');
    const input = document.getElementById('invite-url-input');
    const qrDiv = document.getElementById('qr-canvas');
    if (!modal || !input || !qrDiv) return;

    let inviteUrl = `${window.location.origin}${window.location.pathname}?room=${activeRoomId}`;
    input.value = inviteUrl;

    qrDiv.innerHTML = '';
    if (typeof QRCode !== 'undefined') {
        try {
            new QRCode(qrDiv, {
                text: inviteUrl,
                width: 160,
                height: 160,
                colorDark : "#0c0c14",
                colorLight : "#ffffff",
                correctLevel : QRCode.CorrectLevel.M
            });
        } catch(e) {
            qrDiv.innerText = 'QR Canvas error';
        }
    } else {
        qrDiv.innerText = 'QR Code library offline. Share URL below.';
        qrDiv.style.color = '#333';
        qrDiv.style.fontSize = '0.75rem';
    }

    modal.style.display = 'flex';
}

function closeInviteModal() {
    const modal = document.getElementById('modal-room-invite');
    if (modal) modal.style.display = 'none';
}

function copyInviteUrl() {
    const input = document.getElementById('invite-url-input');
    if (!input || !input.value) return;
    navigator.clipboard.writeText(input.value).then(() => {
        const copyBtn = input.nextElementSibling;
        if (copyBtn) {
            const orig = copyBtn.innerText;
            copyBtn.innerText = 'COPIED!';
            setTimeout(() => { copyBtn.innerText = orig; }, 2000);
        }
    });
}

// ==========================================
// HOST INCOMING MESSAGE ROUTING
// ==========================================
function handleHostIncomingData(conn, data) {
    if (!data || !data.type) return;

    // Filter heartbeat pings from logging to prevent pollution
    if (data.type === 'PING') {
        handleHostPing(conn, data);
        return;
    }
    
    // NTP Time sync handshake responder
    if (data.type === 'TIME_SYNC') {
        sendFastOrReliable(conn, data.clientId, {
            type: 'TIME_SYNC_REPLY',
            clientTx: data.clientTx,
            hostRx: Date.now(),
            hostTx: Date.now()
        });
        return;
    }

    if (data.type === 'JOIN') {
        if (data.role === 'spectator') {
            handleHostSpectatorJoin(conn, data);
        } else {
            handleHostPlayerJoin(conn, data);
        }
        return;
    }

    if (data.type === 'BUZZ') {
        handleHostBuzz(data);
        return;
    }

    if (data.type === 'TOGGLE_DOUBLE_DOWN') {
        if (scores[data.clientId]) {
            scores[data.clientId].doubleDownActive = data.active;
            if (data.active) {
                scores[data.clientId].shieldActive = false;
            }
            broadcastRoster();
        }
        return;
    }

    if (data.type === 'TOGGLE_SHIELD') {
        if (scores[data.clientId]) {
            if (scores[data.clientId].shieldCooldown > 0 && data.active) {
                return; // Block activation if on cooldown
            }
            scores[data.clientId].shieldActive = data.active;
            if (data.active) {
                scores[data.clientId].doubleDownActive = false;
            }
            broadcastRoster();
        }
        return;
    }
}

function handleHostConnectionClose(conn) {
    let foundClientId = null;
    let isPlayer = true;

    for (let cid in playerConnections) {
        if (playerConnections[cid] === conn) {
            foundClientId = cid;
            break;
        }
    }

    if (!foundClientId) {
        for (let cid in spectatorConnections) {
            if (spectatorConnections[cid] === conn) {
                foundClientId = cid;
                isPlayer = false;
                break;
            }
        }
    }

    if (foundClientId) {
        if (isPlayer) {
            if (scores[foundClientId]) {
                logTerminal('DISCONNECTED', `Player ${scores[foundClientId].username} closed connection.`);
            }
        } else {
            if (spectators[foundClientId]) {
                logTerminal('DISCONNECTED', `Spectator ${spectators[foundClientId].username} disconnected.`);
                delete spectatorConnections[foundClientId];
                delete spectators[foundClientId];
                broadcastRoster();
            }
        }
    }
}

function handleHostSpectatorJoin(conn, data) {
    const incomingClientId = data.clientId;
    const incomingName = (data.username || 'Spectator').trim().substring(0, 12);

    spectatorConnections[incomingClientId] = conn;
    spectators[incomingClientId] = {
        username: incomingName,
        status: 'online',
        lastPing: Date.now()
    };

    conn.send({
        type: 'JOIN_SUCCESS',
        role: 'spectator',
        clientId: incomingClientId,
        username: incomingName,
        settings: settings
    });

    logTerminal('SPECTATOR', `Spectator "${incomingName}" connected.`);
    broadcastRoster();
    broadcastState();
}

/**
 * Processes incoming Player handshake request.
 * Enforces name uniqueness for active players, handles re-connections (same or new client ID),
 * and safely splits duplicated tabs sharing sessionStorage IDs.
 */
function handleHostPlayerJoin(conn, data) {
    let incomingClientId = data.clientId;
    const incomingName = (data.username || 'PLAYER').trim().substring(0, 10);
    const incomingDeviceId = data.deviceId;
    const incomingColor = data.color || 'amber';

    // 0a. Check if player, device, or username is banned from this room
    if (bannedClients[incomingClientId] || (incomingDeviceId && bannedDevices[incomingDeviceId]) || bannedUsernames[incomingName.toLowerCase()]) {
        conn.send({
            type: 'JOIN_REJECT',
            reason: 'You have been kicked and banned from this room.'
        });
        logTerminal('BAN_BLOCK', `Blocked join attempt from kicked player "${incomingName}".`);
        return;
    }

    // 0b. Check Room Password
    const roomPassword = settings.password ? settings.password.trim() : '';
    if (roomPassword) {
        if (!data.password) {
            conn.send({
                type: 'PASSWORD_REQUIRED'
            });
            logTerminal('PROMPT', `Prompted "${incomingName}" for room password.`);
            return;
        } else if (data.password !== roomPassword) {
            conn.send({
                type: 'PASSWORD_INCORRECT'
            });
            logTerminal('REJECT', `Rejected join for "${incomingName}" (Incorrect password).`);
            return;
        }
    }

    // 1. Split duplicated tabs sharing a sessionStorage client ID under a DIFFERENT username
    if (scores[incomingClientId]) {
        const existingName = scores[incomingClientId].username;
        if (existingName.toLowerCase() !== incomingName.toLowerCase()) {
            incomingClientId = 'c-' + Math.random().toString(36).substring(2, 11);
            logTerminal('CONFLICT', `Client ID conflict for "${incomingName}" (shared ID with "${existingName}"). Reassigned new ID: ${incomingClientId}`);
        }
    }

    // 2. Check if the username is already registered in the directory
    let existingRecordClientId = null;
    for (let cid in scores) {
        if (scores[cid].username.toLowerCase() === incomingName.toLowerCase()) {
            existingRecordClientId = cid;
            break;
        }
    }

    if (existingRecordClientId) {
        const existingRecord = scores[existingRecordClientId];
        const oldConn = playerConnections[existingRecordClientId];
        const isConnAlive = (existingRecord.status === 'online') && oldConn && oldConn.open && (Date.now() - existingRecord.lastPing < 5000);

        if (isConnAlive) {
            // Player is genuinely online and actively connected right now: REJECT duplicate join
            conn.send({
                type: 'JOIN_REJECT',
                reason: 'Username already active in game.'
            });
            logTerminal('REJECT', `Rejected join attempt for active username "${incomingName}".`);
            return;
        }

        // Player is OFFLINE (or connection dead): RECONNECT & rebind profile if client ID changed!
        if (existingRecordClientId !== incomingClientId) {
            // Client ID changed (e.g., cleared sessionStorage, new tab, browser restart)
            // Transfer profile record to the new Client ID
            scores[incomingClientId] = existingRecord;
            delete scores[existingRecordClientId];
            if (playerConnections[existingRecordClientId]) {
                delete playerConnections[existingRecordClientId];
            }
            logTerminal('REBIND', `Rebound profile for "${incomingName}" to new session ID [${incomingClientId}].`);
        }

        playerConnections[incomingClientId] = conn;
        scores[incomingClientId].status = 'online';
        scores[incomingClientId].lastPing = Date.now();
        scores[incomingClientId].disconnectTime = null;
        scores[incomingClientId].color = incomingColor;
        scores[incomingClientId].team = data.teamName || '';

        conn.send({
            type: 'JOIN_SUCCESS',
            settings: settings,
            clientId: incomingClientId,
            username: incomingName
        });

        logTerminal('JOIN', `${incomingName} reconnected.`);
        broadcastRoster();
        broadcastState();
        saveHostStateToStorage();
        return;
    }

    // 3. Brand new registration
    playerConnections[incomingClientId] = conn;
    scores[incomingClientId] = {
        username: incomingName,
        team: data.teamName || '',
        score: 0,
        streak: 0,
        status: 'online',
        lastPing: Date.now(),
        disconnectTime: null,
        doubleDownActive: false,
        shieldActive: false,
        shieldCooldown: 0,
        deviceId: incomingDeviceId,
        color: incomingColor,
        stats: {
            buzzReactionTimes: [],
            correctCount: 0,
            incorrectCount: 0,
            maxStreak: 0,
            maxColdStreak: 0,
            doubleDownCount: 0,
            backupDeltas: []
        }
    };

    conn.send({
        type: 'JOIN_SUCCESS',
        settings: settings,
        clientId: incomingClientId,
        username: incomingName
    });

    logTerminal('JOIN', `${incomingName} registered to room.`);
    broadcastRoster();

    // Send late-joined notification if round is in progress
    if (roundStatus !== 'idle') {
        conn.send({
            type: 'LATE_JOIN_WARNING'
        });
    }

    broadcastState();
    saveHostStateToStorage();
}

function sendFastOrReliable(conn, clientId, msg) {
    if (clientId && fastConnections[clientId] && fastConnections[clientId].open) {
        fastConnections[clientId].send(msg);
    } else if (conn && conn.open) {
        conn.send(msg);
    }
}

function handleHostPing(conn, data) {
    const cid = data.clientId;
    if (scores[cid]) {
        scores[cid].lastPing = Date.now();
        scores[cid].status = 'online';
        
        // Update player ping latency on the Host Scoreboard
        const pingEl = document.getElementById(`ping-val-${cid}`);
        if (pingEl && data.lastRtt !== undefined) {
            pingEl.innerText = `${data.lastRtt}ms`;
        }
    }
    sendFastOrReliable(conn, cid, { type: 'PONG', timestamp: data.timestamp });
}

// ==========================================
// HOST ENGINE BROADCAST HOOKS
// ==========================================
function broadcast(msg) {
    for (let cid in playerConnections) {
        const conn = playerConnections[cid];
        if (conn && conn.open) {
            conn.send(msg);
        }
    }
    for (let cid in spectatorConnections) {
        const conn = spectatorConnections[cid];
        if (conn && conn.open) {
            conn.send(msg);
        }
    }
}

function broadcastRoster() {
    const list = Object.keys(scores).map(cid => ({
        clientId: cid,
        username: scores[cid].username,
        team: scores[cid].team || '',
        score: scores[cid].score,
        streak: scores[cid].streak,
        status: scores[cid].status,
        doubleDownActive: scores[cid].doubleDownActive,
        shieldActive: scores[cid].shieldActive || false,
        shieldCooldown: scores[cid].shieldCooldown || 0,
        color: scores[cid].color || 'amber'
    }));

    const specList = Object.keys(spectators).map(cid => ({
        clientId: cid,
        username: spectators[cid].username,
        status: spectators[cid].status
    }));

    const onlineCount = list.filter(p => p.status === 'online').length;
    document.getElementById('host-peer-count').innerText = onlineCount;

    updateSpectatorListsUI(specList);

    broadcast({
        type: 'ROSTER_UPDATE',
        roster: list,
        spectators: specList
    });

    updateHostDirectoryUI(list);
    updateTeamsStandingsUI(list);
    syncDirectoryTabsVisibility();
}

function updateSpectatorListsUI(specList) {
    const listText = specList.length === 0 ? 'NONE' : specList.map(s => s.username).join(', ');
    const displayStyle = specList.length === 0 ? 'none' : 'block';

    ['host', 'player', 'spectator'].forEach(role => {
        const container = document.getElementById(`${role}-spectators-container`);
        const listSpan = document.getElementById(`${role}-spectator-list`);
        if (container) container.style.display = displayStyle;
        if (listSpan) listSpan.innerText = listText;
    });
}

function updateTeamsStandingsUI(list) {
    const teamMap = {};
    list.forEach(p => {
        const teamName = p.team || p.username; // Fallback to username for solo players
        if (!teamMap[teamName]) {
            teamMap[teamName] = { score: 0, members: [], online: false };
        }
        teamMap[teamName].score += p.score;
        teamMap[teamName].members.push(p.username);
        if (p.status === 'online') {
            teamMap[teamName].online = true;
        }
    });

    const sortedTeams = Object.keys(teamMap).map(name => ({
        name: name,
        score: teamMap[name].score,
        members: teamMap[name].members,
        online: teamMap[name].online
    })).sort((a, b) => b.score - a.score);

    ['host', 'player', 'spectator'].forEach(role => {
        const tbodyId = `${role}-teams-tbody`;
        const tbody = document.getElementById(tbodyId);
        if (!tbody) return;
        tbody.innerHTML = '';

        sortedTeams.forEach((t, i) => {
            const tr = document.createElement('tr');
            if (!t.online) {
                tr.className = 'player-row-offline';
            }
            
            const rankBadge = `<span style="font-weight:bold; color:var(--accent-amber)">#${i + 1}</span>`;
            const tooltipText = `Members: ${t.members.join(', ')}`;
            const scoreVal = settings.hideScores ? '<span style="color: var(--accent-amber); font-weight:bold;">???</span>' : `<span style="font-weight:bold;">${t.score}</span>`;

            tr.innerHTML = `
                <td>${rankBadge}</td>
                <td>
                    <span style="font-weight:bold; cursor:help; border-bottom: 1px dashed var(--text-muted);" title="${escapeHTML(tooltipText)}">${escapeHTML(t.name)}</span>
                </td>
                <td style="text-align:right; font-family:var(--font-terminal);">${scoreVal}</td>
            `;
            tbody.appendChild(tr);
        });
    });
}

function updateHostDirectoryUI(list) {
    const tbody = document.getElementById('host-directory-tbody');
    tbody.innerHTML = '';
    
    list.forEach(p => {
        const tr = document.createElement('tr');
        if (p.status === 'offline') {
            tr.className = 'player-row-offline'; // Fade out offline players
        }

        let streakText = '';
        if (p.streak >= 2) {
            streakText = `<span class="streak-indicator" style="color: var(--accent-amber);">🔥${p.streak}</span>`;
        } else if (p.streak <= -1) {
            streakText = `<span class="streak-indicator" style="color: #66ccff;">❄️${p.streak}</span>`;
        }

        const doubleText = p.doubleDownActive ? '⚡' : '';
        const shieldText = p.shieldActive ? '🛡️' : '';

        tr.innerHTML = `
            <td>
                <span class="status-dot ${p.status === 'online' ? 'status-dot-online' : 'status-dot-offline'}" title="Player is ${p.status}"></span>
            </td>
            <td>
                <div class="player-name-container">
                    <span class="player-name-text player-color-${p.color || 'amber'}" title="${escapeHTML(p.username)}">${escapeHTML(p.username)}</span>
                    ${streakText}
                    ${doubleText}
                    ${shieldText}
                </div>
            </td>
            <td style="text-align: right;"><span style="font-weight:bold;">${p.score}</span></td>
            <td id="ping-val-${p.clientId}" style="text-align: center; font-size: 0.72rem; color: var(--text-muted);">--ms</td>
            <td style="text-align: right; white-space: nowrap;">
                <button class="btn-action-sm" title="Edit Score & Streak" onclick="openEditModal('${p.clientId}')">✏️</button>
                <button class="btn-action-sm" title="Kick & Ban Player" style="color: var(--accent-red); border-color: var(--accent-red);" onclick="hostKickPlayer('${p.clientId}')">❌</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function broadcastState() {
    const mappedQueue = buzzQueue.map(item => ({
        clientId: item.clientId,
        username: item.username,
        buzzTime: item.buzzTime,
        color: (scores[item.clientId] && scores[item.clientId].color) || 'amber'
    }));

    broadcast({
        type: 'STATE_UPDATE',
        roundStatus: roundStatus,
        currentRound: currentRound,
        queue: mappedQueue,
        lockoutActive: lockoutActive,
        timeRemaining: timeRemaining,
        settings: settings
    });

    updateHostUI();
}

function updateHostUI() {
    const label = document.getElementById('host-round-state');
    label.className = 'status-current';
    
    if (roundStatus === 'idle') {
        label.innerText = 'STANDBY';
        label.classList.add('text-glow-amber');
    } else if (roundStatus === 'active') {
        label.innerText = 'BUZZERS ARMED';
        label.classList.add('text-glow-green');
    } else if (roundStatus === 'hotseat') {
        const hotseatName = buzzQueue[0] ? buzzQueue[0].username : 'UNKNOWN';
        const timeIsUp = (timeRemaining <= 0 && settings.timed);
        if (timeIsUp) {
            label.innerText = `HOTSEAT: ${hotseatName} (EXPIRED)`;
            label.classList.add('text-glow-red');
        } else {
            label.innerText = `HOTSEAT: ${hotseatName}`;
            label.classList.add('text-glow-green');
        }
    }

    // Render active buzz queue
    const qList = document.getElementById('host-queue-list');
    qList.innerHTML = '';

    buzzQueue.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'queue-item';
        if (index === 0) {
            div.classList.add('hotseat-item');
        }

        let deltaStr = '';
        if (index > 0) {
            const delta = item.buzzTime - buzzQueue[0].buzzTime;
            deltaStr = `+${delta.toFixed(0)}ms`; // Show millisecond difference relative to first place
        } else {
            deltaStr = '1st BUZZ';
        }

        const pProfile = scores[item.clientId];
        const pColor = pProfile ? (pProfile.color || 'amber') : 'amber';
        const colorClass = `player-color-${pColor}`;

        div.innerHTML = `
            <div style="display:flex; align-items:center;">
                <span class="queue-index">#${index + 1}</span>
                <span class="${colorClass}" style="font-weight:bold;">${escapeHTML(item.username)}</span>
            </div>
            <span class="queue-timestamp">${deltaStr}</span>
        `;
        qList.appendChild(div);
    });

    // Update Lockout Badge indicator
    const lockBad = document.getElementById('queue-lockout-indicator');
    if (roundStatus === 'active') {
        lockBad.style.display = 'inline-block';
        lockBad.className = 'status-badge status-online';
        lockBad.innerText = 'BUZZ OPEN';
    } else if (roundStatus === 'hotseat') {
        lockBad.style.display = 'inline-block';
        if (lockoutActive) {
            lockBad.className = 'status-badge status-online';
            lockBad.style.borderColor = 'var(--accent-amber)';
            lockBad.style.color = 'var(--accent-amber)';
            lockBad.innerText = 'LOCKOUT OPEN';
        } else {
            lockBad.className = 'status-badge status-offline';
            lockBad.innerText = 'LOCKOUT EXPIRED';
        }
    } else {
        lockBad.style.display = 'none';
    }

    // host control button enabling/disabling states
    document.getElementById('btn-mark-correct').disabled = (roundStatus !== 'hotseat');
    document.getElementById('btn-mark-incorrect').disabled = (roundStatus !== 'hotseat');

    // UX Protection: Disable settings inputs while round is active
    const settingsEnabled = (roundStatus === 'idle');
    document.getElementById('host-toggle-timed').disabled = !settingsEnabled;
    document.getElementById('host-toggle-doubledown').disabled = !settingsEnabled;
    document.getElementById('host-toggle-streaks').disabled = !settingsEnabled;
    document.getElementById('host-timer-duration').disabled = !settingsEnabled || !settings.timed;
    if (document.getElementById('host-points-correct')) document.getElementById('host-points-correct').disabled = !settingsEnabled;
    if (document.getElementById('host-points-incorrect')) document.getElementById('host-points-incorrect').disabled = !settingsEnabled;
    if (document.getElementById('host-toggle-hidescores')) document.getElementById('host-toggle-hidescores').disabled = !settingsEnabled;
    if (document.getElementById('btn-show-stats')) document.getElementById('btn-show-stats').disabled = !settingsEnabled;
    if (document.getElementById('btn-clear-scoreboard')) document.getElementById('btn-clear-scoreboard').disabled = !settingsEnabled;
}

// ==========================================
// HOST ENGINE ACTION HANDLERS
// ==========================================
function transitionRoundState(nextState) {
    const validTransitions = {
        'idle': ['active', 'hotseat'],
        'active': ['idle', 'hotseat'],
        'hotseat': ['idle', 'active']
    };
    if (roundStatus === nextState) return true;
    if (validTransitions[roundStatus] && validTransitions[roundStatus].includes(nextState)) {
        logTerminal('STATE', `Round state transitioned: ${roundStatus.toUpperCase()} -> ${nextState.toUpperCase()}`);
        roundStatus = nextState;
        return true;
    }
    logTerminal('STATE_ERR', `Invalid round state transition blocked: ${roundStatus} -> ${nextState}`);
    return false;
}

function hostStartRound() {
    if (timerInterval) clearInterval(timerInterval);
    buzzQueue = [];
    lockoutActive = false;
    if (lockoutTimer) clearTimeout(lockoutTimer);

    // Decrement shield cooldowns for all players
    for (let cid in scores) {
        if (scores[cid].shieldCooldown > 0) {
            scores[cid].shieldCooldown -= 1;
        }
    }

    transitionRoundState('active');
    roundStartTime = Date.now();
    
    if (settings.timed) {
        timeRemaining = parseFloat(document.getElementById('host-timer-duration').value) || 10;
    } else {
        timeRemaining = 0;
    }

    updateTimerDisplay(timeRemaining);
    logTerminal('GAME', `Round ${currentRound} started. Buzzers armed.`);
    
    broadcastRoster();
    broadcast({
        type: 'ROUND_START',
        settings: settings,
        timeRemaining: timeRemaining
    });
    broadcastState();
    saveHostStateToStorage();
}

function hostClearBuzzers() {
    stopGameTimers();
    buzzQueue = [];
    lockoutActive = false;
    transitionRoundState('idle');
    timeRemaining = 0;
    updateTimerDisplay(0);

    // Reset active modifiers for next round during Standby
    for (let cid in scores) {
        scores[cid].doubleDownActive = false;
        scores[cid].shieldActive = false;
    }

    logTerminal('GAME', 'Buzzers cleared. Returning to standby.');
    broadcastRoster();
    broadcastState();
    saveHostStateToStorage();
}

function hostClearScoreboard() {
    // Preserve connection sessions and usernames, reset scores/streaks & stats to zero
    for (let cid in scores) {
        scores[cid].score = 0;
        scores[cid].streak = 0;
        scores[cid].doubleDownActive = false;
        scores[cid].shieldActive = false;
        scores[cid].shieldCooldown = 0;
        scores[cid].stats = {
            buzzReactionTimes: [],
            correctCount: 0,
            incorrectCount: 0,
            maxStreak: 0,
            maxColdStreak: 0,
            doubleDownCount: 0,
            backupDeltas: []
        };
    }
    logTerminal('ADMIN', 'Scoreboard & stats cleared (names preserved).');
    broadcastRoster();
    saveHostStateToStorage();
}

/**
 * Host Kick & Ban player handler.
 * Closes WebRTC data channel and adds Client ID, Device ID, and Username to ban lists.
 */
function hostKickPlayer(clientId) {
    const profile = scores[clientId];
    if (!profile) return;

    if (!confirm(`Are you sure you want to kick and ban "${profile.username}" from this room?`)) return;

    const username = profile.username;
    const deviceId = profile.deviceId;

    // Register ban records
    bannedClients[clientId] = true;
    if (deviceId) bannedDevices[deviceId] = true;
    bannedUsernames[username.toLowerCase()] = true;

    // Send kick message over connection then terminate
    const conn = playerConnections[clientId];
    if (conn && conn.open) {
        conn.send({
            type: 'KICKED',
            reason: 'You were kicked by the Host.'
        });
        conn.close();
    }

    delete playerConnections[clientId];
    delete scores[clientId];

    // Remove from active buzz queue if present
    buzzQueue = buzzQueue.filter(item => item.clientId !== clientId);

    logTerminal('KICK', `Kicked and banned player "${username}" from room.`);
    broadcastRoster();
    broadcastState();
    saveHostStateToStorage();
}

// ==========================================
// HOST SCORE & STREAK EDIT MODAL HANDLERS
// ==========================================
let activeEditingClientId = null;

function openEditModal(clientId) {
    const profile = scores[clientId];
    if (!profile) return;

    activeEditingClientId = clientId;
    document.getElementById('modal-edit-username').innerText = profile.username;
    document.getElementById('modal-edit-score').value = profile.score;

    const streakInput = document.getElementById('modal-edit-streak');
    const streakMsg = document.getElementById('modal-edit-streak-msg');

    if (settings.streakMultipliers) {
        streakInput.value = profile.streak;
        streakInput.disabled = false;
        if (streakMsg) streakMsg.style.display = 'none';
    } else {
        streakInput.value = 0;
        streakInput.disabled = true;
        if (streakMsg) streakMsg.style.display = 'inline';
    }

    document.getElementById('modal-edit-player').style.display = 'flex';
}

function closeEditModal() {
    activeEditingClientId = null;
    document.getElementById('modal-edit-player').style.display = 'none';
}

function saveEditPlayer() {
    if (!activeEditingClientId || !scores[activeEditingClientId]) {
        closeEditModal();
        return;
    }

    const profile = scores[activeEditingClientId];
    const newScore = parseInt(document.getElementById('modal-edit-score').value) || 0;
    
    let newStreak = 0;
    if (settings.streakMultipliers) {
        newStreak = parseInt(document.getElementById('modal-edit-streak').value) || 0;
    }

    profile.score = newScore;
    profile.streak = newStreak;

    logTerminal('ADMIN', `Manually adjusted profile for "${profile.username}": Score=${newScore}, Streak=${newStreak}`);

    closeEditModal();
    broadcastRoster();
    broadcastState();
    saveHostStateToStorage();
}

/**
 * Resolves scoring rewards/penalties for the hotseat player.
 */
function hostMarkAnswer(isCorrect) {
    if (buzzQueue.length === 0) return;
    
    // Record backup deltas for this round before we start modifying the queue
    const firstBuzzTime = buzzQueue[0].buzzTime;
    buzzQueue.forEach((item, index) => {
        const p = scores[item.clientId];
        if (p) {
            if (!p.stats) {
                p.stats = {
                    buzzReactionTimes: [],
                    correctCount: 0,
                    incorrectCount: 0,
                    maxStreak: 0,
                    maxColdStreak: 0,
                    doubleDownCount: 0,
                    backupDeltas: []
                };
            }
            if (index > 0) {
                const delta = item.buzzTime - firstBuzzTime;
                p.stats.backupDeltas.push(delta);
            }
        }
    });

    const hotseat = buzzQueue[0];
    const cid = hotseat.clientId;
    const profile = scores[cid];

    if (!profile) return;

    stopGameTimers();

    if (isCorrect) {
        if (!profile.stats) {
            profile.stats = {
                buzzReactionTimes: [],
                correctCount: 0,
                incorrectCount: 0,
                maxStreak: 0,
                maxColdStreak: 0,
                doubleDownCount: 0,
                firstPlaceBuzzCount: 0,
                shieldBlocks: 0,
                pointsLost: 0,
                backupDeltas: []
            };
        }
        profile.stats.correctCount++;

        // Award points
        let points = (settings.correctPoints !== undefined && !isNaN(settings.correctPoints)) ? settings.correctPoints : 10;
        if (profile.doubleDownActive) {
            points *= 2;
        }
        
        if (settings.streakMultipliers) {
            if (profile.streak < 0) {
                profile.streak = 1; // Reset cold streak on correct answer
            } else {
                profile.streak += 1;
            }
            profile.stats.maxStreak = Math.max(profile.stats.maxStreak || 0, profile.streak);
            if (profile.streak >= 2) {
                points *= profile.streak; // Apply linear streak multiplier
            }
        } else {
            profile.streak = 0;
        }

        const wasShielded = !!profile.shieldActive;
        if (wasShielded) {
            points = Math.floor(points * 0.5);
        }

        profile.score += points;
        profile.doubleDownActive = false; // Reset Double Down flag
        profile.shieldActive = false;     // Reset Shield flag

        logTerminal('CORRECT', `${profile.username} answered CORRECTLY! (+${points} pts)${wasShielded ? ' [🛡️ SHIELDED]' : ''}.`);
        
        playCorrect();
        broadcast({ type: 'SOUND_TRIGGER', cue: 'correct' });

        broadcastRoster();
        currentRound += 1;

        // Auto-Start Next Round Instantly
        setTimeout(() => {
            hostStartRound();
        }, 100);

    } else {
        if (!profile.stats) {
            profile.stats = {
                buzzReactionTimes: [],
                correctCount: 0,
                incorrectCount: 0,
                maxStreak: 0,
                maxColdStreak: 0,
                doubleDownCount: 0,
                firstPlaceBuzzCount: 0,
                shieldBlocks: 0,
                pointsLost: 0,
                backupDeltas: []
            };
        }
        profile.stats.incorrectCount++;

        // Penalize points
        let penalty = (settings.incorrectPenalty !== undefined && !isNaN(settings.incorrectPenalty)) ? settings.incorrectPenalty : 5;
        if (profile.doubleDownActive) {
            penalty *= 2;
        }

        if (settings.streakMultipliers) {
            if (profile.streak > 0) {
                profile.streak = -1; // Start cold streak on wrong answer
            } else {
                profile.streak -= 1; // Accumulate cold streak on consecutive wrong answers
            }

            const coldMagnitude = Math.abs(profile.streak);
            profile.stats.maxColdStreak = Math.max(profile.stats.maxColdStreak || 0, coldMagnitude);

            if (coldMagnitude >= 2) {
                penalty *= coldMagnitude; // Scale penalty for cold streaks of 2 or more (e.g. -2, -3)
            }
        } else {
            profile.streak = 0;
        }

        const wasShielded = !!profile.shieldActive;
        if (wasShielded) {
            penalty = 0;
            profile.shieldCooldown = 2;
            profile.stats.shieldBlocks = (profile.stats.shieldBlocks || 0) + 1;
        } else {
            profile.stats.pointsLost = (profile.stats.pointsLost || 0) + penalty;
        }

        profile.score -= penalty; // Score is allowed to go negative
        profile.doubleDownActive = false;
        profile.shieldActive = false;

        logTerminal('INCORRECT', `${profile.username} answered INCORRECTLY.${wasShielded ? ' [🛡️ SHIELD ACTIVE - 0 PTS LOST (COOLDOWN UNTIL ROUND ' + (currentRound + 3) + ')]' : ` (-${penalty} pts).`}`);

        playIncorrect();
        broadcast({ type: 'SOUND_TRIGGER', cue: 'incorrect' });
        broadcastRoster();

        // Pass hotseat to backup queued player
        buzzQueue.shift(); 

        if (buzzQueue.length > 0) {
            const nextHotseat = buzzQueue[0];
            logTerminal('GAME', `Hotseat passed to next queued player: ${nextHotseat.username}`);
            
            transitionRoundState('hotseat');
            if (settings.timed) {
                timeRemaining = parseFloat(document.getElementById('host-timer-duration').value) || 10;
                startAnsweringCountdown();
            } else {
                timeRemaining = 0;
            }
            broadcastState();
        } else {
            transitionRoundState('idle');
            logTerminal('GAME', 'No backup players in queue. Standby.');
            broadcastState();
        }
        saveHostStateToStorage();
    }
}

/**
 * Handles incoming buzz request from players.
 */
function handleHostBuzz(data) {
    const cid = data.clientId;
    const buzzTime = data.buzzTime;

    if (roundStatus !== 'active' && roundStatus !== 'hotseat') return;

    // Prevent duplicate buzz entries
    const alreadyBuzzed = buzzQueue.some(item => item.clientId === cid);
    if (alreadyBuzzed) return;

    const profile = scores[cid];
    if (!profile || profile.status === 'offline') return;

    // Record stats initial skeleton
    if (!profile.stats) {
        profile.stats = {
            buzzReactionTimes: [],
            correctCount: 0,
            incorrectCount: 0,
            maxStreak: 0,
            maxColdStreak: 0,
            doubleDownCount: 0,
            firstPlaceBuzzCount: 0,
            backupDeltas: []
        };
    }

    // Team Mode Buzz Queue filtering
    if (settings.teamMode) {
        const playerTeam = profile.team || profile.username;
        const teamAlreadyQueued = buzzQueue.some(item => {
            const opponentProfile = scores[item.clientId];
            const opponentTeam = opponentProfile ? (opponentProfile.team || opponentProfile.username) : null;
            return opponentTeam === playerTeam;
        });

        if (teamAlreadyQueued) {
            const conn = playerConnections[cid];
            if (conn && conn.open) {
                conn.send({
                    type: 'BUZZ_REJECTED',
                    reason: 'YOUR TEAM ALREADY BUZZED'
                });
            }
            return;
        }
    }

    const reactionTime = buzzTime - roundStartTime;

    const buzzRecord = {
        clientId: cid,
        username: profile.username,
        buzzTime: buzzTime
    };

    playBuzzerHit();
    broadcast({ type: 'SOUND_TRIGGER', cue: 'buzz' });

    if (roundStatus === 'active') {
        // 1. First buzz: Locks hotseat, starts countdown, opens 3s lockout window
        buzzQueue.push(buzzRecord);
        profile.stats.firstPlaceBuzzCount = (profile.stats.firstPlaceBuzzCount || 0) + 1;
        profile.stats.buzzReactionTimes.push(reactionTime);
        if (profile.doubleDownActive) {
            profile.stats.doubleDownCount++;
        }
        transitionRoundState('hotseat');
        
        logTerminal('BUZZ', `${profile.username} BUZZED IN FIRST!`);
        
        lockoutActive = true;
        lockoutTimer = setTimeout(() => {
            lockoutActive = false;
            logTerminal('LOCKOUT', 'Lockout window closed.');
            broadcastState();
        }, 3000);

        if (settings.timed) {
            timeRemaining = parseFloat(document.getElementById('host-timer-duration').value) || 10;
            startAnsweringCountdown();
        }

        broadcastState();

    } else if (roundStatus === 'hotseat' && lockoutActive) {
        // 2. Subsequent buzzes within 3s window: sort queue by absolute clocksync time
        buzzQueue.push(buzzRecord);
        buzzQueue.sort((a, b) => a.buzzTime - b.buzzTime);
        profile.stats.buzzReactionTimes.push(reactionTime);
        if (profile.doubleDownActive) {
            profile.stats.doubleDownCount++;
        }

        logTerminal('BUZZ', `${profile.username} queued in backup position.`);
        broadcastState();
    } else {
        // 3. Buzz received after lockout closes: reject buzz
        const conn = playerConnections[cid];
        if (conn && conn.open) {
            conn.send({
                type: 'BUZZ_REJECTED',
                reason: 'LOCKED OUT'
            });
        }
    }
}

// ==========================================
// HOST ENGINE TIMING LOOPS
// ==========================================
function startAnsweringCountdown() {
    if (timerInterval) clearInterval(timerInterval);
    lastTickTime = Date.now();
    
    timerInterval = setInterval(() => {
        const now = Date.now();
        const delta = (now - lastTickTime) / 1000;
        lastTickTime = now;

        timeRemaining = Math.max(0, timeRemaining - delta);
        updateTimerDisplay(timeRemaining);

        // Play ticking beep during the final 3 seconds
        if (timeRemaining <= 3.0 && timeRemaining > 0) {
            if (Math.abs(timeRemaining - Math.floor(timeRemaining)) < 0.05) {
                playAnsweringTick();
                broadcast({ type: 'SOUND_TRIGGER', cue: 'tick' });
            }
        }

        // On expiration: stop timer, leave incorrect decision to Host
        if (timeRemaining <= 0) {
            clearInterval(timerInterval);
            timeRemaining = 0;
            updateTimerDisplay(0);
            logTerminal('TIMEOUT', 'Answering time expired. Awaiting Host decision.');
            broadcastState();
        }
    }, 50);
}

function stopGameTimers() {
    if (timerInterval) clearInterval(timerInterval);
    if (lockoutTimer) clearTimeout(lockoutTimer);
    lockoutActive = false;
}

function updateTimerDisplay(sec) {
    const text = sec.toFixed(2);
    document.getElementById('host-timer-digits').innerText = text;
    broadcast({
        type: 'TIMER_SYNC',
        timeRemaining: sec
    });
}

function broadcastSettings() {
    const timedEl = document.getElementById('host-toggle-timed');
    const durEl = document.getElementById('host-timer-duration');
    const ddEl = document.getElementById('host-toggle-doubledown');
    const shieldEl = document.getElementById('host-toggle-shield');
    const streakEl = document.getElementById('host-toggle-streaks');
    const cEl = document.getElementById('host-points-correct');
    const iEl = document.getElementById('host-points-incorrect');
    const passEl = document.getElementById('host-room-password');
    const hideEl = document.getElementById('host-toggle-hidescores');
    const teamEl = document.getElementById('host-toggle-teammode');

    if (timedEl) settings.timed = timedEl.checked;
    if (durEl) {
        const dVal = parseInt(durEl.value);
        settings.duration = isNaN(dVal) ? 10 : dVal;
    }
    let rosterChanged = false;
    if (ddEl) {
        const wasDD = settings.doubleDown;
        settings.doubleDown = ddEl.checked;
        if (wasDD && !settings.doubleDown) {
            for (let cid in scores) {
                if (scores[cid].doubleDownActive) {
                    scores[cid].doubleDownActive = false;
                    rosterChanged = true;
                }
            }
        }
    }
    if (shieldEl) {
        const wasShield = settings.shieldMode;
        settings.shieldMode = shieldEl.checked;
        if (wasShield && !settings.shieldMode) {
            for (let cid in scores) {
                if (scores[cid].shieldActive) {
                    scores[cid].shieldActive = false;
                    rosterChanged = true;
                }
            }
        }
    }
    if (streakEl) settings.streakMultipliers = streakEl.checked;
    if (cEl) {
        const val = parseInt(cEl.value);
        settings.correctPoints = isNaN(val) ? 10 : val;
    }
    if (iEl) {
        const val = parseInt(iEl.value);
        settings.incorrectPenalty = isNaN(val) ? 5 : val;
    }
    if (passEl) settings.password = passEl.value.trim();
    if (hideEl) settings.hideScores = hideEl.checked;
    if (teamEl) {
        const wasTeam = settings.teamMode;
        settings.teamMode = teamEl.checked;
        if (wasTeam !== settings.teamMode) {
            rosterChanged = true;
        }
    }

    broadcast({
        type: 'SETTINGS_UPDATE',
        settings: settings
    });
    
    if (rosterChanged) {
        broadcastRoster();
    }
    
    saveHostStateToStorage();
}

function syncHostSettingsUI() {
    const timedEl = document.getElementById('host-toggle-timed');
    const durEl = document.getElementById('host-timer-duration');
    const ddEl = document.getElementById('host-toggle-doubledown');
    const shieldEl = document.getElementById('host-toggle-shield');
    const streakEl = document.getElementById('host-toggle-streaks');
    const cEl = document.getElementById('host-points-correct');
    const iEl = document.getElementById('host-points-incorrect');
    const passEl = document.getElementById('host-room-password');
    const hideEl = document.getElementById('host-toggle-hidescores');

    if (timedEl) timedEl.checked = settings.timed;
    if (durEl) {
        durEl.value = (settings.duration !== undefined) ? settings.duration : 10;
        durEl.disabled = !settings.timed;
    }
    if (ddEl) ddEl.checked = !!settings.doubleDown;
    if (shieldEl) shieldEl.checked = !!settings.shieldMode;
    if (streakEl) streakEl.checked = !!settings.streakMultipliers;
    if (cEl) cEl.value = (settings.correctPoints !== undefined) ? settings.correctPoints : 10;
    if (iEl) iEl.value = (settings.incorrectPenalty !== undefined) ? settings.incorrectPenalty : 5;
    if (passEl) passEl.value = settings.password || '';
    if (hideEl) hideEl.checked = !!settings.hideScores;
    const teamEl = document.getElementById('host-toggle-teammode');
    if (teamEl) teamEl.checked = !!settings.teamMode;
}

function toggleTimedConfig(val) {
    const input = document.getElementById('host-timer-duration');
    if (input) input.disabled = !val;
    broadcastSettings();
}

// ==========================================
// 100ms HEARTBEAT & RECONNECTION GRACE TIMER
// ==========================================
function hostHeartbeatLoop() {
    const now = Date.now();
    let stateChanged = false;

    for (let cid in scores) {
        const record = scores[cid];
        
        // 1. Offline detection: if player ping missing for > 4000ms
        if (record.status === 'online' && (now - record.lastPing > 4000)) {
            record.status = 'offline';
            record.disconnectTime = now;
            logTerminal('OFFLINE', `${record.username} went offline.`);
            stateChanged = true;
        }

        // 2. Reconnection grace: purge players offline for > 5 minutes (300,000ms)
        if (record.status === 'offline' && record.disconnectTime && (now - record.disconnectTime > 300000)) {
            logTerminal('PURGED', `${record.username} purged from lobby (5m grace expired).`);
            delete scores[cid];
            if (playerConnections[cid]) {
                playerConnections[cid].close();
                delete playerConnections[cid];
            }
            stateChanged = true;
        }
    }

    if (stateChanged) {
        broadcastRoster();
    }
}

// ==========================================
// PLAYER MESSAGE ROUTING & UI SYNC
// ==========================================
function handlePlayerIncomingData(data) {
    if (!data || !data.type) return;

    if (data.type === 'PONG') {
        const lat = Date.now() - data.timestamp;
        currentRtt = lat;
        document.getElementById('player-hud-rtt').innerText = `${lat}ms`;
        return;
    }

    // Clocksync NTP math
    if (data.type === 'TIME_SYNC_REPLY') {
        const clientRx = Date.now();
        const clientTx = data.clientTx;
        const hostRx = data.hostRx;
        const hostTx = data.hostTx;

        // Round Trip Time: measures transmission duration
        const rtt = (clientRx - clientTx) - (hostTx - hostRx);
        // Clock Offset: calculates time gap relative to Host clock
        const offset = ((hostRx - clientTx) + (hostTx - clientRx)) / 2;

        syncHistory.push({ timestamp: clientRx, offset, rtt });
        if (syncHistory.length > 10) syncHistory.shift();

        // Sort offsets by minimum RTT to extract the most accurate offset estimate
        const sorted = [...syncHistory].sort((a, b) => a.rtt - b.rtt);
        const bestSample = sorted[0];
        clockOffset = bestSample.offset;
        lastSyncSampleTime = bestSample.timestamp;

        // Linear regression over lowest RTT samples to track clock drift
        let driftRate = 0;
        if (syncHistory.length >= 4) {
            const n = syncHistory.length;
            const meanT = syncHistory.reduce((s, x) => s + x.timestamp, 0) / n;
            const meanO = syncHistory.reduce((s, x) => s + x.offset, 0) / n;
            let num = 0, den = 0;
            for (let i = 0; i < n; i++) {
                num += (syncHistory[i].timestamp - meanT) * (syncHistory[i].offset - meanO);
                den += Math.pow(syncHistory[i].timestamp - meanT, 2);
            }
            if (den > 0) driftRate = num / den;
        }
        clockDriftRate = driftRate;

        document.getElementById('player-hud-offset').innerText = `${clockOffset.toFixed(1)}ms`;
        return;
    }

    if (data.type === 'JOIN_SUCCESS') {
        if (data.settings) {
            settings = data.settings;
            syncPlayerSettingsUI();
            syncDirectoryTabsVisibility();
        }
        myClientId = data.clientId;
        myUsername = data.username;
        sessionStorage.setItem('quiz_buzzer_client_id', myClientId); // Persist ID
        
        document.getElementById('modal-player-password').style.display = 'none';
        
        if (data.role === 'spectator') {
            document.getElementById('spectator-hud-room-id').innerText = hostConnection.peer;
            switchScreen('spectator-screen');
            setInterval(playerHeartbeatLoop, 1000);
            setInterval(playerTimeSyncLoop, 3000);
            playerTimeSyncLoop();
            startSpectatorTabRotation();
            return;
        }

        document.getElementById('player-hud-name').innerText = myUsername;
        document.getElementById('player-hud-room-id').innerText = hostConnection.peer;
        
        // Apply custom terminal theme color accent
        const savedColor = sessionStorage.getItem('quiz_buzzer_player_color') || 'amber';
        applyPlayerTheme(savedColor);

        switchScreen('player-screen');
        
        // Start heartbeat to Host
        setInterval(playerHeartbeatLoop, 1000);
        
        // Start clocksync schedule (every 3s)
        setInterval(playerTimeSyncLoop, 3000);
        playerTimeSyncLoop();
        return;
    }

    if (data.type === 'PASSWORD_REQUIRED' || data.type === 'PASSWORD_INCORRECT') {
        const btn = document.getElementById('btn-init-player');
        if (btn) {
            btn.innerText = 'CONNECT PEER-TO-PEER';
            btn.disabled = false;
        }
        const modal = document.getElementById('modal-player-password');
        const errDiv = document.getElementById('modal-player-password-error');
        const input = document.getElementById('modal-player-password-input');
        if (modal) {
            modal.style.display = 'flex';
            if (errDiv) errDiv.style.display = (data.type === 'PASSWORD_INCORRECT') ? 'block' : 'none';
            if (input) {
                input.value = '';
                input.focus();
            }
        }
        return;
    }

    if (data.type === 'JOIN_REJECT') {
        document.getElementById('modal-player-password').style.display = 'none';
        alert(`Rejected: ${data.reason}`);
        const btn = document.getElementById('btn-init-player');
        if (btn) {
            btn.innerText = 'CONNECT PEER-TO-PEER';
            btn.disabled = false;
        }
        if (hostConnection) hostConnection.close();
        return;
    }

    if (data.type === 'KICKED') {
        document.getElementById('modal-player-password').style.display = 'none';
        setBuzzerState('disabled');
        document.getElementById('player-status-text').innerText = 'KICKED FROM ROOM';
        document.getElementById('player-status-text').style.color = 'var(--accent-red)';
        showWarningBanner('YOU WERE KICKED BY THE QUIZMASTER');
        if (hostConnection) hostConnection.close();
        return;
    }

    if (data.type === 'ROSTER_UPDATE') {
        lastPlayerRoster = data.roster;
        updatePlayerDirectoryUI(data.roster);
        updateTeamsStandingsUI(data.roster);
        syncDirectoryTabsVisibility();
        if (data.spectators) {
            updateSpectatorListsUI(data.spectators);
        }
        return;
    }

    if (data.type === 'SETTINGS_UPDATE') {
        settings = data.settings;
        syncPlayerSettingsUI();
        syncDirectoryTabsVisibility();
        if (lastPlayerRoster) {
            updatePlayerDirectoryUI(lastPlayerRoster);
            updateTeamsStandingsUI(lastPlayerRoster);
        }
        return;
    }

    if (data.type === 'SHOW_STATS') {
        renderStatsModal(data);
        document.getElementById('modal-game-stats').style.display = 'flex';
        return;
    }

    if (data.type === 'STATE_UPDATE') {
        if (isSpectator) {
            syncSpectatorGameState(data);
        } else {
            syncPlayerGameState(data);
        }
        return;
    }

    if (data.type === 'ROUND_START') {
        if (isSpectator) return;
        document.getElementById('banner-player-warning').classList.remove('show');
        setBuzzerState('armed');
        return;
    }

    if (data.type === 'TIMER_SYNC') {
        if (settings.timed) {
            const timerId = isSpectator ? 'spectator-timer-digits' : 'player-timer-digits';
            const timerDiv = document.getElementById(timerId);
            if (timerDiv) timerDiv.innerText = data.timeRemaining.toFixed(2);
        }
        return;
    }

    if (data.type === 'BUZZ_REJECTED') {
        if (isSpectator) return;
        showWarningBanner(data.reason); // Shows "LOCKED OUT"
        setBuzzerState('disabled');
        return;
    }

    if (data.type === 'LATE_JOIN_WARNING') {
        if (isSpectator) return;
        showWarningBanner('ROUND IN PROGRESS (LATE JOINED)');
        return;
    }

    if (data.type === 'SOUND_TRIGGER') {
        if (data.cue === 'buzz') playBuzzerHit();
        if (data.cue === 'tick') playAnsweringTick();
        if (data.cue === 'correct') playCorrect();
        if (data.cue === 'incorrect') playIncorrect();
        return;
    }
}

function updatePlayerDirectoryUI(list) {
    const tbodyId = isSpectator ? 'spectator-directory-tbody' : 'player-directory-tbody';
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    tbody.innerHTML = '';
    
    list.forEach(p => {
        const tr = document.createElement('tr');
        if (p.status === 'offline') {
            tr.className = 'player-row-offline';
        }

        let streakText = '';
        if (p.streak >= 2) {
            streakText = `<span class="streak-indicator" style="color: var(--accent-amber);">🔥${p.streak}</span>`;
        } else if (p.streak <= -1) {
            streakText = `<span class="streak-indicator" style="color: #66ccff;">❄️${p.streak}</span>`;
        }

        const doubleText = p.doubleDownActive ? '⚡' : '';
        const shieldText = p.shieldActive ? '🛡️' : '';

        const scoreVal = settings.hideScores ? '<span style="color: var(--accent-amber); font-weight:bold;">???</span>' : `<span style="font-weight:bold;">${p.score}</span>`;

        if (isSpectator) {
            tr.innerHTML = `
                <td>
                    <span class="status-badge ${p.status === 'online' ? 'status-online' : 'status-offline'}">${p.status}</span>
                </td>
                <td>
                    <div class="player-name-container">
                        <span class="player-name-text player-color-${p.color || 'amber'}" title="${escapeHTML(p.username)}">${escapeHTML(p.username)}</span>
                        ${streakText}
                    </div>
                </td>
                <td>${scoreVal}</td>
            `;
        } else {
            tr.innerHTML = `
                <td>
                    <span class="status-badge ${p.status === 'online' ? 'status-online' : 'status-offline'}">${p.status}</span>
                </td>
                <td>
                    <div class="player-name-container">
                        <span class="player-name-text player-color-${p.color || 'amber'}" title="${escapeHTML(p.username)}">${escapeHTML(p.username)}</span>
                        ${streakText}
                        ${doubleText}
                        ${shieldText}
                    </div>
                </td>
                <td>${scoreVal}</td>
            `;
        }
        tbody.appendChild(tr);

        // Sync local HUD scores & force Double Down/Shield checkbox reset on round start
        if (!isSpectator && p.clientId === myClientId) {
            const scoreEl = document.getElementById('player-my-score');
            if (scoreEl) {
                if (settings.hideScores) {
                    scoreEl.innerText = '???';
                    scoreEl.style.color = 'var(--accent-amber)';
                } else {
                    scoreEl.innerText = p.score;
                    scoreEl.style.color = 'var(--player-accent)';
                }
            }
            document.getElementById('player-toggle-doubledown').checked = p.doubleDownActive;
            
            const shieldToggle = document.getElementById('player-toggle-shield');
            if (shieldToggle) {
                shieldToggle.checked = p.shieldActive;
                const labelText = shieldToggle.parentNode.querySelector('span');
                if (p.shieldCooldown > 0) {
                    shieldToggle.disabled = true;
                    if (labelText) {
                        labelText.innerText = `SHIELD (CD: ${p.shieldCooldown})`;
                        labelText.style.color = 'var(--accent-red)';
                    }
                } else {
                    if (labelText) {
                        labelText.innerText = 'SHIELD ACTIVE';
                        labelText.style.color = 'var(--text-muted)';
                    }
                    const canToggleShield = settings.shieldMode && (roundStatus === 'idle');
                    shieldToggle.disabled = !canToggleShield;
                }
            }
        }
    });
}

function updatePlayerQueueUI(queue) {
    const qListId = isSpectator ? 'spectator-queue-list' : 'player-queue-list';
    const qList = document.getElementById(qListId);
    if (!qList) return;
    qList.innerHTML = '';

    queue.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'queue-item';
        if (index === 0) {
            div.classList.add('hotseat-item');
        }

        let deltaStr = '';
        if (index > 0) {
            const delta = item.buzzTime - queue[0].buzzTime;
            deltaStr = `+${delta.toFixed(0)}ms`;
        } else {
            deltaStr = '1st BUZZ';
        }

        let pColor = item.color || 'amber';
        const colorClass = `player-color-${pColor}`;

        div.innerHTML = `
            <div style="display:flex; align-items:center;">
                <span class="queue-index">#${index + 1}</span>
                <span class="${colorClass}" style="font-weight:bold;">${escapeHTML(item.username)}</span>
            </div>
            <span class="queue-timestamp">${deltaStr}</span>
        `;
        qList.appendChild(div);
    });
}

function syncPlayerSettingsUI() {
    if (isSpectator) return;
    const doubleContainer = document.getElementById('player-doubledown-container');
    const shieldContainer = document.getElementById('player-shield-container');
    const modifiersDisabledMsg = document.getElementById('player-modifiers-disabled-msg');
    
    const ddToggle = document.getElementById('player-toggle-doubledown');
    const shieldToggle = document.getElementById('player-toggle-shield');
    const scoreEl = document.getElementById('player-my-score');
    
    const canToggleDoubleDown = settings.doubleDown && (roundStatus === 'idle');
    const canToggleShield = settings.shieldMode && (roundStatus === 'idle');

    if (settings.doubleDown) {
        doubleContainer.style.display = 'flex';
    } else {
        doubleContainer.style.display = 'none';
        if (ddToggle) ddToggle.checked = false;
    }

    if (settings.shieldMode) {
        shieldContainer.style.display = 'flex';
    } else {
        shieldContainer.style.display = 'none';
        if (shieldToggle) shieldToggle.checked = false;
    }

    if (!settings.doubleDown && !settings.shieldMode) {
        modifiersDisabledMsg.style.display = 'block';
    } else {
        modifiersDisabledMsg.style.display = 'none';
    }

    if (ddToggle) ddToggle.disabled = !canToggleDoubleDown;
    
    if (shieldToggle) {
        const labelText = shieldToggle.parentNode.querySelector('span');
        const isOnCooldown = labelText && labelText.innerText.includes('CD:');
        if (!isOnCooldown) {
            shieldToggle.disabled = !canToggleShield;
        }
    }

    if (scoreEl && settings.hideScores) {
        scoreEl.innerText = '???';
        scoreEl.style.color = 'var(--accent-amber)';
    }
}

/**
 * Authoritative UI state machine for Player view.
 * Isolates player alerts ("LOCKED OUT", "LATE JOINED") and active hotseat glows.
 */
function syncPlayerGameState(state) {
    roundStatus = state.roundStatus;
    settings = state.settings;
    syncPlayerSettingsUI();
    if (lastPlayerRoster) {
        updatePlayerDirectoryUI(lastPlayerRoster);
        updateTeamsStandingsUI(lastPlayerRoster);
    }
    updatePlayerQueueUI(state.queue);

    const statusText = document.getElementById('player-status-text');
    const hotseatBanner = document.getElementById('banner-player-hotseat');
    const timerDiv = document.getElementById('player-timer-digits');
    
    const hasQueued = state.queue.length > 0;
    const amFirstInQueue = hasQueued && state.queue[0].clientId === myClientId;
    const amInQueue = state.queue.some(item => item.clientId === myClientId);

    // Enable Double Down input ONLY during STANDBY (roundStatus === 'idle')
    const canToggleDoubleDown = settings.doubleDown && (roundStatus === 'idle');
    const ddToggle = document.getElementById('player-toggle-doubledown');
    if (ddToggle) {
        ddToggle.disabled = !canToggleDoubleDown;
    }

    // Active Hotseat Vignette Indicator (Isolated to Player screen)
    if (amFirstInQueue && roundStatus === 'hotseat') {
        document.body.classList.add('hotseat-active');
        hotseatBanner.classList.add('show');
    } else {
        document.body.classList.remove('hotseat-active');
        hotseatBanner.classList.remove('show');
    }

    if (roundStatus === 'hotseat' && settings.timed) {
        timerDiv.style.display = 'block';
    } else {
        timerDiv.style.display = 'none';
    }

    if (roundStatus === 'idle') {
        statusText.innerText = 'STANDBY';
        statusText.style.color = 'var(--text-muted)';
        setBuzzerState('disabled');
        document.getElementById('banner-player-warning').classList.remove('show');
    } else if (roundStatus === 'active') {
        statusText.innerText = 'ARMED - PRESS BUZZ!';
        statusText.style.color = 'var(--accent-green)';
        if (!amInQueue) setBuzzerState('armed');
        document.getElementById('banner-player-warning').classList.remove('show');
    } else if (roundStatus === 'hotseat') {
        const currentHotseat = state.queue[0].username;
        const timeIsUp = (state.timeRemaining <= 0 && settings.timed);
        
        if (amFirstInQueue) {
            statusText.innerText = timeIsUp ? 'TIME EXPIRED - AWAITING HOST' : 'YOUR HOTSEAT';
            statusText.style.color = timeIsUp ? 'var(--accent-red)' : 'var(--accent-green)';
            setBuzzerState('disabled');
            document.getElementById('banner-player-warning').classList.remove('show');
        } else if (amInQueue) {
            statusText.innerText = 'QUEUED (BACKUP)';
            statusText.style.color = 'var(--accent-amber)';
            setBuzzerState('disabled');
            document.getElementById('banner-player-warning').classList.remove('show');
        } else {
            statusText.innerText = timeIsUp ? `TIME EXPIRED (${currentHotseat})` : `HOTSEAT: ${currentHotseat}`;
            statusText.style.color = 'var(--accent-amber)';

            // Lockout window logic
            if (state.lockoutActive) {
                setBuzzerState('lockout-window');
                document.getElementById('banner-player-warning').classList.remove('show');
            } else {
                setBuzzerState('disabled');
                showWarningBanner('LOCKED OUT');
            }
        }
    }
}

function syncSpectatorGameState(state) {
    roundStatus = state.roundStatus;
    settings = state.settings;
    if (lastPlayerRoster) {
        updatePlayerDirectoryUI(lastPlayerRoster);
        updateTeamsStandingsUI(lastPlayerRoster);
    }
    
    updatePlayerQueueUI(state.queue);

    const stateDigits = document.getElementById('spectator-round-state');
    const timerDiv = document.getElementById('spectator-timer-digits');
    if (!stateDigits || !timerDiv) return;

    if (roundStatus === 'idle') {
        stateDigits.innerText = 'STANDBY';
        stateDigits.className = 'status-current text-glow-amber';
    } else if (roundStatus === 'active') {
        stateDigits.innerText = 'BUZZERS ARMED';
        stateDigits.className = 'status-current text-glow-green';
    } else if (roundStatus === 'hotseat') {
        const currentHotseat = state.queue.length > 0 ? state.queue[0].username : 'UNKNOWN';
        const timeIsUp = (state.timeRemaining <= 0 && settings.timed);
        stateDigits.innerText = timeIsUp ? `TIME EXPIRED (${currentHotseat})` : `HOTSEAT: ${currentHotseat}`;
        stateDigits.className = timeIsUp ? 'status-current text-glow-red' : 'status-current text-glow-amber';
    }

    if (roundStatus === 'hotseat' && settings.timed) {
        timerDiv.style.display = 'block';
    } else {
        timerDiv.style.display = settings.timed ? 'block' : 'none';
    }
}

function setBuzzerState(mode) {
    const btn = document.getElementById('btn-player-buzz');
    btn.className = 'buzzer-btn';
    
    if (mode === 'armed') {
        btn.disabled = false;
        btn.classList.add('armed');
    } else if (mode === 'lockout-window') {
        btn.disabled = false;
        btn.classList.add('lockout-window');
    } else {
        btn.disabled = true;
    }
}

function showWarningBanner(msg) {
    const banner = document.getElementById('banner-player-warning');
    banner.innerText = msg;
    banner.classList.add('show');
}

/**
 * Triggers buzz stamp using high-accuracy Clocksync time.
 */
function playerTriggerBuzz() {
    if (!hostConnection || !hostConnection.open) return;

    const timestamp = getSynchronizedTimestamp(); // Synergized Host Time stamp with drift compensation

    sendToHost({
        type: 'BUZZ',
        clientId: myClientId,
        buzzTime: timestamp
    });

    setBuzzerState('disabled');
}

function playerToggleDoubleDown(checked) {
    if (!hostConnection || !hostConnection.open) return;

    if (checked) {
        const shieldToggle = document.getElementById('player-toggle-shield');
        if (shieldToggle && shieldToggle.checked) {
            shieldToggle.checked = false;
            hostConnection.send({
                type: 'TOGGLE_SHIELD',
                clientId: myClientId,
                active: false
            });
        }
    }

    hostConnection.send({
        type: 'TOGGLE_DOUBLE_DOWN',
        clientId: myClientId,
        active: checked
    });
}

function playerToggleShield(checked) {
    if (!hostConnection || !hostConnection.open) return;

    if (checked) {
        const ddToggle = document.getElementById('player-toggle-doubledown');
        if (ddToggle && ddToggle.checked) {
            ddToggle.checked = false;
            hostConnection.send({
                type: 'TOGGLE_DOUBLE_DOWN',
                clientId: myClientId,
                active: false
            });
        }
    }

    hostConnection.send({
        type: 'TOGGLE_SHIELD',
        clientId: myClientId,
        active: checked
    });
}

// ==========================================
// PERIODIC HEARTBEATS & CLIENT TIME SYNC
// ==========================================
function sendToHost(msg) {
    if ((msg.type === 'BUZZ' || msg.type === 'PING' || msg.type === 'TIME_SYNC') && hostFastConnection && hostFastConnection.open) {
        hostFastConnection.send(msg);
    } else if (hostConnection && hostConnection.open) {
        hostConnection.send(msg);
    }
}

function playerHeartbeatLoop() {
    if (isHost || !myUsername) return;

    if (hostConnection && hostConnection.open) {
        sendToHost({
            type: 'PING',
            clientId: myClientId,
            timestamp: Date.now(),
            lastRtt: currentRtt
        });
    } else {
        handlePlayerHostDisconnect();
    }
}

function playerTimeSyncLoop() {
    if (hostConnection && hostConnection.open) {
        sendToHost({
            type: 'TIME_SYNC',
            clientId: myClientId,
            clientTx: Date.now()
        });
    }
}

// ==========================================
// PLAYER PASSWORD PROMPT MODAL HANDLERS
// ==========================================
function submitPlayerPasswordModal() {
    const typedPassword = document.getElementById('modal-player-password-input').value.trim();
    if (!typedPassword) return;

    if (hostConnection && hostConnection.open) {
        hostConnection.send({
            type: 'JOIN',
            username: myUsername,
            clientId: myClientId,
            deviceId: myDeviceId,
            password: typedPassword
        });
    }
}

function cancelPlayerPasswordModal() {
    document.getElementById('modal-player-password').style.display = 'none';
    const btn = document.getElementById('btn-init-player');
    if (btn) {
        btn.innerText = 'CONNECT PEER-TO-PEER';
        btn.disabled = false;
    }
    if (hostConnection) hostConnection.close();
}

/**
 * Copies the Host Reclaim Key to clipboard with visual tooltip feedback.
 */
function copyReclaimKey() {
    if (!myHostReclaimKey) return;
    navigator.clipboard.writeText(myHostReclaimKey);
    const tooltip = document.getElementById('copy-key-tooltip');
    if (tooltip) {
        tooltip.style.display = 'inline';
        setTimeout(() => { tooltip.style.display = 'none'; }, 1500);
    }
}

/**
 * Triggers on player client when Host disconnects.
 * Locks buzzers, updates status to "HOST DISCONNECTED (RECONNECTING...)",
 * and initiates silent background reconnection loop without popups.
 */
function handlePlayerHostDisconnect() {
    if (isHost || !myUsername) return;

    if (isSpectator) {
        const stateDigits = document.getElementById('spectator-round-state');
        if (stateDigits) {
            stateDigits.innerText = 'DISCONNECTED (RECONNECTING...)';
            stateDigits.className = 'status-current text-glow-red';
        }
        if (!hostReconnectInterval) {
            hostReconnectInterval = setInterval(playerSilentHostReconnectLoop, 2000);
        }
        return;
    }

    setBuzzerState('disabled');
    
    const statusEl = document.getElementById('player-status-text');
    if (statusEl) {
        statusEl.innerText = 'HOST DISCONNECTED (RECONNECTING...)';
        statusEl.style.color = 'var(--accent-amber)';
    }

    const hotseatBanner = document.getElementById('banner-player-hotseat');
    if (hotseatBanner) hotseatBanner.classList.remove('show');

    const warningBanner = document.getElementById('banner-player-warning');
    if (warningBanner) warningBanner.classList.remove('show');

    if (!hostReconnectInterval) {
        hostReconnectInterval = setInterval(playerSilentHostReconnectLoop, 2000);
    }
}

function playerSilentHostReconnectLoop() {
    if (hostConnection && hostConnection.open) {
        if (hostReconnectInterval) {
            clearInterval(hostReconnectInterval);
            hostReconnectInterval = null;
        }
        return;
    }

    const inputId = isSpectator ? 'input-spectator-room-id' : 'input-room-id';
    const roomIdInput = document.getElementById(inputId).value.trim().toUpperCase();
    if (!roomIdInput) return;

    if (!peer || peer.destroyed) {
        try { peer = new Peer(null, getPeerOptions()); } catch(e){}
    }

    try {
        const conn = peer.connect(roomIdInput, { reliable: true });
        
        const silentTimeout = setTimeout(() => {
            try { conn.close(); } catch(e){}
        }, 1800);

        conn.on('open', () => {
            clearTimeout(silentTimeout);
            hostConnection = conn;
            try {
                hostFastConnection = peer.connect(roomIdInput, { label: 'fast', reliable: false });
            } catch(e) {}

            if (hostReconnectInterval) {
                clearInterval(hostReconnectInterval);
                hostReconnectInterval = null;
            }

            // Re-bind disconnect handlers so subsequent host disconnections are caught!
            conn.on('close', () => {
                handlePlayerHostDisconnect();
            });
            conn.on('error', () => {
                handlePlayerHostDisconnect();
            });

            const savedColor = sessionStorage.getItem('quiz_buzzer_player_color') || 'amber';
            conn.send({
                type: 'JOIN',
                role: isSpectator ? 'spectator' : 'player',
                username: myUsername,
                clientId: myClientId,
                deviceId: myDeviceId,
                password: null,
                color: savedColor
            });
        });

        conn.on('data', (data) => {
            handlePlayerIncomingData(data);
        });

        conn.on('close', () => {
            // Silence close events during silent reconnect polling
        });

        conn.on('error', () => {
            // Silence error popups during silent reconnect polling per user requirement!
        });
    } catch(err) {
        // Quietly swallow exceptions during silent reconnect polling
    }
}

// ==========================================
// GAME STATISTICS & AWARDS
// ==========================================
function hostShowStats() {
    if (!isHost) return;

    const awards = calculateAwards();
    const summary = generateStatsSummary();

    const statsData = {
        type: 'SHOW_STATS',
        awards: awards,
        summary: summary
    };

    // Render locally for Host
    renderStatsModal(statsData);
    document.getElementById('modal-game-stats').style.display = 'flex';

    // Broadcast to all players
    broadcast(statsData);
}

function calculateAwards() {
    function formatName(p) {
        if (settings.teamMode) {
            return `${p.username} (${p.team || 'Solo'})`;
        }
        return p.username;
    }

    let speedDemon = { username: 'N/A', value: 'No buzzes recorded' };
    let streakLord = { username: 'N/A', value: 'No streaks recorded' };
    let iceSculptor = { username: 'N/A', value: 'No cold streaks recorded' };
    let highRoller = { username: 'N/A', value: 'No Double Downs' };
    let edgeLord = { username: 'N/A', value: 'No backup buzzes' };
    let silentAssassin = { username: 'N/A', value: 'Min. 2 answers required' };

    let fastestAvg = Infinity;
    let maxStreakVal = 1; 
    let maxColdStreakVal = 1; 
    let maxDD = 0;
    let closestTo3s = 0; 
    let maxAccuracy = 0;
    let maxAccuracyCorrectCount = 0;

    for (let cid in scores) {
        const p = scores[cid];
        if (!p.stats) continue;
        const formatted = formatName(p);

        // 1. Speed Demon
        if (p.stats.buzzReactionTimes && p.stats.buzzReactionTimes.length > 0) {
            const sum = p.stats.buzzReactionTimes.reduce((a, b) => a + b, 0);
            const avg = sum / p.stats.buzzReactionTimes.length;
            if (avg < fastestAvg) {
                fastestAvg = avg;
                speedDemon = { username: formatted, value: `${avg.toFixed(0)}ms avg` };
            }
        }

        // 2. Streak Lord
        if (p.stats.maxStreak && p.stats.maxStreak > maxStreakVal) {
            maxStreakVal = p.stats.maxStreak;
            streakLord = { username: formatted, value: `${maxStreakVal} correct in a row` };
        }

        // 3. Ice Sculptor
        if (p.stats.maxColdStreak && p.stats.maxColdStreak > maxColdStreakVal) {
            maxColdStreakVal = p.stats.maxColdStreak;
            iceSculptor = { username: formatted, value: `${maxColdStreakVal} wrong in a row` };
        }

        // 4. High Roller
        if (p.stats.doubleDownCount && p.stats.doubleDownCount > maxDD) {
            maxDD = p.stats.doubleDownCount;
            highRoller = { username: formatted, value: `${maxDD} times activated` };
        }

        // 5. Edge Lord (closest to 3s lockout)
        if (p.stats.backupDeltas && p.stats.backupDeltas.length > 0) {
            const playerMaxDelta = Math.max(...p.stats.backupDeltas);
            if (playerMaxDelta > closestTo3s && playerMaxDelta < 3000) {
                closestTo3s = playerMaxDelta;
                edgeLord = { username: formatted, value: `+${closestTo3s.toFixed(0)}ms delta` };
            }
        }

        // 6. Silent Assassin (Accuracy = Correct / (Correct + Incorrect))
        const correct = p.stats.correctCount || 0;
        const incorrect = p.stats.incorrectCount || 0;
        const totalAnswers = correct + incorrect;
        if (totalAnswers >= 2) {
            const accuracy = correct / totalAnswers;
            if (accuracy > maxAccuracy || (accuracy === maxAccuracy && correct > maxAccuracyCorrectCount)) {
                maxAccuracy = accuracy;
                maxAccuracyCorrectCount = correct;
                silentAssassin = { username: formatted, value: `${(accuracy * 100).toFixed(0)}% accuracy (${correct}/${totalAnswers})` };
            }
        }
    }

    let teamAwards = null;
    if (settings.teamMode) {
        teamAwards = calculateTeamAwards();
    }

    return {
        individual: {
            speedDemon,
            streakLord,
            iceSculptor,
            highRoller,
            edgeLord,
            silentAssassin
        },
        team: teamAwards
    };
}

function calculateTeamAwards() {
    const teamStats = {};
    for (let cid in scores) {
        const p = scores[cid];
        const teamName = p.team || p.username;
        if (!teamStats[teamName]) {
            teamStats[teamName] = {
                name: teamName,
                correctCount: 0,
                incorrectCount: 0,
                shieldBlocks: 0,
                firstPlaces: 0,
                doubleDowns: 0,
                reactionTimes: [],
                onlineCount: 0,
                penaltiesLost: 0
            };
        }

        const stats = p.stats || {};
        teamStats[teamName].correctCount += stats.correctCount || 0;
        teamStats[teamName].incorrectCount += stats.incorrectCount || 0;
        teamStats[teamName].shieldBlocks += stats.shieldBlocks || 0;
        teamStats[teamName].firstPlaces += stats.firstPlaceBuzzCount || 0;
        teamStats[teamName].doubleDowns += stats.doubleDownCount || 0;
        teamStats[teamName].penaltiesLost += stats.pointsLost || 0;
        
        if (stats.buzzReactionTimes) {
            teamStats[teamName].reactionTimes.push(...stats.buzzReactionTimes);
        }
        if (p.status === 'online') {
            teamStats[teamName].onlineCount++;
        }
    }

    let powerhouse = { team: 'N/A', value: 'Min. 2 answers required' };
    let fortress = { team: 'N/A', value: 'No shield blocks' };
    let blitzkrieg = { team: 'N/A', value: 'No 1st place buzzes' };
    let syndicate = { team: 'N/A', value: 'No Double Downs' };
    let lagoon = { team: 'N/A', value: 'No buzzes' };
    let kamikaze = { team: 'N/A', value: 'No penalty points lost' };

    let maxAccuracy = 0;
    let maxAccuracyCorrect = 0;
    let maxShieldBlocks = 0;
    let maxFirstPlaces = 0;
    let maxDoubleDowns = 0;
    let slowestAvg = 0; 
    let maxPenalties = 0;

    for (let tName in teamStats) {
        const t = teamStats[tName];
        
        const total = t.correctCount + t.incorrectCount;
        if (total >= 2) {
            const acc = t.correctCount / total;
            if (acc > maxAccuracy || (acc === maxAccuracy && t.correctCount > maxAccuracyCorrect)) {
                maxAccuracy = acc;
                maxAccuracyCorrect = t.correctCount;
                powerhouse = { team: t.name, value: `${(acc * 100).toFixed(0)}% accuracy (${t.correctCount}/${total})` };
            }
        }

        if (t.shieldBlocks > maxShieldBlocks) {
            maxShieldBlocks = t.shieldBlocks;
            fortress = { team: t.name, value: `${maxShieldBlocks} penalties blocked` };
        }

        if (t.firstPlaces > maxFirstPlaces) {
            maxFirstPlaces = t.firstPlaces;
            blitzkrieg = { team: t.name, value: `${maxFirstPlaces} hotseats claimed` };
        }

        if (t.doubleDowns > maxDoubleDowns) {
            maxDoubleDowns = t.doubleDowns;
            syndicate = { team: t.name, value: `${maxDoubleDowns} times activated` };
        }

        if (t.reactionTimes.length > 0) {
            const sum = t.reactionTimes.reduce((a, b) => a + b, 0);
            const avg = sum / t.reactionTimes.length;
            if (avg > slowestAvg) {
                slowestAvg = avg;
                lagoon = { team: t.name, value: `${avg.toFixed(0)}ms avg` };
            }
        }

        if (t.penaltiesLost > maxPenalties) {
            maxPenalties = t.penaltiesLost;
            kamikaze = { team: t.name, value: `${maxPenalties} pts lost to errors` };
        }
    }

    return {
        powerhouse,
        fortress,
        blitzkrieg,
        syndicate,
        lagoon,
        kamikaze
    };
}

function generateStatsSummary() {
    return Object.keys(scores).map(cid => {
        const p = scores[cid];
        const stats = p.stats || {};
        const totalBuzzes = stats.buzzReactionTimes ? stats.buzzReactionTimes.length : 0;
        let avgSpeed = 'N/A';
        if (totalBuzzes > 0) {
            const sum = stats.buzzReactionTimes.reduce((a, b) => a + b, 0);
            avgSpeed = `${(sum / totalBuzzes).toFixed(0)}ms`;
        }

        return {
            username: p.username,
            team: p.team || '',
            score: p.score,
            correct: stats.correctCount || 0,
            incorrect: stats.incorrectCount || 0,
            avgSpeed: avgSpeed,
            doubleDowns: stats.doubleDownCount || 0
        };
    }).sort((a, b) => b.score - a.score); 
}

function renderStatsModal(data) {
    const container = document.getElementById('stats-modal-content');
    if (!container) return;

    let html = '';

    // 1. Team Awards Section (If Active)
    if (data.awards.team) {
        const teamAwards = data.awards.team;
        const teamList = [
            { id: "🏆 Powerhouse Team", color: "var(--accent-green)", data: teamAwards.powerhouse },
            { id: "🛡️ Fortress Team", color: "var(--accent-cyan)", data: teamAwards.fortress },
            { id: "⚡ Blitzkrieg Team", color: "var(--accent-amber)", data: teamAwards.blitzkrieg },
            { id: "🎲 Syndicate Team", color: "#ff007f", data: teamAwards.syndicate },
            { id: "🐢 Lagoon Team", color: "var(--text-muted)", data: teamAwards.lagoon },
            { id: "💥 Kamikaze Team", color: "var(--accent-red)", data: teamAwards.kamikaze }
        ];

        let hasAnyTeamAward = false;
        let gridHtml = "";
        teamList.forEach(item => {
            if (item.data && item.data.team !== "N/A") {
                hasAnyTeamAward = true;
                gridHtml += `
                    <div class="terminal-panel" style="padding: 10px; background: rgba(0,0,0,0.3); border-color: var(--accent-cyan);">
                        <div style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase;">${item.id}</div>
                        <div style="font-weight: bold; color: ${item.color}; margin-top: 4px;">${escapeHTML(item.data.team)}</div>
                        <div style="font-size: 0.8rem; color: var(--text-muted);">${escapeHTML(item.data.value)}</div>
                    </div>
                `;
            }
        });

        if (hasAnyTeamAward) {
            html += `
                <div style="border-bottom: 1px dashed var(--panel-border); padding-bottom: 15px; margin-bottom: 15px;">
                    <h3 style="color: var(--accent-cyan); margin-bottom: 10px; font-size: 1rem; text-transform: uppercase; letter-spacing: 1px;">🏆 Team Achievements</h3>
                    <div class="stats-grid">
                        ${gridHtml}
                    </div>
                </div>
            `;
        }
    }

    // 2. Individual Awards Section
    const ind = data.awards.individual;
    const indList = [
        { id: "⚡ Speed Demon", color: "var(--accent-green)", data: ind.speedDemon },
        { id: "🔥 Streak Lord", color: "var(--accent-amber)", data: ind.streakLord },
        { id: "❄️ Ice Sculptor", color: "#66ccff", data: ind.iceSculptor },
        { id: "🎲 High Roller", color: "#ff007f", data: ind.highRoller },
        { id: "⏳ Edge Lord", color: "var(--accent-amber)", data: ind.edgeLord },
        { id: "🎯 Silent Assassin", color: "var(--accent-green)", data: ind.silentAssassin }
    ];

    let hasAnyIndAward = false;
    let indGridHtml = "";
    indList.forEach(item => {
        if (item.data && item.data.username !== "N/A") {
            hasAnyIndAward = true;
            indGridHtml += `
                <div class="terminal-panel" style="padding: 10px; background: rgba(0,0,0,0.3);">
                    <div style="font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase;">${item.id}</div>
                    <div style="font-weight: bold; color: ${item.color}; margin-top: 4px;">${escapeHTML(item.data.username)}</div>
                    <div style="font-size: 0.8rem; color: var(--text-muted);">${escapeHTML(item.data.value)}</div>
                </div>
            `;
        }
    });

    if (hasAnyIndAward) {
        html += `
            <div style="border-bottom: 1px dashed var(--panel-border); padding-bottom: 15px; margin-bottom: 15px;">
                <h3 style="color: var(--accent-amber); margin-bottom: 10px; font-size: 1rem; text-transform: uppercase; letter-spacing: 1px;">🏆 Player Achievements</h3>
                <div class="stats-grid">
                    ${indGridHtml}
                </div>
            </div>
        `;
    }

    // 3. Team Standings Table (If Active)
    if (data.awards.team) {
        const teamMap = {};
        data.summary.forEach(p => {
            const teamName = p.team || p.username;
            if (!teamMap[teamName]) {
                teamMap[teamName] = { score: 0, members: [], correct: 0, incorrect: 0 };
            }
            teamMap[teamName].score += p.score;
            teamMap[teamName].members.push(p.username);
            teamMap[teamName].correct += p.correct;
            teamMap[teamName].incorrect += p.incorrect;
        });

        const sortedTeams = Object.keys(teamMap).map(name => ({
            name: name,
            score: teamMap[name].score,
            members: teamMap[name].members,
            correct: teamMap[name].correct,
            incorrect: teamMap[name].incorrect
        })).sort((a, b) => b.score - a.score);

        html += `
            <div style="margin-bottom: 20px;">
                <h3 style="color: var(--accent-cyan); margin-bottom: 10px; font-size: 1rem; text-transform: uppercase; letter-spacing: 1px;">📊 Team Standings</h3>
                <table class="directory-table" style="width: 100%; font-size: 0.8rem;">
                    <thead>
                        <tr>
                            <th style="text-align: left;">Rank</th>
                            <th style="text-align: left;">Team (Members)</th>
                            <th style="text-align: center;">Score</th>
                            <th style="text-align: center;">Correct</th>
                            <th style="text-align: center;">Wrong</th>
                        </tr>
                    </thead>
                    <tbody>
        `;

        sortedTeams.forEach((t, i) => {
            html += `
                <tr>
                    <td style="text-align: left; font-weight: bold; color: var(--accent-amber);">#${i + 1}</td>
                    <td style="text-align: left; font-weight: bold; color: white;">
                        ${escapeHTML(t.name)}
                        <span style="font-size:0.72rem; color:var(--text-muted); font-weight:normal; display:block;">(${t.members.join(', ')})</span>
                    </td>
                    <td style="text-align: center; color: var(--accent-cyan); font-weight: bold;">${t.score}</td>
                    <td style="text-align: center;">${t.correct}</td>
                    <td style="text-align: center;">${t.incorrect}</td>
                </tr>
            `;
        });

        html += `
                    </tbody>
                </table>
            </div>
        `;
    }

    // 4. Individual Breakdown Summary Table
    html += `
        <div>
            <h3 style="color: var(--accent-green); margin-bottom: 10px; font-size: 1rem; text-transform: uppercase; letter-spacing: 1px;">📊 Player Contributions</h3>
            <table class="directory-table" style="width: 100%; font-size: 0.8rem;">
                <thead>
                    <tr>
                        <th style="text-align: left;">Player</th>
                        ${data.awards.team ? '<th style="text-align: left;">Team</th>' : ''}
                        <th style="text-align: center;">Score</th>
                        <th style="text-align: center;">Correct</th>
                        <th style="text-align: center;">Wrong</th>
                        <th style="text-align: center;">Avg Speed</th>
                        <th style="text-align: center;">DDs</th>
                    </tr>
                </thead>
                <tbody>
    `;

    data.summary.forEach(p => {
        html += `
            <tr>
                <td style="text-align: left; font-weight: bold; color: white;">${escapeHTML(p.username)}</td>
                ${data.awards.team ? `<td style="text-align: left; color: var(--text-muted);">${escapeHTML(p.team || 'Solo')}</td>` : ''}
                <td style="text-align: center; color: var(--accent-green); font-weight: bold;">${p.score}</td>
                <td style="text-align: center;">${p.correct}</td>
                <td style="text-align: center;">${p.incorrect}</td>
                <td style="text-align: center; color: var(--accent-amber);">${p.avgSpeed}</td>
                <td style="text-align: center;">${p.doubleDowns}</td>
            </tr>
        `;
    });

    html += `
                </tbody>
            </table>
        </div>
    `;

    container.innerHTML = html;
}

function closeStatsModal() {
    document.getElementById('modal-game-stats').style.display = 'none';
}

// ==========================================
// DESKTOP KEYBOARD SHORTCUTS (ACCESSIBILITY / UX)
// ==========================================
document.addEventListener('keydown', (e) => {
    // Ignore keypresses if user is typing inside an input or textarea
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
        return;
    }

    // Host Dashboard Shortcuts
    if (isHost && document.getElementById('host-screen').classList.contains('screen-active')) {
        if (e.code === 'Space') {
            e.preventDefault();
            const startBtn = document.getElementById('btn-start-round');
            if (startBtn && !startBtn.disabled) {
                hostStartRound();
            }
        } else if (e.key === 'c' || e.key === 'C') {
            e.preventDefault();
            hostClearBuzzers();
        }
        return;
    }

    // Player Screen Shortcuts
    if (!isHost && !isSpectator && document.getElementById('player-screen').classList.contains('screen-active')) {
        if (e.code === 'Space' || e.code === 'Enter') {
            e.preventDefault();
            const buzzBtn = document.getElementById('btn-player-buzz');
            if (buzzBtn && !buzzBtn.disabled && buzzBtn.classList.contains('armed')) {
                playerTriggerBuzz();
            }
        }
    }
});