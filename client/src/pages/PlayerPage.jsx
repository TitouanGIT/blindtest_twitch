import { useEffect, useMemo, useRef, useState } from 'react';
import { createSocket } from '../lib/socket';
import TimerBar from '../components/TimerBar';
import SuggestBox from '../components/SuggestBox';

export default function PlayerPage() {
  const [serverUrl] = useState(window.location.origin);
  const [name, setName] = useState('');
  const [joined, setJoined] = useState(false);
  const [players, setPlayers] = useState([]);
  const [round, setRound] = useState(null);
  const [guess, setGuess] = useState('');
  const [accepted, setAccepted] = useState(null);
  const [settings, setSettings] = useState({});
  const [twitchError, setTwitchError] = useState(false);
  const audioRef = useRef(null);

  // volume: valeur 0..100, persistée en localStorage
  const [volume, setVolume] = useState(() => {
    const v = parseFloat(localStorage.getItem('bt_volume'));
    return Number.isFinite(v) ? v : 80;
  });

  const socket = useMemo(() => createSocket(serverUrl), [serverUrl]);

  // appliquer le volume au lecteur audio quand il change ou quand l'élément audio est (re)créé
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = Math.max(0, Math.min(1, volume / 100));
    }
  }, [volume, round]);

  useEffect(() => {
    localStorage.setItem('bt_volume', String(volume));
  }, [volume]);

  // auto-join après retour Twitch (succès)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const twitchName = params.get('t_name');
    if (twitchName && !joined) {
      const n = twitchName.trim();
      setName(n);
      localStorage.setItem('bt_name', n);
      // on nettoie l'URL
      window.history.replaceState(null, '', window.location.pathname);
      // join auto
      socket.emit('room:join', { name: n });
      setJoined(true);
    }
  }, [socket, joined]);

  // si Twitch a échoué -> on active le formulaire pseudo
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tError = params.get('t_error');
    if (tError === 'twitch' && !joined) {
      setTwitchError(true);
      const stored = localStorage.getItem('bt_name');
      if (stored) setName(stored);
      // on nettoie l'URL
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [joined]);

  useEffect(() => {
    socket.on('room:players', setPlayers);
    socket.on('room:settings', (s) => setSettings(s || {}));

    socket.on('round:start', (payload) => {
      setAccepted(null);
      setGuess('');
      setRound({
        ...payload,
        startedAt: payload.startedAt || Date.now()
      });

      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.play().catch(() => {});
        }
      }, 50);
    });

    socket.on('round:reveal', (payload) => {
      setRound((r) => (r ? { ...r, reveal: payload } : { reveal: payload }));
    });

    socket.on('round:skipped', () => setRound(null));
    socket.on('answer:accepted', (payload) => {
      setAccepted({ ...payload, rejected: false });
      setGuess('');
    });
    socket.on('answer:rejected', () =>
      setAccepted({ points: 0, rejected: true })
    );
    socket.on('room:kicked', () => {
      alert('Vous avez été exclu de la partie.');
      setJoined(false);
    });

    return () => {
      socket.disconnect();
    };
  }, [socket]);

  function joinWithName() {
    const n = (name || '').trim();
    if (!n) return;
    localStorage.setItem('bt_name', n);
    socket.emit('room:join', { name: n });
    setJoined(true);
  }

  function submit() {
    if (!guess) return;
    socket.emit('answer:submit', { text: guess });
  }

  // Enter global même si l'input n'est pas focus
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key !== 'Enter') return;

      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;

      if (!joined) return;
      if (!guess) return;

      submit();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [joined, guess]);

  const myPlayer = players.find((p) => p.id === socket.id) || null;

  return (
    <div style={{ maxWidth: 900, margin: '24px auto', padding: 16 }}>
      <h1>Blind Test — Joueur</h1>

      {!joined && (
        <>
          <div className="card" style={{ marginTop: 16 }}>
            <h2>Connexion</h2>
            <p>Connecte-toi avec ton compte Twitch pour rejoindre la soirée.</p>
            <a className="btn primary" href={`${serverUrl}/auth/twitch/login`}>
              Se connecter avec Twitch
            </a>
          </div>

          {twitchError && (
            <div className="card" style={{ marginTop: 16 }}>
              <h2>Ou entre ton pseudo Twitch</h2>
              <p style={{ color: 'tomato' }}>
                La connexion avec Twitch a échoué. Entre ton pseudo pour continuer.
              </p>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input
                  style={{ flex: 1 }}
                  placeholder="Pseudo Twitch"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <button onClick={joinWithName} disabled={!name.trim()}>
                  Rejoindre
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {joined && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ marginBottom: 8 }}>
            <strong>Bonjour {name}</strong>
            {myPlayer && (
              <span style={{ marginLeft: 12 }}>
                | Score soirée : <strong>{myPlayer.score}</strong>
              </span>
            )}
          </div>

          {round && (
            <>
              <div style={{ marginBottom: 12 }}>
                <audio ref={audioRef} src={round.preview} />
                <TimerBar
                  totalMs={round.answerWindowMs || settings.answerWindowMs || 15000}
                  startAt={round.startedAt}
                />

                {/* Barre de volume */}
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label style={{ fontSize: 13, opacity: 0.9 }}>Volume</label>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={volume}
                    onChange={(e) => setVolume(Number(e.target.value))}
                    style={{ flex: 1 }}
                  />
                  <span style={{ width: 36, textAlign: 'right', fontSize: 13 }}>{volume}%</span>
                </div>
              </div>

              <div className="row" style={{ gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <SuggestBox
                    apiBase={serverUrl}
                    value={guess}
                    onChange={setGuess}
                    onPick={(it) =>
                      setGuess(`${it.title} — ${it.artist?.name || ''}`)
                    }
                    onEnter={submit}
                  />
                </div>
                <button onClick={submit}>Valider</button>
              </div>

              {accepted && (
                <div style={{ marginTop: 8 }}>
                  {accepted.rejected ? (
                    <span style={{ color: 'tomato' }}>Mauvaise réponse</span>
                  ) : (
                    <span style={{ color: 'limegreen' }}>
                      Bonne réponse ! +{accepted.points} points
                    </span>
                  )}
                </div>
              )}
            </>
          )}

          {!round && (
            <div style={{ marginTop: 12, opacity: 0.7 }}>
              En attente de la prochaine manche...
            </div>
          )}

          {round?.reveal && (
            <div style={{ marginTop: 16 }}>
              <hr />
              <div style={{ marginTop: 8 }}>
                <div>Réponse :</div>
                <div>
                  <strong>{round.reveal.title}</strong> — {round.reveal.artist}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
