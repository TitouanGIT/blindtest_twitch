// server/server.js - MariaDB, Twitch OAuth, soirées, stats et classement overlay
import express from 'express';
import fetch from 'node-fetch';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== Express + HTTP + Socket.IO =====
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ===== MariaDB pool & schema =====
const dbPool = mysql.createPool({
  host: process.env.DB_HOST || 'db',
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER || 'blindtest',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_NAME || 'blindtest',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

async function initDb() {
  const conn = await dbPool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tracks (
        id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        deezer_id    BIGINT UNSIGNED,
        title        VARCHAR(255) NOT NULL,
        artist       VARCHAR(255),
        album        VARCHAR(255),
        preview_url  TEXT,
        cover_url    TEXT,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_deezer (deezer_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS players (
        id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name         VARCHAR(64) NOT NULL,
        twitch_id    VARCHAR(64),
        twitch_login VARCHAR(64),
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_name (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS games (
        id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name         VARCHAR(255),
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        started_at   BIGINT,
        ended_at     BIGINT,
        status       ENUM('pending','running','finished') DEFAULT 'running'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS rounds (
        id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        game_id      INT UNSIGNED NOT NULL,
        track_id     INT UNSIGNED,
        round_index  INT UNSIGNED,
        started_at   BIGINT,
        ended_at     BIGINT,
        CONSTRAINT fk_round_game  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
        CONSTRAINT fk_round_track FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS round_answers (
        id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        round_id     INT UNSIGNED NOT NULL,
        player_id    INT UNSIGNED NOT NULL,
        answer_text  TEXT,
        is_correct   TINYINT(1) DEFAULT 0,
        points       INT NOT NULL DEFAULT 0,
        elapsed_ms   INT UNSIGNED,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_answer_round  FOREIGN KEY (round_id) REFERENCES rounds(id) ON DELETE CASCADE,
        CONSTRAINT fk_answer_player FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    console.log('MariaDB – tables initialisées');
  } finally {
    conn.release();
  }
}

await initDb();

// ===== Single-room in-memory state =====
const room = {
  players: new Map(),           // socketId -> { name, score, banned, dbPlayerId, offline? }
  playlist: [],
  currentTrack: null,
  phase: 'idle',                // idle | playing | reveal
  startedAt: null,
  answers: [],
  roundCounter: 0,
  currentGameId: null,
  currentRoundId: null,
  isTestRound: false,
  settings: {
    extractDurationMs: 15000,
    answerWindowMs: 15000,
    basePoints: 1000,
    answerCooldownMs: 800
  }
};

// ===== Test round track (cache) =====
let cachedTestTrack = null;
async function getTestTrackTop1Squeezie() {
  if (cachedTestTrack) return cachedTestTrack;
  const queries = ['Top 1 Squeezie', 'Squeezie Top 1', 'Top 1 - Squeezie', 'Top 1 de Squeezie'];
  for (const q of queries) {
    try {
      const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}`;
      const r = await fetch(url);
      const j = await r.json();
      const t = (j?.data || []).find((x) => x && x.preview);
      if (!t) continue;
      cachedTestTrack = {
        id: t.id,
        title: t.title,
        artist: { name: t.artist?.name || '' },
        album: {
          title: t.album?.title || '',
          cover: t.album?.cover || '',
          cover_medium: t.album?.cover_medium || t.album?.cover || '',
          cover_big: t.album?.cover_big || t.album?.cover || ''
        },
        preview: t.preview
      };
      return cachedTestTrack;
    } catch (e) {
      console.error('getTestTrackTop1Squeezie error', e);
    }
  }
  return null;
}

// ===== Helpers =====
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCorrectAnswer(raw, track) {
  const ans = normalize(raw);
  if (!track) return false;

  const title = normalize(track.title);
  const artist = normalize(track.artist?.name || track.artistName || '');
  if (!ans) return false;
  if (title && ans.includes(title)) return true;
  if (artist && ans.includes(artist)) return true;
  if (title && artist && ans.includes(title + ' ' + artist)) return true;
  if (title && artist && ans.includes(artist + ' ' + title)) return true;
  return false;
}

function serializePlayers() {
  // On renvoie aussi les joueurs "offline" pour qu'ils restent dans le classement
  return Array.from(room.players.entries()).map(([id, p]) => ({
    id,
    name: p.name,
    score: Number(p.score) || 0,
    banned: p.banned,
    offline: !!p.offline
  }));
}

async function dbEnsureTrack(track) {
  if (!track) return null;
  const deezerId = track.id || null;
  const title = track.title || '';
  const artist = track.artist?.name || track.artistName || '';
  const album = track.album?.title || '';
  const preview = track.preview || '';
  const cover = track.album?.cover_big || track.album?.cover || '';

  if (deezerId) {
    const [rows] = await dbPool.query('SELECT id FROM tracks WHERE deezer_id = ?', [deezerId]);
    if (rows.length) return rows[0].id;
  }

  const [res] = await dbPool.query(
    'INSERT INTO tracks (deezer_id, title, artist, album, preview_url, cover_url) VALUES (?,?,?,?,?,?)',
    [deezerId, title, artist, album, preview, cover]
  );
  return res.insertId;
}

async function dbEnsurePlayer(name) {
  if (!name) return null;
  const clean = name.trim();
  const [rows] = await dbPool.query('SELECT id FROM players WHERE name = ?', [clean]);
  if (rows.length) return rows[0].id;
  const [res] = await dbPool.query('INSERT INTO players (name) VALUES (?)', [clean]);
  return res.insertId;
}

// ========== SOIRÉES (GAMES) ==========

// Crée ou récupère la soirée (game) en cours
async function dbCreateGameIfNeeded() {
  if (room.currentGameId) return room.currentGameId;

  // On cherche une soirée en cours
  const [rows] = await dbPool.query(
    "SELECT id, name FROM games WHERE status = 'running' ORDER BY started_at DESC LIMIT 1"
  );
  if (rows.length) {
    room.currentGameId = rows[0].id;
    return room.currentGameId;
  }

  // Sinon on crée une nouvelle soirée
  const now = Date.now();
  const label = `Soirée du ${new Date(now).toLocaleString('fr-FR')}`;
  const [res] = await dbPool.query(
    "INSERT INTO games (name, started_at, status) VALUES (?,?, 'running')",
    [label, now]
  );
  room.currentGameId = res.insertId;
  return room.currentGameId;
}

async function dbCreateRound(track, roundIndex) {
  const gameId = await dbCreateGameIfNeeded();
  const trackId = await dbEnsureTrack(track);
  const startedAt = room.startedAt || Date.now();
  const [res] = await dbPool.query(
    'INSERT INTO rounds (game_id, track_id, round_index, started_at) VALUES (?,?,?,?)',
    [gameId, trackId, roundIndex, startedAt]
  );
  room.currentRoundId = res.insertId;
  return room.currentRoundId;
}

async function dbFinishRound() {
  if (!room.currentRoundId) return;
  const endedAt = Date.now();
  await dbPool.query('UPDATE rounds SET ended_at = ? WHERE id = ?', [
    endedAt,
    room.currentRoundId
  ]);
}

async function dbInsertAnswer({ playerId, answerText, isCorrect, points, elapsedMs }) {
  if (!room.currentRoundId || !playerId) return;
  await dbPool.query(
    'INSERT INTO round_answers (round_id, player_id, answer_text, is_correct, points, elapsed_ms) VALUES (?,?,?,?,?,?)',
    [room.currentRoundId, playerId, answerText, isCorrect ? 1 : 0, points, elapsedMs]
  );
}

// ===== Twitch OAuth (only for nickname) =====
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
const TWITCH_REDIRECT_URI = '';

app.get('/auth/twitch/login', (req, res) => {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    return res
      .status(500)
      .send('Twitch OAuth non configuré (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET manquants).');
  }
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const redirectUri = TWITCH_REDIRECT_URI || `${baseUrl}/auth/twitch/callback`;
  const params = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'user:read:email'
  });
  const url = `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
  res.redirect(url);
});

app.get('/auth/twitch/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    // Pas de code => on retourne sur la home avec un flag d'erreur
    return res.redirect('/?t_error=twitch');
  }

  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const redirectUri = TWITCH_REDIRECT_URI || `${baseUrl}/auth/twitch/callback`;

    const body = new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    });

    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      body
    });

    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      console.error('Twitch token error:', txt);
      // Code invalide / expiré / etc. -> on renvoie vers formulaire
      return res.redirect('/?t_error=twitch');
    }

    const tokenJson = await tokenRes.json();
    const accessToken = tokenJson.access_token;

    let twitchName = null;

    try {
      const userRes = await fetch('https://api.twitch.tv/helix/users', {
        headers: {
          'Client-Id': TWITCH_CLIENT_ID,
          Authorization: `Bearer ${accessToken}`
        }
      });

      if (!userRes.ok) {
        const txt = await userRes.text();
        console.error('Twitch user error:', txt);
        return res.redirect('/?t_error=twitch');
      }

      const userJson = await userRes.json();
      const user = (userJson.data && userJson.data[0]) || {};
      twitchName = user.display_name || user.login || null;
    } catch (e) {
      console.error('Twitch user fetch error:', e);
      return res.redirect('/?t_error=twitch');
    }

    if (!twitchName) {
      return res.redirect('/?t_error=twitch');
    }

    // Succès : comme avant
    return res.redirect(`/?t_name=${encodeURIComponent(twitchName)}`);
  } catch (e) {
    console.error('Erreur OAuth Twitch:', e);
    return res.redirect('/?t_error=twitch');
  }
});



// ===== Import songs from CSV (pre-configured list) =====
app.post('/api/import-songs', async (_req, res) => {
  try {
    const csvPath = path.resolve(__dirname, 'songs_import.csv');
    const content = await fs.promises.readFile(csvPath, 'utf-8');
    const lines = content.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('artist;'));

    const imported = [];
    const unmatched = [];

    for (const line of lines) {
      const parts = line.split(';');
      const artist = (parts[0] || '').trim();
      const title = (parts[1] || '').trim();
      if (!title) continue;

      const queries = [];
      if (artist && title) {
        queries.push(`${artist} ${title}`);
        queries.push(`${title} ${artist}`);
      }
      queries.push(title);

      let foundTrack = null;

      for (const q of queries) {
        const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}`;
        try {
          const r = await fetch(url);
          const j = await r.json();

          if (j && j.error) {
            console.error('Deezer API error for', artist, '-', title, j.error);
            break;
          }

          const t = (j.data && j.data[0]) || null;
          if (t) {
            foundTrack = t;
            break;
          }
        } catch (e) {
          console.error('Deezer error for', artist, '-', title, e);
          break;
        }
      }

      if (!foundTrack) {
        console.warn('No Deezer match for', artist, '-', title);
        unmatched.push({ artist, title });
        continue;
      }

      const t = foundTrack;
      const track = {
        id: t.id,
        title: t.title,
        artist: { name: t.artist?.name || artist },
        album: {
          title: t.album?.title || '',
          cover: t.album?.cover || '',
          cover_medium: t.album?.cover_medium || t.album?.cover || '',
          cover_big: t.album?.cover_big || t.album?.cover || ''
        },
        preview: t.preview
      };

      imported.push(track);
    }

    res.json({ tracks: imported, unmatched });
  } catch (e) {
    console.error('import-songs error', e);
    res.status(500).json({ error: 'Import failed' });
  }
});


// ===== Deezer API proxy =====
app.get('/api/suggest', async (req, res) => {
  const q = req.query.q || '';
  if (!q) return res.json({ data: [] });
  try {
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}`;
    const r = await fetch(url);
    const j = await r.json();
    const data = (j.data || []).map((t) => ({
      id: t.id,
      title: t.title,
      artist: { name: t.artist?.name || '' },
      album: {
        title: t.album?.title || '',
        cover: t.album?.cover || null,
        cover_medium: t.album?.cover_medium || null,
        cover_big: t.album?.cover_big || null
      },
      preview: t.preview
    }));
    res.json({ data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur Deezer' });
  }
});

app.get('/api/track/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const r = await fetch(`https://api.deezer.com/track/${id}`);
    const t = await r.json();
    if (!t || t.error) return res.status(404).json({ error: 'Track not found' });
    res.json({
      id: t.id,
      title: t.title,
      artist: { name: t.artist?.name || '' },
      album: {
        title: t.album?.title || '',
        cover: t.album?.cover || null,
        cover_medium: t.album?.cover_medium || null,
        cover_big: t.album?.cover_big || null
      },
      preview: t.preview
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur Deezer track' });
  }
});

// ===== Stats API (global ou par soirée) =====
app.get('/api/stats', async (req, res) => {
  try {
    const gameId = req.query.gameId ? Number(req.query.gameId) : null;

    // Stats globales ou par soirée
    let global;
    if (gameId) {
      const [rows] = await dbPool.query(
        `
        SELECT
          (SELECT COUNT(DISTINCT a.player_id)
           FROM round_answers a
           JOIN rounds r2 ON r2.id = a.round_id
           WHERE r2.game_id = ?)                     AS totalPlayers,
          1                                          AS totalGames,
          (SELECT COUNT(*) FROM rounds r WHERE r.game_id = ?)      AS totalRounds,
          (SELECT COUNT(*) FROM round_answers a
           JOIN rounds r2 ON r2.id = a.round_id
           WHERE r2.game_id = ?)                     AS totalAnswers,
          COALESCE((SELECT SUM(a.points) FROM round_answers a
                    JOIN rounds r2 ON r2.id = a.round_id
                    WHERE r2.game_id = ?), 0)       AS totalPoints
        `,
        [gameId, gameId, gameId, gameId]
      );
      global = rows[0] || {};
    } else {
      const [rows] = await dbPool.query(`
        SELECT
          (SELECT COUNT(*) FROM players)         AS totalPlayers,
          (SELECT COUNT(*) FROM games)          AS totalGames,
          (SELECT COUNT(*) FROM rounds)         AS totalRounds,
          (SELECT COUNT(*) FROM round_answers)  AS totalAnswers,
          COALESCE((SELECT SUM(points) FROM round_answers), 0) AS totalPoints
      `);
      global = rows[0] || {};
    }

    // Classement joueurs
    let playerRows;
    if (gameId) {
      const [rows] = await dbPool.query(
        `
        SELECT
          p.id,
          p.name,
          COALESCE(SUM(a.points), 0)           AS score,
          COUNT(a.id)                          AS answersCount,
          AVG(a.elapsed_ms)                    AS avgResponseTimeMs,
          MIN(a.elapsed_ms)                    AS minResponseTimeMs,
          MAX(a.elapsed_ms)                    AS maxResponseTimeMs
        FROM players p
        LEFT JOIN round_answers a ON a.player_id = p.id
        LEFT JOIN rounds r        ON r.id = a.round_id
        WHERE r.game_id = ?
        GROUP BY p.id, p.name
        ORDER BY score DESC;
      `,
        [gameId]
      );
      playerRows = rows;
    } else {
      const [rows] = await dbPool.query(`
        SELECT
          p.id,
          p.name,
          COALESCE(SUM(a.points), 0)           AS score,
          COUNT(a.id)                          AS answersCount,
          AVG(a.elapsed_ms)                    AS avgResponseTimeMs,
          MIN(a.elapsed_ms)                    AS minResponseTimeMs,
          MAX(a.elapsed_ms)                    AS maxResponseTimeMs
        FROM players p
        LEFT JOIN round_answers a ON a.player_id = p.id
        GROUP BY p.id, p.name
        ORDER BY score DESC;
      `);
      playerRows = rows;
    }

    // Stats par manche
    let roundRows;
    if (gameId) {
      const [rows] = await dbPool.query(
        `
        SELECT
          r.id,
          r.round_index               AS roundIndex,
          t.title,
          t.artist,
          COUNT(a.id)                 AS answersCount,
          AVG(a.elapsed_ms)           AS avgResponseTimeMs,
          MIN(a.elapsed_ms)           AS minResponseTimeMs,
          MAX(a.elapsed_ms)           AS maxResponseTimeMs
        FROM rounds r
        LEFT JOIN tracks t        ON t.id = r.track_id
        LEFT JOIN round_answers a ON a.round_id = r.id
        WHERE r.game_id = ?
        GROUP BY r.id, r.round_index, t.title, t.artist
        ORDER BY r.id ASC;
      `,
        [gameId]
      );
      roundRows = rows;
    } else {
      const [rows] = await dbPool.query(`
        SELECT
          r.id,
          r.round_index               AS roundIndex,
          t.title,
          t.artist,
          COUNT(a.id)                 AS answersCount,
          AVG(a.elapsed_ms)           AS avgResponseTimeMs,
          MIN(a.elapsed_ms)           AS minResponseTimeMs,
          MAX(a.elapsed_ms)           AS maxResponseTimeMs
        FROM rounds r
        LEFT JOIN tracks t        ON t.id = r.track_id
        LEFT JOIN round_answers a ON a.round_id = r.id
        GROUP BY r.id, r.round_index, t.title, t.artist
        ORDER BY r.id ASC;
      `);
      roundRows = rows;
    }

    res.json({
      global,
      players: playerRows,
      rounds: roundRows
    });
  } catch (e) {
    console.error('Error /api/stats', e);
    res.status(500).json({ error: 'Erreur récupération stats' });
  }
});

// Liste des soirées (games)
app.get('/api/games', async (_req, res) => {
  try {
    const [rows] = await dbPool.query(
      'SELECT id, name, created_at, started_at, ended_at, status FROM games ORDER BY started_at DESC'
    );
    res.json(rows);
  } catch (e) {
    console.error('Error /api/games', e);
    res.status(500).json({ error: 'Erreur récupération soirées' });
  }
});

// ===== Socket.IO =====
io.on('connection', (socket) => {
  let lastAnswerAt = 0;

  socket.on('room:join', async ({ name }) => {
    const cleanName = String(name || 'Joueur').trim();

    // Connexions techniques: MOD / OVERLAY
    const isTech = cleanName === 'MOD' || cleanName === 'OVERLAY';
    if (!isTech) {
      const dbPlayerId = await dbEnsurePlayer(cleanName);
      const gameId = await dbCreateGameIfNeeded();

      // Score du joueur pour la soirée courante
      let dbScore = 0;
      try {
        const [rows] = await dbPool.query(
          `SELECT COALESCE(SUM(a.points),0) AS score
           FROM round_answers a
           JOIN rounds r ON r.id = a.round_id
           WHERE a.player_id = ? AND r.game_id = ?`,
          [dbPlayerId, gameId]
        );
        dbScore = Number(rows[0]?.score || 0);
      } catch (e) {
        console.error('Error loading player score from DB', e);
      }

      // Réutiliser un joueur existant avec le même pseudo pour garder sa place dans le classement
      let reused = false;
      for (const [id, p] of room.players.entries()) {
        if (p.name === cleanName) {
          room.players.delete(id);
          room.players.set(socket.id, {
            ...p,
            score: Number(p.score ?? dbScore) || 0,
            banned: p.banned || false,
            dbPlayerId,
            offline: false
          });
          reused = true;
          break;
        }
      }
      if (!reused) {
        room.players.set(socket.id, {
          name: cleanName,
          score: Number(dbScore) || 0,
          banned: false,
          dbPlayerId,
          offline: false
        });
      }
    }

    socket.join('main');
    io.to('main').emit('room:players', serializePlayers());
    io.to(socket.id).emit('room:settings', room.settings);
    io.to(socket.id).emit('room:playlist', room.playlist);

    // Si une manche est en cours, on renvoie l'état
    if (room.phase === 'playing' && room.currentTrack) {
      io.to(socket.id).emit('round:start', {
        preview: room.currentTrack.preview,
        cover:
          room.currentTrack.album?.cover_medium ||
          room.currentTrack.album?.cover ||
          null,
        extractDurationMs: room.settings.extractDurationMs,
        answerWindowMs: room.settings.answerWindowMs,
        startedAt: room.startedAt
      });
    } else if (room.phase === 'reveal' && room.currentTrack) {
      io.to(socket.id).emit('round:reveal', {
        title: room.currentTrack.title,
        artist: room.currentTrack.artist?.name || room.currentTrack.artistName,
        cover:
          room.currentTrack.album?.cover_big ||
          room.currentTrack.album?.cover ||
          null,
        answers: room.answers
      });
    }
  });

  socket.on('room:leave', () => {
    const p = room.players.get(socket.id);
    if (p) {
      p.offline = true;
      room.players.set(socket.id, p);
    }
    socket.leave('main');
    io.to('main').emit('room:players', serializePlayers());
  });

  socket.on('disconnect', () => {
    const p = room.players.get(socket.id);
    if (p) {
      p.offline = true;
      room.players.set(socket.id, p);
    }
    io.to('main').emit('room:players', serializePlayers());
  });

  socket.on('admin:kick', ({ socketId }) => {
    const p = room.players.get(socketId);
    if (p) {
      p.banned = true;
      io.to('main').emit('room:players', serializePlayers());
      io.to(socketId).emit('room:kicked');
    }
  });

  socket.on('admin:settings', ({ settings }) => {
    room.settings = { ...room.settings, ...settings };
    io.to('main').emit('room:settings', room.settings);
  });

  // Nouvelle soirée (game) : reset scores en mémoire
  socket.on('admin:newGame', async ({ name } = {}) => {
    try {
      // Clôturer l'ancienne soirée si besoin
      if (room.currentGameId) {
        await dbPool.query(
          "UPDATE games SET ended_at = ?, status = 'finished' WHERE id = ?",
          [Date.now(), room.currentGameId]
        );
      }

      const now = Date.now();
      const label =
        (name && name.trim()) || `Soirée du ${new Date(now).toLocaleString('fr-FR')}`;
      const [res] = await dbPool.query(
        "INSERT INTO games (name, started_at, status) VALUES (?,?, 'running')",
        [label, now]
      );
      room.currentGameId = res.insertId;
      room.roundCounter = 0;

      // Reset des scores en mémoire pour cette nouvelle soirée
      for (const [sid, p] of room.players.entries()) {
        room.players.set(sid, { ...p, score: 0 });
      }

      io.to('main').emit('room:players', serializePlayers());
      io.to('main').emit('game:changed', { id: room.currentGameId, name: label });
    } catch (e) {
      console.error('admin:newGame error', e);
    }
  });

  socket.on('admin:addTrack', async ({ track }) => {
    if (!track || !track.preview) return;
    room.playlist.push(track);
    // préparer en DB
    try {
      await dbEnsureTrack(track);
    } catch (e) {
      console.error('dbEnsureTrack error', e);
    }
    io.to('main').emit('room:playlist', room.playlist);
  });

  socket.on('admin:clearPlaylist', () => {
    room.playlist = [];
    io.to('main').emit('room:playlist', room.playlist);
  });

  socket.on('admin:startRound', async ({ index } = {}) => {
    if (!room.playlist.length && !room.currentTrack) return;

    let trackIndex = 0;
    if (typeof index === 'number' && index >= 0 && index < room.playlist.length) {
      trackIndex = index;
    }
    const track = room.playlist[trackIndex];
    if (!track) return;

    // retirer définitivement cette musique de la playlist
    room.playlist.splice(trackIndex, 1);
    io.to('main').emit('room:playlist', room.playlist);

    room.currentTrack = track;
    room.phase = 'playing';
    room.isTestRound = false;
    room.startedAt = Date.now();
    room.answers = [];
    room.roundCounter += 1;

    try {
      await dbCreateRound(track, room.roundCounter);
    } catch (e) {
      console.error('dbCreateRound error', e);
    }

    io.to('main').emit('round:start', {
      preview: track.preview,
      cover: track.album?.cover_medium || track.album?.cover || null,
      extractDurationMs: room.settings.extractDurationMs,
      answerWindowMs: room.settings.answerWindowMs,
      startedAt: room.startedAt,
      isTestRound: false
    });

    setTimeout(async () => {
      if (room.phase === 'playing') {
        await endRound();
      }
    }, room.settings.answerWindowMs + 100);
  });

  // Manche de test : ne donne pas de points et lance "Top 1" de Squeezie
  socket.on('admin:startTestRound', async () => {
    // éviter de relancer si une manche est déjà en cours
    if (room.phase === 'playing') return;

    const track = await getTestTrackTop1Squeezie();
    if (!track || !track.preview) return;

    room.currentTrack = track;
    room.phase = 'playing';
    room.isTestRound = true;
    room.startedAt = Date.now();
    room.answers = [];
    room.roundCounter += 1;

    try {
      await dbCreateRound(track, room.roundCounter);
    } catch (e) {
      console.error('dbCreateRound error (test round)', e);
    }

    io.to('main').emit('round:start', {
      preview: track.preview,
      cover: track.album?.cover_medium || track.album?.cover || null,
      extractDurationMs: room.settings.extractDurationMs,
      answerWindowMs: room.settings.answerWindowMs,
      startedAt: room.startedAt,
      isTestRound: true
    });

    setTimeout(async () => {
      if (room.phase === 'playing') {
        await endRound();
      }
    }, room.settings.answerWindowMs + 100);
  });

  socket.on('admin:skip', async () => {
    if (room.phase === 'playing') {
      await dbFinishRound().catch((e) => console.error('dbFinishRound error (skip)', e));
    }
    room.phase = 'idle';
    room.currentTrack = null;
    room.startedAt = null;
    room.answers = [];
    room.isTestRound = false;
    io.to('main').emit('round:skipped');
  });

  socket.on('admin:reveal', async () => {
    if (room.phase === 'playing') {
      await endRound();
    }
  });

  socket.on('answer:submit', async ({ text }) => {
    if (room.phase !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || player.banned) return;

    const now = Date.now();
    if (now - lastAnswerAt < room.settings.answerCooldownMs) {
      io.to(socket.id).emit('answer:rejected');
      return;
    }
    lastAnswerAt = now;

    const track = room.currentTrack;
    if (!track) return;

    const elapsed = now - room.startedAt;
    const correct = isCorrectAnswer(text, track);
    if (!correct) {
      // on loggue la mauvaise réponse si besoin
      try {
        if (player.dbPlayerId) {
          await dbInsertAnswer({
            playerId: player.dbPlayerId,
            answerText: text,
            isCorrect: false,
            points: 0,
            elapsedMs: elapsed
          });
        }
      } catch (e) {
        console.error('dbInsertAnswer (wrong)', e);
      }
      io.to(socket.id).emit('answer:rejected');
      return;
    }

    // Empêche un joueur de marquer plusieurs fois dans la même manche
    const alreadyGood = room.answers.some((a) => a.socketId === socket.id);
    if (alreadyGood) {
      io.to(socket.id).emit('answer:rejected');
      return;
    }

    const t = Math.max(0, Math.min(elapsed, room.settings.answerWindowMs));
    const speedFactor = 1 - t / room.settings.answerWindowMs;
    const points = room.isTestRound
      ? 0
      : Math.max(50, Math.round(room.settings.basePoints * speedFactor));
    if (!room.isTestRound) {
      player.score += points;
    }

    room.answers.push({ socketId: socket.id, name: player.name, points, elapsedMs: elapsed });

    try {
      if (player.dbPlayerId) {
        await dbInsertAnswer({
          playerId: player.dbPlayerId,
          answerText: text,
          isCorrect: true,
          points,
          elapsedMs: elapsed
        });
      }
    } catch (e) {
      console.error('dbInsertAnswer (correct)', e);
    }

    io.to(socket.id).emit('answer:accepted', { points });
    if (!room.isTestRound) {
      io.to('main').emit('room:players', serializePlayers());
    }
  });
});

async function endRound() {
  const track = room.currentTrack;
  if (!track) return;
  room.phase = 'reveal';
  try {
    await dbFinishRound();
  } catch (e) {
    console.error('dbFinishRound error', e);
  }
  io.to('main').emit('round:reveal', {
    title: track.title,
    artist: track.artist?.name || track.artistName,
    cover: track.album?.cover_big || track.album?.cover || null,
    answers: room.answers,
    isTestRound: room.isTestRound
  });
  // on laisse currentTrack pour les nouveaux arrivants en phase reveal
  // la manche de test ne concerne que cette manche
  room.isTestRound = false;
}

// ===== Static client =====
const distDir = path.resolve(__dirname, '..', 'client', 'dist');
app.use(express.static(distDir));
app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`BlindTest server running on :${PORT}`));

app.get("/api/playlist/export", (req, res) => {
  const rows = playlist.map(t => `${t.artist};${t.title}`).join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=playlist.csv");
  res.send(rows);
});

