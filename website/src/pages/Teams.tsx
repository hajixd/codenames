import { Link } from 'react-router-dom';
import { useTournament } from '../context/TournamentContext';
import './Teams.css';

const Teams = () => {
  const { teams } = useTournament();

  return (
    <div className="teams-page">
      <div className="container">
        <div className="teams-header">
          <h1>Registered Teams</h1>
          <p>All teams participating in the Codenames Tournament</p>
          <Link to="/register" className="btn btn-primary">
            Register New Team
          </Link>
        </div>

        {teams.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🎯</div>
            <h2>No teams registered yet</h2>
            <p>Be the first to register your team for the tournament!</p>
            <Link to="/register" className="btn btn-primary">
              Register Your Team
            </Link>
          </div>
        ) : (
          <div className="teams-grid">
            {teams.map((team) => (
              <div key={team.id} className="team-card">
                <div className="team-header">
                  <h2>{team.teamName}</h2>
                  <span className="team-id">#{team.id.slice(-6)}</span>
                </div>
                <div className="team-players">
                  <h3>Players:</h3>
                  <ul>
                    {team.players.map((player, index) => (
                      <li key={index}>
                        <span className="player-name">{player.name}</span>
                        <span className="player-email">{player.email}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="team-footer">
                  <span className="team-date">
                    Registered: {new Date(team.registeredAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {teams.length > 0 && (
          <div className="teams-summary">
            <div className="summary-card">
              <div className="summary-number">{teams.length}</div>
              <div className="summary-label">Total Teams</div>
            </div>
            <div className="summary-card">
              <div className="summary-number">{teams.length * 3}</div>
              <div className="summary-label">Total Players</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Teams;
