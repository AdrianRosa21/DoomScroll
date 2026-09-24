const STREAM_URL = 'ws://127.0.0.1:8765/media-producer';
const MIME_CANDIDATES = [
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp8',
  'video/webm'
];
let socket;
let reconnectTimer;
let sourceStream;
let outputStream;
let recorder;
let sourceVideo;
let canvas;
let context;
let renderTimer;
let crop;
let captureActive = false;
let previewBusy = false;
let lastPreviewAt = 0;

function connect() {
  clearTimeout(reconnectTimer);
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  socket = new WebSocket(STREAM_URL);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    // The VS Code consumer asks for a fresh MediaRecorder header when ready.
  });
  socket.addEventListener('message', event => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'CONSUMER_READY' && sourceStream) restartRecorder();
    } catch { /* Binary media never arrives on the producer channel. */ }
  });
  socket.addEventListener('close', () => {
    stopRecorder();
    if (captureActive) reconnectTimer = setTimeout(connect, 1500);
  });
  socket.addEventListener('error', () => undefined);
}

function selectMimeType() {
  return MIME_CANDIDATES.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

async function startCapture(streamId) {
  stopCapture();
  sourceStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30
      }
    }
  });
  sourceVideo = document.createElement('video');
  sourceVideo.srcObject = sourceStream;
  sourceVideo.muted = true;
  sourceVideo.playsInline = true;
  if (sourceVideo.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise(resolve => sourceVideo.addEventListener('loadedmetadata', resolve, { once: true }));
  }
  await sourceVideo.play();

  canvas = document.createElement('canvas');
  canvas.width = 540;
  canvas.height = 960;
  context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  renderFrame();
  renderTimer = setInterval(renderFrame, 1000 / 30);

  // Record Chrome's native tab stream. The canvas is kept only for the
  // cropped JPEG fallback shown when a VS Code Webview cannot decode WebM.
  outputStream = sourceStream;
  captureActive = true;
  connect();
  sourceStream.getTracks().forEach(track => track.addEventListener('ended', stopCapture, { once: true }));
}

function renderFrame() {
  if (!sourceVideo || !context || !canvas) return;
  const videoWidth = sourceVideo.videoWidth;
  const videoHeight = sourceVideo.videoHeight;
  if (videoWidth > 0 && videoHeight > 0) {
    const validCrop = crop && crop.width > 20 && crop.height > 20 && crop.viewportWidth > 0 && crop.viewportHeight > 0;
    let sx;
    let sy;
    let sw;
    let sh;
    if (validCrop) {
      const scaleX = videoWidth / crop.viewportWidth;
      const scaleY = videoHeight / crop.viewportHeight;
      sx = Math.max(0, crop.x * scaleX);
      sy = Math.max(0, crop.y * scaleY);
      sw = Math.min(videoWidth - sx, crop.width * scaleX);
      sh = Math.min(videoHeight - sy, crop.height * scaleY);
    } else {
      sh = videoHeight;
      sw = Math.min(videoWidth, sh * 9 / 16);
      sx = (videoWidth - sw) / 2;
      sy = 0;
    }
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(sourceVideo, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    if (!previewBusy && Date.now() - lastPreviewAt >= 100 && socket?.readyState === WebSocket.OPEN) {
      previewBusy = true;
      lastPreviewAt = Date.now();
      try {
        canvas.toBlob(async blob => {
          try {
            if (!blob || socket?.readyState !== WebSocket.OPEN) return;
            const jpeg = new Uint8Array(await blob.arrayBuffer());
            const packet = new Uint8Array(jpeg.byteLength + 1);
            packet[0] = 0x4a;
            packet.set(jpeg, 1);
            socket.send(packet.buffer);
          } finally {
            previewBusy = false;
          }
        }, 'image/jpeg', 0.72);
      } catch {
        previewBusy = false;
      }
    }
  }
}

function restartRecorder() {
  stopRecorder();
  if (!outputStream || socket?.readyState !== WebSocket.OPEN) return;
  const mimeType = selectMimeType();
  const nextRecorder = new MediaRecorder(outputStream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: 1_300_000,
    audioBitsPerSecond: 96_000
  });
  recorder = nextRecorder;
  socket.send(JSON.stringify({ type: 'STREAM_RESET', mimeType: nextRecorder.mimeType || mimeType || 'video/webm' }));
  nextRecorder.addEventListener('dataavailable', async event => {
    if (recorder !== nextRecorder || event.data.size === 0 || socket?.readyState !== WebSocket.OPEN) return;
    const media = new Uint8Array(await event.data.arrayBuffer());
    const packet = new Uint8Array(media.byteLength + 1);
    packet[0] = 0x57;
    packet.set(media, 1);
    socket.send(packet.buffer);
  });
  nextRecorder.start(250);
}

function stopRecorder() {
  const previousRecorder = recorder;
  recorder = undefined;
  if (previousRecorder && previousRecorder.state !== 'inactive') previousRecorder.stop();
}

function stopCapture() {
  captureActive = false;
  clearTimeout(reconnectTimer);
  stopRecorder();
  if (renderTimer) clearInterval(renderTimer);
  sourceStream?.getTracks().forEach(track => track.stop());
  outputStream?.getTracks().forEach(track => track.stop());
  sourceStream = undefined;
  outputStream = undefined;
  sourceVideo = undefined;
  canvas = undefined;
  context = undefined;
  renderTimer = undefined;
  previewBusy = false;
  socket?.close(1000, 'Capture stopped');
  socket = undefined;
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.target !== 'offscreen') return;
  if (message.type === 'start-capture') {
    startCapture(message.data).catch(error => {
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_ERROR',
        message: `Error de captura: ${error instanceof Error ? error.message : String(error)}`
      }).catch(() => undefined);
    });
  } else if (message.type === 'stop-capture') {
    stopCapture();
  } else if (message.type === 'update-crop') {
    crop = message.data;
  }
});
