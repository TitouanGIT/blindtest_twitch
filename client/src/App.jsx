import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import PlayerPage from './pages/PlayerPage';
import ModeratorPage from './pages/ModeratorPage';
import OverlayPage from './pages/OverlayPage';
import ResultsPage from './pages/ResultsPage';

export default function App() {
  return (
    <BrowserRouter>
      <div style={{ padding: 16 }}>
        <nav className="row" style={{ gap: 12, marginBottom: 12 }}>
        </nav>
        <Routes>
          <Route path="/" element={<PlayerPage />} />
          <Route path="/mod" element={<ModeratorPage />} />
          <Route path="/overlay" element={<OverlayPage />} />
          <Route path="/results" element={<ResultsPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
