export const CAPABILITY_KEYS = [
  'power', 'dpad', 'back', 'home', 'search', 'mediaControls', 'volume',
  'mute', 'channelUpDown', 'directChannel', 'inputs', 'installedApps',
  'launchApp', 'appIcons', 'pairingRequired',
];

export function capabilities(overrides = {}) {
  return Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, !!overrides[key]]));
}

export function fetchWithTimeout(url, options = {}, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

export function unsupported(feature) {
  const error = new Error(`${feature} no está disponible para esta TV.`);
  error.code = 'UNSUPPORTED';
  throw error;
}
