/** Playlist Shelves popup controller. */
(() => {
  'use strict';

  const Storage = globalThis.PlaylistShelvesStorage;
  if (!Storage) return;

  const $ = (selector) => document.querySelector(selector);
  const playlistListEl = $('#playlist-list');
  const feedbackEl = $('#feedback');
  const addForm = $('#playlist-add-form');
  const urlInput = $('#playlist-url');
  const nameInput = $('#playlist-title');
  let renderVersion = 0;

  const setFeedback = (message = '', kind = '') => {
    feedbackEl.textContent = message;
    feedbackEl.className = `feedback ${message ? `is-${kind}` : 'hidden'}`.trim();
  };

  function parseDuration(value) {
    if (!/^\d+(?::\d{1,2}){1,2}$/.test(value || '')) return null;
    return value.split(':').map(Number).reduce((sum, part) => sum * 60 + part, 0);
  }

  function formatWatchTime(videos) {
    const durations = videos.map((video) => parseDuration(video.duration)).filter(Number.isFinite);
    if (!durations.length) return '—';
    const seconds = durations.reduce((sum, value) => sum + value, 0);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours || days) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    return `${durations.length === videos.length ? '' : 'At least '}${parts.join(' ')}`;
  }

  function estimateProgress(cache) {
    const progress = cache.syncProgress || {};
    const loaded = Math.max(0, Number(progress.loaded) || 0);
    const total = Number(progress.total);
    const startedAt = Number(progress.startedAt);
    const elapsed = Date.now() - (Number.isFinite(startedAt) ? startedAt : Date.now());
    const eta = Number.isFinite(total) && total > loaded && loaded >= 5 && elapsed > 2500
      ? ` · about ${Math.max(1, Math.ceil((elapsed / loaded * (total - loaded)) / 1000))}s left`
      : '';
    const count = Number.isFinite(total) && total > 0 ? `${loaded} of ${total}` : `${loaded} loaded`;
    return `${progress.phase || 'Syncing'} · ${count}${eta}`;
  }

  function makeButton(label, className, onClick, disabled = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className || '';
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener('click', onClick);
    return button;
  }

  async function savePlaylistEdit(playlists, id, edit) {
    const next = playlists.map((item) => item.id === id ? { ...item, ...edit } : item);
    await Storage.savePlaylists(next);
  }

  async function renderPlaylistList() {
    const version = ++renderVersion;
    const playlists = await Storage.getPlaylists();
    const entries = [];
    const caches = await Promise.all(playlists.map((playlist) => Storage.getCache(playlist.id)));
    if (version !== renderVersion) return;

    const allVideos = caches.flatMap((cache) => cache.videos);
    $('#playlist-count').textContent = String(playlists.length);
    $('#video-count').textContent = String(allVideos.length);
    $('#watch-time').textContent = formatWatchTime(allVideos);
    const isSyncing = caches.some((cache) => cache.syncStatus === Storage.SYNC_STATUS.SYNCING);
    const statusBadge = $('#status-badge');
    statusBadge.textContent = isSyncing ? 'Syncing' : 'Saved locally';
    statusBadge.dataset.status = isSyncing ? 'syncing' : 'local';

    for (let index = 0; index < playlists.length; index += 1) {
      const playlist = playlists[index];
      const cache = caches[index];
      const entry = document.createElement('article');
      entry.className = 'playlist-entry';

      const main = document.createElement('div');
      main.className = 'playlist-entry-main';
      const heading = document.createElement('div');
      heading.className = 'playlist-entry-heading';
      const title = document.createElement('span');
      title.className = 'playlist-entry-title';
      title.textContent = playlist.title;
      const renameButton = makeButton('Rename', 'playlist-rename-button', () => {});
      renameButton.setAttribute('aria-label', `Rename ${playlist.title} shelf`);
      heading.append(title, renameButton);

      const meta = document.createElement('span');
      meta.className = 'playlist-entry-url';
      meta.textContent = cache.syncStatus === Storage.SYNC_STATUS.SYNCING
        ? estimateProgress(cache)
        : cache.videos.length === 0
          ? cache.syncStatus === Storage.SYNC_STATUS.SYNCED ? 'Playlist is empty' : 'Not synced yet'
          : `${cache.videos.length} ${cache.videos.length === 1 ? 'video' : 'videos'} · ${formatWatchTime(cache.videos)} total`;
      meta.title = `Playlist ID: ${playlist.id}`;
      main.append(heading, meta);
      if (cache.syncStatus === Storage.SYNC_STATUS.ERROR || cache.syncStatus === Storage.SYNC_STATUS.NOT_LOGGED_IN) {
        const error = document.createElement('span');
        error.className = 'playlist-entry-error';
        error.textContent = cache.lastError?.split('\n')[0] || 'Sync failed. Try again.';
        error.title = cache.lastError || error.textContent;
        main.appendChild(error);
      }

      const controls = document.createElement('div');
      controls.className = 'playlist-entry-controls';
      const syncing = cache.syncStatus === Storage.SYNC_STATUS.SYNCING;
      const syncButton = makeButton(syncing ? 'Syncing…' : cache.syncStatus === Storage.SYNC_STATUS.ERROR ? 'Retry' : 'Sync', 'sync-playlist', () => {
        syncButton.disabled = true;
        syncButton.textContent = 'Starting…';
        chrome.runtime.sendMessage({ type: 'PLAYLIST_SHELVES_START_SYNC', playlistId: playlist.id }, (response) => {
          if (chrome.runtime.lastError || !response?.ok) {
            const message = chrome.runtime.lastError?.message || response?.error || 'Playlist sync failed.';
            setFeedback(message, 'error');
            syncButton.disabled = false;
            syncButton.textContent = 'Retry';
          }
        });
      }, syncing);

      const openLink = document.createElement('a');
      openLink.href = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlist.id)}`;
      openLink.target = '_blank';
      openLink.rel = 'noopener noreferrer';
      openLink.textContent = 'Open';

      const hiddenButton = makeButton(`Restore ${cache.hiddenVideoIds.length}`, '', () => Storage.restoreHiddenVideos(playlist.id), cache.hiddenVideoIds.length === 0);
      hiddenButton.setAttribute('aria-label', `Restore ${cache.hiddenVideoIds.length} hidden videos`);
      controls.append(syncButton, openLink, hiddenButton);
      if (playlist.id !== 'WL') {
        const removeButton = makeButton('Remove', '', async () => {
          await Storage.savePlaylists(playlists.filter((item) => item.id !== playlist.id));
          await Storage.removePlaylistCache(playlist.id);
        });
        controls.appendChild(removeButton);
      }

      renameButton.addEventListener('click', () => {
        const input = document.createElement('input');
        input.className = 'playlist-rename-input';
        input.type = 'text';
        input.maxLength = 60;
        input.value = playlist.title;
        input.setAttribute('aria-label', `Shelf name for ${playlist.title}`);
        const save = makeButton('Save', '', async () => {
          const name = input.value.trim();
          if (!name) return setFeedback('Shelf name cannot be empty.', 'warning');
          await savePlaylistEdit(playlists, playlist.id, { title: name });
        });
        const cancel = makeButton('Cancel', '', renderPlaylistList);
        const editor = document.createElement('div');
        editor.className = 'playlist-rename-editor';
        const actions = document.createElement('div');
        actions.className = 'playlist-rename-actions';
        actions.append(save, cancel);
        editor.append(input, actions);
        heading.replaceChildren(editor);
        input.focus();
        input.select();
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') save.click();
          if (event.key === 'Escape') cancel.click();
        });
      });

      entry.append(main, controls);
      entries.push(entry);
    }

    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-playlists';
      empty.textContent = 'Add a YouTube playlist to create your first shelf.';
      entries.push(empty);
    }
    if (version === renderVersion) playlistListEl.replaceChildren(...entries);
  }

  addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    let playlistId = '';
    try {
      const url = new URL(urlInput.value);
      if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) {
        playlistId = Storage.sanitizePlaylistId(url.searchParams.get('list') || '');
      }
    } catch { /* handled below */ }
    if (!playlistId) return setFeedback('Paste a valid YouTube playlist link.', 'error');
    const playlists = await Storage.getPlaylists();
    if (playlists.some((playlist) => playlist.id === playlistId)) return setFeedback('That playlist is already added.', 'warning');
    const title = nameInput.value.trim() || (playlistId === 'WL' ? 'Watch Later' : playlistId);
    await Storage.savePlaylists([...playlists, { id: playlistId, title, enabled: true }]);
    addForm.reset();
    setFeedback('Playlist added. Sync it to load videos.', 'success');
    await renderPlaylistList();
  });

  function savePreferences() {
    Storage.setSettings({
      sort: $('#setting-sort').value,
      showChannel: $('#setting-channel').checked
    });
  }
  $('#setting-sort').addEventListener('change', savePreferences);
  $('#setting-channel').addEventListener('change', savePreferences);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const relevant = [Storage.STORAGE_KEYS.PLAYLISTS, Storage.STORAGE_KEYS.PLAYLIST_CACHES, Storage.STORAGE_KEYS.VIDEOS, Storage.STORAGE_KEYS.SETTINGS, Storage.STORAGE_KEYS.SEEN_VIDEO_IDS, Storage.STORAGE_KEYS.HIDDEN_VIDEO_IDS].some((key) => changes[key]);
    if (!relevant) return;
    renderPlaylistList();
    Storage.getCache().then((cache) => {
      $('#setting-sort').value = cache.settings.sort;
      $('#setting-channel').checked = Boolean(cache.settings.showChannel);
    });
  });

  Storage.getCache().then((cache) => {
    $('#setting-sort').value = cache.settings.sort;
    $('#setting-channel').checked = Boolean(cache.settings.showChannel);
  });
  renderPlaylistList();
})();
