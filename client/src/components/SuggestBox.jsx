import { useEffect, useRef, useState } from 'react';

export default function SuggestBox({ apiBase, value, onChange, onPick, onEnter }) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (!value) {
      setItems([]);
      setOpen(false);
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`${apiBase}/api/suggest?q=${encodeURIComponent(value)}`);
        const j = await r.json();
        setItems((j.data || []).slice(0, 6));
        setOpen(true);
      } catch (e) {
        console.error('suggest error', e);
      }
    }, 250);

    return () => clearTimeout(timer.current);
  }, [value, apiBase]);

  return (
    <div className="suggest">
      <input
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => items.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && items.length > 0 && (
        <div className="suggest-list">
          {items.map((it) => (
            <div
              key={it.id}
              className="suggest-item"
              onMouseDown={() => onPick(it)}
            >
              {it.title} — <i>{it.artist?.name}</i>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
