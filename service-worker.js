/**
 * Playlist Shelves Background Service Worker (Manifest V3)
 *
 * Coordinates playlist refreshes via a temporary YouTube tab, ensures safe
 * tab cleanup, and enforces cache integrity so failed or
 * incomplete extractions never overwrite valid cached data.
 */

importScripts('services/playlist-storage.js');

const Storage = globalThis.PlaylistShelvesStorage;
const TAB_LOAD_TIMEOUT_MS = 25000;

let activeRefreshPromise = null;
let activeRefreshPlaylistId = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeCloseTab(tabId) {
  if (typeof tabId !== 'number') {
    return;
  }
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Tab may already have been closed by the user or browser.
  }
}

/**
 * Waits for a background tab to finish loading YouTube or detect an auth/consent redirect.
 */
function waitForTabReady(tabId, expectedPlaylistId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    function cleanup() {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function finish(fn, value) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn(value);
    }

    function evaluateTab(tab) {
      if (!tab) {
        return;
      }
      let url;
      try {
        url = new URL(tab.url || '');
      } catch {
        return;
      }

      if (url.protocol === 'https:' && url.hostname === 'accounts.google.com') {
        finish(resolve, {
          status: 'redirect_auth',
          error:
            'YouTube is not signed in. Please open YouTube, sign in to your Google account, and try again.'
        });
        return;
      }

      if (url.protocol === 'https:' && url.hostname === 'consent.youtube.com') {
        finish(resolve, {
          status: 'redirect_consent',
          error:
            'YouTube requires accepting cookie/consent prompts first. Open the playlist once, accept, and retry.'
        });
        return;
      }

      const isYouTubePlaylist = url.protocol === 'https:' &&
        ['www.youtube.com', 'youtube.com'].includes(url.hostname) &&
        url.pathname === '/playlist' &&
        url.searchParams.get('list') === expectedPlaylistId;
      if (tab.status === 'complete' && isYouTubePlaylist) {
        finish(resolve, { status: 'ready', url: url.href });
      } else if (tab.status === 'complete') {
        finish(reject, new Error('Sync tab did not remain on the requested YouTube playlist.'));
      }
    }

    function onUpdated(updatedTabId, _changeInfo, tab) {
      if (updatedTabId !== tabId) {
        return;
      }
      evaluateTab(tab);
    }

    function onRemoved(removedTabId) {
      if (removedTabId !== tabId) {
        return;
      }
      finish(
        reject,
        new Error('Background sync tab was closed before extraction completed.')
      );
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    timer = setTimeout(() => {
      finish(
        reject,
        new Error('Timed out waiting for playlist page to load.')
      );
    }, timeoutMs);

    // Check current tab state immediately in case load already completed.
    chrome.tabs
      .get(tabId)
      .then(evaluateTab)
      .catch(() => {
        finish(reject, new Error('Unable to inspect background sync tab.'));
      });
  });
}

/**
 * Sends a message to a tab's content script with retries while document_idle settles.
 */
async function sendMessageWithRetry(tabId, payload, maxAttempts = 8, delayMs = 450) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, payload);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
    }
  }

  throw new Error(
    lastError?.message ||
      'Could not communicate with YouTube page content script.'
  );
}

/**
 * Executes a full playlist refresh in a temporary active tab.
 */
async function performManualRefresh(playlistId = 'WL') {
  const existingCache = await Storage.getCache(playlistId);
  await Storage.setSyncStatus(Storage.SYNC_STATUS.SYNCING, null, playlistId);
  await Storage.setSyncProgress({ loaded: 0, total: null, phase: 'Opening playlist', reset: true }, playlistId);

  let tempTabId = null;

  try {
    const tab = await chrome.tabs.create({
      url: `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}&ps_sync=1`,
      active: true
    });
    tempTabId = tab.id;

    const tabState = await waitForTabReady(tempTabId, playlistId);
    if (
      tabState.status === 'redirect_auth' ||
      tabState.status === 'redirect_consent'
    ) {
      await Storage.setSyncStatus(
        Storage.SYNC_STATUS.NOT_LOGGED_IN,
        tabState.error,
        playlistId
      );
      return {
        ok: false,
        syncStatus: Storage.SYNC_STATUS.NOT_LOGGED_IN,
        error: tabState.error
      };
    }

    // Allow Polymer/Lit initial hydration a brief moment before querying.
    await sleep(600);

    const result = await sendMessageWithRetry(tempTabId, {
      type: 'PLAYLIST_SHELVES_EXTRACT_PLAYLIST',
      fullScroll: true,
      playlistId
    });

    if (!result || !result.ok) {
      const status =
        result?.reason === 'not_logged_in'
          ? Storage.SYNC_STATUS.NOT_LOGGED_IN
          : Storage.SYNC_STATUS.ERROR;
      const reasonMessages = {
        timeout: 'YouTube did not render the playlist items before the timeout. Open the playlist in a normal tab and retry.',
        navigated_away: 'The sync tab left the playlist before extraction completed. Retry refresh.',
        aborted: 'The playlist refresh was interrupted. Retry refresh.',
        error: 'The playlist reader hit an error. Open the playlist in a normal tab and retry.'
      };
      const errorMsg = result?.error || reasonMessages[result?.reason] ||
        (result ? `Playlist extraction failed (${result.reason || 'unknown reason'}).` : 'The YouTube page did not return an extraction result. Reload the extension and retry.');
      const diagnostic = [
        `Reason: ${result?.reason || 'no response'}`,
        `Extracted videos: ${Array.isArray(result?.videos) ? result.videos.length : 'unavailable'}`,
        `Rendered rows: ${result?.renderedCount ?? 'unavailable'}`,
        `Unavailable items skipped: ${result?.skippedUnavailable ?? 'unavailable'}`,
        `Playlist count: ${result?.reportedCount ?? 'unavailable'}`,
        `Reached page bottom: ${typeof result?.reachedBottom === 'boolean' ? result.reachedBottom : 'unknown'}`,
        `Extraction complete: ${typeof result?.complete === 'boolean' ? result.complete : 'unknown'}`
      ].join('\n');
      const detailedError = `${errorMsg}\n\n${diagnostic}`;

      await Storage.setSyncStatus(status, detailedError, playlistId);
      return {
        ok: false,
        syncStatus: status,
        error: detailedError
      };
    }

    // Never report a partial first batch as a successful full sync.
    if (!result.complete) {
      const msg =
        'Extraction ended before all playlist items loaded. Previous cache was kept intact.';
      const detailedError = `${msg}\n\nReason: incomplete extraction\nExtracted videos: ${result.videos.length}\nUnavailable items skipped: ${result.skippedUnavailable || 0}\nRendered rows: ${result.renderedCount ?? 'unavailable'}\nReached page bottom: ${Boolean(result.reachedBottom)}\nCached videos: ${existingCache.videos.length}\nPlaylist count: ${result.reportedCount ?? 'unavailable'}`;
      await Storage.setSyncStatus(Storage.SYNC_STATUS.ERROR, detailedError, playlistId);
      return {
        ok: false,
        syncStatus: Storage.SYNC_STATUS.ERROR,
        error: detailedError
      };
    }

    const saved = await Storage.saveSyncedVideos(result.videos, playlistId);
    console.info(
      '[Playlist Shelves] Manual refresh saved %d videos (complete=%s).',
      saved.videos.length,
      result.complete
    );

    return {
      ok: true,
      syncStatus: saved.syncStatus,
      count: saved.videos.length,
      lastSyncedAt: saved.lastSyncedAt,
      complete: Boolean(result.complete),
      skippedUnavailable: result.skippedUnavailable || 0
    };
  } catch (error) {
    const errorMsg =
      error?.message || 'Unexpected error during playlist refresh.';
    const detailedError = error?.stack ? `${errorMsg}\n\n${error.stack}` : errorMsg;
    await Storage.setSyncStatus(Storage.SYNC_STATUS.ERROR, detailedError, playlistId);
    return {
      ok: false,
      syncStatus: Storage.SYNC_STATUS.ERROR,
      error: detailedError
    };
  } finally {
    await safeCloseTab(tempTabId);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const current = await chrome.storage.local.get([
      Storage.STORAGE_KEYS.VIDEOS,
      Storage.STORAGE_KEYS.LAST_SYNCED_AT,
      Storage.STORAGE_KEYS.SYNC_STATUS
    ]);

    const patch = {};
    if (!Array.isArray(current[Storage.STORAGE_KEYS.VIDEOS])) {
      patch[Storage.STORAGE_KEYS.VIDEOS] = [];
    }
    if (current[Storage.STORAGE_KEYS.LAST_SYNCED_AT] === undefined) {
      patch[Storage.STORAGE_KEYS.LAST_SYNCED_AT] = null;
    }
    if (typeof current[Storage.STORAGE_KEYS.SYNC_STATUS] !== 'string') {
      patch[Storage.STORAGE_KEYS.SYNC_STATUS] =
        Storage.SYNC_STATUS.NEVER_SYNCED;
    }

    if (Object.keys(patch).length > 0) {
      await chrome.storage.local.set(patch);
    }
  } catch (error) {
    console.error('[Playlist Shelves] Failed to initialize storage defaults:', error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
  if (message.type !== 'PLAYLIST_SHELVES_START_SYNC') {
    return false;
  }

  // Only this extension's popup or its YouTube content scripts may request a sync.
  if (sender?.id !== chrome.runtime.id) return false;
  if (sender.tab) {
    try {
      const tabUrl = new URL(sender.tab.url || '');
      if (tabUrl.protocol !== 'https:' ||
          !['www.youtube.com', 'youtube.com'].includes(tabUrl.hostname) ||
          tabUrl.pathname !== '/') return false;
    } catch {
      return false;
    }
  } else {
    try {
      const senderUrl = new URL(sender.url || '');
      if (senderUrl.protocol !== 'chrome-extension:' ||
          senderUrl.hostname !== chrome.runtime.id ||
          senderUrl.pathname !== '/popup/manager.html') return false;
    } catch {
      return false;
    }
  }

  const playlistId = Storage.sanitizePlaylistId(message.playlistId || 'WL');
  if (!playlistId) {
    sendResponse({ ok: false, error: 'Invalid playlist ID.' });
    return false;
  }
  Storage.getPlaylists().then((playlists) => {
    if (!playlists.some((playlist) => playlist.id === playlistId)) {
      sendResponse({ ok: false, error: 'That playlist is not configured.' });
      return;
    }
    startRefresh(playlistId, sendResponse);
  }).catch((error) => {
    sendResponse({ ok: false, error: error?.message || 'Could not load playlists.' });
  });
  return true;
});

function startRefresh(playlistId, sendResponse) {
  if (activeRefreshPromise && activeRefreshPlaylistId !== playlistId) {
    sendResponse({ ok: false, error: 'Another playlist is syncing. Try again when it finishes.' });
    return;
  }
  if (!activeRefreshPromise) {
    activeRefreshPlaylistId = playlistId;
    activeRefreshPromise = performManualRefresh(playlistId).finally(() => {
      activeRefreshPromise = null;
      activeRefreshPlaylistId = null;
    });
  }

  activeRefreshPromise.then(sendResponse).catch((error) => {
    sendResponse({
      ok: false,
      syncStatus: Storage.SYNC_STATUS.ERROR,
      error: error?.message || 'Refresh failed.'
    });
  });

}
