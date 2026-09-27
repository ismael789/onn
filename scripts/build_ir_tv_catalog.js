/*
 * Convierte los controles de TVs de Flipper-IRDB a un catálogo local para la app.
 * Uso: node scripts/build_ir_tv_catalog.js <ruta-a-Flipper-IRDB>
 */
const fs = require('fs');
const path = require('path');

const sourceRoot = process.argv[2];
if (!sourceRoot) {
  throw new Error('Falta la ruta de Flipper-IRDB.');
}

const tvRoot = path.join(sourceRoot, 'TVs');
const outputPath = path.join(__dirname, '..', 'ir_tv_catalog.json');

const normalize = (value) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '');

const aliases = {
  PowerToggle: ['power', 'powertoggle', 'onoff', 'standby'],
  Up: ['up', 'cursorup', 'navup'],
  Down: ['down', 'cursordown', 'navdown'],
  Left: ['left', 'cursorleft', 'navleft'],
  Right: ['right', 'cursorright', 'navright'],
  Select: ['ok', 'select', 'enter'],
  Home: ['home', 'smarthub', 'smart', 'menu'],
  Back: ['back', 'return', 'exit'],
  Search: ['search', 'voice'],
  Rev: ['rewind', 'fastback', 'fastba', 'fastrewind', 'rev', 'rw'],
  Play: ['playpause', 'play', 'pause'],
  Fwd: ['fastforward', 'fastfo', 'fastfwd', 'forward', 'fwd', 'ff'],
  Info: ['info', 'display'],
  VolumeMute: ['mute', 'volumemute'],
  VolumeDown: ['voldn', 'voldown', 'volumedown'],
  VolumeUp: ['volup', 'volumeup'],
  InstantReplay: ['instantreplay', 'replay'],
  ChannelUp: ['chnext', 'channelup', 'chup', 'programup'],
  ChannelDown: ['chprev', 'channeldown', 'chdown', 'programdown'],
  Digit0: ['0', 'digit0', 'num0'],
  Digit1: ['1', 'digit1', 'num1'],
  Digit2: ['2', 'digit2', 'num2'],
  Digit3: ['3', 'digit3', 'num3'],
  Digit4: ['4', 'digit4', 'num4'],
  Digit5: ['5', 'digit5', 'num5'],
  Digit6: ['6', 'digit6', 'num6'],
  Digit7: ['7', 'digit7', 'num7'],
  Digit8: ['8', 'digit8', 'num8'],
  Digit9: ['9', 'digit9', 'num9'],
};

const canonicalByAlias = new Map();
Object.entries(aliases).forEach(([canonical, names]) => {
  names.forEach((name, priority) => canonicalByAlias.set(name, { canonical, priority }));
});

function parseHexLE(value) {
  return value.trim().split(/\s+/).reduce(
    (result, byte, index) => result + (parseInt(byte, 16) * (2 ** (index * 8))),
    0,
  );
}

function parseFile(filePath) {
  const blocks = fs.readFileSync(filePath, 'utf8').split(/^#\s*$/m);
  const selected = new Map();

  blocks.forEach((block) => {
    const fields = {};
    block.split(/\r?\n/).forEach((line) => {
      const separator = line.indexOf(':');
      if (separator > 0) {
        fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
      }
    });

    if (!fields.name || !fields.type) return;
    const match = canonicalByAlias.get(normalize(fields.name));
    if (!match) return;

    let signal = null;
    if (fields.type === 'raw' && fields.frequency && fields.data) {
      signal = {
        type: 'raw',
        frequency: Number(fields.frequency),
        data: fields.data.split(/\s+/).map(Number).filter(Number.isFinite),
      };
    } else if (
      fields.type === 'parsed' && fields.protocol && fields.address && fields.command
    ) {
      signal = {
        type: 'parsed',
        protocol: fields.protocol,
        address: parseHexLE(fields.address),
        command: parseHexLE(fields.command),
      };
    }

    if (!signal || (signal.type === 'raw' && signal.data.length < 2)) return;
    const previous = selected.get(match.canonical);
    if (!previous || match.priority < previous.priority) {
      selected.set(match.canonical, { priority: match.priority, signal });
    }
  });

  return Object.fromEntries(
    [...selected.entries()].map(([key, value]) => [key, value.signal]),
  );
}

const brands = fs.readdirSync(tvRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }))
  .map((brandEntry) => {
    const brandPath = path.join(tvRoot, brandEntry.name);
    const remotes = fs.readdirSync(brandPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.ir'))
      .sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }))
      .map((entry) => {
        const commands = parseFile(path.join(brandPath, entry.name));
        if (!Object.keys(commands).length) return null;
        return {
          id: `${brandEntry.name}/${entry.name}`,
          name: path.basename(entry.name, '.ir').replace(/_/g, ' '),
          commands,
        };
      })
      .filter(Boolean);

    if (!remotes.length) return null;
    return { id: brandEntry.name, name: brandEntry.name.replace(/_/g, ' '), remotes };
  })
  .filter(Boolean);

const catalog = {
  meta: {
    source: 'Lucaslhm/Flipper-IRDB',
    revision: 'd126fb1b6f1e114c52b4a8c19839ea65e3a9c24d',
    license: 'CC0-1.0',
  },
  brands,
};

fs.writeFileSync(outputPath, `${JSON.stringify(catalog)}\n`);
const remoteCount = brands.reduce((total, brand) => total + brand.remotes.length, 0);
console.log(`Catálogo generado: ${brands.length} marcas, ${remoteCount} controles.`);
