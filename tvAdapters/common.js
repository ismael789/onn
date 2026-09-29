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

export const CONNECTION_ERROR_CODES = {
  TIMEOUT: 'TIMEOUT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  PORT_BLOCKED: 'PORT_BLOCKED',
  DIFFERENT_NETWORK: 'DIFFERENT_NETWORK',
  NETWORK_ISOLATION: 'NETWORK_ISOLATION',
  TV_OFFLINE: 'TV_OFFLINE',
  UNSUPPORTED: 'UNSUPPORTED',
  QUEUE_FULL: 'QUEUE_FULL',
  UNKNOWN: 'UNKNOWN',
};

export function connectionError(code, technicalMessage, cause, userInfo) {
  const error = new Error(technicalMessage);
  error.code = code;
  if (cause) error.cause = cause;
  if (userInfo) error.userInfo = userInfo;
  return error;
}

export function normalizeConnectionError(error, context = {}) {
  const technicalMessage = error?.message || String(error || 'Error desconocido');
  const normalizedText = technicalMessage.toLowerCase();
  let code = error?.code || CONNECTION_ERROR_CODES.UNKNOWN;

  if (error?.name === 'AbortError' || /timeout|tiempo|agotó|no respondió/.test(normalizedText)) {
    code = CONNECTION_ERROR_CODES.TIMEOUT;
  } else if (/unauthorized|rechaz|denied|permiso|autoriz|http 401|http 403/.test(normalizedText)) {
    code = CONNECTION_ERROR_CODES.PERMISSION_DENIED;
  } else if (/network request failed|websocket|puerto|socket|cerró la conexión/.test(normalizedText)) {
    code = CONNECTION_ERROR_CODES.PORT_BLOCKED;
  }

  if (context.differentSubnet && code !== CONNECTION_ERROR_CODES.PERMISSION_DENIED) {
    code = CONNECTION_ERROR_CODES.DIFFERENT_NETWORK;
  }

  const descriptions = {
    [CONNECTION_ERROR_CODES.TIMEOUT]: {
      message: 'La TV no respondió a tiempo.',
      cause: 'Puede estar apagada, desconectada del Wi‑Fi o bloqueada por el router.',
    },
    [CONNECTION_ERROR_CODES.PERMISSION_DENIED]: {
      message: 'La TV rechazó el permiso de control.',
      cause: 'Acepta la solicitud de autorización en la pantalla de la TV.',
    },
    [CONNECTION_ERROR_CODES.PORT_BLOCKED]: {
      message: 'No se pudo abrir el puerto de control de la TV.',
      cause: 'El puerto puede estar bloqueado, la TV apagada o el control por red desactivado.',
    },
    [CONNECTION_ERROR_CODES.DIFFERENT_NETWORK]: {
      message: 'El teléfono y la TV parecen estar en redes diferentes.',
      cause: 'Conecta ambos a la misma red local, aunque usen bandas 2.4 GHz y 5 GHz distintas.',
    },
    [CONNECTION_ERROR_CODES.NETWORK_ISOLATION]: {
      message: 'La red local no permite llegar hasta la TV.',
      cause: 'Revisa red de invitados, AP isolation o aislamiento entre clientes/bandas.',
    },
    [CONNECTION_ERROR_CODES.TV_OFFLINE]: {
      message: 'La TV no está disponible en la red.',
      cause: 'Comprueba que esté encendida y conectada al router.',
    },
    [CONNECTION_ERROR_CODES.UNSUPPORTED]: {
      message: 'Esta función no es compatible con la TV seleccionada.',
      cause: 'El protocolo disponible para este modelo no ofrece esa función.',
    },
    [CONNECTION_ERROR_CODES.QUEUE_FULL]: {
      message: 'Se enviaron demasiados comandos seguidos.',
      cause: 'Espera un momento y vuelve a intentarlo.',
    },
    [CONNECTION_ERROR_CODES.UNKNOWN]: {
      message: 'No se pudo comunicar con la TV.',
      cause: 'Comprueba que la TV esté encendida y que la red local no tenga aislamiento.',
    },
  };
  const userInfo = error?.userInfo || descriptions[code] || descriptions[CONNECTION_ERROR_CODES.UNKNOWN];
  return { code, ...userInfo, technicalMessage };
}

export function isRetryableConnectionError(error) {
  const { code } = normalizeConnectionError(error);
  return [
    CONNECTION_ERROR_CODES.TIMEOUT,
    CONNECTION_ERROR_CODES.PORT_BLOCKED,
    CONNECTION_ERROR_CODES.DIFFERENT_NETWORK,
    CONNECTION_ERROR_CODES.NETWORK_ISOLATION,
    CONNECTION_ERROR_CODES.TV_OFFLINE,
    CONNECTION_ERROR_CODES.UNKNOWN,
  ].includes(code);
}

export function unsupported(feature) {
  const error = new Error(`${feature} no está disponible para esta TV.`);
  error.code = CONNECTION_ERROR_CODES.UNSUPPORTED;
  throw error;
}
