import {
  capabilities,
  connectionError,
  CONNECTION_ERROR_CODES,
  fetchWithTimeout,
  unsupported,
} from './common';
import remoteStability from '../utils/remoteStability';

const { getSamsungPortOrder } = remoteStability;

export const type = 'samsung';
export const label = 'Samsung Tizen';
export const defaultPort = 8001;
const securePort = 8002;
const connectionPorts = [defaultPort, securePort];
export const samsungCapabilities = capabilities({
  power: true, dpad: true, back: true, home: true, search: true,
  mediaControls: true, volume: true, mute: true, channelUpDown: true,
  inputs: true, pairingRequired: true,
});

const sockets = new Map();
const pendingConnections = new Map();
const keyMap = {
  PowerOff: 'KEY_POWER', Up: 'KEY_UP', Down: 'KEY_DOWN', Left: 'KEY_LEFT',
  Right: 'KEY_RIGHT', Select: 'KEY_ENTER', Back: 'KEY_RETURN', Home: 'KEY_HOME',
  Search: 'KEY_SEARCH', Rev: 'KEY_REWIND', Play: 'KEY_PLAY', Fwd: 'KEY_FF',
  Info: 'KEY_INFO', VolumeMute: 'KEY_MUTE', VolumeDown: 'KEY_VOLDOWN',
  VolumeUp: 'KEY_VOLUP', ChannelDown: 'KEY_CHDOWN', ChannelUp: 'KEY_CHUP',
  InputTuner: 'KEY_TV', InputHDMI1: 'KEY_HDMI1', InputHDMI2: 'KEY_HDMI2',
  InputHDMI3: 'KEY_HDMI3', InputHDMI4: 'KEY_HDMI4', InputAV1: 'KEY_AV1',
};

export async function probe(ip, options = {}) {
  try {
    const response = await fetchWithTimeout(
      `http://${ip}:${defaultPort}/api/v2/`,
      {},
      options.timeoutMs || 1200,
    );
    if (!response.ok) return null;
    const json = await response.json();
    const device = json.device || {};
    if (!device.name && !device.modelName && !device.id) return null;
    return {
      id: `samsung:${device.id || ip}`, name: device.name || 'Samsung TV',
      model: device.modelName || '', type, brand: 'Samsung', os: 'Tizen', ip, port: defaultPort,
      capabilities: samsungCapabilities, auth: { state: 'required', token: null },
    };
  } catch (_) {
    return null;
  }
}

function connectionKey(ip, port) {
  return `${ip}:${port}`;
}

function socketState(socket) {
  if (!socket) return 'Desconectado';
  if (socket.readyState === WebSocket.CONNECTING) return 'Conectando';
  if (socket.readyState === WebSocket.OPEN) return 'Conectado';
  if (socket.readyState === WebSocket.CLOSING) return 'Cerrando';
  return 'Desconectado';
}

function socketUrl(device, port) {
  const name = 'b25uIFJlbW90ZQ==';
  const token = device.auth?.token ? `&token=${encodeURIComponent(device.auth.token)}` : '';
  const protocol = port === securePort ? 'wss' : 'ws';
  return `${protocol}://${device.ip}:${port}/api/v2/channels/samsung.remote.control?name=${encodeURIComponent(name)}${token}`;
}

function connectOnPort(device, port, handlers = {}) {
  const key = connectionKey(device.ip, port);
  const current = sockets.get(key);
  if (current?.readyState === WebSocket.OPEN) return Promise.resolve({ ...device, port });
  if (pendingConnections.has(key)) return pendingConnections.get(key);
  handlers.onPairingState?.('waiting');
  const connection = new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl(device, port));
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingConnections.delete(key);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
      reject(error);
    };
    const timer = setTimeout(() => {
      rejectOnce(connectionError(CONNECTION_ERROR_CODES.TIMEOUT, `Samsung no respondió en el puerto ${port}.`));
    }, device.auth?.token ? 7000 : 12000);
    socket.onerror = () => rejectOnce(
      connectionError(CONNECTION_ERROR_CODES.PORT_BLOCKED, `No se pudo abrir Samsung ${port}.`),
    );
    socket.onclose = () => {
      if (sockets.get(key) === socket) sockets.delete(key);
      rejectOnce(connectionError(CONNECTION_ERROR_CODES.PORT_BLOCKED, `Samsung cerró el puerto ${port}.`));
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.event === 'ms.channel.unauthorized') {
          handlers.onPairingState?.('denied');
          rejectOnce(connectionError(CONNECTION_ERROR_CODES.PERMISSION_DENIED, 'La TV Samsung rechazó la autorización.'));
        }
        if (message.event === 'ms.channel.connect') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pendingConnections.delete(key);
          const token = message.data?.token || device.auth?.token || null;
          const connected = { ...device, port, auth: { state: 'authorized', token } };
          sockets.set(key, socket);
          handlers.onPairingState?.('authorized');
          handlers.onAuth?.(connected.auth);
          resolve(connected);
        }
      } catch (_) {}
    };
  });
  pendingConnections.set(key, connection);
  return connection;
}

export async function connect(device, handlers = {}) {
  const ports = getSamsungPortOrder(device.port);
  let lastError;
  for (const port of ports) {
    try {
      return await connectOnPort(device, port, handlers);
    } catch (error) {
      lastError = error;
      if (error?.code === CONNECTION_ERROR_CODES.PERMISSION_DENIED) throw error;
    }
  }
  throw lastError || connectionError(CONNECTION_ERROR_CODES.TV_OFFLINE, 'Samsung no respondió en 8001 ni 8002.');
}

export function disconnect(device) {
  if (!device?.ip) return;
  connectionPorts.forEach((port) => {
    const key = connectionKey(device.ip, port);
    sockets.get(key)?.close();
    sockets.delete(key);
    pendingConnections.delete(key);
  });
}

async function openSocket(device, handlers) {
  const preferred = sockets.get(connectionKey(device.ip, device.port || defaultPort));
  if (preferred?.readyState === WebSocket.OPEN) return preferred;
  const connected = await connect(device, handlers);
  return sockets.get(connectionKey(connected.ip, connected.port));
}

async function sendSamsungKey(device, samsungKey, handlers) {
  const socket = await openSocket(device, handlers);
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw connectionError(CONNECTION_ERROR_CODES.PORT_BLOCKED, 'El WebSocket de Samsung no está abierto.');
  }
  socket.send(JSON.stringify({
    method: 'ms.remote.control',
    params: { Cmd: 'Click', DataOfCmd: samsungKey, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
  }));
}

export async function sendKey(device, key, handlers) {
  const samsungKey = keyMap[key];
  if (!samsungKey) unsupported(key);
  await sendSamsungKey(device, samsungKey, handlers);
}

export async function tuneChannel(device, channel, handlers) {
  for (const character of String(channel)) {
    if (!/\d/.test(character)) continue;
    await sendSamsungKey(device, `KEY_${character}`, handlers);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  await sendSamsungKey(device, 'KEY_ENTER', handlers);
}

export async function loadApps() { unsupported('Lista de aplicaciones'); }
export async function launchApp() { unsupported('Abrir aplicaciones'); }
export function getAppIcon() { return null; }

export async function diagnose(device, handlers = {}) {
  const startedAt = Date.now();
  const connected = await connect(device, handlers);
  const socket = sockets.get(connectionKey(connected.ip, connected.port));
  return {
    device: connected,
    responding: socket?.readyState === WebSocket.OPEN,
    latencyMs: Date.now() - startedAt,
    port: connected.port,
    transport: connected.port === securePort ? 'WebSocket seguro' : 'WebSocket',
    websocketState: socketState(socket),
  };
}

export const adapter = { type, label, probe, connect, disconnect, sendKey, tuneChannel, loadApps, launchApp, getAppIcon, diagnose };
export default adapter;
