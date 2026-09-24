const vscode = acquireVsCodeApi();
const elements = {
  play: document.getElementById('play'), interval: document.getElementById('interval'),
  smart: document.getElementById('smart'), mute: document.getElementById('mute'),
  openReels: document.getElementById('openReels'), onlyCoding: document.getElementById('onlyCoding'),
  volume: document.getElementById('volume'), volumeValue: document.getElementById('volumeValue'),
  opacity: document.getElementById('opacity'), content: document.getElementById('content'),
  status: document.getElementById('status'), dot: document.getElementById('dot'),
  addForm: document.getElementById('addForm'), reelUrl: document.getElementById('reelUrl'),
  reelFrame: document.getElementById('reelFrame'), empty: document.getElementById('empty'),
  reelNav: document.getElementById('reelNav'), previous: document.getElementById('previous'),
  next: document.getElementById('next'), remove: document.getElementById('remove'), counter: document.getElementById('counter')
};
let state;
let loadedUrl = '';
let reelStartedAt = Date.now();

const update = (key, value) => vscode.postMessage({ type: 'updateSetting', key, value });
elements.openReels.addEventListener('click', () => vscode.postMessage({ type: 'openReels' }));
elements.addForm.addEventListener('submit', event => { event.preventDefault(); vscode.postMessage({ type: 'addReel', url: elements.reelUrl.value }); elements.reelUrl.value = ''; });
elements.previous.addEventListener('click', () => selectRelative(-1));
elements.next.addEventListener('click', () => selectRelative(1));
elements.remove.addEventListener('click', () => vscode.postMessage({ type: 'removeReel' }));
elements.play.addEventListener('click', () => update('autoScrollEnabled', !state.autoScrollEnabled));
elements.smart.addEventListener('click', () => update('smartModeEnabled', !state.smartModeEnabled));
elements.mute.addEventListener('click', () => update('muted', !state.muted));
elements.interval.addEventListener('change', event => update('intervalSeconds', Number(event.target.value)));
elements.onlyCoding.addEventListener('change', event => update('onlyWhileCoding', event.target.checked));
elements.volume.addEventListener('input', event => { elements.volumeValue.value = event.target.value + '%'; });
elements.volume.addEventListener('change', event => update('volume', Number(event.target.value)));
elements.opacity.addEventListener('change', event => update('opacity', Number(event.target.value)));

function selectRelative(delta) {
  if (!state?.reels?.length) return;
  const index = (state.currentIndex + delta + state.reels.length) % state.reels.length;
  vscode.postMessage({ type: 'selectReel', index });
}

setInterval(() => {
  if (!state?.reels?.length || state.status.startsWith('PAUSED')) return;
  if (Date.now() - reelStartedAt >= state.intervalSeconds * 1000) selectRelative(1);
}, 500);

window.addEventListener('message', event => {
  if (event.data?.type !== 'state') return;
  state = event.data.value;
  elements.play.textContent = state.autoScrollEnabled ? '⏸' : '▶';
  elements.interval.value = String(state.intervalSeconds);
  elements.smart.classList.toggle('active', state.smartModeEnabled);
  elements.mute.textContent = state.muted ? '🔇' : '🔊';
  elements.onlyCoding.checked = state.onlyWhileCoding;
  elements.volume.value = String(state.volume);
  elements.volumeValue.value = state.volume + '%';
  elements.opacity.value = String(state.opacity);
  elements.content.style.opacity = String(state.opacity);
  elements.status.textContent = state.status;
  elements.dot.className = state.status.startsWith('PAUSED') ? 'paused' : 'active';
  const hasReels = state.reels.length > 0;
  elements.empty.hidden = hasReels;
  elements.reelFrame.hidden = !hasReels;
  elements.reelNav.hidden = !hasReels;
  if (hasReels) {
    const url = state.reels[state.currentIndex];
    if (url !== loadedUrl) { loadedUrl = url; elements.reelFrame.src = url; reelStartedAt = Date.now(); }
    elements.counter.textContent = `${state.currentIndex + 1} / ${state.reels.length}`;
  } else if (loadedUrl) { loadedUrl = ''; elements.reelFrame.removeAttribute('src'); }
});
