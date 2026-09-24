const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const elements = {
  connection: $('connection'), content: $('content'), headline: $('headline'), detail: $('detail'),
  reelIcon: $('reelIcon'), streamVideo: $('streamVideo'), streamFrame: $('streamFrame'), streamPlaceholder: $('streamPlaceholder'),
  streamHint: $('streamHint'), openReels: $('openReels'), openConnector: $('openConnector'),
  previous: $('previous'), play: $('play'), next: $('next'), mute: $('mute'), pip: $('pip'),
  interval: $('interval'), smart: $('smart'), onlyCoding: $('onlyCoding'), volume: $('volume'),
  volumeValue: $('volumeValue'), opacity: $('opacity'), setup: $('setup'), error: $('error'),
  dot: $('dot'), status: $('status'), activity: $('activity')
};
let state;
let mediaSocket;
let mediaReconnectTimer;
let mediaSource;
let sourceBuffer;
let mediaObjectUrl;
let mediaQueue = [];
let pendingMimeType = 'video/webm;codecs="vp8,opus"';
let frameObjectUrl;

const update = (key, value) => vscode.postMessage({ type: 'updateSetting', key, value });
const command = (name, value) => vscode.postMessage({ type: 'command', name, value });
elements.openReels.addEventListener('click', () => vscode.postMessage({ type: 'openReels' }));
elements.openConnector.addEventListener('click', () => vscode.postMessage({ type: 'openConnectorFolder' }));
elements.previous.addEventListener('click', () => command('PREVIOUS'));
elements.next.addEventListener('click', () => command('NEXT'));
elements.pip.addEventListener('click', () => command('PICTURE_IN_PICTURE'));
elements.play.addEventListener('click', () => update('autoScrollEnabled', !state?.autoScrollEnabled));
elements.mute.addEventListener('click', () => update('muted', !state?.muted));
elements.interval.addEventListener('change', event => update('intervalSeconds', Number(event.target.value)));
elements.smart.addEventListener('change', event => update('smartModeEnabled', event.target.checked));
elements.onlyCoding.addEventListener('change', event => update('onlyWhileCoding', event.target.checked));
elements.volume.addEventListener('input', event => { elements.volumeValue.value = `${event.target.value}%`; });
elements.volume.addEventListener('change', event => update('volume', Number(event.target.value)));
elements.opacity.addEventListener('change', event => update('opacity', Number(event.target.value)));

window.addEventListener('message', event => {
  if (event.data?.type !== 'state') return;
  state = event.data.value;
  const browser = state.browser;
  const connectorOutdated = Boolean(browser.connectorVersion && browser.connectorVersion !== state.expectedConnectorVersion);
  elements.connection.textContent = state.connected ? 'Navegador conectado' : 'Sin navegador';
  elements.connection.className = `badge ${state.connected ? 'connected' : ''}`;
  elements.play.textContent = state.autoScrollEnabled ? '⏸' : '▶';
  elements.mute.textContent = state.muted ? '🔇' : '🔊';
  elements.smart.checked = state.smartModeEnabled;
  elements.onlyCoding.checked = state.onlyWhileCoding;
  elements.interval.value = String(state.intervalSeconds);
  elements.volume.value = String(state.volume);
  elements.volumeValue.value = `${state.volume}%`;
  elements.opacity.value = String(state.opacity);
  elements.content.style.opacity = String(state.opacity);
  elements.streamVideo.muted = state.muted;
  elements.setup.hidden = state.connected;
  elements.status.textContent = state.status;
  elements.activity.textContent = state.onlyWhileCoding ? ` · ${state.secondsSinceCoding}s` : '';
  elements.dot.className = state.connected && state.autoScrollEnabled && state.codingActive ? 'active' : 'paused';
  const versionError = connectorOutdated
    ? `Conector del navegador ${browser.connectorVersion} desactualizado. Carga la carpeta ${state.expectedConnectorVersion} y recarga la pestaña de Instagram.`
    : '';
  elements.error.hidden = !(state.serverError || browser.error || versionError);
  elements.error.textContent = state.serverError || browser.error || versionError;
  document.querySelectorAll('.transport button').forEach(button => { button.disabled = !state.connected; });
  elements.streamVideo.hidden = !state.mediaReceiving;
  elements.streamPlaceholder.hidden = state.mediaReceiving;
  if (!state.mediaReceiving) elements.streamFrame.hidden = true;

  if (connectorOutdated) {
    elements.headline.textContent = 'Actualiza el conector de Chrome';
    elements.detail.textContent = `Chrome usa ${browser.connectorVersion}; la transmisión necesita ${state.expectedConnectorVersion}.`;
    elements.reelIcon.textContent = '!';
    elements.streamHint.textContent = 'Elimina el conector viejo, carga la carpeta nueva y recarga Instagram';
  } else if (state.mediaStreaming && !state.mediaReceiving) {
    elements.headline.textContent = 'Preparando la transmisión';
    elements.detail.textContent = 'Chrome está conectado; esperando los primeros cuadros del Reel.';
    elements.reelIcon.textContent = '…';
    elements.streamHint.textContent = 'La captura puede tardar un momento al iniciar';
  } else if (state.mediaReceiving) {
    elements.headline.textContent = 'Transmitiendo dentro de VS Code';
    const duration = browser.duration > 0 ? ` · ${Math.round(browser.currentTime)}s / ${Math.round(browser.duration)}s` : '';
    elements.detail.textContent = `${state.status}${duration}`;
    elements.streamVideo.play().catch(() => undefined);
  } else if (!state.connected) {
    elements.headline.textContent = 'Conecta Chrome o Edge';
    elements.detail.textContent = 'Carga el conector local una vez. DoomScroll nunca recibe tu contraseña ni tus cookies.';
    elements.reelIcon.textContent = '↔';
    elements.streamHint.textContent = 'Primero conecta la extensión del navegador';
  } else if (!browser.pageReady) {
    elements.headline.textContent = 'Abre Instagram Reels';
    elements.detail.textContent = 'El conector está listo, pero no encuentra una pestaña de Reels abierta.';
    elements.reelIcon.textContent = '◎';
    elements.streamHint.textContent = 'Abre Instagram Reels en Chrome o Edge';
  } else if (!browser.hasVideo) {
    elements.headline.textContent = 'Buscando el Reel';
    elements.detail.textContent = browser.status || 'Instagram está cargando el video activo.';
    elements.reelIcon.textContent = '…';
    elements.streamHint.textContent = 'Esperando el video visible';
  } else {
    elements.headline.textContent = browser.playing ? 'Reel reproduciéndose' : 'Reel en pausa';
    const duration = browser.duration > 0 ? ` · ${Math.round(browser.currentTime)}s / ${Math.round(browser.duration)}s` : '';
    elements.detail.textContent = `${state.status}${duration}`;
    elements.reelIcon.textContent = browser.playing ? '▶' : 'Ⅱ';
    elements.streamHint.textContent = 'Pulsa el icono de DoomScroll en Chrome para transmitir aquí';
  }
});

function connectMediaStream() {
  clearTimeout(mediaReconnectTimer);
  if (mediaSocket && (mediaSocket.readyState === WebSocket.OPEN || mediaSocket.readyState === WebSocket.CONNECTING)) return;
  mediaSocket = new WebSocket('ws://127.0.0.1:8765/media-consumer');
  mediaSocket.binaryType = 'arraybuffer';
  mediaSocket.addEventListener('message', event => {
    if (typeof event.data === 'string') {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'STREAM_RESET') resetMediaSource(message.mimeType);
      } catch { /* Ignore malformed stream control messages. */ }
      return;
    }
    const packet = new Uint8Array(event.data);
    if (packet[0] === 0x4a) {
      showJpegFrame(event.data.slice(1));
      return;
    }
    mediaQueue.push(packet[0] === 0x57 ? event.data.slice(1) : event.data);
    pumpMediaQueue();
  });
  mediaSocket.addEventListener('close', () => {
    mediaReconnectTimer = setTimeout(connectMediaStream, 1500);
  });
  mediaSocket.addEventListener('error', () => undefined);
}

function showJpegFrame(buffer) {
  const nextUrl = URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' }));
  const previousUrl = frameObjectUrl;
  frameObjectUrl = nextUrl;
  elements.streamFrame.src = nextUrl;
  elements.streamFrame.hidden = false;
  if (previousUrl) setTimeout(() => URL.revokeObjectURL(previousUrl), 1000);
}

function resetMediaSource(mimeType) {
  pendingMimeType = MediaSource.isTypeSupported(mimeType) ? mimeType : 'video/webm;codecs="vp8,opus"';
  mediaQueue = [];
  sourceBuffer = undefined;
  if (mediaObjectUrl) URL.revokeObjectURL(mediaObjectUrl);
  mediaSource = new MediaSource();
  mediaObjectUrl = URL.createObjectURL(mediaSource);
  elements.streamVideo.src = mediaObjectUrl;
  mediaSource.addEventListener('sourceopen', () => {
    try {
      const supportedType = MediaSource.isTypeSupported(pendingMimeType) ? pendingMimeType : 'video/webm';
      sourceBuffer = mediaSource.addSourceBuffer(supportedType);
      sourceBuffer.mode = 'sequence';
      sourceBuffer.addEventListener('updateend', () => {
        keepPlaybackLive();
        pumpMediaQueue();
      });
      pumpMediaQueue();
    } catch (error) {
      elements.error.hidden = false;
      elements.error.textContent = `No se pudo reproducir la transmisión: ${error instanceof Error ? error.message : String(error)}`;
    }
  }, { once: true });
}

function pumpMediaQueue() {
  if (!sourceBuffer || sourceBuffer.updating || mediaQueue.length === 0 || mediaSource?.readyState !== 'open') return;
  try {
    sourceBuffer.appendBuffer(mediaQueue.shift());
  } catch {
    mediaQueue = [];
  }
}

function keepPlaybackLive() {
  const video = elements.streamVideo;
  if (!video.buffered.length) return;
  const liveEdge = video.buffered.end(video.buffered.length - 1);
  if (!Number.isFinite(video.currentTime) || liveEdge - video.currentTime > 1.5) video.currentTime = Math.max(0, liveEdge - 0.25);
  video.play().catch(() => undefined);
}

connectMediaStream();
