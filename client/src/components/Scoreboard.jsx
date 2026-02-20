export default function Scoreboard({ players=[] }) {
  const sorted = [...players].sort((a,b)=> b.score - a.score);
  return (
    <div className="card">
      <h3>Classement</h3>
      <div>
        {sorted.map((p,i)=> (
          <div key={p.id} className="score-row">
            <div>#{i+1} — {p.name}</div>
            <div>{p.score}</div>
          </div>
        ))}
      </div>
    </div>
  );
}