import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTournament } from '../context/TournamentContext';
import { Player } from '../types';
import './Register.css';

const Register = () => {
  const navigate = useNavigate();
  const { addTeam, teams } = useTournament();
  const [teamName, setTeamName] = useState('');
  const [players, setPlayers] = useState<Player[]>([
    { name: '', email: '' },
    { name: '', email: '' },
    { name: '', email: '' },
  ]);
  const [errors, setErrors] = useState<string[]>([]);

  const handlePlayerChange = (index: number, field: keyof Player, value: string) => {
    const newPlayers = [...players];
    newPlayers[index] = { ...newPlayers[index], [field]: value };
    setPlayers(newPlayers);
  };

  const validateForm = (): boolean => {
    const newErrors: string[] = [];

    if (!teamName.trim()) {
      newErrors.push('Team name is required');
    }

    players.forEach((player, index) => {
      if (!player.name.trim()) {
        newErrors.push(`Player ${index + 1} name is required`);
      }
      if (!player.email.trim()) {
        newErrors.push(`Player ${index + 1} email is required`);
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(player.email)) {
        newErrors.push(`Player ${index + 1} email is invalid`);
      }
    });

    // Check for duplicate emails
    const emails = players.map(p => p.email.toLowerCase());
    const uniqueEmails = new Set(emails);
    if (uniqueEmails.size !== emails.length) {
      newErrors.push('Each player must have a unique email address');
    }

    setErrors(newErrors);
    return newErrors.length === 0;
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    addTeam({
      teamName: teamName.trim(),
      players: players as [Player, Player, Player],
    });

    // Reset form
    setTeamName('');
    setPlayers([
      { name: '', email: '' },
      { name: '', email: '' },
      { name: '', email: '' },
    ]);
    setErrors([]);

    // Navigate to teams page
    navigate('/teams');
  };

  return (
    <div className="register-page">
      <div className="container">
        <div className="register-content">
          <div className="register-header">
            <h1>Register Your Team</h1>
            <p>Fill in your team details to join the tournament</p>
          </div>

          {errors.length > 0 && (
            <div className="error-box">
              <h3>Please fix the following errors:</h3>
              <ul>
                {errors.map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
            </div>
          )}

          <form onSubmit={handleSubmit} className="register-form">
            <div className="form-section">
              <h2>Team Information</h2>
              <div className="form-group">
                <label htmlFor="teamName">Team Name *</label>
                <input
                  type="text"
                  id="teamName"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="Enter your team name"
                  required
                />
              </div>
            </div>

            <div className="form-section">
              <h2>Team Members (3 players required)</h2>
              {players.map((player, index) => (
                <div key={index} className="player-card">
                  <h3>Player {index + 1}</h3>
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor={`player${index}-name`}>Name *</label>
                      <input
                        type="text"
                        id={`player${index}-name`}
                        value={player.name}
                        onChange={(e) => handlePlayerChange(index, 'name', e.target.value)}
                        placeholder="Player name"
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor={`player${index}-email`}>Email *</label>
                      <input
                        type="email"
                        id={`player${index}-email`}
                        value={player.email}
                        onChange={(e) => handlePlayerChange(index, 'email', e.target.value)}
                        placeholder="player@example.com"
                        required
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="form-actions">
              <button type="submit" className="btn btn-primary">
                Register Team
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => navigate('/teams')}
              >
                View All Teams
              </button>
            </div>
          </form>

          <div className="register-info">
            <p>
              <strong>Note:</strong> Make sure all information is correct. You can view all registered teams on the Teams page.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Register;
