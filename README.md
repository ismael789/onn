# onn Remote — control Wi‑Fi e infrarrojo multi‑TV

Aplicación Expo/React Native con una sola interfaz de mando y adaptadores separados
para Roku OS/ECP, Samsung Tizen, LG webOS y una base de Sony Bravia IP Control. El modo
infrarrojo sigue siendo independiente y usa el catálogo local de marcas. En Wi‑Fi el
adaptador se elige por protocolo (`type`), no por la marca comercial (`brand`).

La pestaña Mando elige automáticamente una plantilla oscura según el tipo guardado:
conserva el control morado original para Roku/onn, usa una distribución compacta para
Samsung y una distribución redondeada tipo Magic Remote para LG. Son diseños propios
con iconos de la app, sin imágenes ni logotipos oficiales. Al olvidar la TV vuelve a la
plantilla Roku predeterminada.

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

1. En la TV abre `Configuración > Sistema > Configuración avanzada > Control por apps móviles > Acceso de red` y selecciona `Permisivo` si las consultas ECP devuelven HTTP 403.
2. Abre la barra `Toca para conectar...`.
3. Usa la búsqueda automática o abre `Conexión manual` y escribe la IP.
4. Prueba Mando, entradas, canales, aplicaciones y accesos directos.

Roku usa ECP local en el puerto 8060. Se conservan `query/device-info`, `query/apps`,
`query/icon`, `keypress`, `launch` y la sintonización de TV en vivo.
El XML de `query/device-info` conserva nombre, modelo, número de modelo, versión y marca
cuando están disponibles. Por ejemplo, una TCL o Hisense con Roku OS se guarda como
`type=roku` y `brand=TCL`/`Hisense`, y siempre utiliza el adaptador ECP.

### Samsung Tizen

1. Enciende la TV y déjala conectada a la misma red.
2. Busca automáticamente o abre `Conexión manual` e introduce su IP.
3. Acepta `onn Remote` cuando la TV muestre la solicitud de autorización.
4. Prueba dirección, OK, Home, Back, volumen, reproducción, canales y entradas.

Samsung prueba automáticamente el WebSocket local en los puertos 8001 y 8002; empieza
por el último que funcionó y guarda ese puerto junto con el token en AsyncStorage. La
consulta y lanzamiento de aplicaciones se mantienen deshabilitados porque el canal de
control remoto disponible no ofrece una lista estable de apps para todos los modelos
Tizen.

### LG webOS

1. Abre `Conexión manual` en el mismo modal de conexión.
2. Escribe la IP de la TV; LG no se escanea automáticamente para evitar solicitudes
   de emparejamiento y falsos positivos en toda la subred.
3. Acepta el emparejamiento en la pantalla.
4. Prueba navegación, volumen, reproducción, canales y aplicaciones.

Los webOS que todavía exponen el WebSocket local del puerto 3000 pueden funcionar con
esta implementación. Algunos modelos recientes requieren LG Connect SDK y un APK
personalizado; esa integración nativa no funciona dentro de Expo Go. Canal directo,
búsqueda y cambio directo de entrada se muestran deshabilitados en LG.

### Sony Bravia

Sony se detecta mediante su API HTTP local `/sony/system` y se controla con JSON-RPC e
IRCC en el puerto 80. La TV debe tener activado `Control IP` o `IP Control`. Si el modelo
exige autenticación, la app lo informa claramente; puede ser necesario configurar en la
TV la autenticación permitida para la red local. Los botones se habilitan únicamente si
`getRemoteControllerInfo` devuelve el comando correspondiente. La consulta y apertura
de aplicaciones quedan deshabilitadas en esta primera base.

### Android TV / Google TV y plataformas futuras

Existe un adaptador placeholder controlado para `androidtv`, sin anunciar control total.
Google Cast puede descubrir receptores y controlar contenido multimedia, pero no
reemplaza todos los botones del mando. El control completo de Android/Google TV requiere
emparejamiento e integración nativa, por lo que se reserva para un APK personalizado y
no se simula dentro de Expo Go.

Fire TV queda como etapa futura porque normalmente depende de ADB o de una integración
específica. VIDAA y Vizio SmartCast también se evaluarán por separado según el protocolo
real de cada modelo; no se clasifican solamente por ver la marca Hisense o Vizio.

### Infrarrojo

1. Abre la pestaña `IR` y elige marca y modelo.
2. Instala un APK personalizado en un Android con emisor IR físico.
3. Apunta el teléfono al televisor.

Expo Go permite ver y guardar el perfil, pero no contiene el módulo nativo que transmite
IR. La preferencia y el nivel de vibración se comparten con el mando Wi‑Fi.

## Capacidades por plataforma

| Función | Roku | Samsung | LG webOS | Sony Bravia |
|---|---:|---:|---:|---:|
| D-pad, Home y Back | Sí | Sí | Sí | Según comandos anunciados |
| Volumen y mute | Sí | Sí | Sí | Según comandos anunciados |
| Reproducción | Sí | Sí | Sí, según app | Según comandos anunciados |
| Canal +/- | Sí | Sí | Sí | Según comandos anunciados |
| Canal directo | Sí | No | No | Según comandos anunciados |
| Entradas directas | Sí | Sí, según modelo | Pendiente | Según comandos anunciados |
| Consultar/abrir apps | Sí | No | Sí, según versión webOS | No |
| Iconos de apps | Sí | No | Cuando webOS devuelve URL | No |
| Emparejamiento | No | Sí | Sí | Según configuración IP |

Los botones sin capacidad declarada permanecen visibles pero deshabilitados.

## Arquitectura

```text
App.js                         Interfaz y funciones genéricas
tvAdapters/common.js           Capacidades y utilidades compartidas
tvAdapters/index.js            Registro, detección y escaneo
tvAdapters/roku.js             Roku ECP
tvAdapters/samsung.js          Samsung Tizen WebSocket
tvAdapters/lg.js               LG webOS WebSocket/SSAP
tvAdapters/sony.js             Sony Bravia HTTP JSON-RPC/IRCC
tvAdapters/androidtv.js        Placeholder seguro para futura integración nativa
utils/deviceMetadata.js        Clasificación de protocolo y marca comercial
utils/notificationPolicy.js    Transiciones y acciones seguras de notificación
services/notifications.js      Permisos, canal, eventos locales y preparación push
services/androidIntents.js     Ajustes Wi‑Fi y configuración de la aplicación
luz_infraroja.js               Control IR independiente
ir_tv_catalog.json             Perfiles IR locales
```

La TV guardada incluye `id`, `name`, `type`, `brand`, `model`, `ip`, `port`,
`capabilities` y estado/token de autorización. `type` representa el sistema/protocolo y
puede ser `roku`, `samsung`, `lg`, `sony`, `androidtv`, `firetv`, `vidaa`, `vizio` o
`unknown`; `brand` es solamente informativo. Al iniciar se prueba primero la última IP. Si no responde,
se revisan las direcciones cercanas y después el resto de la subred; una Roku, Samsung o Sony
que cambió de IP se reconoce por su identificador y la nueva dirección se guarda. La app
también reconecta al volver del segundo plano o al cambiar el Wi‑Fi. Si un comando falla
por conexión, abre de nuevo el transporte una vez y reenvía ese comando. Samsung y LG
mantienen sus WebSocket mientras sigan disponibles; Roku continúa usando ECP HTTP local
en el puerto 8060.

La búsqueda manual prioriza la última IP conocida y direcciones cercanas a la IP del
teléfono. Roku, Samsung y Sony se examinan en grupos separados con concurrencia moderada y
tiempos de espera más tolerantes para evitar que Android o el router descarten una gran
cantidad de solicitudes simultáneas.

LG conserva la recuperación manual por IP porque escanear su WebSocket en todas las
direcciones podría generar solicitudes de emparejamiento no deseadas. Una red de
invitados, AP isolation o el aislamiento de clientes/bandas debe desactivarse en el
router; la app no puede atravesar ese bloqueo de la red local.

Los comandos de navegación, volumen, reproducción y canal pasan por una cola local
corta para conservar su orden. Ante un error de red se intenta una reconexión y un solo
reenvío. Si ese intento también falla, se descartan los comandos pendientes de ese lote
para evitar reconexiones y avisos repetidos. En `Ajustes > Diagnóstico de conexión`, `Probar conexión` muestra las IP, tipo
de TV, puerto activo, latencia, transporte, estado WebSocket y una causa legible si la
prueba falla. Los detalles técnicos permanecen únicamente en `console.warn`.

`Ajustes > Accesos directos del control` permite seleccionar hasta tres aplicaciones
por tipo de TV y guarda la elección en AsyncStorage. Roku y LG muestran únicamente apps
detectadas que sus adaptadores pueden abrir. Samsung informa que esta opción no está
disponible porque el canal de control implementado no ofrece una consulta estable de
aplicaciones instaladas.

## Notificaciones e Intents Android

La app crea el canal Android `tv-status` (`Estado de TV`) y solicita el permiso de
notificaciones una sola vez. Rechazarlo no afecta el control remoto. En Ajustes se puede
abrir la configuración de la aplicación para cambiar el permiso posteriormente.

Se generan notificaciones locales únicamente después de transiciones confirmadas:

- TV conectada tras completar realmente `adapter.connect`.
- TV encontrada después de pasar de desconectada a conectada.
- TV desconectada cuando falla también la reconexión o Android informa pérdida de red.
- Wi‑Fi requerido al intentar usar la red local sin conexión disponible.

La máquina de estados evita repetir avisos durante cada reintento. Las notificaciones de
red tienen la acción `Abrir Wi-Fi`, que valida la acción recibida y abre
`android.settings.WIFI_SETTINGS` solamente en Android. La respuesta inicial también se
procesa cuando el APK se inicia desde una notificación cerrada, y el listener se elimina
al desmontar la app.

Las notificaciones locales y el Intent Wi‑Fi pueden probarse en Android. Desde Expo SDK
53, las notificaciones push remotas ya no se prueban en Expo Go: requieren Development
Build o APK, un proyecto EAS real (`extra.eas.projectId`), `google-services.json` y las
credenciales FCM v1 cargadas en EAS. La app tiene preparada la obtención segura del Expo
Push Token cuando esa configuración exista; no incluye claves, credenciales ni backend.

El perfil `preview` de `eas.json` genera un APK instalable:

```bash
npx eas-cli@latest build --platform android --profile preview
```

Para habilitar push remoto después de vincular el proyecto con EAS:

```bash
npx eas-cli@latest init
npx eas-cli@latest credentials
```

Después descarga `google-services.json` desde Firebase, colócalo en la raíz y configura
`expo.android.googleServicesFile`. No subas a Git claves privadas de servicio.

## Validar el bundle Android

Las pruebas automáticas no necesitan televisores físicos y verifican la cola, el puerto
Samsung preferido, la plantilla predeterminada y la limpieza de preferencias:

```bash
npm test
```

```bash
npx expo export --platform android --no-bytecode --output-dir .expo-check
```

`.expo`, `.expo-check`, `node_modules` y los logs están excluidos mediante `.gitignore`.
