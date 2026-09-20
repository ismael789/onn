/**
 * luz_infraroja.js
 * Control por infrarrojo (IR) para onn. Roku TV
 *
 * REQUISITOS:
 *   1. El celular debe tener hardware IR físico (chip emisor infrarrojo).
 *      La mayoría de teléfonos modernos NO lo tienen (Pixel, iPhones, etc.)
 *   2. Este módulo NO funciona en Expo Go estándar. Requiere un
 *      "Development Build" (npx expo prebuild + eas build) porque usa
 *      código nativo de Android (ConsumerIRManager).
 *   3. Mientras uses Expo Go, el botón IR siempre mostrará
 *      "No disponible en este dispositivo" — esto es esperado.
 *
 * El control por WiFi (ECP) en App.js NO fue tocado y sigue funcionando.
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Platform,
  NativeModules,
  Vibration,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

// Expo Go no contiene módulos nativos añadidos por el proyecto. Cargarlo de
// forma protegida evita que la app completa se cierre: WiFi siempre queda
// disponible y el modo IR solo se habilita en el APK compilado.
let hasIrBlaster = null;
let transmit = null;
try {
  ({ hasIrBlaster, transmit } = require('@sachinjs/ir-transmit'));
} catch (_) {
  hasIrBlaster = null;
  transmit = null;
}

// ─── Constantes de color (igual que App.js) ──────────────────────────────────
const PURPLE      = '#8b5cf6';
const PURPLE_DARK = '#6d28d9';
const BG          = '#0f0f14';
const PANEL       = '#1a1a22';
const PANEL_2     = '#232330';
const ORANGE      = '#f97316'; // color distintivo para el modo IR
const TAP_VIBRATION_MS = 12;

async function vibrateOnlyInVibrateMode() {
  try {
    if (await NativeModules.RingerMode?.isVibrateMode()) {
      Vibration.vibrate(TAP_VIBRATION_MS);
    }
  } catch (_) {
    // Expo Go no incluye el módulo nativo; en ese caso no hay vibración.
  }
}

// ─── Protocolo NEC → array de pulsos en microsegundos ────────────────────────
// La mayoría de controles universales y Roku usan el protocolo NEC a 38 kHz.
// Formato de bit:
//   Header: 9000µs ON  + 4500µs OFF
//   '1':     562µs ON  + 1687µs OFF
//   '0':     562µs ON  +  562µs OFF
//   Stop:    562µs ON
function necToPulses(necHex32) {
  const header = [9000, 4500];
  const stop   = [562];
  const bits   = [];
  for (let i = 31; i >= 0; i--) {
    const bit = (necHex32 >>> i) & 1;
    bits.push(562, bit === 1 ? 1687 : 562);
  }
  return [...header, ...bits, ...stop];
}

// ─── Códigos NEC documentados para onn. Roku TV ──────────────────────────────
// Protocolo NEC, prefijo de dispositivo 0x57E3 (verificado en modelos onn.)
// Si algún botón no responde, captura el código de tu control físico con
// una app como "IR Remote Controller" (nRF Connect o similar en Android).
// Frecuencia portadora: 38000 Hz
const IR_FREQ = 38000;

const ROKU_NEC = {
  // ── Energía ──────────────────────────────────────────────────────────────
  PowerToggle:   0x57E310EF, // Encendido/apagado (toggle)

  // ── Navegación D-pad ─────────────────────────────────────────────────────
  Up:            0x57E3609F,
  Down:          0x57E3A05F,
  Left:          0x57E330CF,
  Right:         0x57E3B04F,
  Select:        0x57E3E01F, // OK / Enter

  // ── Navegación sistema ───────────────────────────────────────────────────
  Home:          0x57E3C03F,
  Back:          0x57E3F00F,
  Search:        0x57E36897, // búsqueda / teclado

  // ── Reproducción ─────────────────────────────────────────────────────────
  Play:          0x57E3C837, // play / pausa (toggle)
  Rev:           0x57E34857, // retroceso
  Fwd:           0x57E308F7, // avance
  InstantReplay: 0x57E32AD5, // replay instantáneo
  Info:          0x57E35AA5, // asterisco / info

  // ── Volumen ──────────────────────────────────────────────────────────────
  VolumeUp:      0x57E3708F,
  VolumeDown:    0x57E3B847,
  VolumeMute:    0x57E3F807,

  // ── Canal ────────────────────────────────────────────────────────────────
  ChannelUp:     0x57E330CF, // mismo que Left en algunos modelos; varía
  ChannelDown:   0x57E3B04F, // mismo que Right en algunos modelos; varía
};

// ─── Función principal de envío IR ───────────────────────────────────────────
async function sendIR(necKey) {
  if (!hasIrBlaster || !transmit) return { ok: false, reason: 'no_module' };
  try {
    if (!hasIrBlaster()) return { ok: false, reason: 'no_hardware' };
  } catch (_) {
    return { ok: false, reason: 'no_hardware' };
  }

  const necCode = ROKU_NEC[necKey];
  if (!necCode) return { ok: false, reason: 'no_code' };

  try {
    const pulses = necToPulses(necCode);
    const result = transmit(IR_FREQ, pulses);
    return result.success ? { ok: true } : { ok: false, reason: result.message };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

// ─── Componente de botón IR ───────────────────────────────────────────────────
function IRBtn({ icon, IconSet = Ionicons, necKey, label, onSend, wide, size = 22 }) {
  return (
    <TouchableOpacity
      style={[s.roundBtn, wide && s.roundBtnWide]}
      activeOpacity={0.7}
      onPress={() => onSend(necKey)}
    >
      <IconSet name={icon} size={size} color="#e6e6ea" />
      {label ? <Text style={s.btnLabel}>{label}</Text> : null}
    </TouchableOpacity>
  );
}

// ─── Pantalla principal IR ────────────────────────────────────────────────────
export default function LuzInfrarojaScreen() {
  const [hwStatus, setHwStatus]   = useState('checking'); // checking | ok | unavailable
  const [lastResult, setLastResult] = useState(null);     // null | 'ok' | string error

  // Verificar hardware al montar
  useEffect(() => {
    (async () => {
      if (Platform.OS !== 'android') {
        setHwStatus('unavailable');
        return;
      }
      if (!hasIrBlaster || !transmit) {
        setHwStatus('unavailable');
        return;
      }
      try {
        const has = hasIrBlaster();
        setHwStatus(has ? 'ok' : 'unavailable');
      } catch (_) {
        setHwStatus('unavailable');
      }
    })();
  }, []);

  const onSend = async (necKey) => {
    vibrateOnlyInVibrateMode();
    const result = await sendIR(necKey);
    setLastResult(result.ok ? 'ok' : result.reason);
    if (result.ok) setTimeout(() => setLastResult(null), 700);
  };

  // ── Estado: verificando ─────────────────────────────────────────────────
  if (hwStatus === 'checking') {
    return (
      <View style={s.center}>
        <ActivityIndicator color={ORANGE} size="large" />
        <Text style={s.statusText}>Verificando hardware IR...</Text>
      </View>
    );
  }

  // ── Estado: no disponible ───────────────────────────────────────────────
  if (hwStatus === 'unavailable') {
    return (
      <View style={s.unavailableBox}>
        <Ionicons name="flash-off-outline" size={64} color="#555" />
        <Text style={s.unavailableTitle}>
          Luz infrarroja no disponible
        </Text>
        <Text style={s.unavailableBody}>
          {!hasIrBlaster || !transmit
            ? 'El modo IR requiere instalar el APK generado por GitHub Actions. Expo Go no incluye este módulo nativo.\n\nEl control por WiFi sigue disponible en la pestaña Mando.'
            : Platform.OS !== 'android'
            ? 'El control por infrarrojo solo está disponible en Android con hardware IR físico.'
            : 'Tu dispositivo Android no tiene emisor infrarrojo (IR blaster).\n\nUsa el control por WiFi, que sigue disponible en la pestaña Mando.'}
        </Text>
        <View style={s.unavailableTip}>
          <Ionicons name="wifi" size={18} color={PURPLE} />
          <Text style={s.tipText}>
            El control por WiFi (ECP) en la pestaña "Mando" sigue activo.
          </Text>
        </View>
      </View>
    );
  }

  // ── Estado: hardware IR disponible — mostrar control ────────────────────
  return (
    <ScrollView contentContainerStyle={s.scroll}>
      {/* Header */}
      <View style={s.header}>
        <Ionicons name="flash" size={18} color={ORANGE} />
        <Text style={s.headerText}>Control por Infrarojo</Text>
        {lastResult === 'ok' && (
          <Ionicons name="checkmark-circle" size={18} color="#22c55e" />
        )}
        {lastResult && lastResult !== 'ok' && (
          <Ionicons name="alert-circle" size={18} color="#ef4444" />
        )}
      </View>

      {/* Power */}
      <TouchableOpacity style={s.powerBtn} onPress={() => onSend('PowerToggle')} activeOpacity={0.7}>
        <Ionicons name="power" size={24} color={ORANGE} />
      </TouchableOpacity>

      {/* D-Pad */}
      <View style={s.crossWrap}>
        <TouchableOpacity style={s.crossUp} onPress={() => onSend('Up')} activeOpacity={0.7}>
          <Ionicons name="chevron-up" size={30} color="#fff" />
        </TouchableOpacity>
        <View style={s.crossMiddleRow}>
          <TouchableOpacity style={s.crossLeft} onPress={() => onSend('Left')} activeOpacity={0.7}>
            <Ionicons name="chevron-back" size={30} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity style={s.crossCenter} onPress={() => onSend('Select')} activeOpacity={0.7}>
            <Text style={s.okText}>OK</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.crossRight} onPress={() => onSend('Right')} activeOpacity={0.7}>
            <Ionicons name="chevron-forward" size={30} color="#fff" />
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={s.crossDown} onPress={() => onSend('Down')} activeOpacity={0.7}>
          <Ionicons name="chevron-down" size={30} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Back / Home / Search */}
      <View style={s.row3}>
        <IRBtn icon="arrow-back"   necKey="Back"   onSend={onSend} />
        <IRBtn icon="home"         necKey="Home"   onSend={onSend} wide />
        <IRBtn icon="search"       necKey="Search" onSend={onSend} />
      </View>

      {/* Reproducción */}
      <View style={s.row3}>
        <IRBtn icon="play-back"    necKey="Rev"           onSend={onSend} />
        <IRBtn icon="play-pause"   necKey="Play"          onSend={onSend} IconSet={MaterialCommunityIcons} />
        <IRBtn icon="play-forward" necKey="Fwd"           onSend={onSend} />
        <IRBtn icon="asterisk"     necKey="Info"          onSend={onSend} IconSet={MaterialCommunityIcons} />
      </View>

      {/* Volumen */}
      <View style={s.row3}>
        <IRBtn icon="volume-mute"  necKey="VolumeMute"    onSend={onSend} />
        <IRBtn icon="volume-low"   necKey="VolumeDown"    onSend={onSend} />
        <IRBtn icon="volume-high"  necKey="VolumeUp"      onSend={onSend} />
        <IRBtn icon="reload"       necKey="InstantReplay" onSend={onSend} />
      </View>

      {/* Nota informativa */}
      <View style={s.noteBox}>
        <Text style={s.noteText}>
          ⚠️ El control IR requiere línea de visión directa con el frente del TV.{'\n'}
          Si algún botón no responde, los códigos NEC pueden variar según el modelo exacto
          de tu onn. Roku TV. Puedes capturar los códigos de tu control físico con la app
          "IR Remote Controller" (Android) y actualizar ROKU_NEC en luz_infraroja.js.
        </Text>
      </View>
    </ScrollView>
  );
}

// ─── Estilos ──────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  scroll:  { alignItems: 'center', paddingVertical: 20, paddingHorizontal: 16 },
  center:  { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 20,
    backgroundColor: PANEL,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: ORANGE,
    width: '100%',
    justifyContent: 'center',
  },
  headerText: { color: ORANGE, fontWeight: '700', fontSize: 15 },

  // Power
  powerBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: PANEL,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: ORANGE,
    marginBottom: 24,
  },

  // D-Pad (mismo diseño que App.js pero con color naranja)
  crossWrap:      { alignItems: 'center', marginBottom: 30 },
  crossMiddleRow: { flexDirection: 'row' },
  crossUp: {
    width: 92, height: 60,
    backgroundColor: ORANGE,
    borderTopLeftRadius: 40, borderTopRightRadius: 40,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 3, borderWidth: 2, borderColor: '#000', borderBottomWidth: 0,
  },
  crossDown: {
    width: 92, height: 60,
    backgroundColor: ORANGE,
    borderBottomLeftRadius: 40, borderBottomRightRadius: 40,
    alignItems: 'center', justifyContent: 'center',
    marginTop: 3, borderWidth: 2, borderColor: '#000', borderTopWidth: 0,
  },
  crossLeft: {
    width: 60, height: 92,
    backgroundColor: ORANGE,
    borderTopLeftRadius: 40, borderBottomLeftRadius: 40,
    alignItems: 'center', justifyContent: 'center',
    marginRight: 3, borderWidth: 2, borderColor: '#000', borderRightWidth: 0,
  },
  crossRight: {
    width: 60, height: 92,
    backgroundColor: ORANGE,
    borderTopRightRadius: 40, borderBottomRightRadius: 40,
    alignItems: 'center', justifyContent: 'center',
    marginLeft: 3, borderWidth: 2, borderColor: '#000', borderLeftWidth: 0,
  },
  crossCenter: {
    width: 92, height: 92,
    borderRadius: 46,
    backgroundColor: '#c2530a',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: '#000',
  },
  okText: { color: '#fff', fontWeight: '800', fontSize: 16 },

  // Botones de fila
  row3: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 18,
    gap: 10,
  },
  roundBtn: {
    flex: 1, height: 56,
    borderRadius: 18,
    backgroundColor: PANEL_2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundBtnWide: { flex: 1.6 },
  btnLabel: { color: '#8a8a99', fontSize: 9, marginTop: 2 },

  // Estado de error / confirmación
  statusText: { color: '#8a8a99', fontSize: 14, textAlign: 'center' },

  // Pantalla "No disponible"
  unavailableBox: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: 28,
    gap: 16,
  },
  unavailableTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  unavailableBody: {
    color: '#8a8a99',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
  },
  unavailableTip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: PANEL,
    borderRadius: 12,
    padding: 14,
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#3a2a5c',
  },
  tipText: { color: '#c7c7d1', fontSize: 13, flex: 1 },

  // Nota al pie
  noteBox: {
    backgroundColor: PANEL,
    borderRadius: 12,
    padding: 14,
    marginTop: 8,
    width: '100%',
    borderWidth: 1,
    borderColor: '#333',
  },
  noteText: { color: '#8a8a99', fontSize: 12, lineHeight: 18 },
});
