import { Link, useLocation } from 'react-router-dom';
import { useTournament } from '../context/TournamentContext';
import './Navbar.css';

const Navbar = () => {
  const location = useLocation();
  const { teams } = useTournament();

  return (
    <nav className="navbar">
      <div className="container">
        <Link to="/" className="nav-brand">
          🎯 Codenames Tournament
        </Link>
        <ul className="nav-menu">
          <li>
            <Link to="/" className={location.pathname === '/' ? 'active' : ''}>
              Home
            </Link>
          </li>
          <li>
            <Link to="/register" className={location.pathname === '/register' ? 'active' : ''}>
              Register Team
            </Link>
          </li>
          <li>
            <Link to="/teams" className={location.pathname === '/teams' ? 'active' : ''}>
              Teams ({teams.length})
            </Link>
          </li>
        </ul>
      </div>
    </nav>
  );
};

export default Navbar;
