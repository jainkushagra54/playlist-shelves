/**
 * Playlist Shelves Playlist Reader
 *
 * Reads YouTube playlist pages (including SPA navigations).
 * Handles dynamic rendering, lazy-loaded continuation batches, duplicate video IDs,
 * unavailable videos, and explicit extraction requests from the background worker.
 */
(() => {
  'use strict';

  const Storage = globalThis.PlaylistShelvesStorage;
  const Adapter = globalThis.PlaylistShelvesYouTubeAdapter;

  if (!Storage || !Adapter) {
    console.error('[Playlist Shelves] Missing storage or playlist DOM adapter dependency.');
    return;
  }

  const INITIAL_WAIT_TIMEOUT_MS = 16000;
  const BATCH_WAIT_TIMEOUT_MS = 8000;
  const END_OF_LIST_PROBE_MS = 1800;
  const END_OF_LIST_PROBES = 3;
  const TOTAL_EXTRACTION_TIMEOUT_MS = 240000;
  const MAX_CONTINUATION_BATCHES = 200;
  const MAX_CONSECUTIVE_STALLS = 6;
  const MAX_UNRENDERED_ITEMS_AT_BOTTOM = 5;
  const MUTATION_DEBOUNCE_MS = 350;

  let activeRunController = null;
  let explicitExtractionActive = false;
  let activePlaylistId = 'WL';
  let playlistObserver = null;
  let mutationDebounceTimer = null;

  function sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        resolve();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
 * Waits until the playlist DOM shows videos, an empty state,
   * or a signed-out/error state.
   */
  async function waitForPlaylistReady(signal) {
    const start = Date.now();

    while (!signal?.aborted && Date.now() - start < INITIAL_WAIT_TIMEOUT_MS) {
      if (!Adapter.isPlaylistUrl() || Adapter.getPlaylistId() !== activePlaylistId) {
        return { state: 'navigated_away' };
      }

      const access = Adapter.checkAccessState();
      if (access.signedOut) {
        return { state: 'not_logged_in', error: access.reason };
      }

      const extracted = Adapter.extractRenderedPlaylistVideos();
      if (extracted.renderedCount > 0) {
        return { state: 'ready' };
      }

      if (Adapter.isPlaylistConfirmedEmpty()) {
        return { state: 'empty' };
      }

      await sleep(300, signal);
    }

    if (signal?.aborted) {
      return { state: 'aborted' };
    }

    // Final check after timeout
    const access = Adapter.checkAccessState();
    if (access.signedOut) {
      return { state: 'not_logged_in', error: access.reason };
    }
    if (Adapter.getPlaylistId() !== activePlaylistId) return { state: 'navigated_away' };
    if (Adapter.isPlaylistConfirmedEmpty()) {
      return { state: 'empty' };
    }

    return {
      state: 'timeout',
      error: 'Timed out waiting for playlist items to render.'
    };
  }

  /**
   * Waits for either new playlist items to render or the continuation sentinel to disappear.
   */
  async function waitForNextBatch(previousRenderedCount, expectedCount, signal) {
    const start = Date.now();
    while (!signal?.aborted && Date.now() - start < BATCH_WAIT_TIMEOUT_MS) {
      const current = Adapter.extractRenderedPlaylistVideos();
      const currentTotal = current.videos.length + current.skippedUnavailable;
      const countReached = typeof expectedCount === 'number' && currentTotal >= expectedCount;
      if (
        current.renderedCount > previousRenderedCount ||
        (!current.hasContinuation && (typeof expectedCount !== 'number' || countReached))
      ) {
        return current;
      }
      await sleep(250, signal);
    }
    return Adapter.extractRenderedPlaylistVideos();
  }

  async function probeForLateContinuation(previousRenderedCount, signal) {
    const start = Date.now();
    while (!signal?.aborted && Date.now() - start < END_OF_LIST_PROBE_MS) {
      const current = Adapter.extractRenderedPlaylistVideos();
      if (current.renderedCount > previousRenderedCount || current.hasContinuation) {
        return current;
      }
      await sleep(250, signal);
    }
    return Adapter.extractRenderedPlaylistVideos();
  }

  /**
   * Performs a full extraction pass, scrolling through lazy-loaded batches if enabled.
   */
  async function extractPlaylist({
    autoScroll = true,
    respectUserScroll = false,
    signal
  } = {}) {
    const ready = await waitForPlaylistReady(signal);

    if (ready.state === 'aborted' || ready.state === 'navigated_away') {
      return { ok: false, reason: ready.state, videos: [], complete: false };
    }

    if (ready.state === 'not_logged_in') {
      return {
        ok: false,
        reason: 'not_logged_in',
        error: ready.error,
        videos: [],
        complete: false
      };
    }

    if (ready.state === 'timeout') {
      return {
        ok: false,
        reason: 'timeout',
        error: ready.error,
        videos: [],
        complete: false
      };
    }

    if (ready.state === 'empty') {
      return {
        ok: true,
        videos: [],
        complete: true,
        skippedUnavailable: 0,
        reportedCount: 0
      };
    }

    let userInteracted = false;
    const initialScrollY = window.scrollY;
    const onUserScrollIntent = () => {
      if (respectUserScroll) {
        userInteracted = true;
      }
    };

    if (respectUserScroll) {
      window.addEventListener('wheel', onUserScrollIntent, { passive: true, once: true });
      window.addEventListener('touchstart', onUserScrollIntent, { passive: true, once: true });
    }

    try {
      let snapshot = Adapter.extractRenderedPlaylistVideos();
      const reportedCount = Adapter.getReportedPlaylistCount();
      if (explicitExtractionActive) {
        const loaded = snapshot.videos.length + snapshot.skippedUnavailable;
        const continuationBeyondCount = snapshot.hasContinuation &&
          typeof reportedCount === 'number' && loaded >= reportedCount;
        await Storage.setSyncProgress({
          loaded,
          total: continuationBeyondCount ? null : reportedCount,
          phase: continuationBeyondCount ? 'Loading next playlist batch' : reportedCount ? 'Reading playlist items' : 'Reading loaded items'
        }, activePlaylistId);
      }
      const hasMoreExpected = (current) =>
        current.hasContinuation ||
        (typeof reportedCount === 'number' &&
          current.videos.length + current.skippedUnavailable < reportedCount);
      const startedAt = Date.now();
      let batches = 0;
      let stallCount = 0;
      let noContinuationStallCount = 0;
      let reachedBottom = false;

      // YouTube can render the first chunk before it attaches the continuation
      // marker. Probe the end of the loaded list before treating a matching
      // header count as proof that the whole playlist has been read.
      if (autoScroll && !snapshot.hasContinuation) {
        for (let probe = 0; probe < END_OF_LIST_PROBES; probe += 1) {
          const previousCount = snapshot.renderedCount;
          Adapter.triggerContinuationLoad();
          const probed = await probeForLateContinuation(previousCount, signal);
          if (probed.renderedCount > previousCount || probed.hasContinuation) {
            snapshot = probed;
            break;
          }
          snapshot = probed;
          const pageHeight = Math.max(
            document.documentElement.scrollHeight,
            document.body?.scrollHeight || 0
          );
          reachedBottom = window.scrollY + window.innerHeight >= pageHeight - 8;
        }
      }

      while (
        autoScroll &&
        !signal?.aborted &&
        Adapter.getPlaylistId() === activePlaylistId &&
        !userInteracted &&
        hasMoreExpected(snapshot) &&
        batches < MAX_CONTINUATION_BATCHES &&
        Date.now() - startedAt < TOTAL_EXTRACTION_TIMEOUT_MS
      ) {
        batches += 1;
        const prevCount = snapshot.renderedCount;
        Adapter.triggerContinuationLoad();

        const nextSnapshot = await waitForNextBatch(prevCount, reportedCount, signal);
        if (nextSnapshot.renderedCount > prevCount) {
          stallCount = 0;
          noContinuationStallCount = 0;
          snapshot = nextSnapshot;
          if (explicitExtractionActive) {
            const loaded = snapshot.videos.length + snapshot.skippedUnavailable;
            const continuationBeyondCount = snapshot.hasContinuation &&
              typeof reportedCount === 'number' && loaded >= reportedCount;
            await Storage.setSyncProgress({
              loaded,
              total: continuationBeyondCount ? null : reportedCount,
              phase: continuationBeyondCount ? 'Loading next playlist batch' : 'Reading playlist items'
            }, activePlaylistId);
          }
        } else if (!hasMoreExpected(nextSnapshot)) {
          snapshot = nextSnapshot;
          break;
        } else {
          stallCount += 1;
          snapshot = nextSnapshot;
          if (snapshot.hasContinuation) {
            noContinuationStallCount = 0;
          } else {
            noContinuationStallCount += 1;
          }
          if (explicitExtractionActive) {
            await Storage.setSyncProgress({
              loaded: snapshot.videos.length + snapshot.skippedUnavailable,
              total: reportedCount,
              phase: 'Checking for remaining videos'
            }, activePlaylistId);
          }
          if (!snapshot.hasContinuation && noContinuationStallCount >= 2) {
            const pageHeight = Math.max(
              document.documentElement.scrollHeight,
              document.body?.scrollHeight || 0
            );
            reachedBottom = window.scrollY + window.innerHeight >= pageHeight - 8;
            if (reachedBottom) break;
          }
          if (stallCount >= MAX_CONSECUTIVE_STALLS) {
            break;
          }
          // Nudge scroll slightly up then down to re-trigger IntersectionObserver
          window.scrollBy(0, -300);
          await sleep(150, signal);
        }
      }

      if (Adapter.getPlaylistId() !== activePlaylistId) {
        return { ok: false, reason: 'navigated_away', videos: [], complete: false };
      }

      // Restore original scroll position if we auto-scrolled on a foreground visit
      if (respectUserScroll && !userInteracted && batches > 0) {
        window.scrollTo({ top: initialScrollY, behavior: 'auto' });
      }

      const totalExtractedAndSkipped =
        snapshot.videos.length + snapshot.skippedUnavailable;

      // Determine whether extraction is complete enough to replace the cache.
      const countReached = typeof reportedCount === 'number' &&
        totalExtractedAndSkipped >= reportedCount;
      const countGap = typeof reportedCount === 'number'
        ? reportedCount - totalExtractedAndSkipped
        : 0;
      const complete = !snapshot.hasContinuation && (
        typeof reportedCount !== 'number' ||
        countReached ||
        (reachedBottom && countGap > 0 && countGap <= MAX_UNRENDERED_ITEMS_AT_BOTTOM)
      );

      return {
        ok: true,
        videos: snapshot.videos,
        renderedCount: snapshot.renderedCount,
        complete,
        reachedBottom,
        skippedUnavailable: snapshot.skippedUnavailable,
        reportedCount
      };
    } finally {
      if (respectUserScroll) {
        window.removeEventListener('wheel', onUserScrollIntent);
        window.removeEventListener('touchstart', onUserScrollIntent);
      }
    }
  }

  /**
   * Saves extraction output to chrome.storage.local without overwriting a fuller
   * cache with an incomplete/partial extraction.
   */
  async function persistIfSafe(result) {
    if (!result.ok) {
      if (result.reason === 'not_logged_in') {
        await Storage.setSyncStatus(
          Storage.SYNC_STATUS.NOT_LOGGED_IN,
          result.error,
          activePlaylistId
        );
      } else if (result.reason !== 'aborted' && result.reason !== 'navigated_away') {
        await Storage.setSyncStatus(
          Storage.SYNC_STATUS.ERROR,
          result.error || 'Failed to extract playlist.',
          activePlaylistId
        );
      }
      return { saved: false };
    }

    const existing = await Storage.getCache(activePlaylistId);
    if (!result.complete) {
      console.warn(
        '[Playlist Shelves] Skipping cache overwrite: extraction was incomplete (%d extracted vs %d cached).',
        result.videos.length,
        existing.videos.length
      );
      return { saved: false, incomplete: true };
    }

    await Storage.saveSyncedVideos(result.videos, activePlaylistId);
    console.info(
      '[Playlist Shelves] Cached %d playlist videos (complete=%s, skippedUnavailable=%d).',
      result.videos.length,
      result.complete,
      result.skippedUnavailable
    );
    return { saved: true };
  }

  function disconnectObserver() {
    if (playlistObserver) {
      playlistObserver.disconnect();
      playlistObserver = null;
    }
    if (mutationDebounceTimer) {
      clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = null;
    }
  }

  /**
   * Watches the active playlist container for lazy-loaded items added as the user scrolls.
   */
  function attachPlaylistObserver() {
    disconnectObserver();
    const containers = Adapter.getPlaylistContainers();
    const target = containers?.contents || containers?.browse;
    if (!target) {
      return;
    }

    playlistObserver = new MutationObserver(() => {
      if (!Adapter.isPlaylistUrl()) {
        disconnectObserver();
        return;
      }

      clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = setTimeout(async () => {
        try {
          const snapshot = Adapter.extractRenderedPlaylistVideos();
          if (snapshot.videos.length === 0 && !Adapter.isPlaylistConfirmedEmpty()) {
            return;
          }
          activePlaylistId = Adapter.getPlaylistId();
          await persistIfSafe({
            ok: true,
            videos: snapshot.videos,
            complete: !snapshot.hasContinuation,
            skippedUnavailable: snapshot.skippedUnavailable,
            reportedCount: Adapter.getReportedPlaylistCount()
          });
        } catch (error) {
          console.debug('[Playlist Shelves] Observer sync issue:', error?.message || error);
        }
      }, MUTATION_DEBOUNCE_MS);
    });

    playlistObserver.observe(target, {
      childList: true,
      subtree: false
    });
  }

  function abortActiveRun() {
    if (activeRunController) {
      activeRunController.abort();
      activeRunController = null;
    }
  }

  /**
   * Runs passive extraction when the user visits /playlist?list=WL normally.
   */
  async function handlePlaylistVisit() {
    // Manual refresh owns this page even if YouTube emits another SPA route
    // event or strips our private ps_sync query parameter during hydration.
    if (explicitExtractionActive) {
      return;
    }

    if (!Adapter.isPlaylistUrl()) {
      abortActiveRun();
      disconnectObserver();
      return;
    }

    activePlaylistId = Adapter.getPlaylistId() || 'WL';
    if (!explicitExtractionActive && activePlaylistId !== 'WL') {
      const tracked = await Storage.getPlaylists();
      if (!tracked.some((playlist) => playlist.id === activePlaylistId)) {
        abortActiveRun();
        disconnectObserver();
        return;
      }
    }

    // If this tab was opened specifically by the service worker for manual sync,
    // let the explicit PLAYLIST_SHELVES_EXTRACT_PLAYLIST message drive the extraction.
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('ps_sync') === '1') {
      return;
    }

    abortActiveRun();
    const controller = new AbortController();
    activeRunController = controller;

    try {
      const shouldAutoScroll = window.scrollY < 40;
      const result = await extractPlaylist({
        autoScroll: shouldAutoScroll,
        respectUserScroll: true,
        signal: controller.signal
      });

      if (controller.signal.aborted) {
        return;
      }

      await persistIfSafe(result);
      attachPlaylistObserver();
    } catch (error) {
      console.error('[Playlist Shelves] Passive playlist extraction failed:', error);
    } finally {
      if (activeRunController === controller) {
        activeRunController = null;
      }
    }
  }

  // Listen for explicit extraction requests from the service worker.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'PLAYLIST_SHELVES_EXTRACT_PLAYLIST') {
      return false;
    }

    const senderUrl = sender?.url || '';
    let senderIsServiceWorker = false;
    try {
      const sourceUrl = new URL(senderUrl);
      senderIsServiceWorker = sender?.id === chrome.runtime.id &&
        sourceUrl.protocol === 'chrome-extension:' &&
        sourceUrl.hostname === chrome.runtime.id &&
        sourceUrl.pathname === '/service-worker.js';
    } catch {
      senderIsServiceWorker = false;
    }
    // tabs.sendMessage originates from the extension service worker, so
    // sender.tab may be absent here. Validate the receiving page directly.
    if (!senderIsServiceWorker || !Adapter.isPlaylistUrl()) return false;

    const requestedPlaylistId = Storage.sanitizePlaylistId(message.playlistId || '');
    if (requestedPlaylistId && Adapter.getPlaylistId() !== requestedPlaylistId) return false;

    abortActiveRun();
    disconnectObserver();
    activePlaylistId = Adapter.getPlaylistId();
    explicitExtractionActive = true;
    Storage.setSyncProgress({ loaded: 0, total: null, phase: 'Waiting for playlist to load' }, activePlaylistId);

    extractPlaylist({
      autoScroll: message.fullScroll !== false,
      respectUserScroll: false
    })
      .then((result) => {
        sendResponse(result);
      })
      .catch((error) => {
        console.error('[Playlist Shelves] Explicit extraction error:', error);
        sendResponse({
          ok: false,
          reason: 'error',
          error: error?.message || 'Unexpected extraction error.',
          videos: [],
          complete: false
        });
      })
      .finally(() => {
        explicitExtractionActive = false;
      });

    return true; // Keep message channel open for async sendResponse
  });

  // Handle YouTube SPA navigation lifecycle.
  document.addEventListener('yt-navigate-start', () => {
    // YouTube also emits navigate-start while hydrating or re-resolving the
    // current playlist route. Keep extraction alive until the destination is
    // known; handlePlaylistVisit() aborts it after navigate-finish if we left WL.
    disconnectObserver();
  });

  document.addEventListener('yt-navigate-finish', () => {
    handlePlaylistVisit();
  });

  window.addEventListener('popstate', () => {
    handlePlaylistVisit();
  });

  // Initial check in case content script loads after yt-navigate-finish.
  if (Adapter.isPlaylistUrl()) {
    activePlaylistId = Adapter.getPlaylistId() || 'WL';
    handlePlaylistVisit();
  }
})();
