import roku from './roku';
import samsung from './samsung';
import lg, { defaultPort as lgPort, lgCapabilities } from './lg';

export const adapters = { roku, samsung, lg };
export const getAdapter = (type) => adapters[type] || null;

export function createManualDevice(ip, type) {
  if (type === 'lg') {
    return { id: `lg:${ip}`, name: 'LG webOS TV', model: '', type: 'lg', brand: 'lg', ip, port: lgPort, capabilities: lgCapabilities, auth: { state: 'required', token: null } };
  }
  return null;
}

export async function probeIp(ip, preferredType = 'auto') {
  if (preferredType === 'lg') return createManualDevice(ip, 'lg');
  const selected = preferredType === 'auto' ? [roku, samsung] : [getAdapter(preferredType)].filter(Boolean);
  const results = await Promise.all(selected.map((adapter) => adapter.probe(ip)));
  return results.find(Boolean) || null;
}

export async function scanSubnet(prefix, onProgress) {
  const candidates = Array.from({ length: 254 }, (_, index) => `${prefix}.${index + 1}`);
  const found = [];
  const batchSize = 24;
  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = candidates.slice(index, index + batchSize);
    const results = await Promise.all(batch.map((ip) => probeIp(ip)));
    results.filter(Boolean).forEach((device) => {
      if (!found.some((item) => item.id === device.id || (item.ip === device.ip && item.type === device.type))) found.push(device);
    });
    onProgress?.(found);
  }
  return found;
}
