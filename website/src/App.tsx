import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { TournamentProvider } from './context/TournamentContext';
import Navbar from './components/Navbar';
import Home from './pages/Home';
import Register from './pages/Register';
import Teams from './pages/Teams';
import NotFound from './pages/NotFound';
import './styles/App.css';

function App() {
  return (
    <TournamentProvider>
      <Router>
        <div className="app">
          <Navbar />
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/register" element={<Register />} />
            <Route path="/teams" element={<Teams />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
      </Router>
    </TournamentProvider>
  );
}

export default App;
