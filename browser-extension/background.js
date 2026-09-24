const WS_URL = 'ws://127.0.0.1:8765';
const TAB_PATTERNS = ['https://www.instagram.com/reels/*', 'https://www.instagram.com/reel/*'];
let socket;
let reconnectTimer;
let reconnectAttempt = 0;
let heartbeatTimer;
let connectionState = { connected: false, error: '', lastSeen: 0 };

function setConnectionState(next) {
  connectionState = { ...connectionState, ...next };
  chrome.storage.local.set({ connectionState });
  chrome.runtime.sendMessage({ type: 'CONNECTION_STATE', value: connectionState }).catch(() => undefined);
}

function connect() {
  clearTimeout(reconnectTimer);
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  try {
    socket = new WebSocket(WS_URL);
  } catch (error) {
    setConnectionState({ connected: false, error: String(error) });
    scheduleReconnect();
    return;
  }
  socket.addEventListener('open', () => {
    reconnectAttempt = 0;
    setConnectionState({ connected: true, error: '', lastSeen: Date.now() });
    send({ type: 'HELLO', protocolVersion: 1, client: 'doomscroll-browser', browserVersion: chrome.runtime.getManifest().version });
    relayToInstagram({ type: 'BRIDGE_STATE', connected: true });
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => send({ type: 'PING', at: Date.now() }), 20000);
  });
  socket.addEventListener('message', event => {
    setConnectionState({ connected: true, error: '', lastSeen: Date.now() });
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (['SETTINGS', 'CODING_STATE', 'COMMAND', 'WELCOME'].includes(message.type)) relayToInstagram(message);
  });
  socket.addEventListener('close', () => {
    clearInterval(heartbeatTimer);
    setConnectionState({ connected: false });
    relayToInstagram({ type: 'BRIDGE_STATE', connected: false });
    scheduleReconnect();
  });
  socket.addEventListener('error', () => setConnectionState({ connected: false, error: 'No se pudo conectar con VS Code en localhost:8765.' }));
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(15000, 1000 * (2 ** Math.min(reconnectAttempt++, 4)));
  reconnectTimer = setTimeout(connect, delay);
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

async function relayToInstagram(payload) {
  const tabs = await chrome.tabs.query({ url: TAB_PATTERNS });
  await Promise.all(tabs.map(tab => tab.id ? chrome.tabs.sendMessage(tab.id, payload).catch(() => undefined) : undefined));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  if (message.channel === 'doomscroll-content' && message.payload && sender.tab) {
    send(message.payload);
    chrome.storage.local.set({ lastReelState: message.payload });
    return;
  }
  if (message.type === 'GET_STATUS') {
    chrome.storage.local.get(['lastReelState']).then(result => sendResponse({ connectionState, lastReelState: result.lastReelState }));
    return true;
  }
  if (message.type === 'RECONNECT') {
    socket?.close();
    connect();
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'POPUP_COMMAND') {
    relayToInstagram({ type: 'COMMAND', name: message.name, value: message.value });
    sendResponse({ ok: true });
  }
});

chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
connect();
