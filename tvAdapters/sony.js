import {
  capabilities,
  connectionError,
  CONNECTION_ERROR_CODES,
  fetchWithTimeout,
  unsupported,
} from './common';

export const type = 'sony';
export const label = 'Sony Bravia';
export const defaultPort = 80;

const commandCache = new Map();
const keyNames = {
  PowerOff: ['PowerOff', 'TvPower', 'Power'],
  Up: ['Up'], Down: ['Down'], Left: ['Left'], Right: ['Right'],
  Select: ['Confirm', 'Enter'], Back: ['Return', 'Back'], Home: ['Home'],
  Search: ['Search'], Info: ['Display', 'Info'],
  Rev: ['Rewind'], Play: ['Play', 'Pause'], Fwd: ['Forward'],
  VolumeMute: ['Mute'], VolumeDown: ['VolumeDown'], VolumeUp: ['VolumeUp'],
  ChannelDown: ['ChannelDown'], ChannelUp: ['ChannelUp'],
  InputTuner: ['Input', 'Tv'], InputHDMI1: ['Hdmi1'], InputHDMI2: ['Hdmi2'],
  InputHDMI3: ['Hdmi3'], InputHDMI4: ['Hdmi4'], InputAV1: ['Video1'],
};

function authHeaders(device, extra = {}) {
  const headers = { ...extra };
  if (device?.auth?.token) headers['X-Auth-PSK'] = device.auth.token;
  return headers;
}

function sonyDevice(ip, info = {}, authState = 'not_required') {
  return {
    id: `sony:${info.serial || info.macAddr || ip}`,
    name: info.name || info.product || 'Sony Bravia',
    model: info.model || '',
    modelNumber: info.model || '',
    serialNumber: info.serial || '',
    softwareVersion: info.generation || '',
    type,
    brand: 'Sony',
    os: 'BRAVIA',
    ip,
    port: defaultPort,
    capabilities: capabilities({ pairingRequired: authState === 'required' }),
    auth: { state: authState, token: null },
  };
}

async function jsonRpc(device, service, method, params = [], version = '1.0', timeoutMs = 2500) {
  const response = await fetchWithTimeout(
    `http://${device.ip}:${device.port || defaultPort}/sony/${service}`,
    {
      method: 'POST',
      headers: authHeaders(device, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ method, params, id: 1, version }),
    },
    timeoutMs,
  );
  if (response.status === 401 || response.status === 403) {
    throw connectionError(
      CONNECTION_ERROR_CODES.PERMISSION_DENIED,
      'Sony Bravia requiere autorización. Activa Control IP y configura Autenticación en la TV.',
      null,
      {
        message: 'Sony Bravia requiere configurar el control por red.',
        cause: 'Activa Control IP/IP Control en la TV y permite la autenticación desde la red local.',
      },
    );
  }
  if (!response.ok) {
    throw connectionError(CONNECTION_ERROR_CODES.PORT_BLOCKED, `Sony Bravia respondió HTTP ${response.status}.`);
  }
  const payload = await response.json();
  if (payload.error) {
    throw connectionError(CONNECTION_ERROR_CODES.UNSUPPORTED, `Sony rechazó ${method}: ${JSON.stringify(payload.error)}.`);
  }
  return payload.result || [];
}

function parseRemoteCommands(result) {
  const entries = Array.isArray(result?.[1]) ? result[1] : [];
  return Object.fromEntries(entries
    .filter((entry) => entry?.name && entry?.value)
    .map((entry) => [String(entry.name).toLowerCase(), entry.value]));
}

function hasCommand(commands, candidates) {
  return candidates.some((name) => commands[String(name).toLowerCase()]);
}

function capabilitiesFor(commands) {
  const has = (key) => hasCommand(commands, keyNames[key] || []);
  return capabilities({
    power: has('PowerOff'),
    dpad: ['Up', 'Down', 'Left', 'Right', 'Select'].every(has),
    back: has('Back'),
    home: has('Home'),
    search: has('Search'),
    mediaControls: has('Play') || has('Rev') || has('Fwd'),
    volume: has('VolumeUp') && has('VolumeDown'),
    mute: has('VolumeMute'),
    channelUpDown: has('ChannelUp') && has('ChannelDown'),
    directChannel: Array.from({ length: 10 }, (_, digit) => `num${digit}`).every((name) => commands[name]),
    inputs: Object.keys(keyNames).some((key) => key.startsWith('Input') && has(key)),
  });
}

export async function probe(ip, options = {}) {
  const device = sonyDevice(ip);
  try {
    const response = await fetchWithTimeout(
      `http://${ip}:${defaultPort}/sony/system`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'getSystemInformation', params: [], id: 1, version: '1.0' }),
      },
      options.timeoutMs || 1400,
    );
    if (response.status === 401 || response.status === 403) return sonyDevice(ip, {}, 'required');
    if (!response.ok) return null;
    const payload = await response.json();
    const info = payload.result?.[0];
    return info && typeof info === 'object' ? sonyDevice(ip, info) : null;
  } catch (_) {
    return null;
  }
}

export async function connect(device) {
  const systemResult = await jsonRpc(device, 'system', 'getSystemInformation');
  const info = systemResult[0] || {};
  const remoteResult = await jsonRpc(device, 'system', 'getRemoteControllerInfo');
  const commands = parseRemoteCommands(remoteResult);
  if (Object.keys(commands).length === 0) {
    throw connectionError(CONNECTION_ERROR_CODES.UNSUPPORTED, 'Sony Bravia no entregó comandos de control IP.');
  }
  commandCache.set(device.ip, commands);
  return {
    ...device,
    ...sonyDevice(device.ip, info, device.auth?.token ? 'authorized' : 'not_required'),
    auth: device.auth?.token ? { state: 'authorized', token: device.auth.token } : { state: 'not_required', token: null },
    capabilities: capabilitiesFor(commands),
  };
}

export function disconnect(device) {
  if (device?.ip) commandCache.delete(device.ip);
}

async function remoteCommands(device) {
  if (commandCache.has(device.ip)) return commandCache.get(device.ip);
  const commands = parseRemoteCommands(await jsonRpc(device, 'system', 'getRemoteControllerInfo'));
  commandCache.set(device.ip, commands);
  return commands;
}

async function sendIrcc(device, code) {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>${code}</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>`;
  const response = await fetchWithTimeout(
    `http://${device.ip}:${device.port || defaultPort}/sony/IRCC`,
    {
      method: 'POST',
      headers: authHeaders(device, {
        'Content-Type': 'text/xml; charset=UTF-8',
        SOAPACTION: '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"',
      }),
      body,
    },
    2000,
  );
  if (response.status === 401 || response.status === 403) {
    throw connectionError(
      CONNECTION_ERROR_CODES.PERMISSION_DENIED,
      'Sony Bravia rechazó el control IP.',
      null,
      {
        message: 'Sony Bravia rechazó el control por red.',
        cause: 'Revisa Control IP y Autenticación en los ajustes de red de la TV.',
      },
    );
  }
  if (!response.ok) {
    throw connectionError(CONNECTION_ERROR_CODES.PORT_BLOCKED, `Sony IRCC respondió HTTP ${response.status}.`);
  }
}

export async function sendKey(device, key) {
  const commands = await remoteCommands(device);
  const commandName = (keyNames[key] || []).find((name) => commands[name.toLowerCase()]);
  if (!commandName) unsupported(key);
  await sendIrcc(device, commands[commandName.toLowerCase()]);
}

export async function tuneChannel(device, channel) {
  const commands = await remoteCommands(device);
  for (const digit of String(channel)) {
    const code = commands[`num${digit}`];
    if (!code) unsupported('Canal directo');
    await sendIrcc(device, code);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  const enter = commands.confirm || commands.enter;
  if (enter) await sendIrcc(device, enter);
}

export async function loadApps() { unsupported('Lista de aplicaciones'); }
export async function launchApp() { unsupported('Abrir aplicaciones'); }
export function getAppIcon() { return null; }

export async function diagnose(device) {
  const startedAt = Date.now();
  const connected = await connect(device);
  return {
    device: connected,
    responding: true,
    latencyMs: Date.now() - startedAt,
    port: connected.port || defaultPort,
    transport: 'HTTP JSON-RPC / IRCC',
    websocketState: 'No aplica',
  };
}

export const adapter = {
  type, label, probe, connect, disconnect, sendKey, tuneChannel,
  loadApps, launchApp, getAppIcon, diagnose,
};
export default adapter;
