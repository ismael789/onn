import roku from './roku';
import samsung from './samsung';
import lg, { defaultPort as lgPort, lgCapabilities } from './lg';
import sony from './sony';
import androidtv from './androidtv';
import remoteStability from '../utils/remoteStability';

const { orderIpCandidates } = remoteStability;

export const adapters = { roku, samsung, lg, sony, androidtv };
export const getAdapter = (type) => adapters[type] || null;

const DEFAULT_SCAN_CONCURRENCY = 18;

function uniqueIps(ips) {
  return [...new Set(ips.filter(Boolean))];
}

function subnetCandidates(prefix) {
  return Array.from({ length: 254 }, (_, index) => `${prefix}.${index + 1}`);
}

async function scanIps(ips, preferredType, onProgress, options = {}) {
  const candidates = uniqueIps(ips);
  const found = [];
  let nextIndex = 0;
  let stopped = false;
  const concurrency = Math.min(
    Math.max(1, options.concurrency || DEFAULT_SCAN_CONCURRENCY),
    Math.max(1, candidates.length),
  );

  const worker = async () => {
    while (!stopped && nextIndex < candidates.length) {
      const ip = candidates[nextIndex++];
      const device = await probeIp(ip, preferredType, { timeoutMs: options.timeoutMs });
      if (!device) continue;
      if (!found.some((item) => item.id === device.id || (item.ip === device.ip && item.type === device.type))) {
        found.push(device);
        onProgress?.([...found]);
        if (options.stopWhen?.(device)) stopped = true;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return found;
}

export function createManualDevice(ip, type) {
  if (type === 'lg') {
    return { id: `lg:${ip}`, name: 'LG webOS TV', model: '', type: 'lg', brand: 'LG', os: 'webOS', ip, port: lgPort, capabilities: lgCapabilities, auth: { state: 'required', token: null } };
  }
  return null;
}

export async function probeIp(ip, preferredType = 'auto', options = {}) {
  if (preferredType === 'lg') return createManualDevice(ip, 'lg');
  const selected = preferredType === 'auto' ? [roku, samsung, sony] : [getAdapter(preferredType)].filter(Boolean);
  const results = await Promise.all(selected.map((adapter) => adapter.probe(ip, options)));
  return results.find(Boolean) || null;
}

export async function scanNearby(prefix, lastIp, preferredType = 'auto', onProgress, options = {}) {
  const lastOctet = Number.parseInt(String(lastIp).split('.').pop(), 10);
  if (!Number.isInteger(lastOctet) || lastOctet < 1 || lastOctet > 254) return [];
  const radius = options.radius || 14;
  const nearby = [];
  for (let distance = 1; distance <= radius; distance += 1) {
    if (lastOctet - distance >= 1) nearby.push(`${prefix}.${lastOctet - distance}`);
    if (lastOctet + distance <= 254) nearby.push(`${prefix}.${lastOctet + distance}`);
  }
  return scanIps(nearby, preferredType, onProgress, {
    concurrency: options.concurrency || 28,
    timeoutMs: options.timeoutMs || 900,
    stopWhen: options.stopWhen,
  });
}

export async function scanSubnet(prefix, onProgress, options = {}) {
  const excluded = new Set(options.excludeIps || []);
  const candidates = orderIpCandidates(
    subnetCandidates(prefix).filter((ip) => !excluded.has(ip)),
    options.anchorIp,
    options.priorityIps,
  );

  if (!options.preferredType || options.preferredType === 'auto') {
    const combined = [];
    const mergeProgress = (devices) => {
      devices.forEach((device) => {
        if (!combined.some((item) => item.id === device.id || (item.ip === device.ip && item.type === device.type))) {
          combined.push(device);
        }
      });
      onProgress?.([...combined]);
    };
    await Promise.all([
      scanIps(candidates, 'roku', mergeProgress, {
        concurrency: options.rokuConcurrency || 18,
        timeoutMs: options.rokuTimeoutMs || 1800,
      }),
      scanIps(candidates, 'samsung', mergeProgress, {
        concurrency: options.samsungConcurrency || 12,
        timeoutMs: options.samsungTimeoutMs || 2000,
      }),
      scanIps(candidates, 'sony', mergeProgress, {
        concurrency: options.sonyConcurrency || 10,
        timeoutMs: options.sonyTimeoutMs || 1800,
      }),
    ]);
    return combined;
  }

  return scanIps(candidates, options.preferredType || 'auto', onProgress, {
    concurrency: options.concurrency || DEFAULT_SCAN_CONCURRENCY,
    timeoutMs: options.timeoutMs || 2000,
    stopWhen: options.stopWhen,
  });
}
