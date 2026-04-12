// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://alphacloudsf.github.io',
  base: '/Salesforce-API-Version-Updater',
  vite: {
    plugins: [tailwindcss()]
  }
});