export interface Player {
  name: string;
  email: string;
}

export interface Team {
  id: string;
  teamName: string;
  players: [Player, Player, Player];
  registeredAt: Date;
}

export interface TournamentState {
  teams: Team[];
  maxTeams?: number;
  tournamentDate?: Date;
}
