const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clearCommandQueue,
  createQueueState,
  enableCommandQueue,
  enqueueCommand,
  executeWithTransientRetry,
  getSamsungPortOrder,
  normalizeTemplateType,
  orderIpCandidates,
  sanitizeShortcutPreferences,
} = require('../utils/remoteStability');
const {
  deviceTitle,
  normalizeDeviceMetadata,
  parseRokuDeviceInfo,
  protocolLabel,
} = require('../utils/deviceMetadata');
const {
  createConnectionNotificationPolicy,
  notificationActionFromResponse,
} = require('../utils/notificationPolicy');

test('usa Roku como plantilla segura y conserva marcas compatibles', () => {
  assert.equal(normalizeTemplateType(), 'roku');
  assert.equal(normalizeTemplateType('desconocida'), 'roku');
  assert.equal(normalizeTemplateType('samsung'), 'samsung');
  assert.equal(normalizeTemplateType('lg'), 'lg');
  assert.equal(normalizeTemplateType('sony'), 'roku');
  assert.equal(normalizeTemplateType('androidtv'), 'roku');
});

test('clasifica Roku OS por protocolo y conserva la marca comercial del XML', () => {
  const brands = ['TCL', 'Hisense', 'Sharp'];
  brands.forEach((brand) => {
    const device = parseRokuDeviceInfo(`
      <device-info>
        <vendor-name>${brand}</vendor-name>
        <user-device-name>Sala ${brand}</user-device-name>
        <model-name>${brand} Roku TV</model-name>
        <model-number>TV-123</model-number>
        <device-id>${brand.toLowerCase()}-123</device-id>
      </device-info>
    `, '192.168.1.30');
    assert.equal(device.brand, brand);
    assert.equal(device.name, `Sala ${brand}`);
    assert.equal(device.model, `${brand} Roku TV`);
    assert.equal(deviceTitle({ ...device, type: 'roku' }), `${brand} Roku TV`);
  });
});

test('normaliza sistema y marca de TVs guardadas sin decidir el adaptador por marca', () => {
  assert.deepEqual(
    normalizeDeviceMetadata({ type: 'roku', brand: 'onn', ip: '192.168.1.20' }),
    { type: 'roku', brand: 'onn', ip: '192.168.1.20' },
  );
  assert.equal(normalizeDeviceMetadata({ type: 'otro', brand: 'TCL' }).type, 'unknown');
  assert.equal(protocolLabel('samsung'), 'Samsung Tizen');
  assert.equal(protocolLabel('lg'), 'LG webOS');
});

test('las notificaciones de conexión respetan transiciones y no duplican reintentos', () => {
  const policy = createConnectionNotificationPolicy();
  assert.equal(policy.markConnected(), 'connected');
  assert.equal(policy.markConnected(), null);
  assert.equal(policy.markDisconnected(), 'disconnected');
  assert.equal(policy.markDisconnected(), null);
  assert.equal(policy.markConnected(), 'reconnected');
  assert.equal(policy.markConnected(), null);
});

test('el aviso Wi-Fi se emite una sola vez hasta recuperar la red', () => {
  const policy = createConnectionNotificationPolicy();
  assert.equal(policy.markWifiUnavailable(), true);
  assert.equal(policy.markWifiUnavailable(), false);
  policy.markWifiAvailable();
  assert.equal(policy.markWifiUnavailable(), true);
});

test('solo acepta acciones seguras desde una notificación', () => {
  const response = (action, actionIdentifier = 'default') => ({
    actionIdentifier,
    notification: { request: { content: { data: { action } } } },
  });
  assert.equal(notificationActionFromResponse(response('wifi')), 'wifi');
  assert.equal(notificationActionFromResponse(response('power')), null);
  assert.equal(notificationActionFromResponse(response('ignorado', 'open_wifi')), 'wifi');
});

test('prioriza el último puerto Samsung funcional', () => {
  assert.deepEqual(getSamsungPortOrder(8001), [8001, 8002]);
  assert.deepEqual(getSamsungPortOrder(8002), [8002, 8001]);
  assert.deepEqual(getSamsungPortOrder('8002'), [8002, 8001]);
});

test('prioriza IP conocida y direcciones cercanas al teléfono', () => {
  const candidates = ['192.168.1.1', '192.168.1.40', '192.168.1.41', '192.168.1.100'];
  assert.deepEqual(
    orderIpCandidates(candidates, '192.168.1.40', ['192.168.1.100']),
    ['192.168.1.100', '192.168.1.40', '192.168.1.41', '192.168.1.1'],
  );
});

test('limpia preferencias inválidas y limita cada marca a tres accesos', () => {
  const result = sanitizeShortcutPreferences({
    roku: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    samsung: 'incorrecto',
    desconocida: [{ id: 5 }],
  });
  assert.deepEqual(result, { roku: [{ id: 1 }, { id: 2 }, { id: 3 }] });
});

test('la cola ejecuta comandos en orden sin solaparlos', async () => {
  const state = createQueueState();
  const order = [];
  let active = 0;
  let maximumActive = 0;
  const execute = async (operation) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const result = await operation();
    active -= 1;
    return result;
  };
  const options = { delayMs: 0 };
  const results = await Promise.all([
    enqueueCommand(state, async () => { order.push(1); return 1; }, execute, options),
    enqueueCommand(state, async () => { order.push(2); return 2; }, execute, options),
    enqueueCommand(state, async () => { order.push(3); return 3; }, execute, options),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(results, [1, 2, 3]);
  assert.equal(maximumActive, 1);
});

test('la cola respeta la pausa individual de cada comando', async () => {
  const state = createQueueState();
  const pauses = [];
  const wait = async (milliseconds) => pauses.push(milliseconds);
  const execute = async (operation) => operation();
  const first = enqueueCommand(state, async () => 1, execute, { delayMs: 125, wait });
  const second = enqueueCommand(state, async () => 2, execute, { delayMs: 65, wait });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(pauses, [125]);
});

test('cuarenta pulsaciones rápidas se conservan en el mismo orden', async () => {
  const state = createQueueState();
  const received = [];
  const commands = Array.from({ length: 40 }, (_, index) =>
    enqueueCommand(
      state,
      async () => { received.push(index); return index; },
      async (operation) => operation(),
      { maxSize: 40, delayMs: 0 },
    ));
  assert.deepEqual(await Promise.all(commands), Array.from({ length: 40 }, (_, index) => index));
  assert.deepEqual(received, Array.from({ length: 40 }, (_, index) => index));
});

test('un fallo transitorio reintenta una vez antes de reconectar', async () => {
  let attempts = 0;
  let retries = 0;
  const result = await executeWithTransientRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('Network request failed'), { code: 'PORT_BLOCKED' });
    return 'enviado';
  }, {
    shouldRetry: (error) => error.code === 'PORT_BLOCKED',
    delayMs: 140,
    wait: async (milliseconds) => assert.equal(milliseconds, 140),
    onRetry: () => { retries += 1; },
  });
  assert.equal(result, 'enviado');
  assert.equal(attempts, 2);
  assert.equal(retries, 1);
});

test('un error no recuperable no reintenta el comando', async () => {
  let attempts = 0;
  await assert.rejects(
    executeWithTransientRetry(async () => {
      attempts += 1;
      throw Object.assign(new Error('permiso rechazado'), { code: 'PERMISSION_DENIED' });
    }, { shouldRetry: (error) => error.code !== 'PERMISSION_DENIED', delayMs: 0 }),
    /permiso rechazado/,
  );
  assert.equal(attempts, 1);
});

test('una falla rechaza lo pendiente y evita una cadena de reconexiones', async () => {
  const state = createQueueState();
  let executions = 0;
  const expectedError = new Error('sin red');
  const execute = async (operation) => {
    executions += 1;
    return operation();
  };
  const first = enqueueCommand(state, async () => { throw expectedError; }, execute, { delayMs: 0 });
  const second = enqueueCommand(state, async () => 'no debe ejecutarse', execute, { delayMs: 0 });
  await assert.rejects(first, /sin red/);
  await assert.rejects(second, /sin red/);
  assert.equal(executions, 1);
});

test('limpiar la cola no ejecuta comandos pendientes y permite habilitarla después', async () => {
  const state = createQueueState();
  state.processing = true;
  const pending = enqueueCommand(state, async () => 'pendiente', async (operation) => operation());
  clearCommandQueue(state);
  assert.equal(await pending, null);
  assert.equal(state.items.length, 0);
  enableCommandQueue(state);
  state.processing = false;
  assert.equal(await enqueueCommand(state, async () => 'nuevo', async (operation) => operation(), { delayMs: 0 }), 'nuevo');
});
