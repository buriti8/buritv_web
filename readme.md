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
también el que sigue. Los
datos son guías XMLTV gratuitas de [open-epg.com](https://www.open-epg.com),
que el relay descarga al arrancar y cada 6 horas, y sirve en `/epg`.

Las fuentes y la equivalencia de canales están en `relay/epg-map.json`
(`tvg-id` → `"fuente:canal del XML"`, en orden de preferencia). DSports usa la
guía de Venezuela porque las de Colombia no la traen. Los canales sin
programación salen en `docker compose logs`. Después de editarlo hay que
reconstruir la imagen.
