import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import notificationPolicy from '../utils/notificationPolicy';

const { notificationActionFromResponse, notificationResponseKey } = notificationPolicy;

export const TV_STATUS_CHANNEL_ID = 'tv-status';
export const WIFI_CATEGORY_ID = 'wifi_actions';
export const OPEN_WIFI_ACTION_ID = 'open_wifi';
const PERMISSION_REQUESTED_KEY = 'notifications_permission_requested_v1';
const handledResponseKeys = new Set();
let initializationPromise = null;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
  handleError: (notificationId, error) => {
    console.warn('No se pudo presentar la notificación:', { notificationId, error });
  },
});

async function configureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(TV_STATUS_CHANNEL_ID, {
    name: 'Estado de TV',
    description: 'Conexión de la TV y avisos de red local de onn Remote.',
    importance: Notifications.AndroidImportance.DEFAULT,
    enableVibrate: true,
    vibrationPattern: [0, 120],
    sound: null,
    showBadge: false,
  });
}

async function configureNotificationCategories() {
  await Notifications.setNotificationCategoryAsync(WIFI_CATEGORY_ID, [
    {
      identifier: OPEN_WIFI_ACTION_ID,
      buttonTitle: 'Abrir Wi-Fi',
      options: {
        opensAppToForeground: true,
        isAuthenticationRequired: false,
        isDestructive: false,
      },
    },
  ]);
}

export async function getNotificationPermissionStatus() {
  try {
    return (await Notifications.getPermissionsAsync()).status;
  } catch (error) {
    console.warn('No se pudo consultar el permiso de notificaciones:', error);
    return 'unavailable';
  }
}

export async function requestNotificationPermission({ force = false } = {}) {
  try {
    await configureAndroidChannel();
    const existing = await Notifications.getPermissionsAsync();
    if (existing.status === 'granted' || existing.status === 'denied') return existing.status;

    const alreadyRequested = await AsyncStorage.getItem(PERMISSION_REQUESTED_KEY);
    if (!force && alreadyRequested === 'true') return existing.status;

    await AsyncStorage.setItem(PERMISSION_REQUESTED_KEY, 'true');
    return (await Notifications.requestPermissionsAsync()).status;
  } catch (error) {
    console.warn('No se pudo solicitar el permiso de notificaciones:', error);
    return 'unavailable';
  }
}

export function initializeNotifications() {
  if (initializationPromise) return initializationPromise;
  initializationPromise = (async () => {
    try {
      await configureAndroidChannel();
      await configureNotificationCategories();
      return await requestNotificationPermission();
    } catch (error) {
      console.warn('No se pudo inicializar el sistema de notificaciones:', error);
      return 'unavailable';
    }
  })();
  return initializationPromise;
}

async function showLocalNotification({ title, body, action = 'remote', categoryIdentifier }) {
  try {
    await initializeNotifications();
    if (await getNotificationPermissionStatus() !== 'granted') return null;
    return await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: { action },
        categoryIdentifier,
      },
      trigger: Platform.OS === 'android' ? { channelId: TV_STATUS_CHANNEL_ID } : null,
    });
  } catch (error) {
    console.warn('No se pudo mostrar la notificación local:', error);
    return null;
  }
}

export function showTvConnectionNotification(event, deviceLabel) {
  if (event === 'reconnected') {
    return showLocalNotification({
      title: '📺 TV encontrada',
      body: `${deviceLabel || 'Tu TV'} se reconectó automáticamente.`,
    });
  }
  return showLocalNotification({
    title: `📺 ${deviceLabel || 'TV'} conectada`,
    body: `${deviceLabel || 'Tu TV'} se conectó correctamente.`,
  });
}

export function showTvDisconnectedNotification(deviceLabel) {
  return showLocalNotification({
    title: '⚠️ TV desconectada',
    body: `Se perdió la conexión con ${deviceLabel || 'tu TV'}.`,
    action: 'wifi',
    categoryIdentifier: WIFI_CATEGORY_ID,
  });
}

export function showWifiRequiredNotification() {
  return showLocalNotification({
    title: '📶 Conexión Wi-Fi requerida',
    body: 'Conéctate a la misma red Wi-Fi que tu TV.',
    action: 'wifi',
    categoryIdentifier: WIFI_CATEGORY_ID,
  });
}

export function addNotificationResponseListener(listener) {
  return Notifications.addNotificationResponseReceivedListener(listener);
}

export function getInitialNotificationResponse() {
  return Notifications.getLastNotificationResponseAsync();
}

export async function clearInitialNotificationResponse() {
  try {
    await Notifications.clearLastNotificationResponseAsync();
  } catch (error) {
    console.warn('No se pudo limpiar la acción de notificación procesada:', error);
  }
}

export function consumeNotificationAction(response) {
  const responseKey = notificationResponseKey(response);
  if (responseKey && handledResponseKeys.has(responseKey)) return null;
  const action = notificationActionFromResponse(response);
  if (!action) return null;
  if (responseKey) handledResponseKeys.add(responseKey);
  return action;
}

export async function getExpoPushTokenIfConfigured() {
  try {
    if (!Device.isDevice) return { ok: false, reason: 'physical_device_required' };
    if (await getNotificationPermissionStatus() !== 'granted') {
      return { ok: false, reason: 'permission_not_granted' };
    }
    const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
    if (!projectId) return { ok: false, reason: 'missing_project_id' };
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return { ok: true, token: token.data, projectId };
  } catch (error) {
    console.warn('No se pudo obtener el Expo Push Token:', error);
    return { ok: false, reason: 'token_error', error };
  }
}
