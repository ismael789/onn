# onn Remote — Control para onn. Roku TV

Control remoto funcional para onn. Roku TV, con el diseño de cruz morada
tipo mando universal. Funciona por WiFi con el protocolo ECP de Roku
(HTTP local, puerto 8060) — sin nube, sin API keys, sin Bluetooth (Roku no
expone su protocolo BT a terceros).

## 1. Preparar la TV (una sola vez)

En la onn. Roku TV:

```
Configuración > Sistema > Configuración avanzada del sistema > Control por apps móviles
```

Actívalo. Sin esto la TV ignora los comandos.

El celular debe estar en la **misma red WiFi** que la TV.

## 2. Instalar y correr

Descomprime este zip, entra a la carpeta y corre:

```bash
npm install
npx expo start
```

Escanea el código QR con la app **Expo Go** en tu Android.

## 3. Usar la app

- Al abrir, toca la barra de arriba ("Toca para conectar...") para
  buscar tu TV en la red automáticamente o escribir su IP a mano
  (la IP también aparece en la TV: `Configuración > Red > Acerca de`).
- **Tab "Mando"**: cruz direccional, Home/Back/búsqueda,
  adelantar/retroceder/play, **volumen (mute, bajar, subir)**, y un
  botón para alternar a la vista de **entradas** (HDMI1-4, Tuner, AV).
- **Tab "Canal"**: subir/bajar canal y teclado numérico.
- **Tab "Transmitir"**: placeholder — Cast/SSDP no está incluido en esta
  base, se puede agregar después.
- **Tab "Ajustes"**: ver la TV conectada, reconectar u olvidar la IP
  guardada.

## Qué es "funcional" aquí

Todo lo que aprietas manda de verdad un `POST` a
`http://<ip-tv>:8060/keypress/<Tecla>`, que es el mismo comando que usa
la app oficial de Roku. El volumen, el D-pad, home/back, play/pausa y los
canales funcionan en cuanto conectes con la IP correcta y tengas
"Control por apps móviles" activado.

## Limitación real de Roku

No se puede **encender** una TV apagada por WiFi (ECP), solo mandarla a
standby. Para encender a distancia se necesitaría HDMI-CEC desde otro
aparato.

## Estructura del proyecto

```
onn-remote/
├── App.js          ← toda la lógica y la interfaz
├── app.json        ← configuración de Expo
├── package.json    ← dependencias
└── babel.config.js
```
# control
# ismael789-control
# onn
# onn
# onn
