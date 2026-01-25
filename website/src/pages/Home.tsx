import { Link } from 'react-router-dom';
import { useTournament } from '../context/TournamentContext';
import './Home.css';

const Home = () => {
  const { teams } = useTournament();

  return (
    <div className="home">
      <section className="hero">
        <div className="container">
          <div className="hero-content">
            <h1 className="hero-title">Codenames Tournament</h1>
            <p className="hero-subtitle">
              Gather your team of 3 and compete in the ultimate word game challenge!
            </p>
            <div className="hero-stats">
              <div className="stat-card">
                <div className="stat-number">{teams.length}</div>
                <div className="stat-label">Teams Registered</div>
              </div>
              <div className="stat-card">
                <div className="stat-number">3</div>
                <div className="stat-label">Players Per Team</div>
              </div>
            </div>
            <div className="hero-buttons">
              <Link to="/register" className="btn btn-primary">
                Register Your Team
              </Link>
              <Link to="/teams" className="btn btn-secondary">
                View Teams
              </Link>
            </div>
          </div>
          <div className="hero-image">
            <div className="gradient-orb"></div>
          </div>
        </div>
      </section>

      <section className="info-section">
        <div className="container">
          <h2 className="section-title">Tournament Details</h2>
          <div className="info-grid">
            <div className="info-card">
              <div className="info-icon">👥</div>
              <h3>Team Format</h3>
              <p>Each team must consist of exactly 3 players. Work together to decode the clues and win!</p>
            </div>
            <div className="info-card">
              <div className="info-icon">📋</div>
              <h3>How to Play</h3>
              <p>Standard Codenames rules apply. One spymaster gives clues, two operatives guess the words.</p>
            </div>
            <div className="info-card">
              <div className="info-icon">🏆</div>
              <h3>Prizes</h3>
              <p>Compete for glory and bragging rights. The winning team will be crowned champions!</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Home;
