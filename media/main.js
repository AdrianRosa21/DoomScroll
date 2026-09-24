const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const elements = {
  connection: $('connection'), content: $('content'), headline: $('headline'), detail: $('detail'),
  reelIcon: $('reelIcon'), openReels: $('openReels'), openConnector: $('openConnector'),
  previous: $('previous'), play: $('play'), next: $('next'), mute: $('mute'), pip: $('pip'),
  interval: $('interval'), smart: $('smart'), onlyCoding: $('onlyCoding'), volume: $('volume'),
  volumeValue: $('volumeValue'), opacity: $('opacity'), setup: $('setup'), error: $('error'),
  dot: $('dot'), status: $('status'), activity: $('activity')
};
let state;

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
  elements.setup.hidden = state.connected;
  elements.status.textContent = state.status;
  elements.activity.textContent = state.onlyWhileCoding ? ` · ${state.secondsSinceCoding}s` : '';
  elements.dot.className = state.connected && state.autoScrollEnabled && state.codingActive ? 'active' : 'paused';
  elements.error.hidden = !(state.serverError || browser.error);
  elements.error.textContent = state.serverError || browser.error || '';
  document.querySelectorAll('.transport button').forEach(button => { button.disabled = !state.connected; });

  if (!state.connected) {
    elements.headline.textContent = 'Conecta Chrome o Edge';
    elements.detail.textContent = 'Carga el conector local una vez. DoomScroll nunca recibe tu contraseña ni tus cookies.';
    elements.reelIcon.textContent = '↔';
  } else if (!browser.pageReady) {
    elements.headline.textContent = 'Abre Instagram Reels';
    elements.detail.textContent = 'El conector está listo, pero no encuentra una pestaña de Reels abierta.';
    elements.reelIcon.textContent = '◎';
  } else if (!browser.hasVideo) {
    elements.headline.textContent = 'Buscando el Reel';
    elements.detail.textContent = browser.status || 'Instagram está cargando el video activo.';
    elements.reelIcon.textContent = '…';
  } else {
    elements.headline.textContent = browser.playing ? 'Reel reproduciéndose' : 'Reel en pausa';
    const duration = browser.duration > 0 ? ` · ${Math.round(browser.currentTime)}s / ${Math.round(browser.duration)}s` : '';
    elements.detail.textContent = `${state.status}${duration}`;
    elements.reelIcon.textContent = browser.playing ? '▶' : 'Ⅱ';
  }
});
