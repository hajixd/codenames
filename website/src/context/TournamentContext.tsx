import React, { createContext, useContext, useState, ReactNode } from 'react';
import { Team, Player } from '../types';

interface TournamentContextType {
  teams: Team[];
  addTeam: (team: Omit<Team, 'id' | 'registeredAt'>) => void;
  removeTeam: (teamId: string) => void;
  maxTeams?: number;
  setMaxTeams: (max: number) => void;
}

const TournamentContext = createContext<TournamentContextType | undefined>(undefined);

export const TournamentProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [teams, setTeams] = useState<Team[]>([]);

  const addTeam = (teamData: Omit<Team, 'id' | 'registeredAt'>) => {
    const newTeam: Team = {
      ...teamData,
      id: Date.now().toString(),
      registeredAt: new Date(),
    };
    setTeams((prev) => [...prev, newTeam]);
  };

  const removeTeam = (teamId: string) => {
    setTeams((prev) => prev.filter((team) => team.id !== teamId));
  };

  const setMaxTeams = (max: number) => {
    // This could be stored in state if needed
  };

  return (
    <TournamentContext.Provider value={{ teams, addTeam, removeTeam, setMaxTeams }}>
      {children}
    </TournamentContext.Provider>
  );
};

export const useTournament = () => {
  const context = useContext(TournamentContext);
  if (context === undefined) {
    throw new Error('useTournament must be used within a TournamentProvider');
  }
  return context;
};
