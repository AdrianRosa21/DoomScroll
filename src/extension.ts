import * as vscode from 'vscode';

const REELS_URL = vscode.Uri.parse('https://www.instagram.com/reels/');
const VIEW_ID = 'doomScroll.reelsView';
const CONFIG_KEYS = new Set([
  'autoScrollEnabled', 'intervalSeconds', 'smartModeEnabled', 'onlyWhileCoding',
  'inactivityTimeoutSeconds', 'volume', 'muted', 'phoneMode', 'opacity'
]);

interface DoomScrollState {
  autoScrollEnabled: boolean;
  intervalSeconds: number;
  smartModeEnabled: boolean;
  onlyWhileCoding: boolean;
  inactivityTimeoutSeconds: number;
  volume: number;
  muted: boolean;
  phoneMode: boolean;
  opacity: number;
  status: 'AUTO' | 'SMART' | 'PAUSED BY USER' | 'PAUSED - NOT CODING';
  secondsSinceCoding: number;
  reels: string[];
  currentIndex: number;
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

class DoomScrollViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tracker: CodingActivityTracker
  ) {
    this.disposables.push(
      tracker.onDidActivity(() => this.postState()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('doomScroll')) {
          this.postState();
        }
      })
    );
    this.timer = setInterval(() => this.postState(), 1000);
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
    this.postState();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') { return; }
    const data = message as Record<string, unknown>;
    if (data.type === 'openReels') {
      await vscode.env.openExternal(REELS_URL);
      return;
    }
    if (data.type === 'addReel' && typeof data.url === 'string') {
      const embed = this.toEmbedUrl(data.url);
      if (!embed) {
        void vscode.window.showWarningMessage('Pega un enlace válido de Instagram: instagram.com/reel/ID');
        return;
      }
      const reels = this.context.globalState.get<string[]>('reels', []);
      const next = reels.includes(embed) ? reels : [...reels, embed].slice(-30);
      await this.context.globalState.update('reels', next);
      await this.context.globalState.update('currentIndex', next.indexOf(embed));
      this.postState();
      return;
    }
    if (data.type === 'selectReel' && typeof data.index === 'number') {
      const reels = this.context.globalState.get<string[]>('reels', []);
      const index = Math.max(0, Math.min(reels.length - 1, Math.trunc(data.index)));
      await this.context.globalState.update('currentIndex', index);
      this.postState();
      return;
    }
    if (data.type === 'removeReel') {
      const reels = this.context.globalState.get<string[]>('reels', []);
      const index = this.context.globalState.get<number>('currentIndex', 0);
      if (reels.length > 0) { reels.splice(Math.max(0, Math.min(index, reels.length - 1)), 1); }
      await this.context.globalState.update('reels', reels);
      await this.context.globalState.update('currentIndex', Math.max(0, Math.min(index, reels.length - 1)));
      this.postState();
      return;
    }
    if (data.type === 'updateSetting' && typeof data.key === 'string' && CONFIG_KEYS.has(data.key)) {
      await vscode.workspace.getConfiguration('doomScroll').update(data.key, data.value, vscode.ConfigurationTarget.Global);
    }
  }

  private toEmbedUrl(value: string): string | undefined {
    try {
      const url = new URL(value.trim());
      const host = url.hostname.toLowerCase();
      if (host !== 'instagram.com' && host !== 'www.instagram.com') { return undefined; }
      const match = url.pathname.match(/\/(?:reel|reels)\/([A-Za-z0-9_-]+)/i);
      return match ? `https://www.instagram.com/reel/${match[1]}/embed/` : undefined;
    } catch { return undefined; }
  }

  private state(): DoomScrollState {
    const config = vscode.workspace.getConfiguration('doomScroll');
    const secondsSinceCoding = this.tracker.secondsSinceActivity();
    const autoScrollEnabled = config.get('autoScrollEnabled', true);
    const smartModeEnabled = config.get('smartModeEnabled', true);
    const onlyWhileCoding = config.get('onlyWhileCoding', true);
    const inactivityTimeoutSeconds = config.get('inactivityTimeoutSeconds', 20);
    const status = !autoScrollEnabled
      ? 'PAUSED BY USER'
      : onlyWhileCoding && secondsSinceCoding > inactivityTimeoutSeconds
        ? 'PAUSED - NOT CODING'
        : smartModeEnabled ? 'SMART' : 'AUTO';
    const reels = this.context.globalState.get<string[]>('reels', []);
    const storedIndex = this.context.globalState.get<number>('currentIndex', 0);
    return {
      autoScrollEnabled,
      intervalSeconds: config.get('intervalSeconds', 10),
      smartModeEnabled,
      onlyWhileCoding,
      inactivityTimeoutSeconds,
      volume: config.get('volume', 35),
      muted: config.get('muted', false),
      phoneMode: config.get('phoneMode', true),
      opacity: config.get('opacity', 1),
      status,
      secondsSinceCoding,
      reels,
      currentIndex: Math.max(0, Math.min(storedIndex, Math.max(0, reels.length - 1)))
    };
  }

  postState(): void {
    void this.view?.webview.postMessage({ type: 'state', value: this.state() });
  }

  private html(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'styles.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; frame-src https://www.instagram.com https://instagram.com;">
  <link rel="stylesheet" href="${styleUri}">
  <title>DoomScroll Reels</title>
</head>
<body>
  <header>
    <strong>DoomScroll</strong>
    <button id="play" title="Pausar o reanudar el controlador">⏸</button>
    <select id="interval" title="Intervalo preferido"><option value="5">5s</option><option value="10">10s</option><option value="15">15s</option><option value="30">30s</option></select>
    <button id="smart" title="Smart Mode">Smart</button>
    <button id="mute" title="Mute">🔊</button>
  </header>
  <main id="content">
    <div class="phone">
      <form id="addForm"><input id="reelUrl" type="url" required placeholder="Pega un enlace instagram.com/reel/…" aria-label="Enlace del Reel"><button type="submit">Agregar</button></form>
      <div id="empty" class="empty"><div class="reel-placeholder" aria-hidden="true"><span>▶</span></div><h2>Agrega tu primer Reel</h2><p>Copia el enlace de un Reel público y pégalo arriba. Los embeds oficiales sí pueden aparecer aquí.</p></div>
      <iframe id="reelFrame" title="Instagram Reel" allow="autoplay; encrypted-media; picture-in-picture" loading="eager"></iframe>
      <nav id="reelNav"><button id="previous" title="Reel anterior">←</button><span id="counter"></span><button id="next" title="Siguiente Reel">→</button><button id="remove" title="Quitar este Reel">✕</button></nav>
      <button id="openReels" class="secondary">Buscar Reels en Instagram</button>
      <p class="note">El feed completo no admite embed. Esta lista guarda hasta 30 enlaces públicos; no guarda credenciales.</p>
    </div>
    <section class="settings" aria-label="Preferencias">
      <label><input id="onlyCoding" type="checkbox"> Solo mientras programo</label>
      <label>Volumen <input id="volume" type="range" min="0" max="100" step="1"><output id="volumeValue"></output></label>
      <label>Opacidad <select id="opacity"><option value="1">100%</option><option value="0.9">90%</option><option value="0.8">80%</option><option value="0.7">70%</option><option value="0.6">60%</option></select></label>
    </section>
  </main>
  <footer><span id="dot">●</span> <span id="status">CARGANDO</span></footer>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const disposable of this.disposables) { disposable.dispose(); }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const tracker = new CodingActivityTracker();
  const provider = new DoomScrollViewProvider(context, tracker);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBar.name = 'DoomScroll';
  statusBar.text = '$(play-circle) DoomScroll';
  statusBar.tooltip = 'Open DoomScroll';
  statusBar.command = 'doomScroll.open';
  statusBar.show();

  context.subscriptions.push(
    tracker,
    provider,
    statusBar,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('doomScroll.open', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.doomScroll');
    }),
    vscode.commands.registerCommand('doomScroll.openReels', async () => {
      await vscode.env.openExternal(REELS_URL);
    }),
    vscode.commands.registerCommand('doomScroll.toggleAutoScroll', async () => {
      const config = vscode.workspace.getConfiguration('doomScroll');
      await config.update('autoScrollEnabled', !config.get('autoScrollEnabled', true), vscode.ConfigurationTarget.Global);
      provider.postState();
    })
  );
}

export function deactivate(): void { }
