/** 定义游戏规则、持久房间及客户端和服务器之间的唯一通信协议。 */
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

export interface RevealedAction {
  playerId: PlayerId;
  /** null when the action was 垂死一搏. */
  cardType: CardType | null;
  /** Population invested in 垂死一搏. */
  populationCost?: number;
  cancelled: boolean;
  /** Settlement result; empty while the round is still pending. */
  effectText: string;
  /** Card drawn via 向女娲祭祀; shown only to the drawer in the UI. */
  drawnCardType?: CardType;
}

export interface RoundReveal {
  round: number;
  /** false while both actions are locked but not yet settled. */
  resolved: boolean;
  actions: Record<PlayerId, RevealedAction>;
}

export interface GameState {
  id: string;
  /** 房间状态版本从 0 开始；服务器只在实际状态变化时递增。 */
  revision: number;
  players: Record<PlayerId, Player>;
  currentRound: number;
  status: 'waiting' | 'playing' | 'finished';
  winner: PlayerId | 'draw' | null;
  /** How the game ended; null while still in progress. */
  endReason: 'knockout' | 'population' | null;
  selectedActions: Record<PlayerId, Action | null>;
  gameLog: string[];
  /** Both players' Nuwa draws — stored in full; console hides the opponent's card. */
  nuwaDrawHistory: NuwaDraw[];
  /** Cards both players revealed in the most recent settled round. */
  lastReveal: RoundReveal | null;
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
  revision: number;
  /** 仅由 Redis 保存，不包含在 GameState 广播中。 */
  sessionTokenHashes: Partial<Record<PlayerId, string>>;
}

export interface RoomSession {
  roomId: string;
  playerId: PlayerId;
  token: string;
}

export type SocketResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface ActionRequest {
  round: number;
  action: Action;
}

export interface ClientToServerEvents {
  createRoom: (nickname: string, ack: (result: SocketResult<RoomSession>) => void) => void;
  joinRoom: (roomId: string, nickname: string, ack: (result: SocketResult<RoomSession>) => void) => void;
  selectAction: (request: ActionRequest, ack: (result: SocketResult<GameState>) => void) => void;
  getGameState: (ack: (result: SocketResult<GameState>) => void) => void;
}

export interface ServerToClientEvents {
  gameState: (state: GameState) => void;
  serverError: (message: string) => void;
}
