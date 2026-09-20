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
} from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Network from 'expo-network';
import { Ionicons, MaterialIcons, MaterialCommunityIcons } from '@expo/vector-icons';
// Control por infrarojo — archivo separado, no modifica la lógica WiFi/ECP
import LuzInfrarojaScreen from './luz_infraroja';

const STORAGE_KEY = 'onn_tv_ip';
const ECP_PORT = 8060;
const PURPLE = '#8b5cf6';
const PURPLE_DARK = '#6d28d9';
const BG = '#0f0f14';
const PANEL = '#1a1a22';
const PANEL_2 = '#232330';

function fetchWithTimeout(url, options = {}, timeoutMs = 1500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(id)
  );
}

async function probeRoku(ip) {
  try {
    const res = await fetchWithTimeout(`http://${ip}:${ECP_PORT}/query/device-info`, {}, 1500);
    if (!res.ok) return null;
    const xml = await res.text();
    const nameMatch = xml.match(/<friendly-device-name>(.*?)<\/friendly-device-name>/);
    const modelMatch = xml.match(/<model-name>(.*?)<\/model-name>/);
    return {
      ip,
      name: nameMatch ? nameMatch[1] : 'Roku TV',
      model: modelMatch ? modelMatch[1] : '',
    };
  } catch (e) {
    return null;
  }
}

export default function App() {
  const [tvIp, setTvIp] = useState('');
  const [tvName, setTvName] = useState('');
  const [inputIp, setInputIp] = useState('');
  const [scanning, setScanning] = useState(false);
  const [foundDevices, setFoundDevices] = useState([]);
  const [connected, setConnected] = useState(false);
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('mando'); // mando (WiFi) | infrarrojo | canal | transmitir | ajustes
  const [mandoView, setMandoView] = useState('remote'); // remote | inputs

  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem(STORAGE_KEY);
      if (saved) {
        setTvIp(saved);
        setInputIp(saved);
        const device = await probeRoku(saved);
        if (device) {
          setConnected(true);
          setTvName(device.name);
        }
      }
    })();
  }, []);

  const saveIp = async (ip, name) => {
    await AsyncStorage.setItem(STORAGE_KEY, ip);
    setTvIp(ip);
    setInputIp(ip);
    setTvName(name || '');
  };

  const connectManual = async () => {
    if (!inputIp.trim()) return;
    setScanning(true);
    const device = await probeRoku(inputIp.trim());
    setScanning(false);
    if (device) {
      await saveIp(inputIp.trim(), device.name);
      setConnected(true);
      setConnectModalOpen(false);
    } else {
      setConnected(false);
      Alert.alert(
        'No se encontró la TV',
        'No se pudo contactar esa IP. Puedes guardarla e intentarlo después, pero para controlar una Roku por WiFi el teléfono debe tener acceso a la misma red local de la TV y "Control por apps móviles" debe estar activado en la TV.'
      );
    }
  };

  const scanNetwork = useCallback(async () => {
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
      const candidates = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
      const batchSize = 32;
      const results = [];
      for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(probeRoku));
        results.push(...batchResults.filter(Boolean));
      }
      setFoundDevices(results);
      if (results.length === 0) {
        Alert.alert(
          'No se encontró ninguna TV',
          'Prueba escribiendo la IP manualmente (Configuración > Red > Acerca de, en la TV).'
        );
      }
    } catch (e) {
      Alert.alert('Error al escanear', String(e));
    }
    setScanning(false);
  }, []);

  const selectDevice = async (device) => {
    await saveIp(device.ip, device.name);
    setConnected(true);
    setFoundDevices([]);
    setConnectModalOpen(false);
  };

  const sendKey = async (key) => {
    if (!tvIp) {
      setConnectModalOpen(true);
      return;
    }
    try {
      const res = await fetchWithTimeout(
        `http://${tvIp}:${ECP_PORT}/keypress/${encodeURIComponent(key)}`,
        { method: 'POST' },
        800 // Lower timeout for buttons so they feel responsive even if failing
      );
      if (!res.ok) {
        // Roku returns HTTP 403 (Forbidden) for certain keys like the D-pad (Up/Down/Left/Right) 
        // if the TV is in a state or app that blocks navigation input via ECP, 
        // or if a system dialog/screensaver is active. (Volume keys often bypass this).
        // Si tienes este problema, mandar el comando "Home" primero suele despertar la interfaz.
        console.warn('TV rejected command:', key, res.status);
      }
    } catch (e) {
      console.log('Error sendKey:', e);
      Alert.alert('Error de conexión', 'No se pudo enviar el comando a la TV. ¿Sigue encendida?');
      setConnected(false);
    }
  };

  // ---------- UI pieces ----------

  const ConnectBar = () => (
    <TouchableOpacity style={styles.connectBar} onPress={() => setConnectModalOpen(true)}>
      <View style={[styles.connectDot, { backgroundColor: connected ? '#22c55e' : '#555' }]} />
      <Text style={styles.connectBarText}>
        {connected ? (tvName || tvIp) : 'Toca para conectar...'}
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
          <Text style={styles.modalTitle}>Conectar con tu onn. Roku TV</Text>

          <TextInput
            style={styles.input}
            placeholder="IP de la TV (ej. 192.168.1.50)"
            placeholderTextColor="#777"
            value={inputIp}
            onChangeText={setInputIp}
            keyboardType="decimal-pad"
            autoCapitalize="none"
          />
          
          <TouchableOpacity style={styles.primaryBtn} onPress={connectManual}>
            <Text style={styles.primaryBtnText}>Conectar con esta IP</Text>
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity style={styles.searchBtn} onPress={scanNetwork}>
            <Ionicons name="search" size={20} color="#fff" />
            <Text style={styles.searchBtnText}>Buscar TVs en mi red WiFi</Text>
          </TouchableOpacity>

          {scanning && (
            <View style={styles.scanningRow}>
              <ActivityIndicator color={PURPLE} />
              <Text style={styles.scanningText}>Buscando (esto toma unos segundos)...</Text>
            </View>
          )}

          {foundDevices.length > 0 && (
            <ScrollView style={{ maxHeight: 180, marginTop: 10 }}>
              {foundDevices.map((d) => (
                <TouchableOpacity
                  key={d.ip}
                  style={styles.deviceItem}
                  onPress={() => selectDevice(d)}
                >
                  <Text style={styles.deviceName}>{d.name}</Text>
                  <Text style={styles.deviceIp}>
                    {d.ip} {d.model ? `· ${d.model}` : ''}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          <TouchableOpacity
            style={styles.closeBtn}
            onPress={() => setConnectModalOpen(false)}
          >
            <Text style={styles.closeBtnText}>Cerrar</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );

  const CrossPad = () => (
    <View style={styles.crossWrap}>
      <TouchableOpacity style={styles.crossUp} onPress={() => sendKey('Up')} activeOpacity={0.7}>
        <Ionicons name="chevron-up" size={30} color="#fff" />
      </TouchableOpacity>
      <View style={styles.crossMiddleRow}>
        <TouchableOpacity style={styles.crossLeft} onPress={() => sendKey('Left')} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={30} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.crossCenter} onPress={() => sendKey('Select')} activeOpacity={0.7}>
          <Text style={styles.okText}>OK</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.crossRight} onPress={() => sendKey('Right')} activeOpacity={0.7}>
          <Ionicons name="chevron-forward" size={30} color="#fff" />
        </TouchableOpacity>
      </View>
      <TouchableOpacity style={styles.crossDown} onPress={() => sendKey('Down')} activeOpacity={0.7}>
        <Ionicons name="chevron-down" size={30} color="#fff" />
      </TouchableOpacity>
    </View>
  );

  const IconBtn = ({ icon, IconSet = Ionicons, onPress, size = 22, wide }) => (
    <TouchableOpacity
      style={[styles.roundBtn, wide && styles.roundBtnWide]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <IconSet name={icon} size={size} color="#e6e6ea" />
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
          style={styles.inputChip}
          onPress={() => sendKey(key)}
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
          style={styles.powerBtn}
          onPress={() => sendKey('PowerOff')}
          activeOpacity={0.7}
        >
          <Ionicons name="power" size={22} color={PURPLE} />
        </TouchableOpacity>

        <View style={styles.segmented}>
          <TouchableOpacity
            style={[styles.segment, mandoView === 'remote' && styles.segmentActive]}
            onPress={() => setMandoView('remote')}
          >
            <MaterialCommunityIcons
              name="remote"
              size={20}
              color={mandoView === 'remote' ? '#fff' : '#8a8a99'}
            />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.segment, mandoView === 'inputs' && styles.segmentActive]}
            onPress={() => setMandoView('inputs')}
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
            <IconBtn icon="arrow-back" onPress={() => sendKey('Back')} />
            <IconBtn icon="home" onPress={() => sendKey('Home')} wide />
            <IconBtn icon="search" onPress={() => sendKey('Search')} />
          </View>

          <View style={styles.row3}>
            <IconBtn icon="play-back" onPress={() => sendKey('Rev')} />
            <IconBtn icon="play-pause" IconSet={MaterialCommunityIcons} onPress={() => sendKey('Play')} />
            <IconBtn icon="play-forward" onPress={() => sendKey('Fwd')} />
            <IconBtn icon="asterisk" IconSet={MaterialCommunityIcons} onPress={() => sendKey('Info')} />
          </View>

          <View style={styles.row3}>
            <IconBtn icon="volume-mute" onPress={() => sendKey('VolumeMute')} />
            <IconBtn icon="volume-low" onPress={() => sendKey('VolumeDown')} />
            <IconBtn icon="volume-high" onPress={() => sendKey('VolumeUp')} />
            <IconBtn icon="reload" onPress={() => sendKey('InstantReplay')} />
          </View>
        </>
      ) : (
        <InputsView />
      )}
    </>
  );

  const CanalTab = () => {
    const [num, setNum] = useState('');
    const digit = (d) => {
      setNum((n) => n + d);
      sendKey(`Lit_${d}`);
    };
    return (
      <View style={{ alignItems: 'center' }}>
        <View style={styles.row3}>
          <IconBtn icon="remove" onPress={() => sendKey('ChannelDown')} wide />
          <Text style={styles.channelNum}>{num || '—'}</Text>
          <IconBtn icon="add" onPress={() => sendKey('ChannelUp')} wide />
        </View>
        <View style={styles.numpad}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'OK'].map((d, i) =>
            d === '' ? (
              <View key={i} style={styles.numKey} />
            ) : (
              <TouchableOpacity
                key={i}
                style={styles.numKey}
                onPress={() => (d === 'OK' ? sendKey('Enter') : digit(d))}
              >
                <Text style={styles.numKeyText}>{d}</Text>
              </TouchableOpacity>
            )
          )}
        </View>
      </View>
    );
  };

  const TransmitirTab = () => (
    <View style={styles.centeredInfo}>
      <Ionicons name="tv-outline" size={48} color="#4a4a5a" />
      <Text style={styles.infoText}>
        Transmitir contenido (Cast) no está incluido en esta base — requiere el
        protocolo de descubrimiento SSDP, que se puede añadir después si lo
        necesitas.
      </Text>
    </View>
  );

  const AjustesTab = () => (
    <View style={styles.ajustesBox}>
      <Text style={styles.ajustesLabel}>TV conectada</Text>
      <Text style={styles.ajustesValue}>
        {connected ? `${tvName || 'Roku TV'} (${tvIp})` : 'Ninguna'}
      </Text>
      <TouchableOpacity
        style={styles.smallBtn}
        onPress={() => setConnectModalOpen(true)}
      >
        <Text style={styles.smallBtnText}>Cambiar / reconectar</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.smallBtn, { marginTop: 10, backgroundColor: '#3a1e1e' }]}
        onPress={async () => {
          await AsyncStorage.removeItem(STORAGE_KEY);
          setTvIp('');
          setTvName('');
          setConnected(false);
        }}
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
          {activeTab === 'infrarrojo' && <LuzInfrarojaScreen />}
          {activeTab === 'canal' && <CanalTab />}
          {activeTab === 'transmitir' && <TransmitirTab />}
          {activeTab === 'ajustes' && <AjustesTab />}
        </ScrollView>

        <View style={styles.tabBar}>
          {[
            ['mando', 'person', 'Mando'],
            ['infrarrojo', 'flash', 'IR'],
            ['canal', 'grid', 'Canal'],
            ['transmitir', 'tv', 'Transmitir'],
            ['ajustes', 'settings-sharp', 'Ajustes'],
          ].map(([key, icon, label]) => (
            <TouchableOpacity
              key={key}
              style={styles.tabItem}
              onPress={() => setActiveTab(key)}
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
  connectBarText: { color: '#c7c7d1', fontSize: 14, fontWeight: '600' },

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
  roundBtn: {
    flex: 1,
    height: 56,
    borderRadius: 18,
    backgroundColor: PANEL_2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundBtnWide: { flex: 1.6 },

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

  centeredInfo: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 20 },
  infoText: { color: '#8a8a99', textAlign: 'center', marginTop: 14, lineHeight: 20 },

  ajustesBox: { width: '100%' },
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
  deviceItem: { backgroundColor: PANEL_2, padding: 14, borderRadius: 10, marginTop: 8 },
  deviceName: { color: PURPLE, fontWeight: '700', fontSize: 15 },
  deviceIp: { color: '#8a8a99', fontSize: 13, marginTop: 4 },
  closeBtn: { alignItems: 'center', marginTop: 24 },
  closeBtnText: { color: '#8a8a99', fontSize: 15, fontWeight: '600' },
});
