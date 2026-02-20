import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';

export default function ResultsPage() {
  const [serverUrl] = useState(window.location.origin);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState({ global: {}, players: [], rounds: [] });
  const [games, setGames] = useState([]);
  const [selectedGameId, setSelectedGameId] = useState('all');

  async function loadStats(gameId) {
    setLoading(true);
    setError('');
    try {
      const qs = gameId && gameId !== 'all' ? `?gameId=${gameId}` : '';
      const r = await fetch(`${serverUrl}/api/stats${qs}`);
      const j = await r.json();
      setData(j);
    } catch (e) {
      console.error(e);
      setError('Impossible de charger les statistiques.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${serverUrl}/api/games`);
        const j = await r.json();
        setGames(j || []);
      } catch (e) {
        console.error('load games error', e);
      }
    })();
  }, [serverUrl]);

  useEffect(() => {
    loadStats(selectedGameId === 'all' ? null : selectedGameId);
  }, [serverUrl, selectedGameId]);

  const players = data.players || [];
  const rounds = data.rounds || [];
  const global = data.global || {};

  const currentGameLabel =
    selectedGameId === 'all'
      ? 'Toutes les soirées'
      : games.find((g) => String(g.id) === String(selectedGameId))?.name ||
        `Soirée #${selectedGameId}`;

  return (
    <div style={{ maxWidth: 1100, margin: '24px auto', padding: 16 }}>
      <h1>Résultats & Statistiques</h1>

      <div style={{ marginBottom: 12 }}>
        <label>
          Soirée :{' '}
          <select
            value={selectedGameId}
            onChange={(e) => setSelectedGameId(e.target.value)}
          >
            <option value="all">Toutes les soirées confondues</option>
            {games.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name || `Soirée #${g.id}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ marginBottom: 8, opacity: 0.7 }}>
        Classements pour : <strong>{currentGameLabel}</strong>
      </div>

      {loading && <div>Chargement...</div>}
      {error && <div style={{ color: 'tomato' }}>{error}</div>}

      {!loading && !error && (
        <>
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <div className="card" style={{ flex: 1, minWidth: 220 }}>
              <h2>Résumé général</h2>
              <ul>
                <li>Joueurs : {global.totalPlayers ?? 0}</li>
                <li>Soirées : {global.totalGames ?? 0}</li>
                <li>Manches : {global.totalRounds ?? 0}</li>
                <li>Réponses justes : {global.totalAnswers ?? 0}</li>
                <li>Points totaux : {global.totalPoints ?? 0}</li>
              </ul>
            </div>
            <div className="card" style={{ flex: 2, minWidth: 320 }}>
              <h2>Classement général (score)</h2>
              {players.length === 0 && <div>Aucun joueur.</div>}
              {players.length > 0 && (
                <div style={{ width: '100%', height: 260 }}>
                  <ResponsiveContainer>
                    <BarChart data={players}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" hide={players.length > 10} />
                      <YAxis />
                      <Tooltip />
                      <Bar dataKey="score" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>

          <div className="row" style={{ gap: 16, marginTop: 16, flexWrap: 'wrap' }}>
            <div className="card" style={{ flex: 1, minWidth: 320 }}>
              <h2>Temps moyen de réponse par joueur (ms)</h2>
              {players.length > 0 && (
                <div style={{ width: '100%', height: 260 }}>
                  <ResponsiveContainer>
                    <BarChart data={players.filter((p) => p.avgResponseTimeMs != null)}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" hide />
                      <YAxis />
                      <Tooltip />
                      <Bar dataKey="avgResponseTimeMs" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
            <div className="card" style={{ flex: 1, minWidth: 320 }}>
              <h2>Bonnes réponses par manche</h2>
              {rounds.length > 0 && (
                <div style={{ width: '100%', height: 260 }}>
                  <ResponsiveContainer>
                    <BarChart data={rounds}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="roundIndex" />
                      <YAxis />
                      <Tooltip />
                      <Bar dataKey="answersCount" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h2>Détail des manches</h2>
            {rounds.length === 0 && <div>Aucune manche encore enregistrée.</div>}
            {rounds.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Titre</th>
                    <th>Artiste</th>
                    <th>Bonnes réponses</th>
                    <th>Temps moyen (ms)</th>
                    <th>Min (ms)</th>
                    <th>Max (ms)</th>
                  </tr>
                </thead>
                <tbody>
                  {rounds.map((r) => (
                    <tr key={r.id}>
                      <td>{r.roundIndex}</td>
                      <td>{r.title}</td>
                      <td>{r.artist}</td>
                      <td>{r.answersCount}</td>
                      <td>{Math.round(r.avgResponseTimeMs || 0)}</td>
                      <td>{r.minResponseTimeMs ?? '-'}</td>
                      <td>{r.maxResponseTimeMs ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
