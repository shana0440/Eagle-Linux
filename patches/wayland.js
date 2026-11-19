// ==========================================================================
// Native Wayland support (main process)
//
// The launchers pass --ozone-platform-hint=auto, so Eagle runs as a native
// Wayland client on Wayland sessions. That is required for drag-out: KWin
// never bridges Electron 22's XWayland drags to Wayland clients (issue #2).
//
// Electron 22 (Chromium 108) has a use-after-free in its Wayland cursor
// animation (ui::WaylandCursor::SetPlatformShapeInternal, run from the
// animation timer): when the cursor theme is reloaded - at startup once GTK
// reports the user's theme, and whenever a window changes scale - the frames
// of an animated cursor are freed while the timer still uses them. With an
// animated theme such as Midori, Eagle segfaults within seconds.
//
// The timer only runs for cursors with more than one frame. Before any
// window exists, write single-frame copies of the cursor themes Chromium
// will load and put them first on XCURSOR_PATH, which libwayland-cursor
// searches.
// ==========================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');

const isMainProcess = !process.type || process.type === 'browser';

const XCURSOR_MAGIC = 'Xcur';
const XCURSOR_IMAGE_TYPE = 0xfffd0002;

function argValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find(a => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

// Mirrors Chromium's choice: --ozone-platform wins, otherwise
// --ozone-platform-hint=auto picks Wayland on a Wayland session.
function isWaylandSession() {
  if (process.platform !== 'linux') return false;
  const platform = argValue('ozone-platform');
  if (platform) return platform === 'wayland';
  const hint = argValue('ozone-platform-hint');
  if (hint === 'wayland') return !!process.env.WAYLAND_DISPLAY;
  return hint === 'auto' &&
    process.env.XDG_SESSION_TYPE === 'wayland' &&
    !!process.env.WAYLAND_DISPLAY;
}

// --------------------------------------------------------------------------
// Cursor themes
// --------------------------------------------------------------------------

function cursorSearchDirs() {
  const home = os.homedir();
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
    .split(':').filter(Boolean);
  const dirs = [
    path.join(dataHome, 'icons'),
    path.join(home, '.icons'),
    ...dataDirs.map(d => path.join(d, 'icons')),
    '/usr/share/icons',
    '/usr/share/pixmaps'
  ];
  return [...new Set(dirs)];
}

function readCursorThemeName() {
  try {
    const out = child_process.execFileSync(
      'gsettings',
      ['get', 'org.gnome.desktop.interface', 'cursor-theme'],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim().replace(/^'|'$/g, '');
    if (out) return out;
  } catch (e) {}
  try {
    const ini = fs.readFileSync(
      path.join(os.homedir(), '.config', 'gtk-3.0', 'settings.ini'), 'utf8');
    const m = ini.match(/^\s*gtk-cursor-theme-name\s*=\s*(.+?)\s*$/m);
    if (m) return m[1];
  } catch (e) {}
  return process.env.XCURSOR_THEME || null;
}

function findTheme(name, searchDirs) {
  for (const dir of searchDirs) {
    const themeDir = path.join(dir, name);
    if (fs.existsSync(path.join(themeDir, 'cursors')) ||
        fs.existsSync(path.join(themeDir, 'index.theme'))) {
      return themeDir;
    }
  }
  return null;
}

function themeInherits(themeDir) {
  try {
    const index = fs.readFileSync(path.join(themeDir, 'index.theme'), 'utf8');
    const m = index.match(/^\s*Inherits\s*=\s*(.+?)\s*$/m);
    return m ? m[1].split(/[,;]/).map(s => s.trim()).filter(Boolean) : [];
  } catch (e) {
    return [];
  }
}

// Keep the first image of each nominal size; drop the rest of the animation.
function staticXcursor(data) {
  if (data.length < 16 || data.toString('latin1', 0, 4) !== XCURSOR_MAGIC) {
    return data;
  }
  const version = data.readUInt32LE(8);
  const ntoc = data.readUInt32LE(12);
  const kept = [];
  const seenSizes = new Set();
  for (let i = 0; i < ntoc; i++) {
    const entry = 16 + 12 * i;
    if (entry + 12 > data.length) break;
    const type = data.readUInt32LE(entry);
    const size = data.readUInt32LE(entry + 4);
    const pos = data.readUInt32LE(entry + 8);
    if (type !== XCURSOR_IMAGE_TYPE || seenSizes.has(size)) continue;
    if (pos + 36 > data.length) continue;
    const width = data.readUInt32LE(pos + 16);
    const height = data.readUInt32LE(pos + 20);
    const end = pos + 36 + width * height * 4;
    if (end > data.length) continue;
    const chunk = Buffer.from(data.subarray(pos, end));
    chunk.writeUInt32LE(0, 32); // delay
    seenSizes.add(size);
    kept.push({ type, size, chunk });
  }
  if (kept.length === 0) return data;

  const header = Buffer.alloc(16 + 12 * kept.length);
  header.write(XCURSOR_MAGIC, 0, 'latin1');
  header.writeUInt32LE(16, 4);
  header.writeUInt32LE(version, 8);
  header.writeUInt32LE(kept.length, 12);
  let offset = header.length;
  kept.forEach((k, i) => {
    header.writeUInt32LE(k.type, 16 + 12 * i);
    header.writeUInt32LE(k.size, 20 + 12 * i);
    header.writeUInt32LE(offset, 24 + 12 * i);
    offset += k.chunk.length;
  });
  return Buffer.concat([header, ...kept.map(k => k.chunk)]);
}

function themeStamp(themeDir) {
  const parts = [themeDir];
  for (const sub of ['index.theme', 'cursors']) {
    try { parts.push(String(fs.statSync(path.join(themeDir, sub)).mtimeMs)); } catch (e) {}
  }
  return parts.join('|');
}

function writeStaticTheme(name, themeDir, outRoot) {
  const outDir = path.join(outRoot, name);
  const stampFile = path.join(outDir, '.eagle-linux-stamp');
  const stamp = themeStamp(themeDir);
  try {
    if (fs.readFileSync(stampFile, 'utf8') === stamp) return false;
  } catch (e) {}

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'cursors'), { recursive: true });
  const index = path.join(themeDir, 'index.theme');
  if (fs.existsSync(index)) fs.copyFileSync(index, path.join(outDir, 'index.theme'));

  const srcCursors = path.join(themeDir, 'cursors');
  let entries = [];
  try { entries = fs.readdirSync(srcCursors); } catch (e) {}
  for (const entry of entries) {
    try {
      // Resolve symlinks so an alias never points back at an animated file.
      const data = fs.readFileSync(fs.realpathSync(path.join(srcCursors, entry)));
      fs.writeFileSync(path.join(outDir, 'cursors', entry), staticXcursor(data));
    } catch (e) {}
  }
  fs.writeFileSync(stampFile, stamp);
  return true;
}

function installStaticCursors() {
  const searchDirs = cursorSearchDirs();
  const outRoot = path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
    'eagle-linux', 'static-cursors'
  );

  // Chromium first loads its fallback theme, then the one GTK reports.
  const queue = [readCursorThemeName(), 'default', 'breeze_cursors', 'Adwaita']
    .filter(Boolean);
  const done = new Set();
  const written = [];
  while (queue.length) {
    const name = queue.shift();
    if (done.has(name)) continue;
    done.add(name);
    const themeDir = findTheme(name, searchDirs);
    if (!themeDir) continue;
    queue.push(...themeInherits(themeDir));
    if (writeStaticTheme(name, themeDir, outRoot)) written.push(name);
  }

  const existing = process.env.XCURSOR_PATH
    ? process.env.XCURSOR_PATH.split(':')
    : searchDirs;
  process.env.XCURSOR_PATH = [outRoot, ...existing.filter(d => d !== outRoot)].join(':');

  console.log('[STUBS WAYLAND] Static cursor themes:', [...done].join(', '),
    written.length ? `(regenerated: ${written.join(', ')})` : '(cached)');
}

// --------------------------------------------------------------------------
// Keep reloaded cursor themes alive
//
// Static cursors stop the animation timer, but a window can still hold a
// wl_cursor* from a theme that ReloadThemeCursors() destroyed, and the next
// pointer enter crashes in the same function. Chromium frees a theme through
// wl::ObjectTraits<wl_cursor_theme>::deleter, a function pointer in .data
// that holds wl_cursor_theme_destroy. Point it at an empty function instead,
// so old themes leak (a few hundred KB per reload) rather than dangle.
// (Patching the call sites would mean writing to read-only code, which
// current kernels refuse through /proc/self/mem; the slot is writable.)
//
// Only the official Electron 22.3.7 x64 build is touched: the slot's current
// value and the replacement's bytes are checked first.
// --------------------------------------------------------------------------

const ELECTRON_22_3_7_CURSOR_THEME_DELETER = {
  slot: 0x99ed600,           // wl::ObjectTraits<wl_cursor_theme>::deleter
  destroy: 0x655e6f0,        // wl_cursor_theme_destroy
  noop: 0x21b2220,           // media::Tuneable<int>::~Tuneable(), empty
  noopBytes: '554889e55dc3'  // push %rbp; mov %rsp,%rbp; pop %rbp; ret
};

function executableBase() {
  const exe = fs.realpathSync(process.execPath);
  for (const line of fs.readFileSync('/proc/self/maps', 'utf8').split('\n')) {
    const m = line.match(/^([0-9a-f]+)-[0-9a-f]+ \S+ 0+ \S+ \d+\s+(.*)$/);
    if (m && m[2] === exe) return parseInt(m[1], 16);
  }
  return null;
}

function keepCursorThemesAlive() {
  if (process.arch !== 'x64' || process.versions.electron !== '22.3.7') {
    return 'unsupported Electron build';
  }
  const base = executableBase();
  if (base === null) return 'executable mapping not found';

  const { slot, destroy, noop, noopBytes } = ELECTRON_22_3_7_CURSOR_THEME_DELETER;
  const fd = fs.openSync('/proc/self/mem', 'r+');
  try {
    const code = Buffer.alloc(noopBytes.length / 2);
    fs.readSync(fd, code, 0, code.length, base + noop);
    if (code.toString('hex') !== noopBytes) return 'unexpected replacement function';

    const current = Buffer.alloc(8);
    fs.readSync(fd, current, 0, 8, base + slot);
    const value = Number(current.readBigUInt64LE());
    if (value === base + noop) return null;
    if (value !== base + destroy) return 'deleter slot does not hold wl_cursor_theme_destroy';

    const replacement = Buffer.alloc(8);
    replacement.writeBigUInt64LE(BigInt(base + noop));
    fs.writeSync(fd, replacement, 0, 8, base + slot);
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// --------------------------------------------------------------------------
// Give dragged files a text/uri-list
//
// A drag carrying files offers text/uri-list, but Chromium 108's
// WaylandExchangeDataProvider::ExtractData() has no branch for it. The
// request falls through to the plain-text branch, whose GetString() refuses
// to return text whenever the drag holds files, so the drop target reads
// 0 bytes. File managers such as Nautilus then fall back to text/plain or
// text/x-moz-url and save the URI as a .txt file.
//
// Point that one GetString() call at a copy of GetString() that skips the
// "holds files" check. The renderer puts the URI list in the drag's
// text/plain, so a text/uri-list request returns it. Only ExtractData()
// (the drag source answering the drop target) changes: drops into Eagle
// still never see the text.
//
// This writes to read-only code through /proc/self/mem, which kernels
// built with CONFIG_PROC_MEM_NO_FORCE (or FORCE_PTRACE) refuse; the drag
// then keeps its text/x-moz-url fallback. Only the official Electron
// 22.3.7 x64 build is touched, after checking every byte involved.
// --------------------------------------------------------------------------

const ELECTRON_22_3_7_URI_LIST = {
  // call ui::OSExchangeDataProviderNonBacked::GetString() in
  // ui::WaylandExchangeDataProvider::ExtractData()
  call: 0x2ce93a8,
  getString: 0x6459050,
  // GetString()'s prologue: push %rbp; mov %rsp,%rbp; push %r15; push %r14;
  // push %rbx; push %rax; mov %rsi,%r15; mov %rdi,%r14
  prologue: '554889e54157415653504989f74989fe',
  // The instruction after its `if (HasFile()) return false;`
  afterHasFileCheck: 0x6459069,
  // int3 padding up to the next page after BoringSSL's assembly
  cave: 0x1ec24c0,
  caveSize: 0x1ec3000 - 0x1ec24c0
};

function rel32(from, to) {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(to - from);
  return buf;
}

function exportFileUriList() {
  if (process.arch !== 'x64' || process.versions.electron !== '22.3.7') {
    return 'unsupported Electron build';
  }
  const base = executableBase();
  if (base === null) return 'executable mapping not found';

  const { call, getString, prologue, afterHasFileCheck, cave, caveSize } =
    ELECTRON_22_3_7_URI_LIST;
  const stub = Buffer.concat([
    Buffer.from(prologue, 'hex'),
    Buffer.from([0xe9]),
    rel32(cave + prologue.length / 2 + 5, afterHasFileCheck)
  ]);
  const patchedCall = Buffer.concat([Buffer.from([0xe8]), rel32(call + 5, cave)]);
  const originalCall = Buffer.concat([Buffer.from([0xe8]), rel32(call + 5, getString)]);

  const fd = fs.openSync('/proc/self/mem', 'r+');
  const read = (addr, length) => {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, base + addr);
    return buf;
  };
  try {
    const currentCall = read(call, 5);
    if (currentCall.equals(patchedCall) && read(cave, stub.length).equals(stub)) return null;
    if (!currentCall.equals(originalCall)) return 'unexpected ExtractData() code';
    if (read(getString, prologue.length / 2).toString('hex') !== prologue) {
      return 'unexpected GetString() code';
    }
    if (!read(cave, caveSize).every(b => b === 0xcc)) return 'code cave is not padding';

    // Stub first, then the call that jumps to it.
    fs.writeSync(fd, stub, 0, stub.length, base + cave);
    fs.writeSync(fd, patchedCall, 0, patchedCall.length, base + call);
    if (!read(call, 5).equals(patchedCall)) return 'write did not stick';
    return null;
  } catch (err) {
    return `kernel refused the write (${err.code || err.message})`;
  } finally {
    fs.closeSync(fd);
  }
}

// --------------------------------------------------------------------------
// Keep the window size on a bare xdg_surface.configure
//
// Hyprland ends a configure sequence with only xdg_surface.configure, without
// xdg_toplevel.configure, e.g. when the window's workspace is shown again.
// The spec allows that, but Chromium 108 then takes the empty pending bounds
// as the new size: WaylandWindow::ProcessPendingBoundsDip() resizes the window
// to its minimum size (Eagle's 500x375), drawn in the corner of its tile.
//
// ProcessPendingBoundsDip() already answers empty pending bounds by acking
// with the current bounds, but only for minimized windows. Drop the
// "minimized" condition (jne -> nop) so every window does.
//
// Same requirements as above: the official Electron 22.3.7 x64 build, a
// kernel that allows the /proc/self/mem write, and the expected bytes.
// --------------------------------------------------------------------------

const ELECTRON_22_3_7_BARE_CONFIGURE = {
  // cmp $0x2,%eax (PlatformWindowState::kMinimized); jne <normal path>
  minimizedCheck: 0x2d00bd5,
  original: '83f8027514',
  patched: '83f8029090'
};

function keepSizeOnBareConfigure() {
  if (process.arch !== 'x64' || process.versions.electron !== '22.3.7') {
    return 'unsupported Electron build';
  }
  const base = executableBase();
  if (base === null) return 'executable mapping not found';

  const { minimizedCheck, original, patched } = ELECTRON_22_3_7_BARE_CONFIGURE;
  const fd = fs.openSync('/proc/self/mem', 'r+');
  try {
    const code = Buffer.alloc(original.length / 2);
    fs.readSync(fd, code, 0, code.length, base + minimizedCheck);
    if (code.toString('hex') === patched) return null;
    if (code.toString('hex') !== original) return 'unexpected ProcessPendingBoundsDip() code';
    const replacement = Buffer.from(patched, 'hex');
    fs.writeSync(fd, replacement, 0, replacement.length, base + minimizedCheck);
    return null;
  } catch (err) {
    return `kernel refused the write (${err.code || err.message})`;
  } finally {
    fs.closeSync(fd);
  }
}

const usingWayland = isMainProcess && isWaylandSession();
let fileUriListExported = false;

if (usingWayland) {
  // Renderers inherit the environment and use it to pick the drag path.
  process.env.EAGLE_LINUX_WAYLAND = '1';
  try {
    const skipped = keepCursorThemesAlive();
    console.log('[STUBS WAYLAND] Cursor theme free patch:', skipped ? `skipped (${skipped})` : 'applied');
  } catch (err) {
    console.error('[STUBS WAYLAND] Cursor theme free patch failed:', err);
  }
  try {
    const skipped = exportFileUriList();
    fileUriListExported = !skipped;
    console.log('[STUBS WAYLAND] text/uri-list drag patch:', skipped ? `skipped (${skipped})` : 'applied');
  } catch (err) {
    console.error('[STUBS WAYLAND] text/uri-list drag patch failed:', err);
  }
  try {
    const skipped = keepSizeOnBareConfigure();
    console.log('[STUBS WAYLAND] Bare configure size patch:', skipped ? `skipped (${skipped})` : 'applied');
  } catch (err) {
    console.error('[STUBS WAYLAND] Bare configure size patch failed:', err);
  }
  try {
    installStaticCursors();
  } catch (err) {
    console.error('[STUBS WAYLAND] Could not install static cursors:', err);
  }
}

module.exports = {
  usingWayland,
  fileUriListExported: () => fileUriListExported,
  isWaylandSession,
  staticXcursor
};
