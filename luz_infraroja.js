/**
 * Control IR multi-marca. Es independiente de la conexión Wi-Fi del Roku.
 * Expo Go permite configurarlo; transmitir requiere el APK y hardware IR.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Modal, Platform, ScrollView, StyleSheet, Text,
  TouchableOpacity, Vibration, View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import catalog from './ir_tv_catalog.json';

let hasIrBlaster = null;
let transmit = null;
try {
  ({ hasIrBlaster, transmit } = require('@sachinjs/ir-transmit'));
} catch (_) {
  // Expo Go no incluye este módulo nativo; Wi-Fi continúa disponible.
}

const ORANGE = '#f97316';
const PANEL = '#1a1a22';
const PANEL_2 = '#232330';
const BRAND_KEY = '@onn_remote_ir_brand';
const REMOTE_KEY = '@onn_remote_ir_remote';

const bit = (value, index) => Math.floor(value / (2 ** index)) % 2;

function pulseDistance(data, count, header, mark, zeroSpace, oneSpace) {
  const result = [...header];
  for (let index = 0; index < count; index += 1) {
    result.push(mark, bit(data, index) ? oneSpace : zeroSpace);
  }
  result.push(mark);
  return result;
}

function appendSigned(result, value) {
  if (result.length && Math.sign(result[result.length - 1]) === Math.sign(value)) {
    result[result.length - 1] += value;
  } else result.push(value);
}

function manchesterBit(result, value, halfBit, oneIsMarkFirst) {
  const markFirst = value ? oneIsMarkFirst : !oneIsMarkFirst;
  appendSigned(result, markFirst ? halfBit : -halfBit);
  appendSigned(result, markFirst ? -halfBit : halfBit);
}

function cleanSigned(result) {
  while (result[0] < 0) result.shift();
  while (result[result.length - 1] < 0) result.pop();
  return result.map(Math.abs);
}

function encodeNEC(signal) {
  let data;
  if (signal.protocol === 'NEC') {
    const address = signal.address & 0xff;
    const command = signal.command & 0xff;
    data = address + (((~address) & 0xff) * 0x100)
      + (command * 0x10000) + (((~command) & 0xff) * 0x1000000);
  } else {
    data = (signal.address & 0xffff) + ((signal.command & 0xffff) * 0x10000);
  }
  return { frequency: 38000, pattern: pulseDistance(data, 32, [9000, 4500], 562, 562, 1687) };
}

function encodeSamsung(signal) {
  const address = signal.address & 0xff;
  const command = signal.command & 0xff;
  const data = address + (address * 0x100) + (command * 0x10000)
    + (((~command) & 0xff) * 0x1000000);
  return { frequency: 38000, pattern: pulseDistance(data, 32, [4500, 4500], 560, 560, 1690) };
}

function encodeSony(signal) {
  const addressBits = signal.protocol === 'SIRC20' ? 13 : signal.protocol === 'SIRC15' ? 8 : 5;
  const data = (signal.command & 0x7f) + (signal.address * 0x80);
  const frame = [2400];
  for (let index = 0; index < 7 + addressBits; index += 1) {
    frame.push(600, bit(data, index) ? 1200 : 600);
  }
  frame.push(Math.max(10000, 45000 - frame.reduce((sum, value) => sum + value, 0)));
  return { frequency: 40000, pattern: [...frame, ...frame, ...frame.slice(0, -1)] };
}

function encodeRC5(signal) {
  const command = signal.command & 0x7f;
  // Flipper guarda RC5X como variante explícita; su segundo bit de inicio es 0.
  const bits = [1, signal.protocol === 'RC5X' ? 0 : 1, 0];
  for (let index = 4; index >= 0; index -= 1) bits.push(bit(signal.address, index));
  for (let index = 5; index >= 0; index -= 1) bits.push(bit(command, index));
  const signed = [];
  bits.forEach((value) => manchesterBit(signed, value, 889, false));
  return { frequency: 36000, pattern: cleanSigned(signed) };
}

function encodeRC6(signal) {
  const signed = [2664, -888];
  manchesterBit(signed, 1, 444, true);
  [0, 0, 0].forEach((value) => manchesterBit(signed, value, 444, true));
  manchesterBit(signed, 0, 888, true);
  for (let index = 7; index >= 0; index -= 1) manchesterBit(signed, bit(signal.address, index), 444, true);
  for (let index = 7; index >= 0; index -= 1) manchesterBit(signed, bit(signal.command, index), 444, true);
  return { frequency: 36000, pattern: cleanSigned(signed) };
}

function encodeKaseikyo(signal) {
  const id = Math.floor(signal.address / 0x1000000) & 3;
  const vendor = Math.floor(signal.address / 0x100) & 0xffff;
  const vendorLow = vendor & 0xff;
  const vendorHigh = Math.floor(vendor / 0x100) & 0xff;
  const vendorXor = vendorLow ^ vendorHigh;
  const bytes = [
    vendorLow,
    vendorHigh,
    ((vendorXor & 0xf) ^ (vendorXor >> 4)) | ((Math.floor(signal.address / 0x10) & 0xf) << 4),
    (signal.address & 0xf) | ((signal.command & 0xf) << 4),
    (id << 6) | ((signal.command >> 4) & 0x3f),
  ];
  bytes.push(bytes[2] ^ bytes[3] ^ bytes[4]);
  let data = 0;
  bytes.forEach((value, index) => { data += value * (2 ** (index * 8)); });
  return { frequency: 38000, pattern: pulseDistance(data, 48, [3456, 1728], 432, 432, 1296) };
}

function encodeRCA(signal) {
  const address = signal.address & 0xf;
  const command = signal.command & 0xff;
  const data = address + (command << 4) + (((~address) & 0xf) << 12)
    + (((~command) & 0xff) * 0x10000);
  const frame = pulseDistance(data, 24, [4000, 4000], 500, 1000, 2000);
  return { frequency: 38000, pattern: [...frame, 8000, ...frame] };
}

function encodePioneer(signal) {
  const address = signal.address & 0xff;
  const command = signal.command & 0xff;
  const data = address + (((~address) & 0xff) * 0x100)
    + (command * 0x10000) + (((~command) & 0xff) * 0x1000000);
  return { frequency: 40000, pattern: pulseDistance(data, 32, [9000, 4500], 562, 562, 1687) };
}

function encodeSignal(signal) {
  if (!signal) return null;
  if (signal.type === 'raw') return { frequency: signal.frequency, pattern: signal.data };
  if (['NEC', 'NECext'].includes(signal.protocol)) return encodeNEC(signal);
  if (signal.protocol === 'Samsung32') return encodeSamsung(signal);
  if (['SIRC', 'SIRC15', 'SIRC20'].includes(signal.protocol)) return encodeSony(signal);
  if (['RC5', 'RC5X'].includes(signal.protocol)) return encodeRC5(signal);
  if (signal.protocol === 'RC6') return encodeRC6(signal);
  if (signal.protocol === 'Kaseikyo') return encodeKaseikyo(signal);
  if (signal.protocol === 'RCA') return encodeRCA(signal);
  if (signal.protocol === 'Pioneer') return encodePioneer(signal);
  return null;
}

async function sendIR(signal) {
  if (!signal) return { ok: false, reason: 'sin código' };
  if (!hasIrBlaster || !transmit) return { ok: false, reason: 'módulo no disponible' };
  try {
    if (!hasIrBlaster()) return { ok: false, reason: 'sin emisor IR' };
    const encoded = encodeSignal(signal);
    if (!encoded) return { ok: false, reason: 'protocolo no compatible' };
    const result = transmit(encoded.frequency, encoded.pattern);
    return result?.success ? { ok: true } : { ok: false, reason: result?.message || 'error de envío' };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}

function SelectorModal({ visible, title, items, selectedId, onSelect, onClose }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={onClose}>
        <View style={s.modalCard} onStartShouldSetResponder={() => true}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose} style={s.closeBtn}>
              <Ionicons name="close" size={22} color="#fff" />
            </TouchableOpacity>
          </View>
          <ScrollView style={s.modalList} nestedScrollEnabled>
            {items.map((item) => (
              <TouchableOpacity
                key={item.id}
                style={[s.option, item.id === selectedId && s.optionSelected]}
                onPress={() => onSelect(item.id)}
              >
                <Text style={[s.optionText, item.id === selectedId && s.optionTextSelected]}>{item.name}</Text>
                {item.id === selectedId && <Ionicons name="checkmark" size={20} color={ORANGE} />}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

function IRBtn({ icon, IconSet = Ionicons, commandKey, onSend, available, label, wide }) {
  return (
    <TouchableOpacity
      style={[s.roundBtn, wide && s.roundBtnWide, !available && s.disabled]}
      disabled={!available}
      onPress={() => onSend(commandKey)}
      activeOpacity={0.7}
    >
      <IconSet name={icon} size={22} color={available ? '#e6e6ea' : '#555563'} />
      {label ? <Text style={[s.btnLabel, !available && s.disabledText]}>{label}</Text> : null}
    </TouchableOpacity>
  );
}

export default function LuzInfrarojaScreen({ vibrationEnabled = false, vibrationDuration = 12 }) {
  const initialBrand = catalog.brands.find((item) => item.id === 'Onn') || catalog.brands[0];
  const [brandId, setBrandId] = useState(initialBrand.id);
  const [remoteId, setRemoteId] = useState(initialBrand.remotes[0].id);
  const [brandModal, setBrandModal] = useState(false);
  const [remoteModal, setRemoteModal] = useState(false);
  const [hwStatus, setHwStatus] = useState('checking');
  const [lastResult, setLastResult] = useState(null);

  const brand = useMemo(
    () => catalog.brands.find((item) => item.id === brandId) || initialBrand,
    [brandId],
  );
  const remote = useMemo(
    () => brand.remotes.find((item) => item.id === remoteId) || brand.remotes[0],
    [brand, remoteId],
  );
  const commands = remote.commands;

  useEffect(() => {
    Promise.all([AsyncStorage.getItem(BRAND_KEY), AsyncStorage.getItem(REMOTE_KEY)])
      .then(([savedBrandId, savedRemoteId]) => {
        const savedBrand = catalog.brands.find((item) => item.id === savedBrandId);
        if (!savedBrand) return;
        setBrandId(savedBrand.id);
        const savedRemote = savedBrand.remotes.find((item) => item.id === savedRemoteId);
        setRemoteId((savedRemote || savedBrand.remotes[0]).id);
      }).catch(() => {});
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android' || !hasIrBlaster || !transmit) {
      setHwStatus('unavailable');
      return;
    }
    try {
      setHwStatus(hasIrBlaster() ? 'ok' : 'unavailable');
    } catch (_) {
      setHwStatus('unavailable');
    }
  }, []);

  const selectBrand = (nextId) => {
    const nextBrand = catalog.brands.find((item) => item.id === nextId);
    if (!nextBrand) return;
    const nextRemoteId = nextBrand.remotes[0].id;
    setBrandId(nextId);
    setRemoteId(nextRemoteId);
    setBrandModal(false);
    Promise.all([
      AsyncStorage.setItem(BRAND_KEY, nextId),
      AsyncStorage.setItem(REMOTE_KEY, nextRemoteId),
    ]).catch(() => {});
  };

  const selectRemote = (nextId) => {
    setRemoteId(nextId);
    setRemoteModal(false);
    AsyncStorage.setItem(REMOTE_KEY, nextId).catch(() => {});
  };

  const onSend = async (commandKey) => {
    const signal = commands[commandKey];
    if (!signal) return;
    if (vibrationEnabled) Vibration.vibrate(vibrationDuration);
    const result = await sendIR(signal);
    setLastResult(result.ok ? 'ok' : result.reason);
    setTimeout(() => setLastResult(null), result.ok ? 700 : 2200);
  };

  const dpad = (key, style, icon) => (
    <TouchableOpacity
      style={[style, !commands[key] && s.disabled]}
      disabled={!commands[key]}
      onPress={() => onSend(key)}
      activeOpacity={0.7}
    >
      <Ionicons name={icon} size={30} color={commands[key] ? '#fff' : '#73431f'} />
    </TouchableOpacity>
  );

  return (
    <ScrollView contentContainerStyle={s.scroll} nestedScrollEnabled>
      <SelectorModal visible={brandModal} title={`Marca (${catalog.brands.length})`} items={catalog.brands} selectedId={brand.id} onSelect={selectBrand} onClose={() => setBrandModal(false)} />
      <SelectorModal visible={remoteModal} title="Control / modelo" items={brand.remotes} selectedId={remote.id} onSelect={selectRemote} onClose={() => setRemoteModal(false)} />

      <View style={s.header}>
        <Ionicons name="flash" size={18} color={ORANGE} />
        <Text style={s.headerText}>Control por Infrarrojo</Text>
        {lastResult === 'ok' && <Ionicons name="checkmark-circle" size={18} color="#22c55e" />}
        {lastResult && lastResult !== 'ok' && <Ionicons name="alert-circle" size={18} color="#ef4444" />}
      </View>

      <View style={s.selectorRow}>
        <TouchableOpacity style={s.selector} onPress={() => setBrandModal(true)}>
          <Text style={s.selectorLabel}>Marca</Text>
          <View style={s.selectorValueRow}>
            <Text style={s.selectorValue} numberOfLines={1}>{brand.name}</Text>
            <Ionicons name="chevron-down" size={16} color={ORANGE} />
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={s.selector} onPress={() => setRemoteModal(true)}>
          <Text style={s.selectorLabel}>Control / modelo</Text>
          <View style={s.selectorValueRow}>
            <Text style={s.selectorValue} numberOfLines={1}>{remote.name}</Text>
            <Ionicons name="chevron-down" size={16} color={ORANGE} />
          </View>
        </TouchableOpacity>
      </View>
      <Text style={s.coverageText}>{Object.keys(commands).length} botones compatibles en este perfil</Text>

      {hwStatus === 'checking' && (
        <View style={s.hardwareBox}>
          <ActivityIndicator color={ORANGE} size="large" />
          <Text style={s.statusText}>Verificando hardware IR...</Text>
        </View>
      )}

      {hwStatus === 'unavailable' && (
        <View style={s.unavailableBox}>
          <Ionicons name="flash-off-outline" size={54} color="#555" />
          <Text style={s.unavailableTitle}>Luz infrarroja no disponible</Text>
          <Text style={s.unavailableBody}>
            {!hasIrBlaster || !transmit
              ? 'Expo Go no incluye el módulo IR. Instala el APK para transmitir; aquí sí puedes elegir y guardar la marca y el modelo.'
              : Platform.OS !== 'android'
                ? 'El control infrarrojo requiere Android y hardware IR físico.'
                : 'Este teléfono no reporta un emisor infrarrojo. El control por Wi-Fi sigue disponible en Mando.'}
          </Text>
        </View>
      )}

      {hwStatus === 'ok' && (
        <>
          {lastResult && lastResult !== 'ok' && <Text style={s.errorText}>No se pudo enviar: {lastResult}</Text>}
          <TouchableOpacity style={[s.powerBtn, !commands.PowerToggle && s.disabled]} disabled={!commands.PowerToggle} onPress={() => onSend('PowerToggle')}>
            <Ionicons name="power" size={24} color={commands.PowerToggle ? ORANGE : '#555563'} />
          </TouchableOpacity>

          <View style={s.crossWrap}>
            {dpad('Up', s.crossUp, 'chevron-up')}
            <View style={s.crossMiddleRow}>
              {dpad('Left', s.crossLeft, 'chevron-back')}
              <TouchableOpacity style={[s.crossCenter, !commands.Select && s.disabled]} disabled={!commands.Select} onPress={() => onSend('Select')}>
                <Text style={[s.okText, !commands.Select && s.disabledText]}>OK</Text>
              </TouchableOpacity>
              {dpad('Right', s.crossRight, 'chevron-forward')}
            </View>
            {dpad('Down', s.crossDown, 'chevron-down')}
          </View>

          <View style={s.row}>
            <IRBtn icon="arrow-back" commandKey="Back" onSend={onSend} available={!!commands.Back} />
            <IRBtn icon="home" commandKey="Home" onSend={onSend} available={!!commands.Home} wide />
            <IRBtn icon="search" commandKey="Search" onSend={onSend} available={!!commands.Search} />
          </View>
          <View style={s.row}>
            <IRBtn icon="play-back" commandKey="Rev" onSend={onSend} available={!!commands.Rev} />
            <IRBtn icon="play-pause" commandKey="Play" onSend={onSend} available={!!commands.Play} IconSet={MaterialCommunityIcons} />
            <IRBtn icon="play-forward" commandKey="Fwd" onSend={onSend} available={!!commands.Fwd} />
            <IRBtn icon="asterisk" commandKey="Info" onSend={onSend} available={!!commands.Info} IconSet={MaterialCommunityIcons} />
          </View>
          <View style={s.row}>
            <IRBtn icon="volume-mute" commandKey="VolumeMute" onSend={onSend} available={!!commands.VolumeMute} />
            <IRBtn icon="volume-low" commandKey="VolumeDown" onSend={onSend} available={!!commands.VolumeDown} />
            <IRBtn icon="volume-high" commandKey="VolumeUp" onSend={onSend} available={!!commands.VolumeUp} />
            <IRBtn icon="reload" commandKey="InstantReplay" onSend={onSend} available={!!commands.InstantReplay} />
          </View>

          <Text style={s.sectionTitle}>Canal</Text>
          <View style={s.row}>
            <IRBtn icon="remove" commandKey="ChannelDown" onSend={onSend} available={!!commands.ChannelDown} label="CH" />
            <IRBtn icon="add" commandKey="ChannelUp" onSend={onSend} available={!!commands.ChannelUp} label="CH" />
          </View>

          <Text style={s.sectionTitle}>Números</Text>
          <View style={s.numberGrid}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((number) => {
              const key = `Digit${number}`;
              return (
                <TouchableOpacity key={number} style={[s.numberBtn, !commands[key] && s.disabled]} disabled={!commands[key]} onPress={() => onSend(key)}>
                  <Text style={[s.numberText, !commands[key] && s.disabledText]}>{number}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={s.noteBox}>
            <Text style={s.noteText}>
              Apunta el emisor IR del teléfono al televisor. Los códigos cambian entre modelos:
              si uno no responde, prueba otro control de la misma marca. Los botones atenuados no
              tienen un código seguro en ese perfil.
            </Text>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  scroll: { alignItems: 'center', paddingVertical: 20, paddingHorizontal: 16 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, backgroundColor: PANEL, paddingVertical: 10, paddingHorizontal: 18, borderRadius: 20, borderWidth: 1, borderColor: ORANGE, width: '100%', justifyContent: 'center' },
  headerText: { color: ORANGE, fontWeight: '700', fontSize: 15 },
  selectorRow: { flexDirection: 'row', width: '100%', gap: 10 },
  selector: { flex: 1, minWidth: 0, backgroundColor: PANEL, borderRadius: 14, borderWidth: 1, borderColor: '#3a3a46', paddingHorizontal: 12, paddingVertical: 10 },
  selectorLabel: { color: '#8a8a99', fontSize: 10, marginBottom: 4 },
  selectorValueRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  selectorValue: { color: '#fff', fontSize: 13, fontWeight: '700', flex: 1 },
  coverageText: { color: '#777786', fontSize: 11, marginTop: 8, marginBottom: 18 },
  hardwareBox: { alignItems: 'center', gap: 12, paddingVertical: 50 },
  statusText: { color: '#8a8a99', fontSize: 14, textAlign: 'center' },
  unavailableBox: { alignItems: 'center', backgroundColor: PANEL, borderRadius: 16, padding: 22, width: '100%', gap: 12 },
  unavailableTitle: { color: '#fff', fontSize: 18, fontWeight: '700', textAlign: 'center' },
  unavailableBody: { color: '#9a9aa8', fontSize: 14, textAlign: 'center', lineHeight: 21 },
  errorText: { color: '#ef7777', fontSize: 12, marginBottom: 10 },
  powerBtn: { width: 56, height: 56, borderRadius: 28, backgroundColor: PANEL, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: ORANGE, marginBottom: 24 },
  crossWrap: { alignItems: 'center', marginBottom: 30 },
  crossMiddleRow: { flexDirection: 'row' },
  crossUp: { width: 92, height: 60, backgroundColor: ORANGE, borderTopLeftRadius: 40, borderTopRightRadius: 40, alignItems: 'center', justifyContent: 'center', marginBottom: 3, borderWidth: 2, borderColor: '#000', borderBottomWidth: 0 },
  crossDown: { width: 92, height: 60, backgroundColor: ORANGE, borderBottomLeftRadius: 40, borderBottomRightRadius: 40, alignItems: 'center', justifyContent: 'center', marginTop: 3, borderWidth: 2, borderColor: '#000', borderTopWidth: 0 },
  crossLeft: { width: 60, height: 92, backgroundColor: ORANGE, borderTopLeftRadius: 40, borderBottomLeftRadius: 40, alignItems: 'center', justifyContent: 'center', marginRight: 3, borderWidth: 2, borderColor: '#000', borderRightWidth: 0 },
  crossRight: { width: 60, height: 92, backgroundColor: ORANGE, borderTopRightRadius: 40, borderBottomRightRadius: 40, alignItems: 'center', justifyContent: 'center', marginLeft: 3, borderWidth: 2, borderColor: '#000', borderLeftWidth: 0 },
  crossCenter: { width: 92, height: 92, borderRadius: 46, backgroundColor: '#c2530a', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#000' },
  okText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', marginBottom: 18, gap: 10 },
  roundBtn: { flex: 1, height: 56, borderRadius: 18, backgroundColor: PANEL_2, alignItems: 'center', justifyContent: 'center' },
  roundBtnWide: { flex: 1.6 },
  btnLabel: { color: '#8a8a99', fontSize: 9, marginTop: 2 },
  disabled: { opacity: 0.38 },
  disabledText: { color: '#555563' },
  sectionTitle: { alignSelf: 'flex-start', color: '#c7c7d1', fontWeight: '700', fontSize: 13, marginBottom: 10 },
  numberGrid: { flexDirection: 'row', flexWrap: 'wrap', width: '100%', justifyContent: 'center', gap: 9, marginBottom: 16 },
  numberBtn: { width: '29%', height: 48, borderRadius: 15, backgroundColor: PANEL_2, alignItems: 'center', justifyContent: 'center' },
  numberText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  noteBox: { backgroundColor: PANEL, borderRadius: 12, padding: 14, marginTop: 8, width: '100%', borderWidth: 1, borderColor: '#333' },
  noteText: { color: '#8a8a99', fontSize: 12, lineHeight: 18 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'center', padding: 20 },
  modalCard: { backgroundColor: PANEL, borderRadius: 18, maxHeight: '78%', borderWidth: 1, borderColor: '#3a3a46', overflow: 'hidden' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: '#33333d' },
  modalTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  closeBtn: { padding: 4 },
  modalList: { paddingHorizontal: 10 },
  option: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#34343e' },
  optionSelected: { backgroundColor: '#2b211b' },
  optionText: { color: '#c7c7d1', fontSize: 14, flex: 1, paddingRight: 8 },
  optionTextSelected: { color: ORANGE, fontWeight: '700' },
});
