# DoomScroll Reels para Visual Studio Code

DoomScroll controla el feed real de Instagram Reels en Chrome o Edge desde una vista lateral de Visual Studio Code. Instagram continúa abierto en el navegador con tu sesión normal; VS Code solamente envía controles por una conexión local.

## Arquitectura

```text
VS Code extension                       Chrome / Edge extension
┌──────────────────────────┐            ┌────────────────────────────┐
│ Sidebar + settings       │            │ MV3 service worker         │
│ Coding activity tracker  │◄── WS ────►│ reconnect + heartbeat      │
│ 127.0.0.1:8765 only      │            │ content script on Instagram│
└──────────────────────────┘            └────────────────────────────┘
```

- La extensión de VS Code abre un servidor WebSocket únicamente en `127.0.0.1:8765`.
- El service worker del navegador mantiene y recupera la conexión local.
- El content script controla el video visible y navega al Reel siguiente o anterior.
- No se envían cookies, contraseñas, mensajes privados ni el contenido de tu cuenta.

## Instalación

### 1. Visual Studio Code

1. Descarga `doomscroll-vscode-2.1.3.vsix` desde Releases o créalo con `npm run package`.
2. En VS Code abre **Extensions → ⋯ → Install from VSIX…**.
3. Reinicia VS Code y abre DoomScroll desde la Activity Bar.

### 2. Chrome o Edge

1. En DoomScroll pulsa **Abrir carpeta del conector**.
2. Abre `chrome://extensions` o `edge://extensions`.
3. Activa **Modo desarrollador**.
4. Pulsa **Cargar descomprimida** y selecciona la carpeta `browser-extension`.
5. Abre `https://www.instagram.com/reels/` con tu sesión normal.
6. Con la pestaña de Reels activa, pulsa una vez el icono de **DoomScroll Browser Connector** en Chrome/Edge. Verás la insignia `LIVE` y el Reel aparecerá dentro de VS Code. Otro clic detiene la transmisión.

## Funciones

- Reels siguiente/anterior, pausa del auto-scroll, volumen, mute y Picture in Picture.
- Intervalos de 5, 10, 15 o 30 segundos.
- Smart Mode: avanza cuando termina el video y conserva el intervalo máximo configurado.
- Modo **Solo mientras programo**: mantiene el auto-scroll mientras detecta cambios reales en archivos y lo pausa tras 20 segundos sin escribir.
- Estado en vivo del conector, la pestaña y el Reel visible.
- Transmisión recortada del Reel real, con audio, dentro de la barra lateral de VS Code.
- Reconexión automática y latido para el service worker Manifest V3.

## Desarrollo

```powershell
npm install
npm run check
npm run package
```

Presiona `F5` en VS Code para ejecutar el Extension Development Host. El conector del navegador puede cargarse directamente desde `browser-extension`.

## Límites reales

- Instagram no permite incrustar el feed autenticado dentro de un Webview. El video permanece en una pestaña normal del navegador.
- El conector depende del DOM de Instagram. Si Instagram cambia completamente su estructura, la navegación de respaldo puede necesitar una actualización.
- Chrome/Edge pueden exigir una interacción del usuario para Picture in Picture o reproducción con sonido.
- DoomScroll no inicia sesión por ti y nunca solicita credenciales.
