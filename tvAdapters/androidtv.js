import { capabilities, connectionError, CONNECTION_ERROR_CODES, unsupported } from './common';

export const type = 'androidtv';
export const label = 'Android TV / Google TV';
export const defaultPort = null;
export const androidTvCapabilities = capabilities({});

// Placeholder intencional: Google Cast controla sesiones multimedia, pero no
// reemplaza el mando completo. El protocolo de mando requiere integración
// nativa y un APK personalizado; no se anuncia soporte incompleto en Expo Go.
export async function probe() { return null; }
export async function connect() {
  throw connectionError(
    CONNECTION_ERROR_CODES.UNSUPPORTED,
    'Android TV / Google TV requiere una integración nativa de emparejamiento y control remoto.',
  );
}
export function disconnect() {}
export async function sendKey(_device, key) { unsupported(key); }
export async function tuneChannel() { unsupported('Canal directo'); }
export async function loadApps() { unsupported('Lista de aplicaciones'); }
export async function launchApp() { unsupported('Abrir aplicaciones'); }
export function getAppIcon() { return null; }
export async function diagnose() { return connect(); }

export const adapter = {
  type, label, probe, connect, disconnect, sendKey, tuneChannel,
  loadApps, launchApp, getAppIcon, diagnose,
};
export default adapter;
