const status = document.getElementById('status');
const dot = document.getElementById('dot');

async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  const connected = Boolean(result?.connectionState?.connected);
  status.textContent = connected ? 'Conectado con Visual Studio Code' : 'VS Code desconectado';
  dot.className = connected ? 'connected' : '';
}

document.getElementById('open').addEventListener('click', () => chrome.tabs.create({ url: 'https://www.instagram.com/reels/' }));
document.getElementById('reconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'RECONNECT' });
  setTimeout(refresh, 500);
});
document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'POPUP_COMMAND', name: button.dataset.command });
}));
chrome.runtime.onMessage.addListener(message => { if (message.type === 'CONNECTION_STATE') refresh(); });
refresh();
