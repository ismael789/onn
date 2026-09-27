# onn Remote — control Wi‑Fi e infrarrojo multi‑TV

Aplicación Expo/React Native con una sola interfaz de mando y adaptadores separados
para Roku, Samsung Tizen y LG webOS. El modo infrarrojo sigue siendo independiente y
usa el catálogo local de marcas.

## Ejecutar

```bash
npm install
npx expo start
```

El teléfono y la TV deben estar en la misma red local. Pueden usar bandas 2.4 GHz y
5 GHz distintas siempre que el router permita comunicación entre ambas y no tenga
aislamiento de clientes.

## Probar cada plataforma

### Roku

1. En la TV activa `Configuración > Sistema > Configuración avanzada > Control por apps móviles`.
2. Abre la barra `Toca para conectar...`.
3. Usa la búsqueda automática o escribe la IP y selecciona `Roku`/`Automático`.
4. Prueba Mando, entradas, canales, aplicaciones y accesos directos.

Roku usa ECP local en el puerto 8060. Se conservan `query/device-info`, `query/apps`,
`query/icon`, `keypress`, `launch` y la sintonización de TV en vivo.

### Samsung Tizen

1. Enciende la TV y déjala conectada a la misma red.
2. Busca automáticamente o selecciona `Samsung` e introduce su IP.
3. Acepta `onn Remote` cuando la TV muestre la solicitud de autorización.
4. Prueba dirección, OK, Home, Back, volumen, reproducción, canales y entradas.

Samsung usa el WebSocket local del puerto 8001. El token se conserva cuando la TV lo
devuelve. La consulta y lanzamiento de aplicaciones se mantienen deshabilitados porque
el canal de control remoto disponible no ofrece una lista estable de apps para todos
los modelos Tizen.

### LG webOS

1. Selecciona `LG` en el mismo modal de conexión.
2. Escribe la IP de la TV; LG no se escanea automáticamente para evitar solicitudes
   de emparejamiento y falsos positivos en toda la subred.
3. Acepta el emparejamiento en la pantalla.
4. Prueba navegación, volumen, reproducción, canales y aplicaciones.

Los webOS que todavía exponen el WebSocket local del puerto 3000 pueden funcionar con
esta implementación. Algunos modelos recientes requieren LG Connect SDK y un APK
personalizado; esa integración nativa no funciona dentro de Expo Go. Canal directo,
búsqueda y cambio directo de entrada se muestran deshabilitados en LG.

### Infrarrojo

1. Abre la pestaña `IR` y elige marca y modelo.
2. Instala un APK personalizado en un Android con emisor IR físico.
3. Apunta el teléfono al televisor.

Expo Go permite ver y guardar el perfil, pero no contiene el módulo nativo que transmite
IR. La preferencia y el nivel de vibración se comparten con el mando Wi‑Fi.

## Capacidades por plataforma

| Función | Roku | Samsung | LG webOS |
|---|---:|---:|---:|
| D-pad, Home y Back | Sí | Sí | Sí |
| Volumen y mute | Sí | Sí | Sí |
| Reproducción | Sí | Sí | Sí, según app |
| Canal +/- | Sí | Sí | Sí |
| Canal directo | Sí | No | No |
| Entradas directas | Sí | Sí, según modelo | Pendiente |
| Consultar/abrir apps | Sí | No | Sí, según versión webOS |
| Iconos de apps | Sí | No | Cuando webOS devuelve URL |
| Emparejamiento | No | Sí | Sí |

Los botones sin capacidad declarada permanecen visibles pero deshabilitados.

## Arquitectura

```text
App.js                         Interfaz y funciones genéricas
tvAdapters/common.js           Capacidades y utilidades compartidas
tvAdapters/index.js            Registro, detección y escaneo
tvAdapters/roku.js             Roku ECP
tvAdapters/samsung.js          Samsung Tizen WebSocket
tvAdapters/lg.js               LG webOS WebSocket/SSAP
luz_infraroja.js               Control IR independiente
ir_tv_catalog.json             Perfiles IR locales
```

La TV guardada incluye `id`, `name`, `type/brand`, `ip`, `port`, `capabilities` y
estado/token de autorización. Al iniciar se intenta reconectar; si una Roku o Samsung
cambió de IP se vuelve a buscar por identificador. También se reintenta al regresar el
Wi‑Fi.

## Validar el bundle Android

```bash
npx expo export --platform android --no-bytecode --output-dir .expo-check
```

`.expo`, `.expo-check`, `node_modules` y los logs están excluidos mediante `.gitignore`.
