# Least Score

Online multiplayer implementation of the card game **Least Score**. Node.js + Express + Socket.io backend with a single served `index.html` frontend. All game logic — shuffling, dealing, turn order, discard validation, scoring — lives on the server. Clients only ever see their own hand; opponents are shown as card counts.

## Run locally

```bash
npm install
npm start
```

Then open <http://localhost:3000> in two or more browser tabs/windows.

- One player clicks **Create Game**, enters their name, and gets a 6-character Game ID.
- The others enter that Game ID + their own name and click **Join Game**.
- Host clicks **Start Game** once 2–6 players have joined.

## Rules in a nutshell

- Each player is dealt 5 cards. (5–6 player games use two shuffled decks.)
- Card values: A = 1, 2–10 = face, J/Q/K = 10.
- On your turn, either:
  1. **Discard** a valid combo, then **pick** one card from the deck OR one card from the previous player's discard.
  2. **Declare** that you believe you hold the strictly lowest hand total.
- Valid discards: single card · pair · four-of-a-kind · 3- or 5-card sequence of consecutive ranks (ace high or low, no wrap) · 5-card flush. Three-of-a-kind is **not** valid.
- On a declare:
  - Strictly lowest hand → declarer scores 0, everyone else adds their hand total to their cumulative score.
  - Not lowest → declarer takes a **40-point** penalty, everyone else still adds their hand total.
- A player is eliminated at **100+ cumulative points**. Last player standing wins.
- If the deck runs out, all discarded cards except the current top group are reshuffled into a new deck.

## Fairness

- Shuffling uses Fisher-Yates with `crypto.randomInt`.
- Every discard is validated server-side before the hand is mutated.
- A player's hand is only ever sent to that player's own socket.
- Actions from anyone who isn't the current player are silently ignored.
- Disconnected players have **60 seconds** to rejoin (same Game ID + same name) before the server marks them eliminated and continues the game.

## Project layout

```
server.js          Express + Socket.io server. All game state & rules.
public/index.html  Single-file client (HTML/CSS/JS, served statically).
package.json       Dependencies + npm start script.
railway.json       Railway deployment config.
Procfile           Alternate process file (Railway / Heroku-style).
```

## Deploying to Railway

1. Push this repo to GitHub.
2. In [Railway](https://railway.app), click **New Project → Deploy from GitHub repo** and select the repo.
3. Railway will detect `railway.json`, install dependencies with Nixpacks, and run `npm start`.
4. Open the **Settings → Networking** tab and click **Generate Domain** to get a public URL.
5. Share that URL with players.

The server respects the `PORT` environment variable that Railway injects automatically — no extra configuration is needed.

### Deploying elsewhere

The same `Procfile` works on Heroku-style platforms (`web: npm start`). Any host that supports Node 18+ and websockets (Render, Fly.io, etc.) should work — point the platform at `npm start`.
