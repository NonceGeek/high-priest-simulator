export type CardType = 'raid' | 'nightRaid' | 'nightWatch' | 'sacrificeChiyou' | 'sacrificeNuwa';

export interface Card {
  id: string;
  type: CardType;
  owner: PlayerId;
}

export type PlayerId = 'player1' | 'player2';

export interface Captive {
  originalOwner: PlayerId;
  currentController: PlayerId;
}

export interface Player {
  id: PlayerId;
  nickname?: string;
  population: number;
  hand: Card[];
  discardPile: Card[];
  /** Face-up discard names since last 向女娲祭祀; cleared when the ritual resolves. */
  faceUpDiscards: CardType[];
  captives: Captive[];
  socketId?: string;
}

export interface NuwaDraw {
  round: number;
  playerId: PlayerId;
  cardType: CardType;
  cardId: string;
}

export interface GameState {
  id: string;
  players: Record<PlayerId, Player>;
  currentRound: number;
  status: 'waiting' | 'playing' | 'finished';
  winner: PlayerId | 'draw' | null;
  selectedActions: Record<PlayerId, Action | null>;
  gameLog: string[];
  /** Both players' Nuwa draws — stored in full; console hides the opponent's card. */
  nuwaDrawHistory: NuwaDraw[];
}

export type ActionType = 'card' | 'desperateStrike';

export interface CardAction {
  type: 'card';
  cardId: string;
}

export interface DesperateStrikeAction {
  type: 'desperateStrike';
  populationCost: number;
}

export type Action = CardAction | DesperateStrikeAction;

export interface Room {
  id: string;
  gameState: GameState;
  createdAt: number;
}
