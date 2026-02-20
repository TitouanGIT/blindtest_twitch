import { useEffect, useMemo, useState } from 'react';
import { createSocket } from '../lib/socket';

export default function OverlayPage() {
  const [serverUrl] = useState(window.location.origin);
  const [players, setPlayers] = useState([]);
  const socket = useMemo(() => createSocket(serverUrl), [serverUrl]);

  useEffect(() => {
    socket.emit('room:join', { name: 'OVERLAY' });
    socket.on('room:players', setPlayers);
    return () => {
      socket.disconnect();
    };
  }, [socket]);

  const sorted = [...players].sort((a, b) => b.score - a.score).slice(0, 8);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'flex-end',
        padding: 16,
        boxSizing: 'border-box',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto',
        color: '#fff'
      }}
    >
      <div
        style={{
          display: 'grid',
          gap: 8,
          minWidth: 320,
          background: 'rgba(0,0,0,0.25)',
          padding: 12,
          borderRadius: 16
        }}
      >
        {sorted.map((p, i) => (
          <div
            key={p.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '48px 1fr 80px',
              alignItems: 'center',
              background: 'rgba(0,0,0,0.35)',
              padding: '6px 10px',
              borderRadius: 12
            }}
          >
            <div style={{ fontWeight: 700 }}>#{i + 1}</div>
            <div
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {p.name}
            </div>
            <div style={{ textAlign: 'right', fontWeight: 700 }}>{p.score}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
