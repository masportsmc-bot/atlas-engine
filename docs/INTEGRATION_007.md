# MI08 — INTEGRATION 007: endurecimiento SSRF del motor de descarga de páginas

Estado: **preparado y probado offline. Nada aplicado, nada desplegado.**
Base: INTEGRATION 006 (406/406). Cierra el riesgo "SSRF residual" del §riesgos de `INTEGRATION_006.md`.
Sin cambios en RADAR, Blueprint, SQL, RPC ni Review Hub.

## 1. Qué cambia

| Fichero | Cambio |
|---|---|
| `research/net-policy.js` (nuevo) | Política pura: `engineUrlError(url)` (http/https, sin credenciales, solo puerto por defecto, sin nombres locales/internos) y `checkAddress(ip)` (solo unicast público, IPv4 e IPv6) |
| `research/fetch.js` (VS003) | El motor deja de usar `fetch` con `redirect: 'follow'`. Cliente propio: resuelve, valida todas las IP, conecta a una IP validada, sigue las redirecciones a mano revalidando cada salto, sin reutilizar conexiones, con tope de bytes decodificados y plazo global |
| `research/case-adapter.js` | `domainGuardedFetch` pasa al motor un control de dominio por salto (`allowUrl`): una redirección fuera del dominio permitido se rechaza **antes** de conectar. Se mantiene la comprobación de la URL final |
| `test/ssrf.test.js`, `test/support/test-cert.js` (nuevos) | 18 tests offline; el certificado autofirmado de prueba para `pagina.test` se genera localmente con `openssl` al ejecutar los tests (no hay claves en el repositorio) |

Firma y forma de respuesta del motor sin cambios: `engineFetch(url)` → `{ ok, status, finalUrl, text }`. El segundo argumento `{ allowUrl }` es opcional; los llamadores de VS003 (`web.js`, `verify.js`) no cambian.

## 2. Cómo funciona cada salto (primera URL y cada redirección, máximo 5)

1. **URL**: solo `http`/`https`, sin usuario ni contraseña, sin puerto explícito distinto de 80/443, sin `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.intranet`, `*.lan`, `*.arpa`, `*.onion` ni nombres de una sola etiqueta.
2. **Ámbito del llamador** (camino de casos): el dominio registrable debe estar en la lista permitida y la URL debe pasar `urlSafetyError` (que además rechaza cualquier IP literal).
3. **Resolución**: una sola consulta DNS por salto. Si **cualquiera** de las respuestas está bloqueada, se rechaza el host entero. Sin respuestas o con error de DNS → rechazo.
4. **Conexión**: al socket se le pasa la IP validada, nunca el nombre, así que no hay segunda resolución y el DNS rebinding no puede cambiar el destino. En HTTPS, el certificado se sigue verificando contra el nombre del host (SNI). Si una IP rechaza la conexión, se prueba la siguiente **validada** (máximo 3; IPv4 primero).
5. **Respuesta**: una redirección (301/302/303/307/308) vuelve al paso 1 con la nueva URL. El cuerpo se lee con tope de bytes ya descomprimidos (protege frente a bombas gzip); solo `gzip`, `deflate` y `br`.

## 3. Direcciones bloqueadas

**IPv4**: 0/8, 10/8, 100.64/10, 127/8, 169.254/16 (metadatos cloud), 172.16/12, 192.0.0/24, 192.0.2/24, 192.31.196/24, 192.52.193/24, 192.88.99/24, 192.168/16, 192.175.48/24, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4 (incluye 255.255.255.255).

**IPv6**: solo se admite unicast global 2000::/3, y dentro de él se bloquean 2001::/23 (incluye Teredo), 2001:db8::/32, 2002::/16 (6to4), 3ffe::/16, 3fff::/20 y 2620:4f:8000::/48. Por tanto quedan bloqueadas ::, ::1, ::/96, fc00::/7 (incluida la red privada de Railway), fe80::/10, fec0::/10, ff00::/8, 100::/64 y 64:ff9b:1::/48. Las direcciones con zona (`fe80::1%eth0`) se rechazan.
**Formas IPv4 dentro de IPv6**: `::ffff:a.b.c.d` y NAT64 `64:ff9b::/96` se juzgan por la IPv4 incrustada. Una IPv4 mapeada pública se conecta como IPv4 normal.
**IP literales en la URL**: el parser WHATWG normaliza `2130706433`, `0x7f.1`, `0177.0.0.1` y `127.1` a `127.0.0.1` antes de juzgarlas.

## 4. Pruebas (`test/ssrf.test.js`)

El DNS es un resolvedor falso inyectado. Cada socket que pide el motor se abre con un `dial` de prueba que **registra la IP que eligió el motor** y lo conecta a un servidor HTTP/HTTPS del propio proceso en el bucle local. Así se comprueba a qué dirección se habría conectado sin salir a la red.

- Política: 26 IPv4 bloqueadas y 17 públicas aceptadas; 35 IPv6 bloqueadas y 7 aceptadas, con el motivo exacto de 13 de ellas; entradas mal formadas; 21 URLs rechazadas y 6 aceptadas.
- DNS malicioso: 17 respuestas privadas o locales (IPv4 e IPv6) rechazadas sin llegar a conectar; también respuestas mezcladas, vacías, fallidas, basura o con zona.
- DNS rebinding: una sola resolución por salto; la conexión va a la IP validada; la siguiente petición y una redirección al mismo host se vuelven a validar y se rechazan.
- IP literales: 15 formas privadas rechazadas sin DNS ni conexión; las públicas IPv4 e IPv6 se aceptan.
- Redirecciones: 16 destinos bloqueados (IP privada, metadatos, decimal, hexadecimal, IPv6, mapeada, ULA, link-local, nombre que resuelve a metadatos, localhost, `.internal`, ftp, file, puerto, credenciales) sin conectar nunca al destino; las relativas y de http a https funcionan; los bucles paran en 5.
- Ámbito de casos: una redirección fuera del dominio del prospecto no se contacta y queda registrada como `REDIRECT_OUT_OF_SCOPE`.
- TLS: el certificado se verifica contra el nombre aunque se conecte por IP; un certificado de otro nombre o no confiable se rechaza.
- Límites: tope de bytes en cuerpos normales y en una bomba gzip de 50 MB, codificación desconocida rechazada, plazo global también durante el DNS.
- Conexión en producción: servidor, worker VS003 y CLI construyen el motor endurecido; con su configuración por defecto rechaza los destinos internos.

- Reintentos: tras un rechazo de conexión se prueba solo la siguiente IP validada; un fallo de certificado no se reintenta.

Mutaciones: 43 cambios deliberados en `net-policy.js`, `fetch.js` y `case-adapter.js` (quitar rangos, saltarse la validación, resolver dos veces, conectar por nombre, no revalidar redirecciones, quitar TLS, límites o plazo). Los tests detectan los 43.

Entorno: Node 22.22.0, PostgreSQL 16 local y desechable para la suite completa. El arnés de red bloquea y registra cualquier DNS real, `fetch` global y conexión que no sea a 127.0.0.1 o ::1.

## 5. Incompatibilidades

| Cambio de comportamiento | Afecta a |
|---|---|
| `research/fetch.js` es un fichero VS003: su hash cambia (VS003 queda 16/17 sin cambios) | Inventario VS003 |
| El investigador VS003 general (`research/worker.js`, `cli.js`), que no tiene lista de dominios, ahora también rechaza IP privadas, puertos no estándar, nombres locales y credenciales en URL. Las IP literales públicas siguen permitidas ahí (en el camino de casos ya estaban prohibidas) | Fuentes en puertos raros dejan de verificarse |
| Máximo 5 redirecciones (antes 20, valor por defecto de `fetch`) | Cadenas largas de redirección fallan con `TOO_MANY_REDIRECTS` |
| `maxBytes` cuenta bytes descomprimidos (antes, caracteres tras leer **todo** el cuerpo) | Páginas no ASCII se cortan algo antes |
| Mensajes de error nuevos en los diagnósticos: `SSRF_BLOCKED:<código>` y `FETCH_TIMEOUT` | Lectura de diagnósticos y logs |
| User-Agent `ATLAS-research-verifier/0.3` (antes 0.2) | Ninguno conocido |
| Sin reutilización de conexiones: un socket por salto | Algo más de latencia por página |

## 6. Riesgo residual

- Siguen alcanzables las IP **públicas** de servicios propios (por ejemplo, la URL pública de Supabase o de Railway) si el host está permitido. En el camino de casos solo lo están el dominio del prospecto y las semillas que nombra Manuel; el investigador VS003 general no tiene lista de dominios.
- El motor resuelve con el resolvedor del sistema, que incluye `/etc/hosts`; sus respuestas también se validan.
- No probado contra la red real de Railway (IPv6 de salida, DNS). Prueba recomendada en la ventana de piloto con la bandera del worker encendida y una semilla conocida.

## 7. Activación

No requiere migración. Se despliega con el siguiente despliegue del motor; con `ATLAS_CASE_RESEARCH_WORKER_ENABLED` apagado no cambia nada visible. Vuelta atrás: revertir `research/fetch.js`, `research/net-policy.js` y `research/case-adapter.js` a INTEGRATION 006.
