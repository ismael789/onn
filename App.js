import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  Modal,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
  Image,
  Switch,
  Vibration,
  AppState,
} from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Network from 'expo-network';
import { Ionicons, MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import LuzInfrarojaScreen from './luz_infraroja';
import { createManualDevice, getAdapter, probeIp, scanNearby, scanSubnet } from './tvAdapters';
import {
  connectionError,
  CONNECTION_ERROR_CODES,
  isRetryableConnectionError,
  normalizeConnectionError,
} from './tvAdapters/common';
import remoteStability from './utils/remoteStability';
import deviceMetadata from './utils/deviceMetadata';
import notificationPolicy from './utils/notificationPolicy';
import { abrirConfiguracionApp, abrirConfiguracionWifi } from './services/androidIntents';
import {
  addNotificationResponseListener,
  clearInitialNotificationResponse,
  consumeNotificationAction,
  getExpoPushTokenIfConfigured,
  getInitialNotificationResponse,
  getNotificationPermissionStatus,
  initializeNotifications,
  requestNotificationPermission,
  showTvConnectionNotification,
  showTvDisconnectedNotification,
  showWifiRequiredNotification,
} from './services/notifications';

const {
  clearCommandQueue,
  createQueueState,
  enableCommandQueue,
  enqueueCommand,
  executeWithTransientRetry,
  normalizeTemplateType,
  sanitizeShortcutPreferences,
} = remoteStability;
const { deviceTitle, normalizeDeviceMetadata, protocolLabel } = deviceMetadata;
const { createConnectionNotificationPolicy } = notificationPolicy;

const LEGACY_STORAGE_KEY = 'onn_tv_ip';
const DEVICE_STORAGE_KEY = 'connected_tv_device_v2';
const VIBRATION_STORAGE_KEY = 'button_vibration_enabled';
const VIBRATION_LEVEL_STORAGE_KEY = 'button_vibration_level';
const ACTIVE_TEMPLATE_STORAGE_KEY = 'active_wifi_remote_template_v1';
const SHORTCUTS_STORAGE_KEY = 'wifi_remote_shortcuts_by_type_v1';
const PURPLE = '#8b5cf6';
const PURPLE_DARK = '#6d28d9';
const BG = '#0f0f14';
const PANEL = '#1a1a22';
const PANEL_2 = '#232330';
const MAX_COMMAND_QUEUE_SIZE = 40;
const TRANSIENT_COMMAND_RETRY_DELAY_MS = 140;
const TV_TYPE_LABELS = {
  roku: 'Roku OS', samsung: 'Samsung Tizen', lg: 'LG webOS', sony: 'Sony Bravia',
  androidtv: 'Android/Google TV', firetv: 'Fire TV', vidaa: 'VIDAA',
  vizio: 'Vizio SmartCast', unknown: 'Desconocido',
};
const NETWORK_ISOLATION_MESSAGE =
  'Comprueba que el teléfono y la TV estén en la misma red local. Las redes de invitados, AP isolation o el aislamiento entre bandas pueden impedir la conexión.';
const VIBRATION_LEVELS = {
  suave: 25,
  media: 45,
  fuerte: 75,
};
const DEFAULT_REMOTE_APP_SHORTCUTS = [
  { key: 'netflix', label: 'Netflix', aliases: ['netflix'] },
  { key: 'youtube', label: 'YouTube', aliases: ['youtube'] },
  {
    key: 'crunchyroll',
    label: 'Crunchyroll',
    aliases: ['crunchyroll'],
  },
];
const DEFAULT_SHORTCUTS_BY_TYPE = {
  roku: DEFAULT_REMOTE_APP_SHORTCUTS,
  lg: DEFAULT_REMOTE_APP_SHORTCUTS,
  samsung: [],
};

function findShortcutApp(apps, aliases) {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  return (
    apps.find((app) => normalizedAliases.includes(app.name.toLowerCase())) ||
    apps.find((app) =>
      normalizedAliases.some((alias) => app.name.toLowerCase().includes(alias))
    )
  );
}

function resolveShortcutApp(apps, shortcut) {
  if (shortcut.appId) {
    const byId = apps.find((app) => String(app.id) === String(shortcut.appId));
    if (byId) return byId;
  }
  return findShortcutApp(apps, shortcut.aliases || [shortcut.label || shortcut.key]);
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function localSubnetPrefix(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) return null;
  return parts.slice(0, 3).join('.');
}

function nearbySubnetIps(prefix, anchorIp, radius = 18) {
  const lastOctet = Number.parseInt(String(anchorIp || '').split('.').pop(), 10);
  if (!prefix || !Number.isInteger(lastOctet)) return [];
  const ips = [];
  for (let distance = 1; distance <= radius; distance += 1) {
    if (lastOctet - distance >= 1) ips.push(`${prefix}.${lastOctet - distance}`);
    if (lastOctet + distance <= 254) ips.push(`${prefix}.${lastOctet + distance}`);
  }
  return ips;
}

function isSameSavedTv(candidate, savedDevice) {
  if (!candidate || candidate.type !== savedDevice.type) return false;
  if (candidate.id && savedDevice.id && candidate.id === savedDevice.id) return true;
  const sameModel = candidate.model && savedDevice.model && candidate.model === savedDevice.model;
  const sameName = candidate.name && savedDevice.name && candidate.name === savedDevice.name;
  return !!(sameModel && sameName);
}

export default function App() {
  const [tvIp, setTvIp] = useState('');
  const [tvName, setTvName] = useState('');
  const [connectedDevice, setConnectedDevice] = useState(null);
  const [inputIp, setInputIp] = useState('');
  const [connectionView, setConnectionView] = useState('automatic');
  const [scanning, setScanning] = useState(false);
  const [foundDevices, setFoundDevices] = useState([]);
  const [connected, setConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [pairingState, setPairingState] = useState('idle');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('mando'); // mando (WiFi) | infrarrojo | numero | apps | ajustes
  const [mandoView, setMandoView] = useState('remote'); // remote | inputs
  const [channelNumber, setChannelNumber] = useState('');
  const [installedApps, setInstalledApps] = useState([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appsError, setAppsError] = useState('');
  const [failedAppIcons, setFailedAppIcons] = useState({});
  const [buttonVibrationEnabled, setButtonVibrationEnabled] = useState(false);
  const [buttonVibrationLevel, setButtonVibrationLevel] = useState('media');
  const [remoteTemplateType, setRemoteTemplateType] = useState('roku');
  const [shortcutPreferences, setShortcutPreferences] = useState({});
  const [diagnosticRunning, setDiagnosticRunning] = useState(false);
  const [diagnosticResult, setDiagnosticResult] = useState(null);
  const [notificationPermission, setNotificationPermission] = useState('unknown');
  const vibrationDuration = VIBRATION_LEVELS[buttonVibrationLevel];
  const tvCapabilities = connectedDevice?.capabilities || {};
  const activeTemplateType = normalizeTemplateType(connectedDevice?.type || remoteTemplateType);
  const activeShortcutSelections = Object.prototype.hasOwnProperty.call(shortcutPreferences, activeTemplateType)
    ? shortcutPreferences[activeTemplateType]
    : (DEFAULT_SHORTCUTS_BY_TYPE[activeTemplateType] || []);
  const connectedDeviceRef = useRef(null);
  const connectedRef = useRef(false);
  const recoveryPromiseRef = useRef(null);
  const commandReconnectPromiseRef = useRef(null);
  const lastNetworkIpRef = useRef(null);
  const networkEventSeenRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const lastControlModeRef = useRef('wifi');
  const commandQueueStateRef = useRef(createQueueState());
  const commandReconnectEnabledRef = useRef(true);
  const lastErrorAlertRef = useRef({ signature: '', shownAt: 0 });
  const activeScanIdRef = useRef(0);
  const connectionNotificationPolicyRef = useRef(createConnectionNotificationPolicy());

  const persistDevice = useCallback(async (device) => {
    const normalized = normalizeDeviceMetadata(device);
    await AsyncStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(normalized));
    await AsyncStorage.setItem(LEGACY_STORAGE_KEY, normalized.ip);
  }, []);

  const connectDevice = useCallback(async (
    device,
    { automatic = false, reconnecting = false, recovered = false } = {},
  ) => {
    const adapter = getAdapter(device?.type);
    if (!adapter) throw new Error('Tipo de TV no compatible.');
    setConnectionStatus('connecting');
    setPairingState(device.capabilities?.pairingRequired ? 'waiting' : 'not_required');
    setConnectionMessage(
      reconnecting
        ? 'Reconectando…'
        : device.type === 'sony' && device.auth?.state === 'required'
          ? 'Revisa Control IP y Autenticación en tu Sony Bravia.'
        : device.capabilities?.pairingRequired
          ? 'Autoriza onn Remote en la pantalla de tu TV.'
          : 'Conectando…',
    );
    try {
      const connectedTv = normalizeDeviceMetadata(await adapter.connect(device, {
        onPairingState: setPairingState,
        onAuth: (auth) => {
          const updated = { ...device, auth };
          connectedDeviceRef.current = updated;
          setConnectedDevice(updated);
          setRemoteTemplateType(normalizeTemplateType(updated.type));
          persistDevice(updated).catch(() => {});
        },
      }));
      connectedDeviceRef.current = connectedTv;
      connectedRef.current = true;
      commandReconnectEnabledRef.current = true;
      setConnectedDevice(connectedTv);
      const connectedTemplate = normalizeTemplateType(connectedTv.type);
      setRemoteTemplateType(connectedTemplate);
      enableCommandQueue(commandQueueStateRef.current);
      setTvIp(connectedTv.ip);
      setInputIp(connectedTv.ip);
      setTvName(connectedTv.name);
      setConnected(true);
      setConnectionStatus('connected');
      setPairingState(connectedTv.auth?.state || 'not_required');
      setConnectionMessage(automatic ? 'Conectada automáticamente' : 'TV conectada');
      setInstalledApps([]);
      setAppsError('');
      setDiagnosticResult(null);
      await Promise.all([
        persistDevice(connectedTv),
        AsyncStorage.setItem(ACTIVE_TEMPLATE_STORAGE_KEY, connectedTemplate),
      ]);
      const stateNotificationEvent = connectionNotificationPolicyRef.current.markConnected();
      const notificationEvent = recovered ? 'reconnected' : stateNotificationEvent;
      if (notificationEvent) {
        showTvConnectionNotification(notificationEvent, deviceTitle(connectedTv)).catch((error) => {
          console.warn('No se pudo notificar la conexión de la TV:', error);
        });
      }
      return connectedTv;
    } catch (error) {
      connectedRef.current = false;
      setConnected(false);
      setConnectionStatus('error');
      setConnectionMessage(error.message || String(error));
      throw error;
    }
  }, [persistDevice]);

  const restoreSavedDevice = useCallback(async (device) => {
    try {
      await connectDevice(device, { automatic: true });
      return connectedDeviceRef.current;
    } catch (_) {}

    setConnectionStatus('searching');
    setConnectionMessage('Buscando TV…');

    // LG no expone una consulta HTTP segura para reconocerla sin abrir avisos
    // de emparejamiento en cada dirección; conserva la conexión manual por IP.
    if (device.type === 'lg') {
      setConnectionStatus('error');
      setConnectionMessage(`No se encontró la TV. ${NETWORK_ISOLATION_MESSAGE}`);
      return null;
    }

    try {
      const myIp = await Network.getIpAddressAsync();
      lastNetworkIpRef.current = myIp;
      const prefix = localSubnetPrefix(myIp);
      if (!prefix) throw new Error('Sin conexión Wi‑Fi local.');

      const stopWhenSavedTvAppears = (candidate) => isSameSavedTv(candidate, device);
      const nearby = await scanNearby(prefix, device.ip, device.type, undefined, {
        stopWhen: stopWhenSavedTvAppears,
      });
      let moved = nearby.find((item) => isSameSavedTv(item, device));
      if (!moved) {
        const devices = await scanSubnet(prefix, undefined, {
          preferredType: device.type,
          excludeIps: [device.ip],
          stopWhen: stopWhenSavedTvAppears,
          anchorIp: myIp,
        });
        moved = devices.find((item) => isSameSavedTv(item, device));
      }
      if (moved) {
        return connectDevice(
          { ...moved, auth: device.auth },
          { automatic: true, reconnecting: true, recovered: true },
        );
      }
    } catch (error) {
      console.warn('No se pudo localizar la TV guardada:', error);
    }

    connectedRef.current = false;
    setConnected(false);
    setConnectionStatus('error');
    setConnectionMessage(`No se encontró la TV. ${NETWORK_ISOLATION_MESSAGE}`);
    const disconnectEvent = connectionNotificationPolicyRef.current.markDisconnected();
    if (disconnectEvent) {
      showTvDisconnectedNotification(deviceTitle(device)).catch((error) => {
        console.warn('No se pudo notificar la desconexión confirmada:', error);
      });
    }
    return null;
  }, [connectDevice]);

  const recoverSavedDevice = useCallback((device) => {
    if (!device) return Promise.resolve(null);
    if (recoveryPromiseRef.current) return recoveryPromiseRef.current;
    const recovery = restoreSavedDevice(device).finally(() => {
      if (recoveryPromiseRef.current === recovery) recoveryPromiseRef.current = null;
    });
    recoveryPromiseRef.current = recovery;
    return recovery;
  }, [restoreSavedDevice]);

  useEffect(() => {
    let active = true;
    const handleNotificationResponse = async (response) => {
      const action = consumeNotificationAction(response);
      if (!action) return;
      if (action === 'wifi') {
        await abrirConfiguracionWifi();
      } else if (action === 'settings') {
        setActiveTab('ajustes');
      } else if (action === 'remote') {
        setActiveTab('mando');
      } else if (action === 'devices') {
        setActiveTab('mando');
        setConnectionView('automatic');
        setConnectModalOpen(true);
      }
    };

    const responseSubscription = addNotificationResponseListener((response) => {
      handleNotificationResponse(response).catch((error) => {
        console.warn('No se pudo procesar la acción de notificación:', error);
      });
    });

    (async () => {
      const permission = await initializeNotifications();
      if (active) setNotificationPermission(permission);

      const initialResponse = await getInitialNotificationResponse().catch((error) => {
        console.warn('No se pudo leer la notificación inicial:', error);
        return null;
      });
      if (active && initialResponse) {
        await handleNotificationResponse(initialResponse);
        await clearInitialNotificationResponse();
      }

      const pushResult = await getExpoPushTokenIfConfigured();
      if (pushResult.ok) console.info('Expo Push Token disponible para configuración remota.');
    })().catch((error) => {
      console.warn('Falló la preparación de notificaciones:', error);
    });

    return () => {
      active = false;
      responseSubscription.remove();
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [savedVibration, savedVibrationLevel, savedDeviceJson, legacyIp, savedTemplate, savedShortcuts] = await Promise.all([
          AsyncStorage.getItem(VIBRATION_STORAGE_KEY),
          AsyncStorage.getItem(VIBRATION_LEVEL_STORAGE_KEY),
          AsyncStorage.getItem(DEVICE_STORAGE_KEY),
          AsyncStorage.getItem(LEGACY_STORAGE_KEY),
          AsyncStorage.getItem(ACTIVE_TEMPLATE_STORAGE_KEY),
          AsyncStorage.getItem(SHORTCUTS_STORAGE_KEY),
        ]);

        setButtonVibrationEnabled(savedVibration === 'true');
        if (savedVibrationLevel && VIBRATION_LEVELS[savedVibrationLevel]) {
          setButtonVibrationLevel(savedVibrationLevel);
        }
        if (savedShortcuts) {
          try {
            const parsedShortcuts = JSON.parse(savedShortcuts);
            if (parsedShortcuts && typeof parsedShortcuts === 'object') {
              setShortcutPreferences(sanitizeShortcutPreferences(parsedShortcuts));
            }
          } catch (error) {
            console.warn('No se pudieron restaurar los accesos directos:', error);
          }
        }

        if (savedDeviceJson) {
          const savedDevice = normalizeDeviceMetadata(JSON.parse(savedDeviceJson));
          setRemoteTemplateType(normalizeTemplateType(savedDevice.type || savedTemplate));
          connectedDeviceRef.current = savedDevice;
          setConnectedDevice(savedDevice);
          setTvIp(savedDevice.ip);
          setInputIp(savedDevice.ip);
          setTvName(savedDevice.name || '');
          await recoverSavedDevice(savedDevice);
        } else if (legacyIp) {
          setRemoteTemplateType('roku');
          setInputIp(legacyIp);
          const legacyDevice = await probeIp(legacyIp, 'roku');
          if (legacyDevice) await connectDevice(legacyDevice, { automatic: true });
        } else setRemoteTemplateType('roku');
      } catch (error) {
        console.warn('No se pudo restaurar la configuración guardada:', error);
      }
    })();
  }, [connectDevice, recoverSavedDevice]);

  useEffect(() => {
    const subscription = Network.addNetworkStateListener(async (state) => {
      const isSubsequentNetworkEvent = networkEventSeenRef.current;
      networkEventSeenRef.current = true;
      if (state.isConnected === false) {
        const shouldNotifyWifi = connectionNotificationPolicyRef.current.markWifiUnavailable();
        const disconnectEvent = connectionNotificationPolicyRef.current.markDisconnected();
        if (disconnectEvent) {
          showTvDisconnectedNotification(deviceTitle(connectedDeviceRef.current)).catch((error) => {
            console.warn('No se pudo notificar la desconexión de la TV:', error);
          });
        } else if (shouldNotifyWifi) {
          showWifiRequiredNotification().catch((error) => {
            console.warn('No se pudo notificar la falta de Wi-Fi:', error);
          });
        }
        connectedRef.current = false;
        setConnected(false);
        setConnectionStatus('disconnected');
        setConnectionMessage('Sin conexión Wi‑Fi');
        return;
      }
      if (state.isConnected) {
        connectionNotificationPolicyRef.current.markWifiAvailable();
        const currentIp = await Network.getIpAddressAsync().catch(() => null);
        const networkChanged = !!lastNetworkIpRef.current && !!currentIp && lastNetworkIpRef.current !== currentIp;
        if (currentIp) lastNetworkIpRef.current = currentIp;
        const savedDevice = connectedDeviceRef.current;
        if (savedDevice && (isSubsequentNetworkEvent || networkChanged || !connectedRef.current)) {
          setConnectionMessage('Reconectando…');
          recoverSavedDevice(savedDevice).catch(() => {});
        }
      }
    });
    return () => subscription.remove();
  }, [recoverSavedDevice]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const wasInBackground = /inactive|background/.test(appStateRef.current);
      appStateRef.current = nextState;
      if (wasInBackground && nextState === 'active' && connectedDeviceRef.current) {
        setConnectionMessage('Reconectando…');
        recoverSavedDevice(connectedDeviceRef.current).catch(() => {});
      }
      if (nextState === 'active') {
        getNotificationPermissionStatus().then(setNotificationPermission).catch(() => {});
      }
    });
    return () => subscription.remove();
  }, [recoverSavedDevice]);

  useEffect(() => {
    if (activeTab === 'infrarrojo') lastControlModeRef.current = 'ir';
    if (['mando', 'numero', 'apps'].includes(activeTab)) lastControlModeRef.current = 'wifi';
  }, [activeTab]);

  const setButtonVibration = (enabled) => {
    setButtonVibrationEnabled(enabled);
    if (enabled) {
      Vibration.vibrate(vibrationDuration);
    }
    AsyncStorage.setItem(VIBRATION_STORAGE_KEY, String(enabled)).catch((error) => {
      console.warn('No se pudo guardar la preferencia de vibración:', error);
    });
  };

  const selectButtonVibrationLevel = (level) => {
    setButtonVibrationLevel(level);
    if (buttonVibrationEnabled) {
      Vibration.vibrate(VIBRATION_LEVELS[level]);
    }
    AsyncStorage.setItem(VIBRATION_LEVEL_STORAGE_KEY, level).catch((error) => {
      console.warn('No se pudo guardar el nivel de vibración:', error);
    });
  };

  const manageNotificationPermission = async () => {
    vibrateButton();
    if (['granted', 'denied'].includes(notificationPermission)) {
      await abrirConfiguracionApp();
      return;
    }
    const status = await requestNotificationPermission({ force: true });
    setNotificationPermission(status);
    if (status === 'denied') await abrirConfiguracionApp();
  };

  const showConnectionError = useCallback((title, error, context = {}) => {
    const normalized = normalizeConnectionError(error, context);
    console.warn(`${title}:`, {
      code: normalized.code,
      technicalMessage: normalized.technicalMessage,
      error,
    });
    const signature = `${title}:${normalized.code}`;
    const now = Date.now();
    if (lastErrorAlertRef.current.signature === signature && now - lastErrorAlertRef.current.shownAt < 3000) {
      return normalized;
    }
    lastErrorAlertRef.current = { signature, shownAt: now };
    Alert.alert(title, `${normalized.message}\n\n${normalized.cause}`);
    return normalized;
  }, []);

  const connectManual = async () => {
    if (!inputIp.trim()) return;
    activeScanIdRef.current += 1;
    setScanning(true);
    try {
      const ip = inputIp.trim();
      const detectedDevice = await probeIp(ip, 'auto');
      await connectDevice(detectedDevice || createManualDevice(ip, 'lg'));
      setConnectModalOpen(false);
    } catch (error) {
      showConnectionError('No se encontró la TV', error);
    } finally {
      setScanning(false);
    }
  };

  const scanDevices = useCallback(async () => {
    const scanId = activeScanIdRef.current + 1;
    activeScanIdRef.current = scanId;
    setScanning(true);
    setFoundDevices([]);
    setConnectionStatus('searching');
    setConnectionMessage('Buscando TV…');
    try {
      const myIp = await Network.getIpAddressAsync();
      console.log('Mi IP es:', myIp);
      if (!myIp || myIp === '0.0.0.0') {
        Alert.alert('Sin WiFi', 'Conecta el teléfono a la misma red WiFi que la TV.');
        if (connectionNotificationPolicyRef.current.markWifiUnavailable()) {
          showWifiRequiredNotification().catch((error) => {
            console.warn('No se pudo notificar la falta de Wi-Fi:', error);
          });
        }
        setConnectionStatus('error');
        setConnectionMessage('No se encontró la TV. Conecta el teléfono a la misma red local.');
        setScanning(false);
        return;
      }
      const prefix = localSubnetPrefix(myIp);
      if (!prefix) throw new Error('No se pudo identificar la red WiFi local.');

      const priorityIps = [...new Set([connectedDeviceRef.current?.ip, inputIp.trim()]
        .filter((ip) => ip && ip.startsWith(`${prefix}.`)))];
      const nearbyIps = nearbySubnetIps(prefix, myIp);
      let results = [];
      const publishResults = (devices, message = 'Buscando TV…') => {
        if (activeScanIdRef.current !== scanId) return;
        devices.forEach((device) => {
          if (!results.some((item) => item.id === device.id || (item.ip === device.ip && item.type === device.type))) {
            results.push(device);
          }
        });
        setFoundDevices([...results]);
        setConnectionMessage(results.length > 0
          ? `${results.length} TV${results.length === 1 ? '' : 's'} encontrada${results.length === 1 ? '' : 's'} · ${message}`
          : message);
      };

      // Etapa 1: prueba enseguida las direcciones conocidas antes de recorrer la red.
      if (priorityIps.length > 0) {
        setConnectionMessage('Probando la última TV…');
        const knownDevices = (await Promise.all(
          priorityIps.map((ip) => probeIp(ip, 'auto', { timeoutMs: 850 })),
        )).filter(Boolean);
        if (activeScanIdRef.current !== scanId) return;
        publishResults(knownDevices, 'búsqueda rápida…');
      }

      // Etapa 2: revisa primero los vecinos DHCP más probables de la IP del teléfono.
      const nearbyDevices = await scanNearby(prefix, myIp, 'auto', (devices) => {
        publishResults(devices, 'buscando cerca…');
      }, {
        radius: 18,
        concurrency: 30,
        timeoutMs: 950,
      });
      if (activeScanIdRef.current !== scanId) return;
      publishResults(nearbyDevices, 'buscando en toda la red…');

      // Etapa 3: completa la subred sin repetir las IP ya comprobadas.
      const remainingDevices = await scanSubnet(prefix, (devices) => {
        publishResults(devices, 'buscando en toda la red…');
      }, {
        anchorIp: myIp,
        excludeIps: [...priorityIps, ...nearbyIps, myIp],
        rokuConcurrency: 26,
        samsungConcurrency: 18,
        sonyConcurrency: 10,
        rokuTimeoutMs: 1400,
        samsungTimeoutMs: 1600,
        sonyTimeoutMs: 1700,
      });
      if (activeScanIdRef.current !== scanId) return;
      publishResults(remainingDevices);
      if (results.length === 0) {
        setConnectionStatus('error');
        setConnectionMessage(`No se encontró la TV. ${NETWORK_ISOLATION_MESSAGE}`);
        Alert.alert(
          'No se encontró ninguna TV',
          `En Roku/onn revisa Configuración > Sistema > Configuración avanzada > Control por aplicaciones móviles y permite el acceso. En Sony Bravia activa Control IP en los ajustes de red. También puedes usar Conexión manual y escribir la IP de cualquier TV compatible. ${NETWORK_ISOLATION_MESSAGE}`
        );
      } else {
        setConnectionMessage(`${results.length} TV${results.length === 1 ? '' : 's'} encontrada${results.length === 1 ? '' : 's'}`);
      }
    } catch (e) {
      if (activeScanIdRef.current !== scanId) return;
      setConnectionStatus('error');
      setConnectionMessage(`No se encontró la TV. ${NETWORK_ISOLATION_MESSAGE}`);
      showConnectionError('Error al escanear', e);
    }
    if (activeScanIdRef.current === scanId) setScanning(false);
  }, [inputIp, showConnectionError]);

  const selectDevice = async (device) => {
    activeScanIdRef.current += 1;
    setScanning(false);
    try {
      await connectDevice(device);
      setFoundDevices([]);
      setConnectModalOpen(false);
    } catch (error) {
      showConnectionError('No se pudo conectar', error);
    }
  };

  const executeWithReconnect = useCallback(async (operation, context = {}) => {
    const device = connectedDeviceRef.current;
    if (!device) throw new Error('No hay una TV conectada.');

    try {
      return await executeWithTransientRetry(
        () => operation(device),
        {
          shouldRetry: isRetryableConnectionError,
          delayMs: TRANSIENT_COMMAND_RETRY_DELAY_MS,
          onRetry: (error) => {
            const normalized = normalizeConnectionError(error);
            console.warn('Reintentando comando tras un fallo transitorio:', {
              type: device.type,
              ip: device.ip,
              command: context,
              code: normalized.code,
              technicalMessage: normalized.technicalMessage,
              queuedCommands: commandQueueStateRef.current.items.length,
            });
          },
        },
      );
    } catch (firstError) {
      if (!isRetryableConnectionError(firstError)) throw firstError;
      if (!commandReconnectEnabledRef.current) throw firstError;
      connectedRef.current = false;
      setConnected(false);
      setConnectionStatus('connecting');
      setConnectionMessage('Reconectando…');

      if (!commandReconnectPromiseRef.current) {
        const adapter = getAdapter(device.type);
        adapter?.disconnect(device);
        const reconnect = (async () => {
          await wait(250);
          return connectDevice(device, { automatic: true, reconnecting: true });
        })().finally(() => {
          if (commandReconnectPromiseRef.current === reconnect) commandReconnectPromiseRef.current = null;
        });
        commandReconnectPromiseRef.current = reconnect;
      }

      try {
        const reconnectedDevice = await commandReconnectPromiseRef.current;
        await wait(120);
        return await operation(reconnectedDevice);
      } catch (retryError) {
        const disconnectEvent = connectionNotificationPolicyRef.current.markDisconnected();
        if (disconnectEvent) {
          showTvDisconnectedNotification(deviceTitle(device)).catch((error) => {
            console.warn('No se pudo notificar la pérdida de conexión:', error);
          });
        }
        connectedRef.current = false;
        setConnected(false);
        setConnectionStatus('error');
        setConnectionMessage(`No se encontró la TV. ${NETWORK_ISOLATION_MESSAGE}`);
        throw retryError;
      }
    }
  }, [connectDevice]);

  const enqueueTvCommand = useCallback((operation, options = {}) => enqueueCommand(
    commandQueueStateRef.current,
    operation,
    executeWithReconnect,
    {
      maxSize: MAX_COMMAND_QUEUE_SIZE,
      delayMs: options.delayMs ?? 90,
      context: options.context,
    },
  ), [executeWithReconnect]);

  const commandDelayForKey = (deviceType, key) => {
    if (deviceType === 'samsung') return 65;
    if (deviceType === 'lg') return 110;
    if (['VolumeUp', 'VolumeDown', 'VolumeMute', 'ChannelUp', 'ChannelDown'].includes(key)) return 125;
    if (['Up', 'Down', 'Left', 'Right', 'Select', 'Back', 'Play', 'Rev', 'Fwd'].includes(key)) return 90;
    return 110;
  };

  const loadTvApps = useCallback(async () => {
    const device = connectedDeviceRef.current;
    if (!device) {
      setInstalledApps([]);
      setAppsError('Conecta una TV para consultar sus aplicaciones.');
      return [];
    }
    if (!device.capabilities?.installedApps) {
      setInstalledApps([]);
      setAppsError(`${device.name} no permite consultar sus aplicaciones mediante el protocolo disponible.`);
      return [];
    }

    setAppsLoading(true);
    setAppsError('');
    setFailedAppIcons({});
    try {
      const apps = await executeWithReconnect((activeDevice) =>
        getAdapter(activeDevice.type).loadApps(activeDevice, { onPairingState: setPairingState })
      );
      setInstalledApps(apps);
      if (apps.length === 0) {
        setAppsError('La TV no devolvió aplicaciones instaladas.');
      }
      return apps;
    } catch (error) {
      setInstalledApps([]);
      const normalized = normalizeConnectionError(error);
      if (normalized.code === CONNECTION_ERROR_CODES.PERMISSION_DENIED && device.type === 'roku') {
        setAppsError(
          'La Roku/onn bloqueó la consulta de aplicaciones. En la TV abre Configuración > Sistema > Configuración avanzada > Control por aplicaciones móviles > Acceso de red y selecciona Permisivo.',
        );
        console.info('Roku bloqueó query/apps:', normalized.technicalMessage);
      } else {
        setAppsError(`${normalized.message} ${normalized.cause}`);
        if (normalized.code === CONNECTION_ERROR_CODES.UNSUPPORTED) {
          console.info('Lista de aplicaciones no compatible:', normalized.technicalMessage);
        } else {
          console.warn('Error loadTvApps:', {
            code: normalized.code,
            technicalMessage: normalized.technicalMessage,
            error,
          });
        }
      }
      return [];
    } finally {
      setAppsLoading(false);
    }
  }, [executeWithReconnect]);

  useEffect(() => {
    const shouldLoadForRemote = ['mando', 'ajustes'].includes(activeTab)
      && connectedDevice?.capabilities?.installedApps
      && installedApps.length === 0;
    if (activeTab === 'apps' || shouldLoadForRemote) {
      loadTvApps();
    }
  }, [activeTab, installedApps.length, loadTvApps, connectedDevice]);

  const runConnectionDiagnostic = async () => {
    setDiagnosticRunning(true);
    const phoneIp = await Network.getIpAddressAsync().catch(() => null);
    const device = connectedDeviceRef.current;

    if (!device) {
      const usingIr = lastControlModeRef.current === 'ir';
      setDiagnosticResult({
        phoneIp: phoneIp || 'No disponible',
        tvIp: 'No aplica',
        brand: usingIr ? 'No aplica' : 'Sin detectar',
        protocol: usingIr ? 'Infrarrojo local' : 'Sin detectar',
        tvType: usingIr ? 'IR' : 'Sin detectar',
        port: 'No aplica',
        latencyMs: null,
        transport: usingIr ? 'Infrarrojo local' : 'No disponible',
        websocketState: 'No aplica',
        responding: null,
        message: usingIr ? 'El modo IR no utiliza conexión Wi‑Fi.' : 'Conecta una TV para ejecutar la prueba.',
        cause: usingIr ? 'No requiere router ni permisos de red.' : 'No hay una TV Wi‑Fi guardada.',
      });
      setDiagnosticRunning(false);
      return;
    }

    const phonePrefix = localSubnetPrefix(phoneIp);
    const tvPrefix = localSubnetPrefix(device.ip);
    const differentSubnet = !!phonePrefix && !!tvPrefix && phonePrefix !== tvPrefix;
    try {
      const adapter = getAdapter(device.type);
      if (!adapter?.diagnose) {
        throw connectionError(CONNECTION_ERROR_CODES.UNSUPPORTED, 'El adaptador no implementa diagnóstico.');
      }
      const result = await adapter.diagnose(device, {
        onPairingState: setPairingState,
        onAuth: (auth) => {
          const updated = { ...connectedDeviceRef.current, auth };
          connectedDeviceRef.current = updated;
          setConnectedDevice(updated);
          persistDevice(updated).catch(() => {});
        },
      });
      const diagnosedDevice = normalizeDeviceMetadata(result.device || device);
      connectedDeviceRef.current = diagnosedDevice;
      setConnectedDevice(diagnosedDevice);
      await persistDevice(diagnosedDevice);
      connectedRef.current = true;
      setConnected(true);
      setConnectionStatus('connected');
      setDiagnosticResult({
        phoneIp: phoneIp || 'No disponible',
        tvIp: diagnosedDevice.ip,
        brand: diagnosedDevice.brand || 'Desconocida',
        protocol: protocolLabel(diagnosedDevice.type),
        tvType: TV_TYPE_LABELS[diagnosedDevice.type] || diagnosedDevice.type.toUpperCase(),
        port: result.port || diagnosedDevice.port || 'No disponible',
        latencyMs: result.latencyMs,
        transport: result.transport || 'Red local',
        websocketState: result.websocketState || 'No aplica',
        responding: !!result.responding,
        message: result.responding ? 'La TV responde correctamente.' : 'La TV no respondió.',
        cause: differentSubnet
          ? 'Las IP parecen pertenecer a subredes diferentes; el router debe permitir comunicación entre ellas.'
          : 'Sin problemas detectados.',
      });
    } catch (error) {
      const normalized = normalizeConnectionError(error, { differentSubnet });
      console.warn('Diagnóstico de conexión:', {
        code: normalized.code,
        technicalMessage: normalized.technicalMessage,
        device,
        error,
      });
      setDiagnosticResult({
        phoneIp: phoneIp || 'No disponible',
        tvIp: device.ip,
        brand: device.brand || 'Desconocida',
        protocol: protocolLabel(device.type),
        tvType: TV_TYPE_LABELS[device.type] || device.type.toUpperCase(),
        port: device.port || 'No disponible',
        latencyMs: null,
        transport: device.type === 'roku' ? 'HTTP ECP' : device.type === 'sony' ? 'HTTP JSON-RPC / IRCC' : 'WebSocket',
        websocketState: ['roku', 'sony'].includes(device.type) ? 'No aplica' : 'Desconectado',
        responding: false,
        message: normalized.message,
        cause: normalized.cause,
      });
    } finally {
      setDiagnosticRunning(false);
    }
  };

  const vibrateButton = () => {
    if (buttonVibrationEnabled) {
      Vibration.vibrate(vibrationDuration);
    }
  };

  const capabilityForKey = (key) => {
    if (key === 'PowerOff') return 'power';
    if (['Up', 'Down', 'Left', 'Right', 'Select'].includes(key)) return 'dpad';
    if (key === 'Back') return 'back';
    if (key === 'Home') return 'home';
    if (key === 'Search') return 'search';
    if (['Rev', 'Play', 'Fwd', 'Info', 'InstantReplay'].includes(key)) return 'mediaControls';
    if (['VolumeUp', 'VolumeDown'].includes(key)) return 'volume';
    if (key === 'VolumeMute') return 'mute';
    if (['ChannelUp', 'ChannelDown'].includes(key)) return 'channelUpDown';
    if (key.startsWith('Input')) return 'inputs';
    return null;
  };

  const canSendKey = (key) => {
    const capability = capabilityForKey(key);
    return !!connectedDevice && (!capability || !!tvCapabilities[capability]);
  };

  const sendRemoteKey = async (key) => {
    vibrateButton();
    if (!connectedDevice) {
      setConnectModalOpen(true);
      return;
    }
    if (!canSendKey(key)) return;
    try {
      await enqueueTvCommand(
        (activeDevice) =>
          getAdapter(activeDevice.type).sendKey(activeDevice, key, { onPairingState: setPairingState }),
        {
          delayMs: commandDelayForKey(connectedDevice.type, key),
          context: { kind: 'key', key },
        },
      );
    } catch (error) {
      if (!commandReconnectEnabledRef.current) return;
      showConnectionError('Error de conexión', error);
    }
  };

  const tuneTvChannel = async () => {
    vibrateButton();
    if (!channelNumber) return;
    if (!connectedDevice) {
      setConnectModalOpen(true);
      return;
    }
    if (!tvCapabilities.directChannel) return;

    try {
      await enqueueTvCommand(
        (activeDevice) =>
          getAdapter(activeDevice.type).tuneChannel(activeDevice, channelNumber, { onPairingState: setPairingState }),
        {
          delayMs: 140,
          context: { kind: 'channel', channel: channelNumber },
        },
      );
    } catch (error) {
      if (!commandReconnectEnabledRef.current) return;
      showConnectionError('No se pudo cambiar el canal', error);
    }
  };

  const launchTvApp = async (app) => {
    vibrateButton();
    if (!connectedDevice) {
      setConnectModalOpen(true);
      return;
    }
    if (!tvCapabilities.launchApp) return;

    try {
      await executeWithReconnect((activeDevice) =>
        getAdapter(activeDevice.type).launchApp(activeDevice, app, { onPairingState: setPairingState })
      );
    } catch (error) {
      if (!commandReconnectEnabledRef.current) return;
      showConnectionError(`No se pudo abrir ${app.name}`, error);
    }
  };

  const updateShortcutPreferences = async (type, selections) => {
    const nextPreferences = { ...shortcutPreferences, [type]: selections };
    setShortcutPreferences(nextPreferences);
    try {
      await AsyncStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(nextPreferences));
    } catch (error) {
      console.warn('No se pudieron guardar los accesos directos:', error);
    }
  };

  const shortcutMatchesApp = (shortcut, app) => {
    if (shortcut.appId && String(shortcut.appId) === String(app.id)) return true;
    return resolveShortcutApp([app], shortcut)?.id === app.id;
  };

  const toggleShortcutApp = (app) => {
    vibrateButton();
    let current = [...activeShortcutSelections];
    const selectedIndex = current.findIndex((shortcut) => shortcutMatchesApp(shortcut, app));
    if (selectedIndex >= 0) {
      current.splice(selectedIndex, 1);
    } else {
      // Las opciones predeterminadas que no estén instaladas no ocupan un espacio.
      current = current.filter((shortcut) => !!resolveShortcutApp(installedApps, shortcut));
      if (current.length >= 3) {
        Alert.alert('Máximo 3 accesos', 'Quita uno de los accesos seleccionados antes de agregar otro.');
        return;
      }
      current.push({
        key: `app:${app.id}`,
        label: app.name,
        appId: app.id,
        aliases: [app.name.toLowerCase()],
      });
    }
    updateShortcutPreferences(activeTemplateType, current);
  };

  const openRemoteShortcut = async (shortcut) => {
    if (!connectedDevice) {
      vibrateButton();
      setConnectModalOpen(true);
      return;
    }

    if (!tvCapabilities.installedApps || !tvCapabilities.launchApp) {
      vibrateButton();
      Alert.alert('Acceso no disponible', `${connectedDevice.name} no permite consultar y abrir aplicaciones con este protocolo.`);
      return;
    }

    const apps = installedApps.length > 0 ? installedApps : await loadTvApps();
    const app = resolveShortcutApp(apps, shortcut);
    if (!app) {
      vibrateButton();
      Alert.alert(
        `${shortcut.label} no está disponible`,
        `No encontré ${shortcut.label} entre las aplicaciones instaladas en esta TV.`
      );
      return;
    }

    await launchTvApp(app);
  };

  const disconnectDevice = () => {
    commandReconnectEnabledRef.current = false;
    connectionNotificationPolicyRef.current.reset();
    clearCommandQueue(commandQueueStateRef.current);
    if (connectedDevice) getAdapter(connectedDevice.type)?.disconnect(connectedDevice);
    connectedRef.current = false;
    setConnected(false);
    setConnectionStatus('disconnected');
    setConnectionMessage('TV desconectada');
  };

  const forgetDevice = async () => {
    disconnectDevice();
    await Promise.all([
      AsyncStorage.removeItem(DEVICE_STORAGE_KEY),
      AsyncStorage.removeItem(LEGACY_STORAGE_KEY),
      AsyncStorage.setItem(ACTIVE_TEMPLATE_STORAGE_KEY, 'roku'),
    ]);
    connectedDeviceRef.current = null;
    setConnectedDevice(null);
    setTvIp('');
    setTvName('');
    setInstalledApps([]);
    setRemoteTemplateType('roku');
    setDiagnosticResult(null);
  };

  // ---------- UI pieces ----------

  const ConnectBar = () => (
    <TouchableOpacity
      style={styles.connectBar}
      onPress={() => {
        vibrateButton();
        setConnectionView('automatic');
        setConnectModalOpen(true);
        scanDevices();
      }}
    >
      <View style={[styles.connectDot, { backgroundColor: connected ? '#22c55e' : '#555' }]} />
      <Text style={styles.connectBarText}>
        {connected
          ? `${tvName || tvIp} · ${TV_TYPE_LABELS[connectedDevice?.type] || 'TV'}${connectionMessage === 'Conectada automáticamente' ? ' · Conectada automáticamente' : ''}`
          : connectionMessage || 'Toca para conectar...'}
      </Text>
    </TouchableOpacity>
  );

  const ConnectModal = () => (
    <Modal visible={connectModalOpen} animationType="slide" transparent>
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'} 
        style={styles.modalOverlay}
      >
        <View style={styles.modalBox}>
          <Text style={styles.modalTitle}>Conectar con tu TV</Text>

          <View style={styles.tvTypeRow}>
            {[
              ['automatic', 'Automático'],
              ['manual', 'Conexión manual'],
            ].map(([view, label]) => (
              <TouchableOpacity
                key={view}
                style={[styles.tvTypeChip, connectionView === view && styles.tvTypeChipActive]}
                onPress={() => {
                  vibrateButton();
                  if (view === 'manual') {
                    activeScanIdRef.current += 1;
                    setScanning(false);
                  }
                  setConnectionView(view);
                }}
              >
                <Text style={[styles.tvTypeText, connectionView === view && styles.tvTypeTextActive]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {connectionView === 'automatic' ? (
            <>
              <TouchableOpacity
                style={[styles.searchBtn, scanning && styles.controlDisabled]}
                disabled={scanning}
                onPress={() => { vibrateButton(); scanDevices(); }}
              >
                <Ionicons name="search" size={20} color="#fff" />
                <Text style={styles.searchBtnText}>Buscar TVs en mi red WiFi</Text>
              </TouchableOpacity>

              {scanning && (
                <View style={styles.scanningRow}>
                  <ActivityIndicator color={PURPLE} />
                  <Text style={styles.scanningText}>Buscando (esto toma unos segundos)...</Text>
                </View>
              )}

              {!!connectionMessage && (
                <View style={styles.connectionMessageBox}>
                  <Ionicons
                    name={connectionStatus === 'connected' ? 'checkmark-circle' : pairingState === 'waiting' ? 'tv-outline' : 'information-circle-outline'}
                    size={19}
                    color={connectionStatus === 'connected' ? '#22c55e' : PURPLE}
                  />
                  <Text style={styles.connectionMessageText}>{connectionMessage}</Text>
                </View>
              )}

              {foundDevices.length > 0 && (
                <ScrollView style={{ maxHeight: 180, marginTop: 10 }}>
                  {foundDevices.map((d) => (
                    <TouchableOpacity
                      key={`${d.type}:${d.ip}`}
                      style={styles.deviceItem}
                      onPress={() => { vibrateButton(); selectDevice(d); }}
                    >
                      <Text style={styles.deviceName}>{deviceTitle(d)}</Text>
                      <Text style={styles.deviceIp}>
                        {d.name && d.name !== deviceTitle(d) ? `${d.name} · ` : ''}{d.ip}
                        {d.model ? ` · ${d.model}` : ''}{d.port ? ` · Puerto ${d.port}` : ''}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </>
          ) : (
            <>
              <Text style={styles.modalSectionDescription}>
                Escribe la IP de la TV. La app identificará automáticamente cómo conectarse.
              </Text>
              <TextInput
                style={styles.input}
                placeholder="IP de la TV (ej. 192.168.1.50)"
                placeholderTextColor="#777"
                value={inputIp}
                onChangeText={setInputIp}
                keyboardType="decimal-pad"
                autoCapitalize="none"
              />
              <TouchableOpacity style={styles.primaryBtn} onPress={() => { vibrateButton(); connectManual(); }}>
                <Text style={styles.primaryBtnText}>Conectar con esta IP</Text>
              </TouchableOpacity>
            </>
          )}

          <TouchableOpacity
            style={styles.closeBtn}
            onPress={() => {
              vibrateButton();
              activeScanIdRef.current += 1;
              setScanning(false);
              setConnectModalOpen(false);
            }}
          >
            <Text style={styles.closeBtnText}>Cerrar</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );

  const CrossPad = () => (
    <View style={styles.crossWrap}>
      <TouchableOpacity style={[styles.crossUp, !canSendKey('Up') && styles.controlDisabled]} disabled={!canSendKey('Up')} onPress={() => sendRemoteKey('Up')} activeOpacity={0.7}>
        <Ionicons name="chevron-up" size={30} color={canSendKey('Up') ? '#fff' : '#777'} />
      </TouchableOpacity>
      <View style={styles.crossMiddleRow}>
        <TouchableOpacity style={[styles.crossLeft, !canSendKey('Left') && styles.controlDisabled]} disabled={!canSendKey('Left')} onPress={() => sendRemoteKey('Left')} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={30} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity style={[styles.crossCenter, !canSendKey('Select') && styles.controlDisabled]} disabled={!canSendKey('Select')} onPress={() => sendRemoteKey('Select')} activeOpacity={0.7}>
          <Text style={styles.okText}>OK</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.crossRight, !canSendKey('Right') && styles.controlDisabled]} disabled={!canSendKey('Right')} onPress={() => sendRemoteKey('Right')} activeOpacity={0.7}>
          <Ionicons name="chevron-forward" size={30} color="#fff" />
        </TouchableOpacity>
      </View>
      <TouchableOpacity style={[styles.crossDown, !canSendKey('Down') && styles.controlDisabled]} disabled={!canSendKey('Down')} onPress={() => sendRemoteKey('Down')} activeOpacity={0.7}>
        <Ionicons name="chevron-down" size={30} color="#fff" />
      </TouchableOpacity>
    </View>
  );

  const IconBtn = ({ icon, IconSet = Ionicons, onPress, size = 22, wide, disabled = false }) => (
    <TouchableOpacity
      style={[styles.roundBtn, wide && styles.roundBtnWide, disabled && styles.controlDisabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
    >
      <IconSet name={icon} size={size} color={disabled ? '#666674' : '#e6e6ea'} />
    </TouchableOpacity>
  );

  const InputsView = () => (
    <View style={styles.inputsGrid}>
      {[
        ['InputTuner', 'Antena/Tuner'],
        ['InputHDMI1', 'HDMI 1'],
        ['InputHDMI2', 'HDMI 2'],
        ['InputHDMI3', 'HDMI 3'],
        ['InputHDMI4', 'HDMI 4'],
        ['InputAV1', 'AV'],
      ].map(([key, label]) => (
        <TouchableOpacity
          key={key}
          style={[styles.inputChip, !canSendKey(key) && styles.controlDisabled]}
          disabled={!canSendKey(key)}
          onPress={() => sendRemoteKey(key)}
        >
          <Text style={styles.inputChipText}>{label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  const RemoteShortcuts = ({ style }) => {
    if (activeShortcutSelections.length === 0) return null;
    return (
      <View style={[styles.remoteShortcutsRow, style]}>
        {activeShortcutSelections.map((shortcut) => {
          const app = resolveShortcutApp(installedApps, shortcut);
          const iconFailed = app && failedAppIcons[app.id];
          const disabled = appsLoading || !tvCapabilities.launchApp || !app;
          return (
            <TouchableOpacity
              key={shortcut.key || `shortcut:${shortcut.appId}`}
              style={[styles.remoteShortcutButton, disabled && styles.remoteShortcutButtonLoading]}
              onPress={() => openRemoteShortcut(shortcut)}
              disabled={disabled}
              activeOpacity={0.75}
              accessibilityLabel={`Abrir ${shortcut.label} en la TV`}
            >
              {app?.iconUri && !iconFailed ? (
                <Image
                  source={{ uri: app.iconUri }}
                  style={styles.remoteShortcutImage}
                  resizeMode="contain"
                  fadeDuration={150}
                  onError={() => setFailedAppIcons((current) => ({ ...current, [app.id]: true }))}
                />
              ) : (
                <Ionicons name="image-outline" size={32} color="#5f5f6d" />
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    );
  };

  const RokuRemoteTab = () => (
    <>
      <View style={styles.topControls}>
        <TouchableOpacity
          style={[styles.powerBtn, !canSendKey('PowerOff') && styles.controlDisabled]}
          disabled={!canSendKey('PowerOff')}
          onPress={() => sendRemoteKey('PowerOff')}
          activeOpacity={0.7}
        >
          <Ionicons name="power" size={22} color={PURPLE} />
        </TouchableOpacity>

        <View style={styles.segmented}>
          <TouchableOpacity
            style={[styles.segment, mandoView === 'remote' && styles.segmentActive]}
            onPress={() => { vibrateButton(); setMandoView('remote'); }}
          >
            <MaterialCommunityIcons
              name="remote"
              size={20}
              color={mandoView === 'remote' ? '#fff' : '#8a8a99'}
            />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.segment, mandoView === 'inputs' && styles.segmentActive]}
            onPress={() => { vibrateButton(); setMandoView('inputs'); }}
          >
            <Ionicons
              name="apps"
              size={20}
              color={mandoView === 'inputs' ? '#fff' : '#8a8a99'}
            />
          </TouchableOpacity>
        </View>
      </View>

      {mandoView === 'remote' ? (
        <>
          <CrossPad />

          <View style={styles.row3}>
            <IconBtn icon="arrow-back" onPress={() => sendRemoteKey('Back')} disabled={!canSendKey('Back')} />
            <IconBtn icon="home" onPress={() => sendRemoteKey('Home')} disabled={!canSendKey('Home')} wide />
            <IconBtn icon="search" onPress={() => sendRemoteKey('Search')} disabled={!canSendKey('Search')} />
          </View>

          <View style={styles.row3}>
            <IconBtn icon="play-back" onPress={() => sendRemoteKey('Rev')} disabled={!canSendKey('Rev')} />
            <IconBtn icon="play-pause" IconSet={MaterialCommunityIcons} onPress={() => sendRemoteKey('Play')} disabled={!canSendKey('Play')} />
            <IconBtn icon="play-forward" onPress={() => sendRemoteKey('Fwd')} disabled={!canSendKey('Fwd')} />
            <IconBtn icon="asterisk" IconSet={MaterialCommunityIcons} onPress={() => sendRemoteKey('Info')} disabled={!canSendKey('Info')} />
          </View>

          <View style={styles.row3}>
            <IconBtn icon="volume-mute" onPress={() => sendRemoteKey('VolumeMute')} disabled={!canSendKey('VolumeMute')} />
            <IconBtn icon="volume-low" onPress={() => sendRemoteKey('VolumeDown')} disabled={!canSendKey('VolumeDown')} />
            <IconBtn icon="volume-high" onPress={() => sendRemoteKey('VolumeUp')} disabled={!canSendKey('VolumeUp')} />
            <IconBtn icon="reload" onPress={() => sendRemoteKey('InstantReplay')} disabled={!canSendKey('InstantReplay')} />
          </View>

          <RemoteShortcuts />
        </>
      ) : (
        <InputsView />
      )}
    </>
  );

  const BrandIconButton = ({ command, icon, IconSet = Ionicons, label, accent = '#d4d4d8' }) => {
    const enabled = canSendKey(command);
    return (
      <TouchableOpacity
        style={[styles.brandActionButton, !enabled && styles.controlDisabled]}
        disabled={!enabled}
        onPress={() => sendRemoteKey(command)}
        activeOpacity={0.7}
        accessibilityLabel={label}
      >
        <IconSet name={icon} size={22} color={enabled ? accent : '#666674'} />
        {!!label && <Text style={styles.brandActionLabel} numberOfLines={1} adjustsFontSizeToFit>{label}</Text>}
      </TouchableOpacity>
    );
  };

  const BrandDpad = ({ accent, lgStyle = false }) => (
    <View style={[styles.brandDpad, lgStyle && styles.lgDpad]}>
      <TouchableOpacity
        style={[styles.brandDpadUp, !canSendKey('Up') && styles.controlDisabled]}
        disabled={!canSendKey('Up')}
        onPress={() => sendRemoteKey('Up')}
      >
        <Ionicons name="chevron-up" size={27} color="#fff" />
      </TouchableOpacity>
      <View style={styles.brandDpadMiddle}>
        <TouchableOpacity
          style={[styles.brandDpadSide, !canSendKey('Left') && styles.controlDisabled]}
          disabled={!canSendKey('Left')}
          onPress={() => sendRemoteKey('Left')}
        >
          <Ionicons name="chevron-back" size={27} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.brandDpadOk, { borderColor: accent }, !canSendKey('Select') && styles.controlDisabled]}
          disabled={!canSendKey('Select')}
          onPress={() => sendRemoteKey('Select')}
        >
          <Text style={[styles.brandDpadOkText, { color: accent }]}>OK</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.brandDpadSide, !canSendKey('Right') && styles.controlDisabled]}
          disabled={!canSendKey('Right')}
          onPress={() => sendRemoteKey('Right')}
        >
          <Ionicons name="chevron-forward" size={27} color="#fff" />
        </TouchableOpacity>
      </View>
      <TouchableOpacity
        style={[styles.brandDpadDown, !canSendKey('Down') && styles.controlDisabled]}
        disabled={!canSendKey('Down')}
        onPress={() => sendRemoteKey('Down')}
      >
        <Ionicons name="chevron-down" size={27} color="#fff" />
      </TouchableOpacity>
    </View>
  );

  const BrandRemoteHeader = ({ title, subtitle, accent }) => (
    <View style={styles.brandRemoteHeader}>
      <TouchableOpacity
        style={[styles.brandPowerButton, !canSendKey('PowerOff') && styles.controlDisabled]}
        disabled={!canSendKey('PowerOff')}
        onPress={() => sendRemoteKey('PowerOff')}
      >
        <Ionicons name="power" size={21} color="#ef4444" />
      </TouchableOpacity>
      <View style={styles.brandRemoteTitleBox}>
        <Text style={styles.brandRemoteTitle} numberOfLines={1} adjustsFontSizeToFit>{title}</Text>
        <Text style={[styles.brandRemoteSubtitle, { color: accent }]} numberOfLines={1}>{subtitle}</Text>
      </View>
      <TouchableOpacity
        style={[styles.brandViewButton, mandoView === 'inputs' && { borderColor: accent }]}
        onPress={() => { vibrateButton(); setMandoView(mandoView === 'remote' ? 'inputs' : 'remote'); }}
      >
        <Ionicons name={mandoView === 'remote' ? 'apps-outline' : 'tv-outline'} size={20} color={accent} />
      </TouchableOpacity>
    </View>
  );

  const SamsungRemoteTab = () => (
    <View style={[styles.brandRemoteShell, styles.samsungRemoteShell]}>
      <BrandRemoteHeader title="Samsung TV" subtitle="Control Tizen" accent="#60a5fa" />
      {mandoView === 'inputs' ? (
        <InputsView />
      ) : (
        <>
          <BrandDpad accent="#60a5fa" />
          <View style={styles.brandActionRow}>
            <BrandIconButton command="Back" icon="arrow-back" label="Atrás" />
            <BrandIconButton command="Home" icon="home-outline" label="Inicio" accent="#60a5fa" />
            <BrandIconButton command="VolumeMute" icon="volume-mute-outline" label="Mute" />
          </View>
          <View style={styles.brandRockerRow}>
            <View style={styles.brandRocker}>
              <TouchableOpacity disabled={!canSendKey('VolumeUp')} onPress={() => sendRemoteKey('VolumeUp')} style={!canSendKey('VolumeUp') && styles.controlDisabled}>
                <Ionicons name="add" size={25} color="#fff" />
              </TouchableOpacity>
              <Text style={styles.brandRockerLabel}>VOL</Text>
              <TouchableOpacity disabled={!canSendKey('VolumeDown')} onPress={() => sendRemoteKey('VolumeDown')} style={!canSendKey('VolumeDown') && styles.controlDisabled}>
                <Ionicons name="remove" size={25} color="#fff" />
              </TouchableOpacity>
            </View>
            <View style={styles.brandMediaColumn}>
              <BrandIconButton command="Rev" icon="play-back" />
              <BrandIconButton command="Play" icon="play-pause" IconSet={MaterialCommunityIcons} accent="#60a5fa" />
              <BrandIconButton command="Fwd" icon="play-forward" />
            </View>
            <View style={styles.brandRocker}>
              <TouchableOpacity disabled={!canSendKey('ChannelUp')} onPress={() => sendRemoteKey('ChannelUp')} style={!canSendKey('ChannelUp') && styles.controlDisabled}>
                <Ionicons name="chevron-up" size={23} color="#fff" />
              </TouchableOpacity>
              <Text style={styles.brandRockerLabel}>CH</Text>
              <TouchableOpacity disabled={!canSendKey('ChannelDown')} onPress={() => sendRemoteKey('ChannelDown')} style={!canSendKey('ChannelDown') && styles.controlDisabled}>
                <Ionicons name="chevron-down" size={23} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
          <RemoteShortcuts style={styles.brandShortcuts} />
        </>
      )}
    </View>
  );

  const LgRemoteTab = () => (
    <View style={[styles.brandRemoteShell, styles.lgRemoteShell]}>
      <BrandRemoteHeader title="LG webOS" subtitle="Control webOS" accent="#ec4899" />
      {mandoView === 'inputs' ? (
        <InputsView />
      ) : (
        <>
          <BrandDpad accent="#ec4899" lgStyle />
          <View style={styles.brandActionRow}>
            <BrandIconButton command="Back" icon="return-up-back" label="Atrás" />
            <BrandIconButton command="Home" icon="home" label="Inicio" accent="#ec4899" />
            <BrandIconButton command="VolumeMute" icon="volume-mute" label="Mute" />
          </View>
          <View style={styles.lgControlGrid}>
            <BrandIconButton command="VolumeDown" icon="volume-low" label="Vol −" />
            <BrandIconButton command="Play" icon="play-pause" IconSet={MaterialCommunityIcons} label="Reproducir" accent="#ec4899" />
            <BrandIconButton command="VolumeUp" icon="volume-high" label="Vol +" />
            <BrandIconButton command="ChannelDown" icon="chevron-down-circle-outline" label="Canal −" />
            <BrandIconButton command="VolumeMute" icon="volume-mute" label="Mute" />
            <BrandIconButton command="ChannelUp" icon="chevron-up-circle-outline" label="Canal +" />
          </View>
          <View style={styles.brandActionRow}>
            <BrandIconButton command="Rev" icon="play-back" />
            <BrandIconButton command="Fwd" icon="play-forward" />
          </View>
          <RemoteShortcuts style={styles.brandShortcuts} />
        </>
      )}
    </View>
  );

  const MandoTab = () => {
    if (activeTemplateType === 'samsung') return <SamsungRemoteTab />;
    if (activeTemplateType === 'lg') return <LgRemoteTab />;
    return <RokuRemoteTab />;
  };

  const NumeroTab = () => {
    const enterCharacter = (character) => {
      vibrateButton();
      setChannelNumber((current) => {
        if (current.length >= 7) return current;
        if (character === '.' && (!current || current.includes('.'))) return current;
        return current + character;
      });
    };

    const eraseCharacter = () => {
      vibrateButton();
      setChannelNumber((current) => current.slice(0, -1));
    };

    return (
      <View style={styles.numberBox}>
        <Text style={styles.sectionTitle}>Escribe el número del canal</Text>
        <Text style={styles.sectionDescription}>
          También puedes usar punto para subcanales, por ejemplo 7.1.
        </Text>
        <View style={styles.row3}>
          <IconBtn icon="remove" onPress={() => sendRemoteKey('ChannelDown')} disabled={!canSendKey('ChannelDown')} wide />
          <Text style={styles.channelNum}>{channelNumber || '—'}</Text>
          <IconBtn icon="add" onPress={() => sendRemoteKey('ChannelUp')} disabled={!canSendKey('ChannelUp')} wide />
        </View>
        <View style={styles.numpad}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map((key) => (
            <TouchableOpacity
              key={key}
              style={styles.numKey}
              onPress={() => (key === '⌫' ? eraseCharacter() : enterCharacter(key))}
              activeOpacity={0.7}
            >
              <Text style={styles.numKeyText}>{key}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity
          style={[styles.tuneButton, (!channelNumber || !tvCapabilities.directChannel) && styles.disabledButton]}
          onPress={tuneTvChannel}
          disabled={!channelNumber || !tvCapabilities.directChannel}
          activeOpacity={0.7}
        >
          <MaterialIcons name="live-tv" size={20} color="#fff" />
          <Text style={styles.tuneButtonText}>Ir al canal</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const AppsTab = () => (
    <View style={styles.appsBox}>
      <View style={styles.appsHeader}>
        <View style={styles.appsHeaderText}>
          <Text style={styles.sectionTitle}>Aplicaciones instaladas</Text>
          <Text style={styles.sectionDescription}>Toca una app para abrirla directamente en la TV.</Text>
        </View>
        <TouchableOpacity
          style={[styles.refreshAppsButton, !tvCapabilities.installedApps && styles.controlDisabled]}
          disabled={!tvCapabilities.installedApps}
          onPress={() => { vibrateButton(); loadTvApps(); }}
        >
          <Ionicons name="refresh" size={21} color={PURPLE} />
        </TouchableOpacity>
      </View>

      {appsLoading ? (
        <View style={styles.appsStatus}>
          <ActivityIndicator color={PURPLE} />
          <Text style={styles.scanningText}>Cargando aplicaciones...</Text>
        </View>
      ) : appsError ? (
        <View style={styles.appsStatus}>
          <Ionicons name="alert-circle-outline" size={32} color="#777" />
          <Text style={styles.infoText}>{appsError}</Text>
        </View>
      ) : (
        <View style={styles.appsGrid}>
          {installedApps.map((app) => (
            <TouchableOpacity
              key={app.id}
              style={styles.appButton}
              onPress={() => launchTvApp(app)}
              activeOpacity={0.7}
            >
              <View style={styles.appIconContainer}>
                {failedAppIcons[app.id] || !app.iconUri ? (
                  <View style={styles.appIconFallback}>
                    <Text style={styles.appIconFallbackText}>
                      {app.name.charAt(0).toUpperCase()}
                    </Text>
                  </View>
                ) : (
                  <Image
                    source={{ uri: app.iconUri }}
                    style={styles.appIcon}
                    resizeMode="contain"
                    fadeDuration={150}
                    onError={() => {
                      setFailedAppIcons((current) => ({ ...current, [app.id]: true }));
                    }}
                    accessibilityLabel={`Icono de ${app.name}`}
                  />
                )}
              </View>
              <Text style={styles.appButtonText} numberOfLines={2}>{app.name}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );

  const AjustesTab = () => (
    <View style={styles.ajustesBox}>
      <View style={styles.settingRow}>
        <View style={styles.settingText}>
          <Text style={styles.settingTitle}>Vibración de botones</Text>
          <Text style={styles.settingDescription}>
            {buttonVibrationEnabled ? 'Activado' : 'Desactivado'}
          </Text>
        </View>
        <Switch
          value={buttonVibrationEnabled}
          onValueChange={setButtonVibration}
          trackColor={{ false: '#3a3a46', true: PURPLE_DARK }}
          thumbColor={buttonVibrationEnabled ? PURPLE : '#a1a1aa'}
        />
      </View>

      {buttonVibrationEnabled && (
        <View style={styles.vibrationLevelBox}>
          <Text style={styles.vibrationLevelTitle}>Nivel de vibración</Text>
          <Text style={styles.settingDescription}>Selecciona la intensidad que prefieras</Text>
          <View style={styles.vibrationLevelOptions}>
            {[
              ['suave', 'Suave'],
              ['media', 'Media'],
              ['fuerte', 'Fuerte'],
            ].map(([level, label]) => (
              <TouchableOpacity
                key={level}
                style={[
                  styles.vibrationLevelButton,
                  buttonVibrationLevel === level && styles.vibrationLevelButtonActive,
                ]}
                onPress={() => selectButtonVibrationLevel(level)}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.vibrationLevelButtonText,
                    buttonVibrationLevel === level && styles.vibrationLevelButtonTextActive,
                  ]}
                >
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      <View style={styles.shortcutSettingsBox}>
        <Text style={styles.settingTitle}>Notificaciones</Text>
        <Text style={styles.settingDescription}>
          Estado: {notificationPermission === 'granted'
            ? 'Permitidas'
            : notificationPermission === 'denied'
              ? 'Bloqueadas'
              : notificationPermission === 'unavailable'
                ? 'No disponibles'
                : 'Pendientes'}
        </Text>
        <Text style={styles.settingDescription}>
          Avisa una vez cuando la TV se conecta, se reconecta o pierde realmente la conexión.
        </Text>
        <TouchableOpacity
          style={[styles.smallBtn, styles.notificationSettingsButton]}
          onPress={manageNotificationPermission}
        >
          <Ionicons name="settings-outline" size={18} color="#fff" />
          <Text style={styles.smallBtnText}>
            {notificationPermission === 'granted' ? 'Administrar permisos' : 'Permitir notificaciones'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.shortcutSettingsBox}>
        <Text style={styles.settingTitle}>Accesos directos del control</Text>
        <Text style={styles.settingDescription}>
          Plantilla {TV_TYPE_LABELS[activeTemplateType] || 'Roku'} · selecciona hasta 3 aplicaciones.
        </Text>
        {!connectedDevice ? (
          <Text style={styles.shortcutUnavailable}>Conecta una TV Wi‑Fi para consultar sus aplicaciones.</Text>
        ) : !tvCapabilities.installedApps || !tvCapabilities.launchApp ? (
          <Text style={styles.shortcutUnavailable}>
            El adaptador de {TV_TYPE_LABELS[activeTemplateType] || activeTemplateType} no permite consultar y abrir aplicaciones de forma confiable.
          </Text>
        ) : appsLoading ? (
          <View style={styles.shortcutLoading}>
            <ActivityIndicator size="small" color={PURPLE} />
            <Text style={styles.settingDescription}>Cargando aplicaciones…</Text>
          </View>
        ) : installedApps.length === 0 ? (
          <Text style={styles.shortcutUnavailable}>{appsError || 'La TV no devolvió aplicaciones instaladas.'}</Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.shortcutOptions}>
            {installedApps.map((app) => {
              const selected = activeShortcutSelections.some((shortcut) => shortcutMatchesApp(shortcut, app));
              return (
                <TouchableOpacity
                  key={`shortcut-option:${app.id}`}
                  style={[styles.shortcutOption, selected && styles.shortcutOptionSelected]}
                  onPress={() => toggleShortcutApp(app)}
                  activeOpacity={0.7}
                >
                  {app.iconUri && !failedAppIcons[`setting:${app.id}`] ? (
                    <Image
                      source={{ uri: app.iconUri }}
                      style={styles.shortcutOptionIcon}
                      resizeMode="contain"
                      onError={() => setFailedAppIcons((current) => ({ ...current, [`setting:${app.id}`]: true }))}
                    />
                  ) : (
                    <View style={styles.shortcutOptionFallback}>
                      <Text style={styles.shortcutOptionFallbackText}>{app.name.charAt(0).toUpperCase()}</Text>
                    </View>
                  )}
                  <Text style={styles.shortcutOptionText} numberOfLines={1}>{app.name}</Text>
                  {selected && <Ionicons name="checkmark-circle" size={17} color={PURPLE} />}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}
      </View>

      <Text style={styles.ajustesLabel}>TV conectada</Text>
      <Text style={styles.ajustesValue}>
        {connectedDevice ? `${deviceTitle(connectedDevice)} · ${tvName || connectedDevice.name}` : 'Ninguna'}
      </Text>
      {!!connectedDevice && (
        <View style={styles.settingsDeviceDetails}>
          {[
            ['Marca comercial', connectedDevice.brand || 'Desconocida'],
            ['Sistema/protocolo', protocolLabel(connectedDevice.type)],
            ['IP', tvIp || connectedDevice.ip || 'No disponible'],
            ['Puerto', String(connectedDevice.port || 'No disponible')],
            ['Estado', connected ? 'Conectada' : connectionStatus === 'connecting' ? 'Conectando' : 'Desconectada'],
          ].map(([label, value]) => (
            <View key={label} style={styles.diagnosticRow}>
              <Text style={styles.diagnosticLabel}>{label}</Text>
              <Text style={styles.diagnosticValue}>{value}</Text>
            </View>
          ))}
          {connectedDevice.capabilities?.pairingRequired && (
            <Text style={styles.settingDescription}>Emparejamiento: {pairingState}</Text>
          )}
        </View>
      )}

      <View style={styles.diagnosticBox}>
        <Text style={styles.settingTitle}>Diagnóstico de conexión</Text>
        <Text style={styles.settingDescription}>
          Comprueba la comunicación local sin enviar comandos a la TV.
        </Text>
        <TouchableOpacity
          style={[styles.smallBtn, styles.diagnosticButton, diagnosticRunning && styles.controlDisabled]}
          disabled={diagnosticRunning}
          onPress={() => { vibrateButton(); runConnectionDiagnostic(); }}
        >
          {diagnosticRunning && <ActivityIndicator size="small" color="#fff" />}
          <Text style={styles.smallBtnText}>
            {diagnosticRunning ? 'Probando…' : 'Probar conexión'}
          </Text>
        </TouchableOpacity>

        {diagnosticResult && (
          <View style={styles.diagnosticResults}>
            {[
              ['IP del teléfono', diagnosticResult.phoneIp],
              ['IP de la TV', diagnosticResult.tvIp],
              ['Marca comercial', diagnosticResult.brand],
              ['Sistema/protocolo', diagnosticResult.protocol || diagnosticResult.tvType],
              ['Puerto', String(diagnosticResult.port)],
              ['Tiempo de respuesta', diagnosticResult.latencyMs == null ? 'No disponible' : `${diagnosticResult.latencyMs} ms`],
              ['Transporte', diagnosticResult.transport],
              ['Estado WebSocket', diagnosticResult.websocketState],
              ['Respuesta', diagnosticResult.responding == null ? 'No aplica' : diagnosticResult.responding ? 'Sí responde' : 'No responde'],
            ].map(([label, value]) => (
              <View key={label} style={styles.diagnosticRow}>
                <Text style={styles.diagnosticLabel}>{label}</Text>
                <Text style={styles.diagnosticValue}>{value}</Text>
              </View>
            ))}
            <View style={styles.diagnosticMessage}>
              <Ionicons
                name={diagnosticResult.responding === false
                  ? 'alert-circle-outline'
                  : diagnosticResult.responding === true
                    ? 'checkmark-circle-outline'
                    : 'information-circle-outline'}
                size={19}
                color={diagnosticResult.responding === false ? '#f59e0b' : diagnosticResult.responding === true ? '#22c55e' : PURPLE}
              />
              <View style={styles.diagnosticMessageText}>
                <Text style={styles.diagnosticStatus}>{diagnosticResult.message}</Text>
                <Text style={styles.settingDescription}>Posible causa: {diagnosticResult.cause}</Text>
              </View>
            </View>
          </View>
        )}
      </View>

      <TouchableOpacity
        style={styles.smallBtn}
        onPress={() => { vibrateButton(); setConnectModalOpen(true); }}
      >
        <Text style={styles.smallBtnText}>Cambiar / reconectar</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.smallBtn, { marginTop: 10, backgroundColor: '#3a1e1e' }]}
        onPress={() => { vibrateButton(); forgetDevice(); }}
      >
        <Text style={[styles.smallBtnText, { color: '#f87171' }]}>Olvidar TV</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" backgroundColor={BG} />
        {ConnectModal()}

        <ScrollView contentContainerStyle={styles.scroll}>
          {activeTab !== 'infrarrojo' && <ConnectBar />}
          {activeTab === 'mando' && <MandoTab />}
          {activeTab === 'infrarrojo' && (
            <LuzInfrarojaScreen
              vibrationEnabled={buttonVibrationEnabled}
              vibrationDuration={vibrationDuration}
            />
          )}
          {activeTab === 'numero' && <NumeroTab />}
          {activeTab === 'apps' && <AppsTab />}
          {activeTab === 'ajustes' && <AjustesTab />}
        </ScrollView>

        <View style={styles.tabBar}>
          {[
            ['mando', 'person', 'Mando'],
            ['infrarrojo', 'flash', 'IR'],
            ['numero', 'keypad', 'Número'],
            ['apps', 'apps', 'Apps'],
            ['ajustes', 'settings-sharp', 'Ajustes'],
          ].map(([key, icon, label]) => (
            <TouchableOpacity
              key={key}
              style={styles.tabItem}
              onPress={() => { vibrateButton(); setActiveTab(key); }}
            >
              <Ionicons
                name={icon}
                size={20}
                color={activeTab === key ? PURPLE : '#6b6b78'}
              />
              <Text
                style={[styles.tabLabel, activeTab === key && { color: PURPLE }]}
              >
                {label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },
  scroll: { alignItems: 'center', paddingVertical: 20, paddingHorizontal: 16 },

  connectBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PANEL_2,
    marginHorizontal: 0,
    marginTop: 0,
    marginBottom: 20,
    width: '100%',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#3a2a5c',
  },
  connectDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 10,
  },
  connectBarText: { color: '#c7c7d1', fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'center' },

  topControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 16,
  },
  powerBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: PANEL,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#3a2a5c',
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: PANEL,
    borderRadius: 22,
    padding: 4,
  },
  segment: { paddingVertical: 8, paddingHorizontal: 18, borderRadius: 18 },
  segmentActive: { backgroundColor: PURPLE_DARK },

  crossWrap: { alignItems: 'center', marginBottom: 30 },
  crossMiddleRow: { flexDirection: 'row' },
  crossUp: {
    width: 92,
    height: 60,
    backgroundColor: PURPLE,
    borderTopLeftRadius: 40,
    borderTopRightRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 3,
    borderWidth: 2,
    borderColor: '#000',
    borderBottomWidth: 0,
  },
  crossDown: {
    width: 92,
    height: 60,
    backgroundColor: PURPLE,
    borderBottomLeftRadius: 40,
    borderBottomRightRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 3,
    borderWidth: 2,
    borderColor: '#000',
    borderTopWidth: 0,
  },
  crossLeft: {
    width: 60,
    height: 92,
    backgroundColor: PURPLE,
    borderTopLeftRadius: 40,
    borderBottomLeftRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 3,
    borderWidth: 2,
    borderColor: '#000',
    borderRightWidth: 0,
  },
  crossRight: {
    width: 60,
    height: 92,
    backgroundColor: PURPLE,
    borderTopRightRadius: 40,
    borderBottomRightRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 3,
    borderWidth: 2,
    borderColor: '#000',
    borderLeftWidth: 0,
  },
  crossCenter: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: PURPLE_DARK,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#000',
  },
  okText: { color: '#fff', fontWeight: '800', fontSize: 16 },

  row3: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 18,
    gap: 10,
  },
  remoteShortcutsRow: {
    flexDirection: 'row',
    width: '100%',
    gap: 10,
    marginTop: 22,
    marginBottom: 18,
  },
  remoteShortcutButton: {
    flex: 1,
    height: 86,
    alignItems: 'center',
    justifyContent: 'center',
  },
  remoteShortcutButtonLoading: { opacity: 0.55 },
  remoteShortcutImage: {
    width: 76,
    height: 76,
    borderRadius: 12,
  },
  roundBtn: {
    flex: 1,
    height: 56,
    borderRadius: 18,
    backgroundColor: PANEL_2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundBtnWide: { flex: 1.6 },
  controlDisabled: { opacity: 0.35 },

  brandRemoteShell: {
    width: '100%',
    maxWidth: 430,
    alignSelf: 'center',
    padding: 16,
    backgroundColor: '#17171d',
    borderWidth: 1,
    borderColor: '#30303a',
  },
  samsungRemoteShell: { borderRadius: 30 },
  lgRemoteShell: { borderRadius: 42, backgroundColor: '#19171b', borderColor: '#3b2b35' },
  brandRemoteHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 22,
  },
  brandPowerButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#25252d',
  },
  brandRemoteTitleBox: { alignItems: 'center' },
  brandRemoteTitle: { color: '#f4f4f5', fontSize: 15, fontWeight: '700' },
  brandRemoteSubtitle: { fontSize: 11, fontWeight: '600', marginTop: 2 },
  brandViewButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#25252d',
    borderWidth: 1,
    borderColor: '#34343e',
  },
  brandDpad: {
    width: '78%',
    maxWidth: 246,
    aspectRatio: 1,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 123,
    backgroundColor: '#222229',
    borderWidth: 2,
    borderColor: '#393943',
    marginBottom: 22,
  },
  lgDpad: {
    borderWidth: 7,
    borderColor: '#302a30',
    backgroundColor: '#1f1d21',
  },
  brandDpadUp: { width: 90, flex: 1, alignItems: 'center', justifyContent: 'center' },
  brandDpadDown: { width: 90, flex: 1, alignItems: 'center', justifyContent: 'center' },
  brandDpadMiddle: {
    width: '100%',
    height: 86,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brandDpadSide: { flex: 1, height: 86, alignItems: 'center', justifyContent: 'center' },
  brandDpadOk: {
    width: 84,
    height: 84,
    borderRadius: 42,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111116',
    borderWidth: 2,
  },
  brandDpadOkText: { fontSize: 15, fontWeight: '800' },
  brandActionRow: { flexDirection: 'row', gap: 10, marginBottom: 15 },
  brandActionButton: {
    flex: 1,
    minWidth: '28%',
    minHeight: 52,
    borderRadius: 18,
    backgroundColor: '#25252d',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  brandActionLabel: { color: '#a1a1aa', fontSize: 10, fontWeight: '600', marginTop: 3 },
  brandRockerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  brandRocker: {
    width: 64,
    height: 136,
    borderRadius: 32,
    backgroundColor: '#25252d',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: 10,
  },
  brandRockerLabel: { color: '#a1a1aa', fontSize: 11, fontWeight: '800' },
  brandMediaColumn: { flex: 1, flexDirection: 'row', gap: 8 },
  lgControlGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 9,
    marginBottom: 14,
  },
  brandShortcuts: { marginTop: 18, marginBottom: 4 },

  inputsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'center',
    marginTop: 10,
  },
  inputChip: {
    backgroundColor: PANEL_2,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 14,
    minWidth: 100,
    alignItems: 'center',
  },
  inputChipText: { color: '#e6e6ea', fontWeight: '600' },

  numberBox: { width: '100%', alignItems: 'center' },
  sectionTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  sectionDescription: {
    color: '#8a8a99',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 5,
    marginBottom: 20,
  },
  channelNum: {
    flex: 1,
    textAlign: 'center',
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
  },
  numpad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    width: 260,
    justifyContent: 'space-between',
  },
  numKey: {
    width: 76,
    height: 56,
    borderRadius: 14,
    backgroundColor: PANEL_2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  numKeyText: { color: '#e6e6ea', fontSize: 18, fontWeight: '700' },
  tuneButton: {
    width: 260,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: PURPLE_DARK,
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 4,
  },
  tuneButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  disabledButton: { opacity: 0.4 },

  appsBox: { width: '100%' },
  appsHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  appsHeaderText: { flex: 1, marginRight: 12 },
  refreshAppsButton: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: PANEL_2,
  },
  appsStatus: { alignItems: 'center', gap: 12, paddingVertical: 50 },
  appsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 10,
  },
  appButton: {
    width: '48%',
    minHeight: 86,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: PANEL_2,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#30303d',
  },
  appIconContainer: {
    width: 52,
    height: 52,
    borderRadius: 11,
    overflow: 'hidden',
    backgroundColor: '#111118',
    marginRight: 10,
  },
  appIcon: { width: '100%', height: '100%' },
  appIconFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PURPLE_DARK,
  },
  appIconFallbackText: { color: '#fff', fontSize: 22, fontWeight: '800' },
  appButtonText: { color: '#e6e6ea', flex: 1, fontSize: 13, fontWeight: '600' },

  centeredInfo: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 20 },
  infoText: { color: '#8a8a99', textAlign: 'center', marginTop: 14, lineHeight: 20 },

  ajustesBox: { width: '100%' },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: PANEL,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 18,
  },
  settingText: { flex: 1, marginRight: 16 },
  settingTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  settingDescription: { color: '#8a8a99', fontSize: 13, marginTop: 4 },
  vibrationLevelBox: {
    backgroundColor: PANEL,
    borderRadius: 14,
    padding: 16,
    marginTop: -8,
    marginBottom: 18,
  },
  vibrationLevelTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  vibrationLevelOptions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  vibrationLevelButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: PANEL_2,
    borderWidth: 1,
    borderColor: '#343442',
  },
  vibrationLevelButtonActive: {
    backgroundColor: PURPLE_DARK,
    borderColor: PURPLE,
  },
  vibrationLevelButtonText: { color: '#9a9aaa', fontSize: 13, fontWeight: '600' },
  vibrationLevelButtonTextActive: { color: '#fff' },
  shortcutSettingsBox: {
    backgroundColor: PANEL,
    borderRadius: 14,
    padding: 16,
    marginBottom: 18,
  },
  notificationSettingsButton: {
    flex: 0,
    marginTop: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  shortcutUnavailable: { color: '#8a8a99', fontSize: 13, lineHeight: 19, marginTop: 13 },
  shortcutLoading: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 13 },
  shortcutOptions: { gap: 9, paddingTop: 14, paddingRight: 6 },
  shortcutOption: {
    width: 118,
    minHeight: 72,
    backgroundColor: PANEL_2,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#343442',
    padding: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shortcutOptionSelected: { borderColor: PURPLE, backgroundColor: '#29213d' },
  shortcutOptionIcon: { width: 32, height: 32, borderRadius: 7, marginBottom: 5 },
  shortcutOptionFallback: {
    width: 32,
    height: 32,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PURPLE_DARK,
    marginBottom: 5,
  },
  shortcutOptionFallbackText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  shortcutOptionText: { color: '#d4d4d8', fontSize: 10, fontWeight: '600', maxWidth: 96 },
  ajustesLabel: { color: '#8a8a99', fontSize: 13, marginTop: 10 },
  ajustesValue: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 16 },
  diagnosticBox: {
    backgroundColor: PANEL,
    borderRadius: 14,
    padding: 16,
    marginTop: 18,
    marginBottom: 18,
  },
  settingsDeviceDetails: {
    marginTop: 8,
    marginBottom: 4,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: '#30303d',
  },
  diagnosticButton: {
    flex: 0,
    marginTop: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  diagnosticResults: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#30303d',
    paddingTop: 8,
  },
  diagnosticRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 14,
    paddingVertical: 6,
  },
  diagnosticLabel: { color: '#8a8a99', fontSize: 12, flex: 1 },
  diagnosticValue: { color: '#fff', fontSize: 12, fontWeight: '600', flex: 1, textAlign: 'right' },
  diagnosticMessage: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    backgroundColor: PANEL_2,
    borderRadius: 10,
    padding: 11,
    marginTop: 10,
  },
  diagnosticMessageText: { flex: 1 },
  diagnosticStatus: { color: '#fff', fontSize: 13, fontWeight: '600', marginBottom: 3 },

  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#232330',
    paddingVertical: 10,
    backgroundColor: BG,
  },
  tabItem: { flex: 1, alignItems: 'center', gap: 3 },
  tabLabel: { color: '#6b6b78', fontSize: 11 },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalBox: {
    backgroundColor: PANEL,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  modalTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 16 },
  modalSectionDescription: { color: '#8a8a99', fontSize: 12, lineHeight: 17, marginBottom: 12 },
  tvTypeRow: { flexDirection: 'row', gap: 6, marginBottom: 12 },
  tvTypeChip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 9,
    backgroundColor: PANEL_2,
    borderWidth: 1,
    borderColor: '#3b3b48',
  },
  tvTypeChipActive: { backgroundColor: PURPLE_DARK, borderColor: PURPLE },
  tvTypeText: { color: '#8a8a99', fontSize: 11, fontWeight: '600' },
  tvTypeTextActive: { color: '#fff' },
  input: {
    backgroundColor: PANEL_2,
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 12,
  },
  primaryBtn: {
    backgroundColor: PANEL_2,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#444',
  },
  primaryBtnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  searchBtn: {
    backgroundColor: PURPLE_DARK,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  searchBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  smallBtn: {
    flex: 1,
    backgroundColor: PURPLE_DARK,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  smallBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  scanningRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16, gap: 10, justifyContent: 'center' },
  scanningText: { color: '#8a8a99', fontSize: 14 },
  connectionMessageBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
    padding: 11,
    borderRadius: 10,
    backgroundColor: '#22222d',
  },
  connectionMessageText: { color: '#b6b6c2', fontSize: 12, flex: 1 },
  deviceItem: { backgroundColor: PANEL_2, padding: 14, borderRadius: 10, marginTop: 8 },
  deviceName: { color: PURPLE, fontWeight: '700', fontSize: 15 },
  deviceIp: { color: '#8a8a99', fontSize: 13, marginTop: 4 },
  closeBtn: { alignItems: 'center', marginTop: 24 },
  closeBtnText: { color: '#8a8a99', fontSize: 15, fontWeight: '600' },
});
