import { useEffect, useMemo, useState, useRef } from 'react';
import { createSocket } from '../lib/socket';
import SuggestBox from '../components/SuggestBox';
import Scoreboard from '../components/Scoreboard';

export default function ModeratorPage() {
  const [serverUrl] = useState(window.location.origin);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [playlist, setPlaylist] = useState([]);
  const [players, setPlayers] = useState([]);
  const [isImporting, setIsImporting] = useState(false);
  const [settings, setSettings] = useState({
    extractDurationMs: 15000,
    answerWindowMs: 15000,
    basePoints: 1000,
    answerCooldownMs: 800
  });

  const [newGameName, setNewGameName] = useState('');
  const [currentGame, setCurrentGame] = useState(null);

  const socket = useMemo(() => createSocket(serverUrl), [serverUrl]);

  // audio preview
  const audioRef = useRef(null);
  const [previewId, setPreviewId] = useState(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);

  // ✅ volume modo (persistant)
  const [modoVolume, setModoVolume] = useState(() => {
    const saved = localStorage.getItem('modoVolume');
    return saved !== null ? Number(saved) : 0.5;
  });

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = modoVolume;
    }
    localStorage.setItem('modoVolume', String(modoVolume));
  }, [modoVolume]);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, []);

  function togglePreviewTrack(t, idx) {
    if (!t || !t.preview) return;

    // stop si même track
    if (previewId === idx && isPreviewPlaying) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setIsPreviewPlaying(false);
      setPreviewId(null);
      return;
    }

    audioRef.current.src = t.preview;
    audioRef.current.play().catch(() => {});
    setPreviewId(idx);
    setIsPreviewPlaying(true);
  }

  useEffect(() => {
    socket.emit('room:join', { name: 'MOD' });

    socket.on('room:players', setPlayers);
    socket.on('room:playlist', setPlaylist);
    socket.on('room:settings', (s) =>
      setSettings((prev) => ({ ...prev, ...(s || {}) }))
    );

    socket.on('game:changed', (game) => {
      setCurrentGame(game);
    });

    return () => {
      socket.disconnect();
    };
  }, [socket]);

  async function doSearch() {
    if (!search) {
      setResults([]);
      return;
    }
    try {
      const r = await fetch(
        `${serverUrl}/api/suggest?q=${encodeURIComponent(search)}`
      );
      const j = await r.json();
      setResults(j.data || []);
    } catch (e) {
      console.error('search error', e);
    }
  }

  function addTrack(t) {
    socket.emit('admin:addTrack', { track: t });
  }

  function clearPlaylist() {
    socket.emit('admin:clearPlaylist');
  }

  // ✅ export CSV propre React
  async function exportCsvSongs() {
    try {
      const res = await fetch(`${serverUrl}/api/playlist/export`);
      if (!res.ok) return;

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'playlist.csv';
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      console.error('exportCsvSongs error', e);
    }
  }

  function importCsvSongs() {
    setIsImporting(true);
    fetch(`${serverUrl}/api/import-songs`, {
      method: 'POST'
    })
      .then((r) => r.json())
      .then((j) => {
        if (j && Array.isArray(j.tracks)) {
          j.tracks.forEach((t) => {
            socket.emit('admin:addTrack', { track: t });
          });
        }
      })
      .catch((e) => {
        console.error('importCsvSongs error', e);
      })
      .finally(() => {
        setIsImporting(false);
      });
  }

  function startAtIndex(index) {
    socket.emit('admin:startRound', { index });
  }

  function startNext() {
    if (!playlist.length) return;
    socket.emit('admin:startRound', {});
  }

  function startRandom() {
    if (!playlist.length) return;
    const idx = Math.floor(Math.random() * playlist.length);
    socket.emit('admin:startRound', { index: idx });
  }

  function startTestRound() {
    socket.emit('admin:startTestRound');
  }

  function skip() {
    socket.emit('admin:skip');
  }

  function reveal() {
    socket.emit('admin:reveal');
  }

  function updateSettingsField(field, value) {
    const next = { ...settings, [field]: value };
    setSettings(next);
    socket.emit('admin:settings', { settings: next });
  }

  function createNewGame() {
    socket.emit('admin:newGame', {
      name: newGameName && newGameName.trim() ? newGameName.trim() : undefined
    });
  }

  return (
    <div style={{ maxWidth: 1100, margin: '24px auto', padding: 16 }}>
      <audio ref={audioRef} style={{ display: 'none' }} />

      <h1>Blind Test — Modération</h1>

      {/* ✅ volume modo */}
      <div className="volume-control">
        <label>Volume :</label>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={modoVolume}
          onChange={(e) => setModoVolume(Number(e.target.value))}
        />
      </div>

      <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 2, display: 'grid', gap: 12 }}>
          <div className="card">
            <h2>Soirée</h2>
            <div style={{ marginBottom: 8 }}>
              Soirée actuelle :{' '}
              <strong>
                {currentGame?.name || 'Soirée en cours (non nommée)'}
              </strong>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <input
                style={{ flex: 1 }}
                value={newGameName}
                onChange={(e) => setNewGameName(e.target.value)}
                placeholder="Nom de la nouvelle soirée (optionnel)"
              />
              <button onClick={createNewGame}>Nouvelle soirée</button>
            </div>
          </div>

          <div className="card">
            <h2>Recherche Deezer</h2>
            <div className="row" style={{ gap: 8 }}>
              <input
                style={{ flex: 1 }}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') doSearch();
                }}
                placeholder="Titre ou artiste"
              />
              <button onClick={doSearch}>Rechercher</button>
            </div>

            <div style={{ marginTop: 8 }}>
              <SuggestBox
                apiBase={serverUrl}
                value={search}
                onChange={setSearch}
                onPick={(t) => addTrack(t)}
              />
            </div>

            {results.length > 0 && (
              <div style={{ marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
                {results.map((t) => (
                  <div
                    key={t.id}
                    className="row"
                    style={{
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '4px 0'
                    }}
                  >
                    <div>
                      <strong>{t.title}</strong> — <i>{t.artist?.name}</i>
                    </div>
                    <button onClick={() => addTrack(t)}>Ajouter</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h2>Playlist</h2>
            <div style={{ marginBottom: 8 }}>
              <button onClick={startNext} disabled={!playlist.length}>
                Lancer suivant
              </button>{' '}
              <button onClick={startRandom} disabled={!playlist.length}>
                Lancer aléatoire
              </button>{' '}
              <button onClick={startTestRound}>
                Round test (0 pt)
              </button>{' '}
              <button onClick={skip}>Passer</button>{' '}
              <button onClick={reveal}>Révéler</button>{' '}
              <button onClick={clearPlaylist}>Vider</button>{' '}
              <button onClick={importCsvSongs} disabled={isImporting}>
                Importer CSV
              </button>{' '}
              <button onClick={exportCsvSongs}>
                Exporter CSV
              </button>
            </div>

            {playlist.length === 0 && (
              <div style={{ opacity: 0.6 }}>
                Aucun titre dans la playlist.
              </div>
            )}

            {playlist.length > 0 && (
              <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                {playlist.map((t, idx) => (
                  <div
                    key={t.id + '-' + idx}
                    className="row"
                    style={{
                      justifyContent: 'space-between',
                      padding: '4px 0',
                      borderBottom: '1px solid rgba(0,0,0,0.05)'
                    }}
                  >
                    <div>
                      <strong>{t.title}</strong> — <i>{t.artist?.name}</i>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => startAtIndex(idx)}>
                        Lancer
                      </button>
                      <button
                        onClick={() => togglePreviewTrack(t, idx)}
                        disabled={!t.preview}
                      >
                        {previewId === idx && isPreviewPlaying
                          ? 'Stop'
                          : 'Aperçu'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h2>Paramètres</h2>
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <label>
                Durée extrait (ms){' '}
                <input
                  type="number"
                  value={settings.extractDurationMs}
                  onChange={(e) =>
                    updateSettingsField(
                      'extractDurationMs',
                      Number(e.target.value) || 0
                    )
                  }
                />
              </label>
              <label>
                Temps de réponse (ms){' '}
                <input
                  type="number"
                  value={settings.answerWindowMs}
                  onChange={(e) =>
                    updateSettingsField(
                      'answerWindowMs',
                      Number(e.target.value) || 0
                    )
                  }
                />
              </label>
              <label>
                Points de base{' '}
                <input
                  type="number"
                  value={settings.basePoints}
                  onChange={(e) =>
                    updateSettingsField(
                      'basePoints',
                      Number(e.target.value) || 0
                    )
                  }
                />
              </label>
              <label>
                Anti-spam (ms){' '}
                <input
                  type="number"
                  value={settings.answerCooldownMs}
                  onChange={(e) =>
                    updateSettingsField(
                      'answerCooldownMs',
                      Number(e.target.value) || 0
                    )
                  }
                />
              </label>
            </div>
          </div>
        </div>

        <div style={{ flex: 1 }}>
          <Scoreboard players={players} />
        </div>
      </div>
    </div>
  );
}
