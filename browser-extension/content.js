(() => {
  if (globalThis.__doomScrollConnector) return;
  globalThis.__doomScrollConnector = true;

  let settings = {
    autoScrollEnabled: true,
    intervalSeconds: 10,
    smartModeEnabled: true,
    onlyWhileCoding: true,
    volume: 35,
    muted: false
  };
  let codingActive = true;
  let bridgeConnected = false;
  let activeVideo;
  let reelStartedAt = Date.now();
  let advancing = false;
  let lastStateSignature = '';
  let lastStateSentAt = 0;
  const watchedVideos = new WeakSet();

  function send(payload) {
    chrome.runtime.sendMessage({ channel: 'doomscroll-content', payload }).catch(() => undefined);
  }

  function visibleVideo() {
    let best;
    let bestArea = 0;
    for (const video of document.querySelectorAll('video')) {
      const rect = video.getBoundingClientRect();
      const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
      const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      const area = width * height;
      if (area > bestArea && rect.width > 100 && rect.height > 100) {
        bestArea = area;
        best = video;
      }
    }
    return best;
  }

  function watch(video) {
    if (watchedVideos.has(video)) return;
    watchedVideos.add(video);
    video.addEventListener('ended', () => {
      if (settings.smartModeEnabled && canAdvance()) requestAdvance(1, 'Video ended');
    });
    video.addEventListener('play', reportState);
    video.addEventListener('pause', reportState);
  }

  function canAdvance() {
    return bridgeConnected && settings.autoScrollEnabled && (!settings.onlyWhileCoding || codingActive);
  }

  function applyPlaybackPreferences(video) {
    const targetVolume = Math.max(0, Math.min(1, Number(settings.volume) / 100));
    if (Math.abs(video.volume - targetVolume) > 0.01) video.volume = targetVolume;
    if (video.muted !== Boolean(settings.muted)) video.muted = Boolean(settings.muted);
  }

  function requestAdvance(direction, reason) {
    if (advancing) return;
    advancing = true;
    navigate(direction);
    reelStartedAt = Date.now();
    send({ type: 'REEL_STATE', pageReady: true, pageUrl: location.href, status: reason });
    setTimeout(() => { advancing = false; scan(); }, 900);
  }

  function navigate(direction) {
    const current = visibleVideo();
    const currentRect = current?.getBoundingClientRect();
    const candidates = [...document.querySelectorAll('video')]
      .map(video => ({ video, rect: video.getBoundingClientRect() }))
      .filter(item => item.video !== current && item.rect.width > 100 && item.rect.height > 100)
      .filter(item => direction > 0 ? item.rect.top > (currentRect?.top ?? -1) + 40 : item.rect.top < (currentRect?.top ?? innerHeight) - 40)
      .sort((a, b) => direction > 0 ? a.rect.top - b.rect.top : b.rect.top - a.rect.top);
    if (candidates[0]) {
      candidates[0].video.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const labels = direction > 0 ? ['next', 'siguiente'] : ['previous', 'anterior'];
    const button = [...document.querySelectorAll('button')].find(element => {
      const label = (element.getAttribute('aria-label') || element.title || '').toLowerCase();
      const rect = element.getBoundingClientRect();
      return labels.some(value => label.includes(value)) && rect.width > 0 && rect.height > 0;
    });
    if (button) button.click();
    else {
      const geometricButton = findGeometricNavigationButton(direction);
      if (geometricButton) geometricButton.click();
      else {
        window.dispatchEvent(new WheelEvent('wheel', { deltaY: direction * innerHeight, bubbles: true, cancelable: true }));
        window.scrollBy({ top: direction * Math.max(500, innerHeight * 0.88), behavior: 'smooth' });
      }
    }
  }

  function findGeometricNavigationButton(direction) {
    const candidates = [...document.querySelectorAll('button')]
      .map(button => ({ button, rect: button.getBoundingClientRect() }))
      .filter(item => item.rect.width >= 36 && item.rect.width <= 120 && item.rect.height >= 36 && item.rect.height <= 120)
      .filter(item => item.rect.left > innerWidth * 0.82 && item.rect.top > innerHeight * 0.2 && item.rect.bottom < innerHeight * 0.9)
      .filter(item => getComputedStyle(item.button).visibility !== 'hidden');
    if (candidates.length < 2) return undefined;
    candidates.sort((a, b) => a.rect.top - b.rect.top);
    return direction > 0 ? candidates.at(-1)?.button : candidates[0]?.button;
  }

  async function pictureInPicture() {
    const video = visibleVideo();
    if (!video) return reportError('No hay un video visible para Picture in Picture.');
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch (error) {
      reportError(`Picture in Picture no se pudo abrir: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function reportError(message) {
    send({ type: 'ERROR', pageReady: true, pageUrl: location.href, message });
  }

  function reportState(force = false) {
    const video = activeVideo || visibleVideo();
    const rect = video?.getBoundingClientRect();
    const state = {
      type: 'REEL_STATE',
      pageReady: true,
      pageUrl: location.href,
      hasVideo: Boolean(video),
      playing: Boolean(video && !video.paused && !video.ended),
      currentTime: video?.currentTime || 0,
      duration: Number.isFinite(video?.duration) ? video.duration : 0,
      muted: video?.muted ?? Boolean(settings.muted),
      volume: Math.round((video?.volume ?? Number(settings.volume) / 100) * 100),
      status: !bridgeConnected ? 'VS Code disconnected' : !canAdvance() ? 'Automation paused' : 'Ready',
      crop: rect ? {
        x: Math.max(0, rect.left),
        y: Math.max(0, rect.top),
        width: Math.min(innerWidth - Math.max(0, rect.left), rect.width),
        height: Math.min(innerHeight - Math.max(0, rect.top), rect.height),
        viewportWidth: innerWidth,
        viewportHeight: innerHeight
      } : undefined
    };
    const signature = JSON.stringify({ ...state, currentTime: Math.floor(state.currentTime) });
    if (force || (signature !== lastStateSignature && Date.now() - lastStateSentAt >= 700)) {
      lastStateSignature = signature;
      lastStateSentAt = Date.now();
      send(state);
    }
  }

  function scan() {
    const video = visibleVideo();
    if (video && video !== activeVideo) {
      activeVideo = video;
      reelStartedAt = Date.now();
      reportState(true);
    }
    if (video) {
      watch(video);
      applyPlaybackPreferences(video);
      if (canAdvance() && Date.now() - reelStartedAt >= Number(settings.intervalSeconds) * 1000) {
        requestAdvance(1, 'Interval elapsed');
      }
    }
    reportState();
  }

  chrome.runtime.onMessage.addListener(message => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'BRIDGE_STATE') {
      bridgeConnected = Boolean(message.connected);
      reportState(true);
    } else if (message.type === 'WELCOME') {
      bridgeConnected = true;
      reportState(true);
    } else if (message.type === 'SETTINGS' && message.value) {
      settings = { ...settings, ...message.value };
      if (activeVideo) applyPlaybackPreferences(activeVideo);
      reportState(true);
    } else if (message.type === 'CODING_STATE' && message.value) {
      codingActive = Boolean(message.value.active);
      reportState(true);
    } else if (message.type === 'COMMAND') {
      if (message.name === 'NEXT') requestAdvance(1, 'Manual next');
      else if (message.name === 'PREVIOUS') requestAdvance(-1, 'Manual previous');
      else if (message.name === 'PICTURE_IN_PICTURE') pictureInPicture();
    }
  });

  const observer = new MutationObserver(() => queueMicrotask(scan));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  send({ type: 'PAGE_STATE', pageReady: true, pageUrl: location.href, hasVideo: Boolean(visibleVideo()), status: 'Instagram page ready' });
  setInterval(scan, 500);
  scan();
})();
