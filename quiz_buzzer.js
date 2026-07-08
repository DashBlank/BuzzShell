/**
 * Q-Terminal Quiz Buzzer Game Engine
 * Authoritative WebRTC Edition (via PeerJS)
 * 
 * Features:
 * - Peer-to-Peer direct connection (signaling bypassed after handshake).
 * - NTP-style clocksync algorithm for sub-millisecond buzzer order sorting.
 * - Browser-synthesized Web Audio oscillators (Sawtooth/Sine) for latency-free sounds.
 * - Heartbeat scanning (100ms) with 2-minute reconnection grace periods.
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

/**
 * Connection Registries
 * - Host role: maps player ClientId -> active PeerJS DataConnection
 * - Player role: holds the single connection to the Host
 */
let playerConnections = {}; 
let hostConnection = null; 

/**
 * PeerJS ICE Server Configuration (ICE = Interactive Connectivity Establishment)
 * - Includes a standard public Google STUN server for normal NAT mappings.
 * - Includes Metered.ca public TURN servers to act as relays when players are behind strict 
 *   Symmetric NATs (common in cellular networks, colleges, or corporate environments).
 */
const PEER_CONFIG = {
    debug: 1, // Only print warnings/errors to browser console
    config: {
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
    }
}; 

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
let currentRtt = 0;     // Network Round Trip Time (RTT) in milliseconds
let syncHistory = [];   // Array of { offset, rtt } to filter network jitter

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
    streakMultipliers: false,
    correctPoints: 10,
    incorrectPenalty: 5
};

/**
 * Scoreboard & Player profiles (Host authoritatively holds this)
 * Format:
 * clientId -> { username, score, streak, status, lastPing, disconnectTime, doubleDownActive }
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

    // Auto-fill reclaim input fields if previous host session exists in localStorage
    const savedRoom = localStorage.getItem('quiz_buzzer_host_room_id');
    const savedKey = localStorage.getItem('quiz_buzzer_host_reclaim_key');
    if (savedRoom && savedKey) {
        const rEl = document.getElementById('input-reclaim-room-id');
        const kEl = document.getElementById('input-reclaim-key');
        if (rEl) rEl.value = savedRoom;
        if (kEl) kEl.value = savedKey;
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
    if (!window.RTCPeerConnection) {
        alert("WebRTC is not supported in this browser or context.");
        return;
    }

    isHost = true;
    const btn = document.getElementById('btn-init-host');
    const originalText = btn.innerText;
    btn.innerText = 'REGISTERING ROOM...';
    btn.disabled = true;

    const targetRoomId = 'ROOM-' + Math.floor(10000 + Math.random() * 90000);
    myHostReclaimKey = 'SEC-' + Math.random().toString(36).substring(2, 8).toUpperCase();

    peer = new Peer(targetRoomId, PEER_CONFIG);

    peer.on('open', (id) => {
        activeRoomId = id;
        document.getElementById('host-room-id-val').innerText = id;
        document.getElementById('host-reclaim-key-val').innerText = myHostReclaimKey;
        switchScreen('host-screen');
        logTerminal('INIT', `Room initiated [${id}] (Reclaim Key: ${myHostReclaimKey})`);
        
        saveHostStateToStorage();
        setInterval(hostHeartbeatLoop, 100);
    });

    bindHostPeerEvents(btn, originalText);
}

function reclaimHostRoom() {
    initAudio();
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
    const savedRoom = localStorage.getItem('quiz_buzzer_host_room_id');
    const savedKey = localStorage.getItem('quiz_buzzer_host_reclaim_key');
    const savedScores = localStorage.getItem('quiz_buzzer_host_scores');
    const savedSettings = localStorage.getItem('quiz_buzzer_host_settings');
    const savedRound = localStorage.getItem('quiz_buzzer_host_round');

    if (savedRoom === roomIdInput && savedKey === reclaimKeyInput && savedScores) {
        try {
            scores = JSON.parse(savedScores);
            // Mark all restored players as offline initially until they re-establish WebRTC connections
            for (let cid in scores) {
                scores[cid].status = 'offline';
                scores[cid].lastPing = Date.now();
            }
        } catch (e) {
            console.error('Error parsing saved scores:', e);
            scores = {};
        }
        if (savedSettings) {
            try { settings = JSON.parse(savedSettings); } catch(e){}
        }
        if (savedRound) currentRound = parseInt(savedRound) || 1;
    }

    roundStatus = 'idle'; // Engine set to STANDBY per user requirements

    peer = new Peer(activeRoomId, PEER_CONFIG);

    peer.on('open', (id) => {
        document.getElementById('host-room-id-val').innerText = id;
        document.getElementById('host-reclaim-key-val').innerText = myHostReclaimKey;
        switchScreen('host-screen');
        
        logTerminal('RECOVER', `Reclaimed control room [${id}]. Engine set to STANDBY.`);
        
        saveHostStateToStorage();
        updateHostDirectoryUI();
        syncHostSettingsUI();

        setInterval(hostHeartbeatLoop, 100);
    });

    bindHostPeerEvents(btn, originalText);
}

function bindHostPeerEvents(btn, originalText) {
    peer.on('connection', (conn) => {
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
        btn.innerText = originalText;
        btn.disabled = false;
        if (err.type === 'unavailable-id') {
            logTerminal('RETRY', `Room ID [${activeRoomId}] is currently registered or in use.`);
            alert(`Room ID [${activeRoomId}] is unavailable on broker server. If host tab was just closed, wait 5 seconds and click Reclaim again.`);
        } else {
            logTerminal('PEER_ERR', `Global peer error: ${err.message}`);
            alert(`Failed to reclaim room: ${err.message}`);
        }
    });
}

// ==========================================
// ROLE CREATION: PLAYER INITIALIZATION
// ==========================================
document.getElementById('btn-init-player').addEventListener('click', () => {
    initAudio();
    
    if (!window.RTCPeerConnection) {
        alert("WebRTC is not supported in this browser or context. Note: WebRTC requires a secure context (HTTPS or localhost) to function.");
        return;
    }

    const usernameInput = document.getElementById('input-player-name').value.trim();
    const roomIdInput = document.getElementById('input-room-id').value.trim().toUpperCase();

    if (!usernameInput) {
        alert('Please enter a username.'); return;
    }
    if (!roomIdInput) {
        alert('Please enter a valid Room ID.'); return;
    }

    myUsername = usernameInput;
    isHost = false;

    const btn = document.getElementById('btn-init-player');
    const originalText = btn.innerText;
    btn.innerText = 'CONNECTING...';
    btn.disabled = true;

    // Generate random transient Peer ID for player's signaling session
    peer = new Peer(null, PEER_CONFIG);

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
            
            conn.send({
                type: 'JOIN',
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

// ==========================================
// USER INTERFACE UTILITIES
// ==========================================
function switchScreen(screenId) {
    document.querySelectorAll('.screen-container').forEach(el => {
        el.classList.remove('screen-active');
    });
    document.getElementById(screenId).classList.add('screen-active');
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
        conn.send({
            type: 'TIME_SYNC_REPLY',
            clientTx: data.clientTx,
            hostRx: Date.now(),
            hostTx: Date.now()
        });
        return;
    }

    if (data.type === 'JOIN') {
        handleHostPlayerJoin(conn, data);
        return;
    }

    if (data.type === 'BUZZ') {
        handleHostBuzz(data);
        return;
    }

    if (data.type === 'TOGGLE_DOUBLE_DOWN') {
        if (scores[data.clientId]) {
            scores[data.clientId].doubleDownActive = data.active;
            broadcastRoster();
        }
        return;
    }
}

function handleHostConnectionClose(conn) {
    let foundClientId = null;
    for (let cid in playerConnections) {
        if (playerConnections[cid] === conn) {
            foundClientId = cid;
            break;
        }
    }

    if (foundClientId && scores[foundClientId]) {
        logTerminal('DISCONNECTED', `Player ${scores[foundClientId].username} closed connection.`);
        // Connection closed is handled by the 100ms heartbeat loop to allow for re-connection grace periods.
    }
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
    const roomPassword = document.getElementById('host-room-password').value.trim();
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
        score: 0,
        streak: 0,
        status: 'online',
        lastPing: Date.now(),
        disconnectTime: null,
        doubleDownActive: false,
        deviceId: incomingDeviceId
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
    conn.send({ type: 'PONG', timestamp: data.timestamp });
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
}

function broadcastRoster() {
    const list = Object.keys(scores).map(cid => ({
        clientId: cid,
        username: scores[cid].username,
        score: scores[cid].score,
        streak: scores[cid].streak,
        status: scores[cid].status,
        doubleDownActive: scores[cid].doubleDownActive
    }));

    const onlineCount = list.filter(p => p.status === 'online').length;
    document.getElementById('host-peer-count').innerText = onlineCount;

    broadcast({
        type: 'ROSTER_UPDATE',
        roster: list
    });

    updateHostDirectoryUI(list);
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

        tr.innerHTML = `
            <td>
                <span class="status-badge ${p.status === 'online' ? 'status-online' : 'status-offline'}">${p.status}</span>
            </td>
            <td>
                <div class="player-name-container">
                    <span class="player-name-text" title="${escapeHTML(p.username)}">${escapeHTML(p.username)}</span>
                    ${streakText}
                    ${doubleText}
                </div>
            </td>
            <td><span style="font-weight:bold;">${p.score}</span></td>
            <td id="ping-val-${p.clientId}">--ms</td>
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
        buzzTime: item.buzzTime
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

        div.innerHTML = `
            <div style="display:flex; align-items:center;">
                <span class="queue-index">#${index + 1}</span>
                <span style="font-weight:bold;">${escapeHTML(item.username)}</span>
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
}

// ==========================================
// HOST ENGINE ACTION HANDLERS
// ==========================================
function hostStartRound() {
    if (timerInterval) clearInterval(timerInterval);
    buzzQueue = [];
    lockoutActive = false;
    if (lockoutTimer) clearTimeout(lockoutTimer);

    roundStatus = 'active';
    
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
    roundStatus = 'idle';
    timeRemaining = 0;
    updateTimerDisplay(0);

    // Reset Double Down flags for next round during Standby
    for (let cid in scores) {
        scores[cid].doubleDownActive = false;
    }

    logTerminal('GAME', 'Buzzers cleared. Returning to standby.');
    broadcastRoster();
    broadcastState();
    saveHostStateToStorage();
}

function hostClearScoreboard() {
    // Preserve connection sessions and usernames, reset scores/streaks to zero
    for (let cid in scores) {
        scores[cid].score = 0;
        scores[cid].streak = 0;
    }
    logTerminal('ADMIN', 'Scoreboard cleared (names preserved).');
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
    document.getElementById('modal-edit-streak').value = profile.streak;

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
    const newStreak = parseInt(document.getElementById('modal-edit-streak').value) || 0;

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
    
    const hotseat = buzzQueue[0];
    const cid = hotseat.clientId;
    const profile = scores[cid];

    if (!profile) return;

    stopGameTimers();

    if (isCorrect) {
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
            if (profile.streak >= 2) {
                points *= profile.streak; // Apply linear streak multiplier
            }
        } else {
            profile.streak = 0;
        }

        profile.score += points;
        profile.doubleDownActive = false; // Reset Double Down flag

        logTerminal('CORRECT', `${profile.username} answered CORRECTLY! (+${points} pts).`);
        
        playCorrect();
        broadcast({ type: 'SOUND_TRIGGER', cue: 'correct' });

        broadcastRoster();
        currentRound += 1;

        // Auto-Start Next Round Instantly
        setTimeout(() => {
            hostStartRound();
        }, 100);

    } else {
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
            if (coldMagnitude >= 2) {
                penalty *= coldMagnitude; // Scale penalty for cold streaks of 2 or more (e.g. -2, -3)
            }
        } else {
            profile.streak = 0;
        }

        profile.score -= penalty; // Score is allowed to go negative
        profile.doubleDownActive = false;

        logTerminal('INCORRECT', `${profile.username} answered INCORRECTLY. (-${penalty} pts).`);

        playIncorrect();
        broadcast({ type: 'SOUND_TRIGGER', cue: 'incorrect' });
        broadcastRoster();

        // Pass hotseat to backup queued player
        buzzQueue.shift(); 

        if (buzzQueue.length > 0) {
            const nextHotseat = buzzQueue[0];
            logTerminal('GAME', `Hotseat passed to next queued player: ${nextHotseat.username}`);
            
            roundStatus = 'hotseat';
            if (settings.timed) {
                timeRemaining = parseFloat(document.getElementById('host-timer-duration').value) || 10;
                startAnsweringCountdown();
            } else {
                timeRemaining = 0;
            }
            broadcastState();
        } else {
            roundStatus = 'idle';
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
        roundStatus = 'hotseat';
        
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
    settings.doubleDown = document.getElementById('host-toggle-doubledown').checked;
    settings.streakMultipliers = document.getElementById('host-toggle-streaks').checked;
    
    const cEl = document.getElementById('host-points-correct');
    const iEl = document.getElementById('host-points-incorrect');
    if (cEl) {
        const val = parseInt(cEl.value);
        settings.correctPoints = isNaN(val) ? 10 : val;
    }
    if (iEl) {
        const val = parseInt(iEl.value);
        settings.incorrectPenalty = isNaN(val) ? 5 : val;
    }

    broadcast({
        type: 'SETTINGS_UPDATE',
        settings: settings
    });
    saveHostStateToStorage();
}

function syncHostSettingsUI() {
    if (document.getElementById('host-toggle-timed')) document.getElementById('host-toggle-timed').checked = settings.timed;
    if (document.getElementById('host-toggle-doubledown')) document.getElementById('host-toggle-doubledown').checked = settings.doubleDown;
    if (document.getElementById('host-toggle-streaks')) document.getElementById('host-toggle-streaks').checked = settings.streakMultipliers;
    if (document.getElementById('host-points-correct')) document.getElementById('host-points-correct').value = settings.correctPoints !== undefined ? settings.correctPoints : 10;
    if (document.getElementById('host-points-incorrect')) document.getElementById('host-points-incorrect').value = settings.incorrectPenalty !== undefined ? settings.incorrectPenalty : 5;
}

function toggleTimedConfig(val) {
    settings.timed = val;
    const input = document.getElementById('host-timer-duration');
    input.disabled = !val; // Lock input duration field if untimed
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

        // 2. Reconnection grace: purge players offline for > 2 minutes (120,000ms)
        if (record.status === 'offline' && record.disconnectTime && (now - record.disconnectTime > 120000)) {
            logTerminal('PURGED', `${record.username} purged from lobby (2m grace expired).`);
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

        syncHistory.push({ offset, rtt });
        if (syncHistory.length > 6) syncHistory.shift();

        // Sort offsets by minimum RTT to extract the most accurate offset estimate
        const sorted = [...syncHistory].sort((a, b) => a.rtt - b.rtt);
        clockOffset = sorted[0].offset;

        document.getElementById('player-hud-offset').innerText = `${clockOffset.toFixed(1)}ms`;
        return;
    }

    if (data.type === 'JOIN_SUCCESS') {
        myClientId = data.clientId;
        myUsername = data.username;
        sessionStorage.setItem('quiz_buzzer_client_id', myClientId); // Persist ID
        
        document.getElementById('modal-player-password').style.display = 'none';
        document.getElementById('player-hud-name').innerText = myUsername;
        document.getElementById('player-hud-room-id').innerText = hostConnection.peer;
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
        updatePlayerDirectoryUI(data.roster);
        return;
    }

    if (data.type === 'SETTINGS_UPDATE') {
        settings = data.settings;
        syncPlayerSettingsUI();
        return;
    }

    if (data.type === 'STATE_UPDATE') {
        syncPlayerGameState(data);
        return;
    }

    if (data.type === 'ROUND_START') {
        document.getElementById('banner-player-warning').classList.remove('show');
        setBuzzerState('armed');
        return;
    }

    if (data.type === 'TIMER_SYNC') {
        if (settings.timed) {
            const timerDiv = document.getElementById('player-timer-digits');
            timerDiv.innerText = data.timeRemaining.toFixed(2);
        }
        return;
    }

    if (data.type === 'BUZZ_REJECTED') {
        showWarningBanner(data.reason); // Shows "LOCKED OUT"
        setBuzzerState('disabled');
        return;
    }

    if (data.type === 'LATE_JOIN_WARNING') {
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
    const tbody = document.getElementById('player-directory-tbody');
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

        tr.innerHTML = `
            <td>
                <span class="status-badge ${p.status === 'online' ? 'status-online' : 'status-offline'}">${p.status}</span>
            </td>
            <td>
                <div class="player-name-container">
                    <span class="player-name-text" title="${escapeHTML(p.username)}">${escapeHTML(p.username)}</span>
                    ${streakText}
                    ${doubleText}
                </div>
            </td>
            <td><span style="font-weight:bold;">${p.score}</span></td>
        `;
        tbody.appendChild(tr);

        // Sync local HUD scores & force Double Down checkbox reset on round start
        if (p.clientId === myClientId) {
            document.getElementById('player-my-score').innerText = p.score;
            document.getElementById('player-toggle-doubledown').checked = p.doubleDownActive;
        }
    });
}

function syncPlayerSettingsUI() {
    const doubleContainer = document.getElementById('player-doubledown-container');
    const doubleDisabledMsg = document.getElementById('player-doubledown-disabled-msg');
    const ddToggle = document.getElementById('player-toggle-doubledown');
    
    const canToggleDoubleDown = settings.doubleDown && (roundStatus === 'idle');

    if (settings.doubleDown) {
        doubleContainer.style.display = 'flex';
        doubleDisabledMsg.style.display = 'none';
    } else {
        doubleContainer.style.display = 'none';
        doubleDisabledMsg.style.display = 'block';
        if (ddToggle) ddToggle.checked = false;
    }

    if (ddToggle) {
        ddToggle.disabled = !canToggleDoubleDown;
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

    const timestamp = Date.now() + clockOffset; // Synergized Host Time stamp

    hostConnection.send({
        type: 'BUZZ',
        clientId: myClientId,
        buzzTime: timestamp
    });

    setBuzzerState('disabled');
}

function playerToggleDoubleDown(checked) {
    if (!hostConnection || !hostConnection.open) return;
    hostConnection.send({
        type: 'TOGGLE_DOUBLE_DOWN',
        clientId: myClientId,
        active: checked
    });
}

// ==========================================
// PERIODIC HEARTBEATS & CLIENT TIME SYNC
// ==========================================
function playerHeartbeatLoop() {
    if (isHost || !myUsername) return;

    if (hostConnection && hostConnection.open) {
        hostConnection.send({
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
        hostConnection.send({
            type: 'TIME_SYNC',
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

    const roomIdInput = document.getElementById('input-room-id').value.trim().toUpperCase();
    if (!roomIdInput) return;

    if (!peer || peer.destroyed) {
        try { peer = new Peer(null, PEER_CONFIG); } catch(e){}
    }

    try {
        const conn = peer.connect(roomIdInput, { reliable: true });
        
        const silentTimeout = setTimeout(() => {
            try { conn.close(); } catch(e){}
        }, 1800);

        conn.on('open', () => {
            clearTimeout(silentTimeout);
            hostConnection = conn;

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

            conn.send({
                type: 'JOIN',
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
            // Silence close events during silent reconnect polling
        });

        conn.on('error', () => {
            // Silence error popups during silent reconnect polling per user requirement!
        });
    } catch(err) {
        // Quietly swallow exceptions during silent reconnect polling
    }
}
