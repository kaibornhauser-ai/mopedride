import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({
  plugins:[react()],
  resolve:{alias:{
    'react-native': 'react-native-web',
    'react-native-maps': path.resolve(__dirname,'src/react-native-maps.tsx'),
    'expo-location': path.resolve(__dirname,'src/expo-location.ts'),
  }},
  build:{target:'es2020'},
});
