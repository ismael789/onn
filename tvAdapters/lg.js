import { capabilities, unsupported } from './common';

export const type = 'lg';
export const label = 'LG webOS';
export const defaultPort = 3000;
export const lgCapabilities = capabilities({
  power: true, dpad: true, back: true, home: true, mediaControls: true,
  volume: true, mute: true, channelUpDown: true, installedApps: true,
  launchApp: true, appIcons: true, pairingRequired: true,
});

const sessions = new Map();
const permissions = [
  'LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CLOSE', 'TEST_OPEN', 'TEST_PROTECTED',
  'CONTROL_AUDIO', 'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_PLAYBACK',
  'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_TV', 'CONTROL_POWER', 'READ_APP_STATUS',
  'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST', 'READ_INSTALLED_APPS', 'READ_LGE_SDX',
  'READ_NETWORK_STATE', 'READ_RUNNING_APPS', 'READ_TV_CHANNEL_LIST', 'WRITE_NOTIFICATION_TOAST',
];

// El escaneo automático no abre solicitudes de emparejamiento en 254 direcciones.
// LG se conecta manualmente por IP para evitar falsos positivos y avisos en TVs ajenas.
export async function probe() { return null; }

function registerPayload(device) {
  return {
    type: 'register', id: 'register_0', payload: {
      forcePairing: false, pairingType: 'PROMPT', 'client-key': device.auth?.token || undefined,
      manifest: {
        manifestVersion: 1, appVersion: '1.0', signed: {
          created: '20260927', appId: 'com.onnremote.app', vendorId: 'com.onnremote',
          localizedAppNames: { '': 'onn Remote' }, localizedVendorNames: { '': 'onn Remote' },
          permissions,
        }, permissions,
      },
    },
  };
}

function request(session, uri, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = `request_${session.nextId++}`;
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error('La TV LG no respondió.'));
    }, 6000);
    session.pending.set(id, { resolve, reject, timer });
    session.socket.send(JSON.stringify({ type: 'request', id, uri, payload }));
  });
}

export function connect(device, handlers = {}) {
  const active = sessions.get(device.ip);
  if (active?.socket?.readyState === WebSocket.OPEN && active.registered) return Promise.resolve(device);
  handlers.onPairingState?.('waiting');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${device.ip}:${device.port || defaultPort}`);
    const session = { socket, pending: new Map(), nextId: 1, registered: false, pointer: null };
    sessions.set(device.ip, session);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('LG no respondió. Algunos modelos nuevos requieren Connect SDK en el APK.'));
    }, 30000);
    socket.onopen = () => socket.send(JSON.stringify(registerPayload(device)));
    socket.onerror = () => { clearTimeout(timer); reject(new Error('No se pudo conectar con LG webOS por el puerto 3000.')); };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'registered') {
          clearTimeout(timer);
          session.registered = true;
          const token = message.payload?.['client-key'] || device.auth?.token || null;
          const connected = { ...device, id: device.id || `lg:${device.ip}`, name: device.name || 'LG webOS TV', type, brand: type, port: defaultPort, capabilities: lgCapabilities, auth: { state: 'authorized', token } };
          handlers.onPairingState?.('authorized');
          handlers.onAuth?.(connected.auth);
          resolve(connected);
        } else if (message.type === 'error' && message.id === 'register_0') {
          clearTimeout(timer);
          handlers.onPairingState?.('denied');
          reject(new Error(message.error || 'La TV LG rechazó el emparejamiento.'));
        } else if (message.id && session.pending.has(message.id)) {
          const pending = session.pending.get(message.id);
          clearTimeout(pending.timer);
          session.pending.delete(message.id);
          if (message.type === 'error') pending.reject(new Error(message.error));
          else pending.resolve(message.payload || {});
        }
      } catch (_) {}
    };
  });
}

export function disconnect(device) {
  const session = sessions.get(device?.ip);
  session?.pointer?.close();
  session?.socket?.close();
  if (device?.ip) sessions.delete(device.ip);
}

async function getSession(device, handlers) {
  let session = sessions.get(device.ip);
  if (!session?.registered) {
    await connect(device, handlers);
    session = sessions.get(device.ip);
  }
  return session;
}

async function pointerButton(device, name, handlers) {
  const session = await getSession(device, handlers);
  if (!session.pointer || session.pointer.readyState !== WebSocket.OPEN) {
    const result = await request(session, 'ssap://com.webos.service.networkinput/getPointerInputSocket');
    session.pointer = new WebSocket(result.socketPath);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No se abrió el control LG.')), 5000);
      session.pointer.onopen = () => { clearTimeout(timer); resolve(); };
      session.pointer.onerror = () => { clearTimeout(timer); reject(new Error('Falló el control LG.')); };
    });
  }
  session.pointer.send(`type:button\nname:${name}\n\n`);
}

const pointerKeys = { Up: 'UP', Down: 'DOWN', Left: 'LEFT', Right: 'RIGHT', Select: 'ENTER', Back: 'BACK', Home: 'HOME' };
const uriKeys = {
  PowerOff: 'ssap://system/turnOff', Rev: 'ssap://media.controls/rewind',
  Play: 'ssap://media.controls/play', Fwd: 'ssap://media.controls/fastForward',
  VolumeMute: 'ssap://audio/setMute', VolumeDown: 'ssap://audio/volumeDown',
  VolumeUp: 'ssap://audio/volumeUp', ChannelDown: 'ssap://tv/channelDown',
  ChannelUp: 'ssap://tv/channelUp',
};

export async function sendKey(device, key, handlers) {
  if (pointerKeys[key]) return pointerButton(device, pointerKeys[key], handlers);
  const uri = uriKeys[key];
  if (!uri) unsupported(key);
  const session = await getSession(device, handlers);
  if (key === 'VolumeMute') {
    const status = await request(session, 'ssap://audio/getStatus');
    return request(session, uri, { mute: !status.mute });
  }
  return request(session, uri);
}

export async function loadApps(device, handlers) {
  const session = await getSession(device, handlers);
  const result = await request(session, 'ssap://com.webos.applicationManager/listLaunchPoints');
  return (result.launchPoints || []).map((app) => ({
    id: app.id,
    name: app.title || app.id,
    iconUri: app.icon
      ? (/^https?:\/\//i.test(app.icon) ? app.icon : `http://${device.ip}:${device.port || defaultPort}${app.icon.startsWith('/') ? '' : '/'}${app.icon}`)
      : null,
  })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export async function launchApp(device, app, handlers) {
  const session = await getSession(device, handlers);
  return request(session, 'ssap://system.launcher/launch', { id: app.id });
}

export async function tuneChannel() { unsupported('Canal directo'); }
export function getAppIcon(_device, _id, app) { return app?.iconUri || null; }

export const adapter = { type, label, probe, connect, disconnect, sendKey, loadApps, launchApp, tuneChannel, getAppIcon };
export default adapter;
