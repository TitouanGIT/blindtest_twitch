# Blind Test Deezer — Single Room, Docker
- Session unique (pas de multi-room)
- Pages: Joueur (`/`), Modération (`/mod`), Overlay OBS (`/overlay`)
- API Deezer publique (preview 30s)

## Local (sans Docker)
```bash
# 1) installer
cd client && npm i && cd ../server && npm i
# 2) build le client
cd ../client && npm run build
# 3) lancer le serveur qui sert aussi le client
cd ../server && npm start  # http://localhost:8080
```

## Docker
```bash
# Build
docker build -t blindtest-deezer .
# Run
docker run --rm -p 8080:8080 blindtest-deezer
# ou via docker-compose
docker compose up --build -d
```
- Ouvre `http://localhost:8080/` (joueur)
- `http://localhost:8080/mod` (modération)
- `http://localhost:8080/overlay` (overlay pour OBS, fond transparent)
- `http://localhost:8080/results` (resultat et stats)

## Notes
- Le serveur sert le client statique (Vite build) et gère Socket.IO + endpoints `/api/suggest`, `/api/track/:id`.
- Le scoring est proportionnel à la rapidité, points min 50, base 1000.
- Pour sécuriser la page modération: ajouter une variable d'env et un middleware simple.
