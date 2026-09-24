import * as vscode from 'vscode';
import WebSocket, { WebSocketServer } from 'ws';

const REELS_URL = vscode.Uri.parse('https://www.instagram.com/reels/');
const VIEW_ID = 'doomScroll.reelsView';
const PORT = 8765;
const PROTOCOL_VERSION = 1;
const EXPECTED_CONNECTOR_VERSION = '2.1.2';
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_MEDIA_CHUNK_BYTES = 4 * 1024 * 1024;
const CONFIG_KEYS = new Set([
  'autoScrollEnabled', 'intervalSeconds', 'smartModeEnabled', 'onlyWhileCoding',
  'inactivityTimeoutSeconds', 'volume', 'muted', 'opacity'
]);

interface ControllerSettings {
  autoScrollEnabled: boolean;
  intervalSeconds: number;
  smartModeEnabled: boolean;
  onlyWhileCoding: boolean;
  inactivityTimeoutSeconds: number;
  volume: number;
  muted: boolean;
  opacity: number;
}

interface BrowserState {
  connectorVersion?: string;
  pageReady: boolean;
  pageUrl?: string;
  hasVideo: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  muted: boolean;
  volume: number;
  status?: string;
  error?: string;
}

interface UiState extends ControllerSettings {
  connected: boolean;
  serverReady: boolean;
  serverError?: string;
  codingActive: boolean;
  secondsSinceCoding: number;
  status: string;
  mediaStreaming: boolean;
  expectedConnectorVersion: string;
  browser: BrowserState;
}

class CodingActivityTracker implements vscode.Disposable {
  private lastActivity = Date.now();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidActivity = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor() {
    this.subscription = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.contentChanges.length === 0 || !['file', 'untitled', 'vscode-notebook-cell'].includes(event.document.uri.scheme)) {
        return;
      }
      this.lastActivity = Date.now();
      this.emitter.fire();
    });
  }

  secondsSinceActivity(): number {
    return Math.floor((Date.now() - this.lastActivity) / 1000);
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

class BrowserBridge implements vscode.Disposable {
  private server?: WebSocketServer;
  private client?: WebSocket;
  private mediaProducer?: WebSocket;
  private readonly mediaConsumers = new Set<WebSocket>();
  private serverReady = false;
  private serverError?: string;
  private browser: BrowserState = {
    pageReady: false,
    hasVideo: false,
    playing: false,
    currentTime: 0,
    duration: 0,
    muted: false,
    volume: 0
  };
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly getSettings: () => ControllerSettings,
    private readonly getCodingState: () => { active: boolean; secondsSinceActivity: number }
  ) {
    this.start();
  }

  private start(): void {
    try {
      const server = new WebSocketServer({ host: '127.0.0.1', port: PORT, maxPayload: MAX_MEDIA_CHUNK_BYTES });
      this.server = server;
      server.on('listening', () => {
        this.serverReady = true;
        this.serverError = undefined;
        this.emitter.fire();
      });
      server.on('connection', (socket, request) => this.route(socket, request.url));
      server.on('error', error => {
        this.serverReady = false;
        this.serverError = error.message;
        this.emitter.fire();
      });
    } catch (error) {
      this.serverError = error instanceof Error ? error.message : String(error);
      this.emitter.fire();
    }
  }

  private route(socket: WebSocket, path?: string): void {
    if (path?.startsWith('/media-producer')) {
      this.acceptMediaProducer(socket);
      return;
    }
    if (path?.startsWith('/media-consumer')) {
      this.acceptMediaConsumer(socket);
      return;
    }
    if (path?.startsWith('/control') || path === '/' || !path) {
      this.accept(socket);
      return;
    }
    socket.close(1008, 'Unknown DoomScroll channel');
  }

  private acceptMediaProducer(socket: WebSocket): void {
    this.mediaProducer?.close(1000, 'Replaced by a newer capture');
    this.mediaProducer = socket;
    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        const text = data.toString();
        if (text.length > 2048) { return; }
        for (const consumer of this.mediaConsumers) {
          if (consumer.readyState === WebSocket.OPEN) { consumer.send(text); }
        }
        return;
      }
      for (const consumer of this.mediaConsumers) {
        if (consumer.readyState === WebSocket.OPEN && consumer.bufferedAmount < MAX_MEDIA_CHUNK_BYTES * 2) {
          consumer.send(data, { binary: true });
        }
      }
    });
    socket.on('close', () => {
      if (this.mediaProducer === socket) {
        this.mediaProducer = undefined;
        this.emitter.fire();
      }
    });
    socket.on('error', () => undefined);
    if (this.mediaConsumers.size > 0) {
      socket.send(JSON.stringify({ type: 'CONSUMER_READY' }));
    }
    this.emitter.fire();
  }

  private acceptMediaConsumer(socket: WebSocket): void {
    this.mediaConsumers.add(socket);
    socket.on('close', () => this.mediaConsumers.delete(socket));
    socket.on('error', () => undefined);
    if (this.mediaProducer?.readyState === WebSocket.OPEN) {
      this.mediaProducer.send(JSON.stringify({ type: 'CONSUMER_READY' }));
    }
  }

  private accept(socket: WebSocket): void {
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      this.client.close(1000, 'Replaced by a newer DoomScroll connector');
    }
    this.client = socket;
    this.browser.error = undefined;
    socket.on('message', data => this.receive(data.toString()));
    socket.on('close', () => {
      if (this.client === socket) {
        this.client = undefined;
        this.browser = { ...this.browser, pageReady: false, hasVideo: false, playing: false, status: 'Connector disconnected' };
        this.emitter.fire();
      }
    });
    socket.on('error', () => undefined);
    this.send({ type: 'WELCOME', protocolVersion: PROTOCOL_VERSION });
    this.syncAll();
    this.emitter.fire();
  }

  private receive(raw: string): void {
    if (Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_BYTES) {
      this.client?.close(1009, 'Message too large');
      return;
    }
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return; }
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === 'PING') {
      this.send({ type: 'PONG', at: Date.now() });
      return;
    }
    if (message.type === 'HELLO') {
      this.browser.connectorVersion = stringValue(message.browserVersion, this.browser.connectorVersion);
      this.syncAll();
      this.emitter.fire();
      return;
    }
    if (message.type === 'PAGE_STATE' || message.type === 'REEL_STATE' || message.type === 'ERROR') {
      this.browser = {
        pageReady: booleanValue(message.pageReady, this.browser.pageReady),
        pageUrl: stringValue(message.pageUrl, this.browser.pageUrl),
        hasVideo: booleanValue(message.hasVideo, this.browser.hasVideo),
        playing: booleanValue(message.playing, this.browser.playing),
        currentTime: numberValue(message.currentTime, this.browser.currentTime),
        duration: numberValue(message.duration, this.browser.duration),
        muted: booleanValue(message.muted, this.browser.muted),
        volume: numberValue(message.volume, this.browser.volume),
        status: stringValue(message.status, this.browser.status),
        error: message.type === 'ERROR' ? stringValue(message.message, 'Browser connector error') : undefined
      };
      this.emitter.fire();
    }
  }

  getState(): { connected: boolean; serverReady: boolean; serverError?: string; mediaStreaming: boolean; browser: BrowserState } {
    return {
      connected: this.client?.readyState === WebSocket.OPEN,
      serverReady: this.serverReady,
      serverError: this.serverError,
      mediaStreaming: this.mediaProducer?.readyState === WebSocket.OPEN,
      browser: { ...this.browser }
    };
  }

  syncAll(): void {
    this.send({ type: 'SETTINGS', value: this.getSettings() });
    this.syncCodingState();
  }

  syncCodingState(): void {
    this.send({ type: 'CODING_STATE', value: this.getCodingState() });
  }

  command(name: string, value?: unknown): void {
    this.send({ type: 'COMMAND', name, value });
  }

  private send(message: Record<string, unknown>): void {
    if (this.client?.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify(message));
    }
  }

  dispose(): void {
    this.client?.close(1001, 'VS Code extension stopped');
    this.mediaProducer?.close(1001, 'VS Code extension stopped');
    for (const consumer of this.mediaConsumers) { consumer.close(1001, 'VS Code extension stopped'); }
    this.server?.close();
    this.emitter.dispose();
  }
}

class DoomScrollViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timer: NodeJS.Timeout;
  private lastCodingActive?: boolean;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tracker: CodingActivityTracker,
    private readonly bridge: BrowserBridge,
    private readonly onStateChanged: (state: UiState) => void
  ) {
    this.disposables.push(
      tracker.onDidActivity(() => this.refresh(true)),
      bridge.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('doomScroll')) {
          this.bridge.syncAll();
          this.refresh();
        }
      })
    );
    this.timer = setInterval(() => this.refresh(), 1000);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    view.webview.html = this.html(view.webview);
    this.disposables.push(
      view.webview.onDidReceiveMessage(message => this.handleMessage(message)),
      view.onDidDispose(() => { if (this.view === view) { this.view = undefined; } })
    );
    this.refresh(true);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') { return; }
    const data = message as Record<string, unknown>;
    if (data.type === 'openReels') {
      await vscode.env.openExternal(REELS_URL);
      return;
    }
    if (data.type === 'openConnectorFolder') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.joinPath(this.context.extensionUri, 'browser-extension'));
      return;
    }
    if (data.type === 'command' && typeof data.name === 'string') {
      this.bridge.command(data.name, data.value);
      return;
    }
    if (data.type === 'updateSetting' && typeof data.key === 'string' && CONFIG_KEYS.has(data.key)) {
      await vscode.workspace.getConfiguration('doomScroll').update(data.key, data.value, vscode.ConfigurationTarget.Global);
    }
  }

  refresh(forceCodingSync = false): void {
    const state = this.state();
    if (forceCodingSync || state.codingActive !== this.lastCodingActive) {
      this.lastCodingActive = state.codingActive;
      this.bridge.syncCodingState();
    }
    void this.view?.webview.postMessage({ type: 'state', value: state });
    this.onStateChanged(state);
  }

  private state(): UiState {
    const settings = readSettings();
    const secondsSinceCoding = this.tracker.secondsSinceActivity();
    const codingActive = !settings.onlyWhileCoding || secondsSinceCoding <= settings.inactivityTimeoutSeconds;
    const connection = this.bridge.getState();
    const status = !connection.serverReady
      ? 'LOCAL SERVER ERROR'
      : !connection.connected
        ? 'CONNECT BROWSER'
        : !settings.autoScrollEnabled
          ? 'PAUSED BY USER'
          : !codingActive
            ? 'PAUSED - NOT CODING'
            : settings.smartModeEnabled ? 'SMART ACTIVE' : 'AUTO ACTIVE';
    return { ...settings, ...connection, expectedConnectorVersion: EXPECTED_CONNECTOR_VERSION, codingActive, secondsSinceCoding, status };
  }

  private html(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'styles.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; connect-src ws://127.0.0.1:${PORT}; media-src blob:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>DoomScroll Reels</title>
</head>
<body>
  <header><strong>DoomScroll</strong><span id="connection" class="badge">Cargando</span></header>
  <main id="content">
    <section class="hero">
      <div class="reel-card" id="playerShell">
        <video id="streamVideo" autoplay muted playsinline></video>
        <div id="streamPlaceholder" class="stream-placeholder"><span id="reelIcon">▶</span><small id="streamHint">Pulsa el icono del conector en Chrome para transmitir</small></div>
      </div>
      <h2 id="headline">Conecta tu navegador</h2>
      <p id="detail">Carga el conector de Chrome o Edge una vez y abre Instagram Reels.</p>
      <div class="primary-actions">
        <button id="openReels" class="primary">Abrir Instagram Reels</button>
        <button id="openConnector">Abrir carpeta del conector</button>
      </div>
    </section>
    <section class="transport" aria-label="Controles de reproducción">
      <button id="previous" title="Reel anterior">←</button>
      <button id="play" class="round" title="Pausar o reanudar">⏸</button>
      <button id="next" title="Siguiente Reel">→</button>
      <button id="mute" title="Silenciar">🔊</button>
      <button id="pip" title="Picture in Picture">▣</button>
    </section>
    <section class="settings" aria-label="Preferencias">
      <label>Intervalo <select id="interval"><option value="5">5s</option><option value="10">10s</option><option value="15">15s</option><option value="30">30s</option></select></label>
      <label><span>Smart Mode<small>Avanza al terminar el video</small></span><input id="smart" type="checkbox"></label>
      <label><span>Solo mientras programo<small>Pausa tras 20 s sin escribir</small></span><input id="onlyCoding" type="checkbox"></label>
      <label>Volumen <input id="volume" type="range" min="0" max="100" step="1"><output id="volumeValue"></output></label>
      <label>Opacidad <select id="opacity"><option value="1">100%</option><option value="0.9">90%</option><option value="0.8">80%</option><option value="0.7">70%</option><option value="0.6">60%</option></select></label>
    </section>
    <section class="setup" id="setup">
      <h3>Configuración inicial</h3>
      <ol><li>Abre la carpeta del conector.</li><li>Ve a <code>chrome://extensions</code> o <code>edge://extensions</code>.</li><li>Activa Modo desarrollador y elige <b>Cargar descomprimida</b>.</li><li>Selecciona esa carpeta y abre Reels.</li></ol>
    </section>
    <p id="error" class="error" hidden></p>
  </main>
  <footer><span id="dot">●</span> <span id="status">CARGANDO</span><span id="activity"></span></footer>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const disposable of this.disposables) { disposable.dispose(); }
  }
}

function readSettings(): ControllerSettings {
  const config = vscode.workspace.getConfiguration('doomScroll');
  return {
    autoScrollEnabled: config.get('autoScrollEnabled', true),
    intervalSeconds: config.get('intervalSeconds', 10),
    smartModeEnabled: config.get('smartModeEnabled', true),
    onlyWhileCoding: config.get('onlyWhileCoding', true),
    inactivityTimeoutSeconds: config.get('inactivityTimeoutSeconds', 20),
    volume: config.get('volume', 35),
    muted: config.get('muted', false),
    opacity: config.get('opacity', 1)
  };
}

function booleanValue(value: unknown, fallback: boolean): boolean { return typeof value === 'boolean' ? value : fallback; }
function numberValue(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
function stringValue(value: unknown, fallback?: string): string | undefined { return typeof value === 'string' ? value.slice(0, 500) : fallback; }

export function activate(context: vscode.ExtensionContext): void {
  const tracker = new CodingActivityTracker();
  const getCodingState = () => {
    const settings = readSettings();
    const secondsSinceActivity = tracker.secondsSinceActivity();
    return { active: !settings.onlyWhileCoding || secondsSinceActivity <= settings.inactivityTimeoutSeconds, secondsSinceActivity };
  };
  const bridge = new BrowserBridge(readSettings, getCodingState);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBar.name = 'DoomScroll';
  statusBar.command = 'doomScroll.open';
  statusBar.show();
  const provider = new DoomScrollViewProvider(context, tracker, bridge, state => {
    statusBar.text = state.connected ? `$(radio-tower) DoomScroll: ${state.status}` : '$(plug) DoomScroll: Connect browser';
    statusBar.tooltip = state.serverError ?? (state.connected ? 'Browser connector connected on localhost:8765' : 'Open DoomScroll to connect Chrome or Edge');
  });

  context.subscriptions.push(
    tracker,
    bridge,
    provider,
    statusBar,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('doomScroll.open', () => vscode.commands.executeCommand('workbench.view.extension.doomScroll')),
    vscode.commands.registerCommand('doomScroll.openReels', () => vscode.env.openExternal(REELS_URL)),
    vscode.commands.registerCommand('doomScroll.openConnectorFolder', () => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.joinPath(context.extensionUri, 'browser-extension'))),
    vscode.commands.registerCommand('doomScroll.toggleAutoScroll', async () => {
      const config = vscode.workspace.getConfiguration('doomScroll');
      await config.update('autoScrollEnabled', !config.get('autoScrollEnabled', true), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('doomScroll.nextReel', () => bridge.command('NEXT')),
    vscode.commands.registerCommand('doomScroll.previousReel', () => bridge.command('PREVIOUS'))
  );
  provider.refresh(true);
}

export function deactivate(): void { }
