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
