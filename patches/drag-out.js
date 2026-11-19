// ==========================================================================
// Drag-out to the desktop / file manager (main process)
//
// Eagle's renderer cancels the HTML5 drag and asks the main process to
// start a native one with webContents.startDrag({ files, icon }). Electron
// returns *silently* without dragging when the icon is empty, and a path
// Electron cannot stat (e.g. still URI-encoded, as Eagle's renderer keeps
// imagesDir) produces a drop the file manager ignores (issue #2).
//
// Wrap startDrag so each call is logged and normalised: decode paths that
// only exist decoded, drop the ones that do not exist at all, and fall back
// to the app icon when Eagle's drag image is missing.
// ==========================================================================

const fs = require('fs');
const { fileURLToPath } = require('url');
const { eagleTrayIconPng } = require('./tray-icon');

let electron;
try {
  electron = require('electron');
} catch (e) {}

const isMainProcess = !process.type || process.type === 'browser';

function resolveDragPath(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  const candidates = [p];
  if (p.startsWith('file://')) {
    try { candidates.push(fileURLToPath(p)); } catch (e) {}
  }
  try { candidates.push(decodeURIComponent(p)); } catch (e) {}
  return candidates.find(c => fs.existsSync(c)) || null;
}

function isUsableIcon(icon) {
  return !!(icon && typeof icon.isEmpty === 'function' && !icon.isEmpty());
}

function fallbackIcon() {
  const image = electron.nativeImage.createFromPath(eagleTrayIconPng);
  if (!image.isEmpty()) return image.resize({ width: 64 });
  // Any non-empty image will do; an empty one cancels the drag.
  return electron.nativeImage.createFromBitmap(
    Buffer.from([0, 0, 0, 0]),
    { width: 1, height: 1 }
  );
}

function normaliseDragItem(item) {
  const requested = []
    .concat(item && item.files ? item.files : [])
    .concat(item && item.file ? [item.file] : []);
  const files = requested.map(resolveDragPath).filter(Boolean);

  let icon = item && item.icon;
  if (typeof icon === 'string') {
    icon = electron.nativeImage.createFromPath(icon);
  }
  const iconOk = isUsableIcon(icon);

  console.log('[STUBS DRAG] startDrag', {
    requested,
    files,
    icon: iconOk ? icon.getSize() : 'empty -> app icon'
  });

  return { files, icon: iconOk ? icon : fallbackIcon() };
}

function wrapStartDrag(webContents) {
  if (!webContents || webContents.__eagleLinuxDragWrapped) return;
  const originalStartDrag = webContents.startDrag;
  if (typeof originalStartDrag !== 'function') return;

  webContents.startDrag = function(item) {
    let normalised;
    try {
      normalised = normaliseDragItem(item);
    } catch (err) {
      console.error('[STUBS DRAG] Could not normalise drag item:', err);
      return originalStartDrag.call(this, item);
    }
    if (normalised.files.length === 0) {
      console.log('[STUBS DRAG] No existing files to drag; ignoring');
      return;
    }
    return originalStartDrag.call(this, normalised);
  };
  webContents.__eagleLinuxDragWrapped = true;
}

// --------------------------------------------------------------------------
// Wayland: drag items out as an HTML5 drag instead
//
// On Wayland, Electron 22's startDrag() offers text/uri-list but writes zero
// bytes when the drop target reads it, so file managers accept the drop and
// copy nothing. On Wayland, let the browser drag Eagle starts go ahead
// (Eagle cancels it in favour of startDrag), fill it in, and swallow Eagle's
// 'ondragstart' request for that drag.
//
// When wayland.js could patch ExtractData() (fileUriListExported), the drag
// carries the files themselves plus their URI list as text/plain, which the
// patched ExtractData() hands out as text/uri-list: every file manager,
// Nautilus included, gets real files. A page can only add files it was
// given, so on mousedown the main process loads the files about to be
// dragged into a hidden <input type=file> through the DevTools protocol
// (DOM.setFileInputFiles, which also grants the renderer read access, as
// Chromium requires for files in a drag).
//
// Otherwise (or if the files are not ready in time) the drag only carries
// text/uri-list, which Chromium exports as text/x-moz-url: Dolphin and
// PureRef accept it, Nautilus saves it as a .txt file.
//
// Eagle never sees the text/plain in its own drops: Chromium hides the text
// of drags that hold files. Its drop handlers treat a URL in text/plain, or
// an <img> in text/html, as a web image to import, and use their global
// `dragging` flag to recognise internal drags (onto folders, tags, the
// trash), which keeps working.
// --------------------------------------------------------------------------

const DRAG_FILES_CHANNEL = 'eagle-linux:drag-files';

const htmlDragScript = (withFiles) => `
(function() {
  if (window.__eagleLinuxHtmlDrag || typeof window.onDragStartContainer !== 'function') {
    return !!window.__eagleLinuxHtmlDrag;
  }
  const { ipcRenderer } = require('electron');
  const { pathToFileURL } = require('url');
  const withFiles = ${withFiles ? 'true' : 'false'};

  let swallowDragStart = false;
  const originalSend = ipcRenderer.send;
  ipcRenderer.send = function(channel, ...args) {
    if (channel === 'ondragstart' && swallowDragStart) {
      swallowDragStart = false;
      return;
    }
    return originalSend.call(this, channel, ...args);
  };

  function draggedFilePaths(element) {
    const scope = angular.element('body').scope();
    if (!scope || !scope.imagesDir) return [];
    const box = jQuery('.box').has(element)[0];
    const target = (box && scope.getItemByElement(box)) || scope.selected[0];
    const items = scope.selected && scope.selected.length ? scope.selected : [target];
    const imagesDir = decodeURIComponent(scope.imagesDir);
    return items
      .filter(item => item && item.id && item.name && item.ext)
      .map(item => imagesDir + item.id + '.info/' + item.name + '.' + item.ext);
  }

  // Files of the next drag, loaded into fileInput by the main process.
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  window.__eagleLinuxDragFileInput = fileInput;
  let prepared = { key: null, files: [] };
  let pendingKey = null;

  function prepareFiles(element) {
    let paths = [];
    try { paths = draggedFilePaths(element); } catch (e) {}
    const key = paths.join('\\n');
    if (paths.length === 0 || key === prepared.key || key === pendingKey) return;
    pendingKey = key;
    ipcRenderer.invoke('${DRAG_FILES_CHANNEL}', paths).then(ok => {
      if (pendingKey !== key) return;
      pendingKey = null;
      const files = Array.from(fileInput.files);
      if (ok && files.length === paths.length) prepared = { key, files };
    }, err => {
      if (pendingKey === key) pendingKey = null;
      console.log('[STUBS DRAG] Could not prepare drag files', err);
    });
  }

  if (withFiles) {
    // Eagle updates the selection while handling the same mousedown.
    document.addEventListener('mousedown', event => {
      if (event.button === 0) setTimeout(() => prepareFiles(event.target), 0);
    }, true);
  }

  const originalDragStart = window.onDragStartContainer;
  window.onDragStartContainer = function(event) {
    const dt = event && event.dataTransfer;
    let paths = [];
    try { paths = dt ? draggedFilePaths(event.target) : []; } catch (e) {}
    if (paths.length === 0) return originalDragStart.apply(this, arguments);

    // Eagle cancels the browser drag first thing; keep it alive.
    event.preventDefault = function() {};
    const result = originalDragStart.apply(this, arguments);
    const uriList = paths.map(p => pathToFileURL(p).href).join('\\r\\n') + '\\r\\n';
    const withFileList = withFiles && prepared.key === paths.join('\\n');
    dt.clearData();
    if (withFileList) {
      prepared.files.forEach(file => dt.items.add(file));
      dt.setData('text/plain', uriList);
    }
    dt.setData('text/uri-list', uriList);
    // Copy only: a "move" drop would take the file out of the library.
    dt.effectAllowed = 'copy';
    swallowDragStart = true;
    console.log('[STUBS DRAG] HTML5 drag-out', withFileList ? 'with files' : 'URIs only', paths);
    return result;
  };

  window.__eagleLinuxHtmlDrag = true;
  return true;
})();
`;

// Load `paths` into the renderer's hidden file input; Chromium grants the
// renderer read access to files set this way.
async function loadDragFiles(webContents, paths) {
  const files = (Array.isArray(paths) ? paths : []).map(resolveDragPath);
  if (files.length === 0 || files.some(f => !f)) return false;

  const dbg = webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  const { result } = await dbg.sendCommand('Runtime.evaluate', {
    expression: 'window.__eagleLinuxDragFileInput'
  });
  if (!result || !result.objectId) return false;
  try {
    await dbg.sendCommand('DOM.setFileInputFiles', { files, objectId: result.objectId });
  } finally {
    dbg.sendCommand('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
  }
  return true;
}

function installHtmlDrag(webContents, withFiles) {
  // onDragStartContainer may not exist yet at dom-ready/did-finish-load,
  // so keep trying for a while after each load.
  let retryTimer = null;
  const inject = (attempt = 0) => {
    clearTimeout(retryTimer);
    if (webContents.isDestroyed()) return;
    const url = webContents.getURL() || '';
    if (!/\/app\/index\.html(\?|#|$)/.test(url)) return;
    webContents.executeJavaScript(htmlDragScript(withFiles))
      .then(installed => {
        if (installed) {
          console.log('[STUBS DRAG] HTML5 drag-out installed', withFiles ? '(files)' : '(URIs only)');
        } else if (attempt < 60) {
          retryTimer = setTimeout(() => inject(attempt + 1), 500);
        } else {
          console.log('[STUBS DRAG] HTML5 drag-out not installed: onDragStartContainer missing');
        }
      })
      .catch(() => {});
  };
  webContents.on('dom-ready', () => inject());
  webContents.on('did-finish-load', () => inject());
}

if (isMainProcess && process.platform === 'linux' && electron && electron.app) {
  const { usingWayland, fileUriListExported } = require('./wayland');
  const withFiles = usingWayland && fileUriListExported();
  if (withFiles) {
    electron.ipcMain.handle(DRAG_FILES_CHANNEL, (event, paths) =>
      loadDragFiles(event.sender, paths).catch(err => {
        console.error('[STUBS DRAG] Could not load drag files:', err.message || err);
        return false;
      }));
  }
  electron.app.on('web-contents-created', (event, webContents) => {
    wrapStartDrag(webContents);
    if (usingWayland) installHtmlDrag(webContents, withFiles);
  });
}

module.exports = {
  resolveDragPath,
  normaliseDragItem
};
