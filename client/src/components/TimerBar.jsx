import { useEffect, useRef } from 'react';
export default function TimerBar({ totalMs=15000, startAt }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!startAt || !ref.current) return;
    const tick = () => {
      const elapsed = Date.now() - startAt;
      const pct = Math.max(0, Math.min(100, (elapsed/totalMs)*100));
      ref.current.style.width = `${pct}%`;
      if (elapsed < totalMs) requestAnimationFrame(tick);
    };
    tick();
  }, [startAt, totalMs]);
  return <div className="timerbar"><div ref={ref} /></div>;
}
