# MopedRide Web

Vercel-ready web build of the supplied MopedRide app code.

## Run locally

```bash
npm install
npm run dev
```

## Deploy

This is a Vite + React site and can be deployed to Vercel with the default settings: build command `npm run build`, output directory `dist`.

The original mobile `react-native-maps` dependency is adapted for web with Leaflet while keeping the supplied app UI and routing logic.
