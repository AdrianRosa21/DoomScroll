# DoomScroll Reels para Visual Studio Code

Extensión compacta de VS Code para guardar y reproducir una lista de Reels públicos dentro de la barra lateral.

## Desarrollo

1. Abre esta carpeta en **Visual Studio Code**.
2. Ejecuta `npm install`.
3. Presiona **F5** y elige **Run DoomScroll Extension**.
4. En la nueva ventana de Extension Development Host, usa **Ctrl+Alt+I** o el icono de DoomScroll en la Activity Bar.

Para crear el instalador:

```text
npm run package
```

## Funciones

- Vista lateral compacta, adaptable y compatible con los temas de VS Code.
- Comandos `DoomScroll: Open DoomScroll`, `Open Instagram Reels` y `Toggle Auto Scroll`.
- Detección de cambios reales en documentos mediante `onDidChangeTextDocument`.
- Estado `AUTO`, `SMART`, `PAUSED BY USER` o `PAUSED - NOT CODING`.
- Preferencias persistentes de intervalo, Smart Mode, actividad, volumen, mute y opacidad.
- Lista persistente de hasta 30 enlaces con embeds oficiales de Reels públicos.

## Limitación de Instagram

Instagram devuelve `X-Frame-Options: DENY` para el feed completo `https://www.instagram.com/reels/`, pero permite el endpoint oficial de un Reel individual (`/reel/{id}/embed/`). Por eso la extensión reproduce dentro de la barra lateral los enlaces públicos que agregues, pero no puede importar ni controlar el feed infinito, iniciar sesión o descubrir automáticamente el siguiente Reel. No almacena credenciales, cookies ni tokens.
