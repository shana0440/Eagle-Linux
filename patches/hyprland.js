// ==========================================================================
// Hyprland: put Eagle's notification where Eagle asks
//
// Eagle shows its notifications ("Download complete", ...) in progress.html,
// a popup it moves to the bottom-right corner with setPosition() before each
// showInactive(). Wayland clients cannot place their windows, so Hyprland
// opens the popup in the middle of the screen instead. Hyprland's IPC socket
// can move it: once the popup is mapped, move it to the position Eagle set.
// ==========================================================================

const net = require('net');
const path = require('path');
const { usingWayland } = require('./wayland');

const NOTIFICATION_TITLE = 'Eagle Notification';
const MAP_POLL_INTERVAL_MS = 50;
const MAP_POLL_ATTEMPTS = 40;

function hyprlandSocket() {
  const { XDG_RUNTIME_DIR, HYPRLAND_INSTANCE_SIGNATURE } = process.env;
  if (!XDG_RUNTIME_DIR || !HYPRLAND_INSTANCE_SIGNATURE) return null;
  return path.join(XDG_RUNTIME_DIR, 'hypr', HYPRLAND_INSTANCE_SIGNATURE, '.socket.sock');
}

function hyprctl(socket, request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const connection = net.connect(socket, () => connection.end(request));
    connection.on('data', chunk => chunks.push(chunk));
    connection.on('end', () => resolve(Buffer.concat(chunks).toString()));
    connection.on('error', reject);
  });
}

async function findMappedNotification(socket) {
  for (let attempt = 0; attempt < MAP_POLL_ATTEMPTS; attempt++) {
    const clients = JSON.parse(await hyprctl(socket, 'j/clients'));
    const notification = clients.find(client =>
      client.pid === process.pid && client.title === NOTIFICATION_TITLE &&
      client.mapped && !client.hidden);
    if (notification) return notification;
    await new Promise(resolve => setTimeout(resolve, MAP_POLL_INTERVAL_MS));
  }
  return null;
}

async function moveNotification(socket, { x, y }) {
  const notification = await findMappedNotification(socket);
  if (!notification) return;
  const window = `address:${notification.address}`;
  // Hyprland reads dispatches as Lua with a Lua config, else as hyprlang.
  const reply = await hyprctl(socket, `dispatch hl.dsp.window.move({ x = ${x}, y = ${y}, window = '${window}' })`);
  if (reply.trim() !== 'ok') {
    await hyprctl(socket, `dispatch movewindowpixel exact ${x} ${y},${window}`);
  }
}

function placeNotifications(socket) {
  const { BrowserWindow } = require('electron');
  const { setPosition } = BrowserWindow.prototype;
  const requestedPositions = new WeakMap();

  const move = win => moveNotification(socket, requestedPositions.get(win)).catch(err =>
    console.error('[STUBS HYPRLAND] Could not move the notification:', err));

  BrowserWindow.prototype.setPosition = function (x, y, ...rest) {
    setPosition.call(this, x, y, ...rest);
    if (!this.webContents.getURL().endsWith('/progress.html')) return;
    if (!requestedPositions.has(this)) {
      this.setTitle(NOTIFICATION_TITLE);
      this.on('show', () => move(this));
    }
    requestedPositions.set(this, { x, y });
    if (this.isVisible()) move(this);
  };
}

const socket = usingWayland ? hyprlandSocket() : null;
if (socket) placeNotifications(socket);
