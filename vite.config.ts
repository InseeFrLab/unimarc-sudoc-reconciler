import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

// Configuration Vite : plugins React + Tailwind, alias "@" vers la racine.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  server: {
    // Autorise les URL de développement du SSP Cloud (n'importe quel
    // sous-domaine de lab.sspcloud.fr). Sans effet en production : le conteneur
    // sert des fichiers statiques et n'utilise pas ce serveur de dev.
    allowedHosts: ['.lab.sspcloud.fr'],
  },
});
