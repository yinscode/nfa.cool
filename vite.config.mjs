import {defineConfig} from 'vite';
import {resolve} from 'node:path';

export default defineConfig({root:'apps/web',base:'/',build:{outDir:'dist',emptyOutDir:true,
  cssCodeSplit:true,rollupOptions:{input:{studio:resolve('apps/web/index.html'),
    landing:resolve('apps/web/landing.html')}}}});
