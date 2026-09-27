import React, { useState, useEffect, useCallback } from 'react';
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
} from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Network from 'expo-network';
import { Ionicons, MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
import LuzInfrarojaScreen from './luz_infraroja';
import { getAdapter, probeIp, scanSubnet } from './tvAdapters';

const LEGACY_STORAGE_KEY = 'onn_tv_ip';
const DEVICE_STORAGE_KEY = 'connected_tv_device_v2';
const VIBRATION_STORAGE_KEY = 'button_vibration_enabled';
const VIBRATION_LEVEL_STORAGE_KEY = 'button_vibration_level';
const PURPLE = '#8b5cf6';
const PURPLE_DARK = '#6d28d9';
const BG = '#0f0f14';
const PANEL = '#1a1a22';
const PANEL_2 = '#232330';
const VIBRATION_LEVELS = {
  suave: 25,
  media: 45,
  fuerte: 75,
};
const REMOTE_APP_SHORTCUTS = [
  { key: 'netflix', label: 'Netflix', aliases: ['netflix'] },
  { key: 'youtube', label: 'YouTube', aliases: ['youtube'] },
  {
    key: 'crunchyroll',
    label: 'Crunchyroll',
    aliases: ['crunchyroll'],
  },
];

function findShortcutApp(apps, aliases) {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  return (
    apps.find((app) => normalizedAliases.includes(app.name.toLowerCase())) ||
    apps.find((app) =>
      normalizedAliases.some((alias) => app.name.toLowerCase().includes(alias))
    )
  );
}

export default function App() {
  const [tvIp, setTvIp] = useState('');
  const [tvName, setTvName] = useState('');
  const [connectedDevice, setConnectedDevice] = useState(null);
  const [inputIp, setInputIp] = useState('');
  const [manualTvType, setManualTvType] = useState('auto');
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
  const vibrationDuration = VIBRATION_LEVELS[buttonVibrationLevel];
  const tvCapabilities = connectedDevice?.capabilities || {};

  const persistDevice = async (device) => {
    await AsyncStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(device));
    await AsyncStorage.setItem(LEGACY_STORAGE_KEY, device.ip);
  };

  const connectDevice = async (device, { automatic = false } = {}) => {
    const adapter = getAdapter(device?.type);
    if (!adapter) throw new Error('Tipo de TV no compatible.');
    setConnectionStatus('connecting');
    setPairingState(device.capabilities?.pairingRequired ? 'waiting' : 'not_required');
    setConnectionMessage(device.capabilities?.pairingRequired ? 'Autoriza onn Remote en la pantalla de tu TV.' : 'Conectando...');
    try {
      const connectedTv = await adapter.connect(device, {
        onPairingState: setPairingState,
        onAuth: (auth) => {
          const updated = { ...device, auth };
          setConnectedDevice(updated);
          persistDevice(updated).catch(() => {});
        },
      });
      setConnectedDevice(connectedTv);
      setTvIp(connectedTv.ip);
      setInputIp(connectedTv.ip);
      setTvName(connectedTv.name);
      setConnected(true);
      setConnectionStatus('connected');
      setPairingState(connectedTv.auth?.state || 'not_required');
      setConnectionMessage(automatic ? 'Conectada automáticamente' : 'TV conectada');
      setInstalledApps([]);
      setAppsError('');
      await persistDevice(connectedTv);
      return connectedTv;
    } catch (error) {
      setConnected(false);
      setConnectionStatus('error');
      setConnectionMessage(error.message || String(error));
      throw error;
    }
  };

  const restoreSavedDevice = async (device) => {
    try {
      await connectDevice(device, { automatic: true });
      return;
    } catch (_) {}

    // Si la IP cambió, localizar de nuevo el mismo equipo por su id/tipo.
    try {
      const myIp = await Network.getIpAddressAsync();
      if (!myIp || myIp === '0.0.0.0' || device.type === 'lg') return;
      const prefix = myIp.split('.').slice(0, 3).join('.');
      const devices = await scanSubnet(prefix);
      const moved = devices.find((item) => item.type === device.type && item.id === device.id);
      if (moved) await connectDevice({ ...moved, auth: device.auth }, { automatic: true });
    } catch (_) {}
  };

  useEffect(() => {
    (async () => {
      try {
        const [savedVibration, savedVibrationLevel, savedDeviceJson, legacyIp] = await Promise.all([
          AsyncStorage.getItem(VIBRATION_STORAGE_KEY),
          AsyncStorage.getItem(VIBRATION_LEVEL_STORAGE_KEY),
          AsyncStorage.getItem(DEVICE_STORAGE_KEY),
          AsyncStorage.getItem(LEGACY_STORAGE_KEY),
        ]);

        setButtonVibrationEnabled(savedVibration === 'true');
        if (savedVibrationLevel && VIBRATION_LEVELS[savedVibrationLevel]) {
          setButtonVibrationLevel(savedVibrationLevel);
        }

        if (savedDeviceJson) {
          const savedDevice = JSON.parse(savedDeviceJson);
          setConnectedDevice(savedDevice);
          setTvIp(savedDevice.ip);
          setInputIp(savedDevice.ip);
          setTvName(savedDevice.name || '');
          await restoreSavedDevice(savedDevice);
        } else if (legacyIp) {
          setInputIp(legacyIp);
          const legacyDevice = await probeIp(legacyIp, 'roku');
          if (legacyDevice) await connectDevice(legacyDevice, { automatic: true });
        }
      } catch (error) {
        console.warn('No se pudo restaurar la configuración guardada:', error);
      }
    })();
  }, []);

  useEffect(() => {
    const subscription = Network.addNetworkStateListener((state) => {
      if (state.isConnected && connectedDevice && !connected && connectionStatus !== 'connecting') {
        connectDevice(connectedDevice, { automatic: true }).catch(() => {});
      }
      if (state.isConnected === false) {
        setConnected(false);
        setConnectionStatus('disconnected');
        setConnectionMessage('Sin conexión Wi‑Fi');
      }
    });
    return () => subscription.remove();
  }, [connectedDevice, connected, connectionStatus]);

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

  const connectManual = async () => {
    if (!inputIp.trim()) return;
    setScanning(true);
    try {
      const device = await probeIp(inputIp.trim(), manualTvType);
      if (!device) throw new Error('No se reconoció una Roku o Samsung en esa IP. Para LG selecciona LG webOS antes de conectar.');
      await connectDevice(device);
      setConnectModalOpen(false);
    } catch (error) {
      Alert.alert('No se encontró la TV', error.message || String(error));
    } finally {
      setScanning(false);
    }
  };

  const scanDevices = useCallback(async () => {
    setScanning(true);
    setFoundDevices([]);
    try {
      const myIp = await Network.getIpAddressAsync();
      console.log('Mi IP es:', myIp);
      if (!myIp || myIp === '0.0.0.0') {
        Alert.alert('Sin WiFi', 'Conecta el teléfono a la misma red WiFi que la TV.');
        setScanning(false);
        return;
      }
      const prefix = myIp.split('.').slice(0, 3).join('.');
      const results = await scanSubnet(prefix, setFoundDevices);
      setFoundDevices(results);
      if (results.length === 0) {
        Alert.alert(
          'No se encontró ninguna TV',
          'Se buscaron Roku y Samsung. Para LG webOS selecciona LG y escribe su IP manualmente para evitar avisos de emparejamiento en otras TVs.'
        );
      }
    } catch (e) {
      Alert.alert('Error al escanear', String(e));
    }
    setScanning(false);
  }, []);

  const selectDevice = async (device) => {
    try {
      await connectDevice(device);
      setFoundDevices([]);
      setConnectModalOpen(false);
    } catch (error) {
      Alert.alert('No se pudo conectar', error.message || String(error));
    }
  };

  const loadTvApps = useCallback(async () => {
    if (!connectedDevice) {
      setInstalledApps([]);
      setAppsError('Conecta una TV para consultar sus aplicaciones.');
      return [];
    }
    if (!connectedDevice.capabilities?.installedApps) {
      setInstalledApps([]);
      setAppsError(`${connectedDevice.name} no permite consultar sus aplicaciones mediante el protocolo disponible.`);
      return [];
    }

    setAppsLoading(true);
    setAppsError('');
    setFailedAppIcons({});
    try {
      const adapter = getAdapter(connectedDevice.type);
      const apps = await adapter.loadApps(connectedDevice, { onPairingState: setPairingState });
      setInstalledApps(apps);
      if (apps.length === 0) {
        setAppsError('La TV no devolvió aplicaciones instaladas.');
      }
      return apps;
    } catch (error) {
      setInstalledApps([]);
      setAppsError('No se pudieron cargar las aplicaciones de la TV.');
      console.warn('Error loadTvApps:', error);
      return [];
    } finally {
      setAppsLoading(false);
    }
  }, [connectedDevice]);

  useEffect(() => {
    if (activeTab === 'apps' || (activeTab === 'mando' && connectedDevice && installedApps.length === 0)) {
      loadTvApps();
    }
  }, [activeTab, installedApps.length, loadTvApps, connectedDevice]);

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
      await getAdapter(connectedDevice.type).sendKey(connectedDevice, key, { onPairingState: setPairingState });
    } catch (error) {
      console.warn('Error sendRemoteKey:', error);
      Alert.alert('Error de conexión', error.message || 'No se pudo enviar el comando a la TV.');
      setConnected(false);
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
      await getAdapter(connectedDevice.type).tuneChannel(connectedDevice, channelNumber, { onPairingState: setPairingState });
    } catch (error) {
      console.warn('Error tuneChannel:', error);
      Alert.alert(
        'No se pudo cambiar el canal',
        error.message || 'Comprueba que la antena o TV en vivo esté configurada.'
      );
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
      await getAdapter(connectedDevice.type).launchApp(connectedDevice, app, { onPairingState: setPairingState });
    } catch (error) {
      console.warn('Error launchApp:', error);
      Alert.alert('No se pudo abrir la app', `La TV no pudo abrir ${app.name}.`);
    }
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
    const app = findShortcutApp(apps, shortcut.aliases);
    if (!app) {
      vibrateButton();
      Alert.alert(
        `${shortcut.label} no está disponible`,
        `No encontré ${shortcut.label} entre las aplicaciones instaladas en esta Roku TV.`
      );
      return;
    }

    await launchTvApp(app);
  };

  const disconnectDevice = () => {
    if (connectedDevice) getAdapter(connectedDevice.type)?.disconnect(connectedDevice);
    setConnected(false);
    setConnectionStatus('disconnected');
    setConnectionMessage('TV desconectada');
  };

  const forgetDevice = async () => {
    disconnectDevice();
    await Promise.all([
      AsyncStorage.removeItem(DEVICE_STORAGE_KEY),
      AsyncStorage.removeItem(LEGACY_STORAGE_KEY),
    ]);
    setConnectedDevice(null);
    setTvIp('');
    setTvName('');
    setInstalledApps([]);
  };

  // ---------- UI pieces ----------

  const ConnectBar = () => (
    <TouchableOpacity
      style={styles.connectBar}
      onPress={() => {
        vibrateButton();
        setConnectModalOpen(true);
        scanDevices();
      }}
    >
      <View style={[styles.connectDot, { backgroundColor: connected ? '#22c55e' : '#555' }]} />
      <Text style={styles.connectBarText}>
        {connected
          ? `${tvName || tvIp} · ${connectedDevice?.type?.toUpperCase()}${connectionMessage === 'Conectada automáticamente' ? ' · Conectada automáticamente' : ''}`
          : 'Toca para conectar...'}
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
              ['auto', 'Automático'],
              ['roku', 'Roku'],
              ['samsung', 'Samsung'],
              ['lg', 'LG'],
            ].map(([type, label]) => (
              <TouchableOpacity
                key={type}
                style={[styles.tvTypeChip, manualTvType === type && styles.tvTypeChipActive]}
                onPress={() => { vibrateButton(); setManualTvType(type); }}
              >
                <Text style={[styles.tvTypeText, manualTvType === type && styles.tvTypeTextActive]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>

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

          <View style={styles.divider} />

          <TouchableOpacity style={styles.searchBtn} onPress={() => { vibrateButton(); scanDevices(); }}>
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
                  <Text style={styles.deviceName}>{d.name} · {d.type.toUpperCase()}</Text>
                  <Text style={styles.deviceIp}>
                    {d.ip} {d.model ? `· ${d.model}` : ''}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          <TouchableOpacity
            style={styles.closeBtn}
            onPress={() => { vibrateButton(); setConnectModalOpen(false); }}
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

  const MandoTab = () => (
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

          <View style={styles.remoteShortcutsRow}>
            {REMOTE_APP_SHORTCUTS.map((shortcut) => {
              const app = findShortcutApp(installedApps, shortcut.aliases);
              const iconFailed = app && failedAppIcons[app.id];
              return (
                <TouchableOpacity
                  key={shortcut.key}
                  style={[
                    styles.remoteShortcutButton,
                    (appsLoading || !tvCapabilities.launchApp) && styles.remoteShortcutButtonLoading,
                  ]}
                  onPress={() => openRemoteShortcut(shortcut)}
                  disabled={appsLoading || !tvCapabilities.launchApp}
                  activeOpacity={0.75}
                  accessibilityLabel={`Abrir ${shortcut.label} en la TV`}
                >
                  {app?.iconUri && !iconFailed ? (
                    <Image
                      source={{ uri: app.iconUri }}
                      style={styles.remoteShortcutImage}
                      resizeMode="contain"
                      fadeDuration={150}
                      onError={() => {
                        setFailedAppIcons((current) => ({ ...current, [app.id]: true }));
                      }}
                    />
                  ) : (
                    <Ionicons name="image-outline" size={32} color="#5f5f6d" />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </>
      ) : (
        <InputsView />
      )}
    </>
  );

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

      <Text style={styles.ajustesLabel}>TV conectada</Text>
      <Text style={styles.ajustesValue}>
        {connectedDevice ? `${tvName || connectedDevice.name} · ${connectedDevice.type.toUpperCase()} (${tvIp})` : 'Ninguna'}
      </Text>
      {!!connectedDevice && (
        <Text style={styles.settingDescription}>
          Estado: {connected ? 'Conectada' : connectionStatus === 'connecting' ? 'Conectando' : 'Desconectada'}
          {connectedDevice.capabilities?.pairingRequired ? ` · Emparejamiento: ${pairingState}` : ''}
        </Text>
      )}
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
  ajustesLabel: { color: '#8a8a99', fontSize: 13, marginTop: 10 },
  ajustesValue: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 16 },

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
  divider: { height: 1, backgroundColor: '#333', marginVertical: 20 },
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
