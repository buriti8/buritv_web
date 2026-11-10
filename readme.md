# BuriTV

Web de TV en vivo (React + Vite) con un relay Node + ffmpeg que convierte el
audio de las señales a AAC. Todo corre en un solo contenedor Docker, pensado
para WSL.

## Ejecutar (WSL)

```bash
docker compose up -d --build
```

Abrir http://localhost:8090. El contenedor tiene `restart: unless-stopped`,
así que vuelve solo cuando Docker arranca.

```bash
docker compose logs -f     # ver logs
docker compose down        # detener
```

## Desarrollo

```bash
npm install
npm run relay   # relay en :8090 (requiere ffmpeg: sudo apt install ffmpeg)
npm run dev     # web en http://localhost:5180
```

## Chromecast

Descomentar `RELAY_PUBLIC_HOST` en `docker-compose.yml` con la IP de tu PC en
la red local.

## Partidos en vivo por canal

La lista muestra qué partido está dando cada canal (datos de la guía de TV de
FotMob para Colombia). El relay los sirve en `/now-playing`, y la web lo
consulta cada minuto.

La equivalencia entre nuestros canales y los nombres de FotMob está en
`relay/channel-map.json` (`tvg-id` → nombres en FotMob). Los canales de FotMob
sin equivalencia salen en `docker compose logs`. Después de editar ese archivo
hay que reconstruir la imagen (`docker compose up -d --build`).

## Programación de cada canal (Ahora / Sigue)

Cuando un canal no está dando un partido, la lista muestra el programa al aire
(pasando el cursor, su horario y el que sigue), y al cambiar de canal se ve
también el que sigue. Si FotMob dice que el canal está dando un partido, se
muestra el partido en vez de la guía. El relay sirve la programación en `/epg`
y la consulta bajo demanda (cada 10 minutos como mucho, si alguien tiene la web
abierta) en estas fuentes:

- `movistar`: guía de Movistar TV Colombia (API JSON, todos los canales en una
  sola petición). Es la principal.
- `claro`: guía de Claro Colombia (`devportal.siba.com.co`, una petición por
  canal). Se usa para Caracol y como respaldo.
- `tapkit`: guía de Warner (`epg.tapkit.warnermedia.com`), para TNT Sports.
- `xmltv`: archivos diarios de [epgshare01](https://epgshare01.online)
  (`epg_ripper_<archivo>.xml.gz`, se bajan cada 6 horas). Se usan para DSports
  (guía de DirecTV Sports Argentina) y TyC Sports (guía de Argentina), que no
  están en Movistar ni en Claro.

Ninguna de estas APIs es oficial, así que pueden cambiar sin aviso; por eso
cada canal tiene varias fuentes. Si una falla, se usa la siguiente y se
conserva lo último que dio.

Las fuentes de cada canal están en `relay/epg-map.json`
(`tvg-id` → `"movistar:<LCH…>"`, `"claro:<id>"`, `"tapkit:<feed>"` o `"xmltv:<archivo>:<canal>"`,
en orden de preferencia). Los canales sin programación salen en
`docker compose logs`. Después de editarlo hay que reconstruir la imagen.

## Streamers (Twitch, Kick, YouTube)

En la lista, los streamers muestran si están en vivo y el título de la
transmisión, antes del título el número de espectadores abreviado, como 100, 1.5k o 15k
(pasando el cursor,
la categoría), o
"Offline". El relay lo consulta en `/streams` (cada minuto como mucho;
YouTube cada 2) para toda opción de la M3U cuya URL sea de Twitch, Kick o
YouTube; no hay que configurar nada aparte.

- **Twitch** no se embebe: su reproductor se pausa cuando no está a la vista y
  exige que la página sea HTTPS. Se reproduce por HLS con
  `/twitch/<canal>.m3u8` (el relay pide el permiso; las calidades y los
  segmentos los baja la web directo de Twitch). Se pide como reproductor
  `embed` (el del embebido oficial), que no trae el anuncio inicial; los
  anuncios a mitad de la transmisión pueden seguir apareciendo.
- **YouTube**: los enlaces a `/@canal/live` no se pueden embeber; la web los
  cambia por el video que está en vivo en ese momento. Si el canal no está
  transmitiendo, pasa a la siguiente opción.
- **Kick** sigue embebido (`player.kick.com`); solo se le consulta el estado.

