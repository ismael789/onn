import { Linking, Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';

export async function abrirConfiguracionWifi() {
  if (Platform.OS !== 'android') return false;
  try {
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.WIFI_SETTINGS);
    return true;
  } catch (error) {
    console.warn('No se pudo abrir la configuración Wi-Fi:', error);
    return false;
  }
}

export async function abrirConfiguracionApp() {
  try {
    await Linking.openSettings();
    return true;
  } catch (error) {
    console.warn('No se pudo abrir la configuración de onn Remote:', error);
    return false;
  }
}
