# 1v1 MOBA – Online + ML‑Style Controls (Pro)

**Additions (retaining previous structure and behavior):**
- Mobile Legends–style controls (left joystick + right skill pad)
- **Target Lock / Auto‑Aim** toggle with aim priority (drag > lock target > pointer)
- **Cooldown overlays** on Attack/Q/E (numbers + gray-out when on CD)
- **Minimap** overlay showing all entities
- Host‑authoritative WebRTC netcode with Firebase RTDB signaling (same as before)

## Files
- `index.html` – UI + controls and canvases
- `ui.js` – joystick, skill drag, lock toggle, cooldown overlays
- `app.js` – game logic, minimap rendering, auto‑aim, cooldown plumbed
- `net.js` – WebRTC + Firebase signaling (unchanged API)

## Run
- **Local hotseat:** open `index.html` directly.
- **Online:** edit `app.js` → paste your Firebase config; deploy on HTTPS (Netlify/Vercel/GitHub Pages).

## Controls
- **Move:** joystick or WASD/Arrows
- **Attack:** A button (or Space)
- **Skills:** Q/E buttons support **drag‑to‑aim**; release to cast (or Q/E keys)
- **LOCK:** toggles auto‑aim to nearest enemy when not dragging
- **Wave/Reset:** bottom bar

This version preserves earlier file names and public interfaces so your previous setup continues to work as expected.
