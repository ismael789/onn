const SUPPORTED_TEMPLATE_TYPES = new Set(['roku', 'samsung', 'lg']);
const TEMPLATE_BY_DEVICE_TYPE = {
  roku: 'roku', samsung: 'samsung', lg: 'lg',
  sony: 'roku', androidtv: 'roku', firetv: 'roku', vidaa: 'roku', vizio: 'roku', unknown: 'roku',
};

function normalizeTemplateType(type) {
  return TEMPLATE_BY_DEVICE_TYPE[type] || 'roku';
}

function sanitizeShortcutPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([type, selections]) => SUPPORTED_TEMPLATE_TYPES.has(type) && Array.isArray(selections))
      .map(([type, selections]) => [type, selections.slice(0, 3)]),
  );
}

function getSamsungPortOrder(savedPort) {
  return Number(savedPort) === 8002 ? [8002, 8001] : [8001, 8002];
}

function ipLastOctet(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return null;
  const value = Number(parts[3]);
  return Number.isInteger(value) && value >= 1 && value <= 254 ? value : null;
}

function orderIpCandidates(ips, anchorIp, priorityIps = []) {
  const unique = [...new Set(ips)];
  const available = new Set(unique);
  const prioritized = [];
  priorityIps.forEach((ip) => {
    if (available.delete(ip)) prioritized.push(ip);
  });
  const anchor = ipLastOctet(anchorIp);
  const remaining = unique.filter((ip) => available.has(ip));
  if (anchor != null) {
    remaining.sort((left, right) => {
      const leftDistance = Math.abs(ipLastOctet(left) - anchor);
      const rightDistance = Math.abs(ipLastOctet(right) - anchor);
      return leftDistance - rightDistance;
    });
  }
  return [...prioritized, ...remaining];
}

function createQueueState() {
  return { items: [], processing: false, enabled: true };
}

function clearCommandQueue(state, resolveValue = null) {
  state.enabled = false;
  state.items.splice(0).forEach((command) => command.resolve(resolveValue));
}

function enableCommandQueue(state) {
  state.enabled = true;
}

async function processCommandQueue(state, execute, options = {}) {
  if (state.processing || !state.enabled) return;
  state.processing = true;
  const delayMs = options.delayMs ?? 65;
  const wait = options.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  try {
    while (state.enabled && state.items.length > 0) {
      const command = state.items.shift();
      try {
        command.resolve(await execute(command.operation));
      } catch (error) {
        command.reject(error);
        // Una sola falla ya incluye reconexión/reenvío. Rechazar lo pendiente
        // evita múltiples reconexiones y alertas para la misma caída de red.
        state.items.splice(0).forEach((pending) => pending.reject(error));
        break;
      }
      if (state.items.length > 0 && delayMs > 0) await wait(delayMs);
    }
  } finally {
    state.processing = false;
  }
}

function enqueueCommand(state, operation, execute, options = {}) {
  const maxSize = options.maxSize ?? 24;
  if (!state.enabled) return Promise.resolve(null);
  if (state.items.length >= maxSize) {
    const error = new Error(`La cola local alcanzó su límite de ${maxSize} comandos.`);
    error.code = 'QUEUE_FULL';
    return Promise.reject(error);
  }
  const promise = new Promise((resolve, reject) => {
    state.items.push({ operation, resolve, reject });
  });
  processCommandQueue(state, execute, options);
  return promise;
}

module.exports = {
  clearCommandQueue,
  createQueueState,
  enableCommandQueue,
  enqueueCommand,
  getSamsungPortOrder,
  orderIpCandidates,
  normalizeTemplateType,
  processCommandQueue,
  sanitizeShortcutPreferences,
};
