import { capabilities, fetchWithTimeout, unsupported } from './common';

export const type = 'samsung';
export const label = 'Samsung Tizen';
export const defaultPort = 8001;
export const samsungCapabilities = capabilities({
  power: true, dpad: true, back: true, home: true, search: true,
  mediaControls: true, volume: true, mute: true, channelUpDown: true,
  inputs: true, pairingRequired: true,
});

const sockets = new Map();
const keyMap = {
  PowerOff: 'KEY_POWER', Up: 'KEY_UP', Down: 'KEY_DOWN', Left: 'KEY_LEFT',
  Right: 'KEY_RIGHT', Select: 'KEY_ENTER', Back: 'KEY_RETURN', Home: 'KEY_HOME',
  Search: 'KEY_SEARCH', Rev: 'KEY_REWIND', Play: 'KEY_PLAY', Fwd: 'KEY_FF',
  Info: 'KEY_INFO', VolumeMute: 'KEY_MUTE', VolumeDown: 'KEY_VOLDOWN',
  VolumeUp: 'KEY_VOLUP', ChannelDown: 'KEY_CHDOWN', ChannelUp: 'KEY_CHUP',
  InputTuner: 'KEY_TV', InputHDMI1: 'KEY_HDMI1', InputHDMI2: 'KEY_HDMI2',
  InputHDMI3: 'KEY_HDMI3', InputHDMI4: 'KEY_HDMI4', InputAV1: 'KEY_AV1',
};

export async function probe(ip) {
  try {
    const response = await fetchWithTimeout(`http://${ip}:${defaultPort}/api/v2/`, {}, 1200);
    if (!response.ok) return null;
    const json = await response.json();
    const device = json.device || {};
    if (!device.name && !device.modelName && !device.id) return null;
    return {
      id: `samsung:${device.id || ip}`, name: device.name || 'Samsung TV',
      model: device.modelName || '', type, brand: type, ip, port: defaultPort,
      capabilities: samsungCapabilities, auth: { state: 'required', token: null },
    };
  } catch (_) {
    return null;
  }
}

function socketUrl(device) {
  const name = 'b25uIFJlbW90ZQ==';
  const token = device.auth?.token ? `&token=${encodeURIComponent(device.auth.token)}` : '';
  return `ws://${device.ip}:${device.port || defaultPort}/api/v2/channels/samsung.remote.control?name=${encodeURIComponent(name)}${token}`;
}

export function connect(device, handlers = {}) {
  const current = sockets.get(device.ip);
  if (current?.readyState === WebSocket.OPEN) return Promise.resolve(device);
  handlers.onPairingState?.('waiting');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl(device));
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('La autorización de Samsung agotó el tiempo.'));
    }, 30000);
    socket.onerror = () => { clearTimeout(timer); reject(new Error('No se pudo abrir el WebSocket de Samsung.')); };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.event === 'ms.channel.unauthorized') {
          handlers.onPairingState?.('denied');
          clearTimeout(timer);
          reject(new Error('La TV rechazó la autorización.'));
        }
        if (message.event === 'ms.channel.connect') {
          clearTimeout(timer);
          const token = message.data?.token || device.auth?.token || null;
          const connected = { ...device, auth: { state: 'authorized', token } };
          sockets.set(device.ip, socket);
          handlers.onPairingState?.('authorized');
          handlers.onAuth?.(connected.auth);
          resolve(connected);
        }
      } catch (_) {}
    };
  });
}

export function disconnect(device) {
  sockets.get(device?.ip)?.close();
  if (device?.ip) sockets.delete(device.ip);
}

async function openSocket(device, handlers) {
  const socket = sockets.get(device.ip);
  if (socket?.readyState === WebSocket.OPEN) return socket;
  await connect(device, handlers);
  return sockets.get(device.ip);
}

async function sendSamsungKey(device, samsungKey, handlers) {
  const socket = await openSocket(device, handlers);
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

export const adapter = { type, label, probe, connect, disconnect, sendKey, tuneChannel, loadApps, launchApp, getAppIcon };
export default adapter;
