import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    // Rutas relativas: el build funciona en cualquier carpeta o ruta
    base: './',
    build: {
        // hls.js pesa lo suyo; mpegts.js va aparte y se carga solo si hace falta
        chunkSizeWarningLimit: 700,
    },
    server: {
        port: 5180,
        // En desarrollo, la lista de canales la atiende el relay (npm run relay)
        proxy: {
            '/m3u': 'http://localhost:8090',
            '/now-playing': 'http://localhost:8090',
        },
    },
});
