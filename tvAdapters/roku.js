import {
  capabilities,
  connectionError,
  CONNECTION_ERROR_CODES,
  fetchWithTimeout,
  unsupported,
} from './common';
import deviceMetadata from '../utils/deviceMetadata';

const { decodeXml, parseRokuDeviceInfo } = deviceMetadata;

export const type = 'roku';
export const label = 'Roku TV';
export const defaultPort = 8060;
export const rokuCapabilities = capabilities({
  power: true, dpad: true, back: true, home: true, search: true,
  mediaControls: true, volume: true, mute: true, channelUpDown: true,
  directChannel: true, inputs: true, installedApps: true, launchApp: true,
  appIcons: true,
});

function ensureRokuResponse(response, action) {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw connectionError(
      CONNECTION_ERROR_CODES.PERMISSION_DENIED,
      `Roku rechazó ${action} (HTTP ${response.status}).`,
    );
  }
  throw connectionError(
    CONNECTION_ERROR_CODES.UNKNOWN,
    `Roku devolvió HTTP ${response.status} al intentar ${action}.`,
  );
}

export async function probe(ip, options = {}) {
  try {
    const response = await fetchWithTimeout(
      `http://${ip}:${defaultPort}/query/device-info`,
      {},
      options.timeoutMs || 1500,
    );
    if (!response.ok) return null;
    const xml = await response.text();
    if (!/<device-info>/i.test(xml)) return null;
    const metadata = parseRokuDeviceInfo(xml, ip);
    return {
      ...metadata,
      type, os: 'Roku OS', ip, port: defaultPort, capabilities: rokuCapabilities,
      auth: { state: 'not_required' },
    };
  } catch (_) {
    return null;
  }
}

export async function connect(device) {
  const found = await probe(device.ip);
  if (!found) throw new Error('No se pudo contactar la Roku TV.');
  return { ...device, ...found };
}

export function disconnect() {}

export async function sendKey(device, key) {
  const response = await fetchWithTimeout(
    `http://${device.ip}:${device.port || defaultPort}/keypress/${encodeURIComponent(key)}`,
    { method: 'POST' }, 1800,
  );
  ensureRokuResponse(response, `enviar ${key}`);
}

export async function loadApps(device) {
  const response = await fetchWithTimeout(`http://${device.ip}:${device.port || defaultPort}/query/apps`, {}, 3000);
  ensureRokuResponse(response, 'consultar las aplicaciones');
  const xml = await response.text();
  return Array.from(xml.matchAll(/<app\b([^>]*)>([\s\S]*?)<\/app>/gi))
    .map((match) => {
      const id = match[1].match(/\bid="([^"]+)"/i)?.[1];
      return id ? { id, name: decodeXml(match[2].trim()), iconUri: getAppIcon(device, id) } : null;
    })
    .filter((app) => app?.name && !app.id.startsWith('tvinput.'))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

export function getAppIcon(device, appId) {
  return `http://${device.ip}:${device.port || defaultPort}/query/icon/${encodeURIComponent(appId)}`;
}

export async function launchApp(device, app) {
  const response = await fetchWithTimeout(
    `http://${device.ip}:${device.port || defaultPort}/launch/${encodeURIComponent(app.id)}`,
    { method: 'POST' }, 2500,
  );
  ensureRokuResponse(response, `abrir ${app.name || app.id}`);
}

export async function tuneChannel(device, channel) {
  const response = await fetchWithTimeout(
    `http://${device.ip}:${device.port || defaultPort}/launch/tvinput.dtv?ch=${encodeURIComponent(channel)}`,
    { method: 'POST' }, 2500,
  );
  ensureRokuResponse(response, `cambiar al canal ${channel}`);
}

export async function diagnose(device) {
  const port = device.port || defaultPort;
  const startedAt = Date.now();
  const response = await fetchWithTimeout(`http://${device.ip}:${port}/query/device-info`, {}, 3000);
  if (!response.ok) {
    throw connectionError(CONNECTION_ERROR_CODES.PORT_BLOCKED, `Roku respondió HTTP ${response.status} en ${port}.`);
  }
  const xml = await response.text();
  if (!/<device-info>/i.test(xml)) {
    throw connectionError(CONNECTION_ERROR_CODES.TV_OFFLINE, 'La respuesta recibida no pertenece a una Roku TV.');
  }
  return {
    device: { ...device, port },
    responding: true,
    latencyMs: Date.now() - startedAt,
    port,
    transport: 'HTTP ECP',
    websocketState: 'No aplica',
  };
}

export const adapter = { type, label, probe, connect, disconnect, sendKey, loadApps, launchApp, tuneChannel, getAppIcon, diagnose };
export default adapter;
