const WS_URL = 'ws://127.0.0.1:8765/control';
const TAB_PATTERNS = ['https://www.instagram.com/reels/*', 'https://www.instagram.com/reel/*'];
let socket;
let reconnectTimer;
let reconnectAttempt = 0;
let heartbeatTimer;
let connectionState = { connected: false, error: '', lastSeen: 0 };
let capturedTabId;

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
  if (message.type === 'OFFSCREEN_ERROR') {
    send({ type: 'ERROR', pageReady: true, message: message.message || 'Error de transmisión' });
    return;
  }
  if (message.channel === 'doomscroll-content' && message.payload && sender.tab) {
    send(message.payload);
    chrome.storage.local.set({ lastReelState: message.payload });
    if (message.payload.crop) {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'update-crop', data: message.payload.crop }).catch(() => undefined);
    }
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

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Transmit the user-selected Instagram tab to the local Visual Studio Code extension.'
    });
  }
}

async function stopCapture() {
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop-capture' }).catch(() => undefined);
  capturedTabId = undefined;
  await chrome.action.setBadgeText({ text: '' });
  send({ type: 'PAGE_STATE', pageReady: true, status: 'Tab transmission stopped' });
}

chrome.action.onClicked.addListener(async tab => {
  try {
    if (!tab.id || !tab.url?.startsWith('https://www.instagram.com/')) {
      await chrome.action.setBadgeText({ text: 'REEL' });
      await chrome.action.setBadgeBackgroundColor({ color: '#c07b25' });
      return;
    }
    const captures = await chrome.tabCapture.getCapturedTabs();
    if (captures.some(capture => capture.tabId === tab.id && capture.status === 'active')) {
      await stopCapture();
      return;
    }
    await ensureOffscreenDocument();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    capturedTabId = tab.id;
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start-capture', data: streamId });
    await chrome.action.setBadgeBackgroundColor({ color: '#2e9b55' });
    await chrome.action.setBadgeText({ text: 'LIVE' });
    send({ type: 'PAGE_STATE', pageReady: true, pageUrl: tab.url, status: 'Streaming tab to VS Code' });
  } catch (error) {
    capturedTabId = undefined;
    await chrome.action.setBadgeBackgroundColor({ color: '#b33a3a' });
    await chrome.action.setBadgeText({ text: 'ERR' });
    send({ type: 'ERROR', pageReady: true, message: `No se pudo transmitir la pestaña: ${error instanceof Error ? error.message : String(error)}` });
  }
});

chrome.tabCapture.onStatusChanged.addListener(info => {
  if (info.tabId === capturedTabId && (info.status === 'stopped' || info.status === 'error')) {
    capturedTabId = undefined;
    chrome.action.setBadgeText({ text: '' });
  }
});

chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
connect();
