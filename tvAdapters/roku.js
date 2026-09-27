import { capabilities, fetchWithTimeout, unsupported } from './common';

export const type = 'roku';
export const label = 'Roku TV';
export const defaultPort = 8060;
export const rokuCapabilities = capabilities({
  power: true, dpad: true, back: true, home: true, search: true,
  mediaControls: true, volume: true, mute: true, channelUpDown: true,
  directChannel: true, inputs: true, installedApps: true, launchApp: true,
  appIcons: true,
});

function xmlText(xml, tag) {
  return xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`, 'i'))?.[1] || '';
}

function decodeXml(value) {
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

export async function probe(ip) {
  try {
    const response = await fetchWithTimeout(`http://${ip}:${defaultPort}/query/device-info`, {}, 1500);
    if (!response.ok) return null;
    const xml = await response.text();
    if (!/<device-info>/i.test(xml)) return null;
    const name = xmlText(xml, 'friendly-device-name') || xmlText(xml, 'user-device-name') || 'Roku TV';
    return {
      id: `roku:${xmlText(xml, 'device-id') || ip}`,
      name: decodeXml(name),
      model: decodeXml(xmlText(xml, 'model-name')),
      type, brand: type, ip, port: defaultPort, capabilities: rokuCapabilities,
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
    { method: 'POST' }, 1000,
  );
  if (!response.ok) throw new Error(`La Roku rechazó ${key} (HTTP ${response.status}).`);
}

export async function loadApps(device) {
  const response = await fetchWithTimeout(`http://${device.ip}:${device.port || defaultPort}/query/apps`, {}, 3000);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export async function tuneChannel(device, channel) {
  const response = await fetchWithTimeout(
    `http://${device.ip}:${device.port || defaultPort}/launch/tvinput.dtv?ch=${encodeURIComponent(channel)}`,
    { method: 'POST' }, 2500,
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export const adapter = { type, label, probe, connect, disconnect, sendKey, loadApps, launchApp, tuneChannel, getAppIcon };
export default adapter;
