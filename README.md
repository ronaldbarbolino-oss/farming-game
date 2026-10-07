# FarmVerse PH

The official FarmVerse PH game (same engine and server mechanism as Farming, with its own data and admin).

- Game: `index.html` (PWA: `manifest.webmanifest`, `sw.js`, icons)
- Admin: `admin.html`
- Server: `netlify/functions/api.mjs` (Netlify Functions + Netlify Blobs)

## Deploy
Create a new Netlify site from this repository, branch `farmverse`, publish directory `.`.
Set the same environment variables as the Farming site (email settings) in the new site's settings.
A new Netlify site keeps its own Blobs, so FarmVerse PH accounts and farms are separate from Farming.

## App stores
Run the deployed URL through PWABuilder to generate the Android (APK/AAB) and iOS packages.
