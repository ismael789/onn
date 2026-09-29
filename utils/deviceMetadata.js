const KNOWN_DEVICE_TYPES = new Set([
  'roku', 'samsung', 'lg', 'sony', 'androidtv', 'firetv', 'vidaa', 'vizio', 'unknown',
]);

const TYPE_LABELS = {
  roku: 'Roku OS / ECP',
  samsung: 'Samsung Tizen',
  lg: 'LG webOS',
  sony: 'Sony Bravia IP Control',
  androidtv: 'Android TV / Google TV',
  firetv: 'Fire TV',
  vidaa: 'VIDAA',
  vizio: 'Vizio SmartCast',
  unknown: 'Sistema desconocido',
};

const BRAND_NAMES = {
  onn: 'onn',
  tcl: 'TCL',
  hisense: 'Hisense',
  sharp: 'Sharp',
  philips: 'Philips',
  rca: 'RCA',
  roku: 'Roku',
  samsung: 'Samsung',
  lg: 'LG',
  sony: 'Sony',
  vizio: 'Vizio',
  insignia: 'Insignia',
  jvc: 'JVC',
  element: 'Element',
  westinghouse: 'Westinghouse',
};

function decodeXml(value = '') {
  return String(value).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function xmlText(xml, tag) {
  const value = String(xml || '').match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'))?.[1] || '';
  return decodeXml(value.trim());
}

function normalizeBrand(value, fallback = 'Desconocida') {
  const cleaned = String(value || '').trim();
  if (!cleaned) return fallback;
  return BRAND_NAMES[cleaned.toLowerCase()] || cleaned;
}

function inferRokuBrand(values) {
  const candidates = values.map((value) => String(value || '').trim()).filter(Boolean);
  const explicit = candidates.slice(0, 2).find((value) => !value.toLowerCase().includes('roku'));
  if (explicit) return normalizeBrand(explicit, 'Roku');
  const searchable = candidates.join(' ').toLowerCase();
  const detected = Object.keys(BRAND_NAMES).find((brand) => brand !== 'roku' && searchable.includes(brand));
  return detected ? BRAND_NAMES[detected] : normalizeBrand(candidates[0], 'Roku');
}

function parseRokuDeviceInfo(xml, ip = '') {
  const userName = xmlText(xml, 'user-device-name');
  const friendlyName = xmlText(xml, 'friendly-device-name');
  const model = xmlText(xml, 'model-name');
  const manufacturer = xmlText(xml, 'manufacturer');
  const vendor = xmlText(xml, 'vendor-name');
  return {
    id: `roku:${xmlText(xml, 'device-id') || xmlText(xml, 'serial-number') || ip}`,
    name: userName || friendlyName || model || 'Roku TV',
    brand: inferRokuBrand([manufacturer, vendor, userName, friendlyName, model]),
    manufacturer: manufacturer || vendor || '',
    model,
    modelNumber: xmlText(xml, 'model-number'),
    serialNumber: xmlText(xml, 'serial-number'),
    softwareVersion: xmlText(xml, 'software-version'),
  };
}

function protocolLabel(type) {
  return TYPE_LABELS[type] || TYPE_LABELS.unknown;
}

function normalizeDeviceMetadata(device) {
  if (!device || typeof device !== 'object') return device;
  const type = KNOWN_DEVICE_TYPES.has(device.type) ? device.type : 'unknown';
  const fallbackBrands = { roku: 'Roku', samsung: 'Samsung', lg: 'LG', sony: 'Sony' };
  return {
    ...device,
    type,
    brand: normalizeBrand(device.brand, fallbackBrands[type] || 'Desconocida'),
  };
}

function deviceTitle(device) {
  const normalized = normalizeDeviceMetadata(device);
  if (!normalized) return 'TV desconocida';
  const brand = normalized.brand === 'Desconocida' ? '' : `${normalized.brand} `;
  if (normalized.type === 'roku') {
    return normalized.brand.toLowerCase().includes('roku') ? 'Roku TV' : `${brand}Roku TV`.trim();
  }
  if (normalized.type === 'samsung') return 'Samsung Tizen';
  if (normalized.type === 'lg') return 'LG webOS';
  if (normalized.type === 'sony') return 'Sony Bravia';
  if (normalized.type === 'androidtv') return `${brand}Android/Google TV`.trim();
  if (normalized.type === 'firetv') return `${brand}Fire TV`.trim();
  if (normalized.type === 'vidaa') return `${brand}VIDAA`.trim();
  if (normalized.type === 'vizio') return `${brand}Vizio SmartCast`.trim();
  return normalized.name || 'TV desconocida';
}

module.exports = {
  KNOWN_DEVICE_TYPES,
  TYPE_LABELS,
  decodeXml,
  deviceTitle,
  normalizeBrand,
  normalizeDeviceMetadata,
  parseRokuDeviceInfo,
  protocolLabel,
};
