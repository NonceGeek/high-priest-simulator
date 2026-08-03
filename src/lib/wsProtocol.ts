import { Action, GameState, PlayerId } from './types';

export type ClientMessage =
  | { type: 'createRoom'; requestId: string }
  | { type: 'joinRoom'; requestId: string; roomId: string }
  | { type: 'rejoinRoom'; requestId: string; roomId: string; playerId: PlayerId }
  | { type: 'selectAction'; requestId: string; action: Action }
  | { type: 'getGameState'; requestId: string };

export type ServerMessage =
  | { type: 'createRoomResult'; requestId: string; roomId: string }
  | { type: 'joinRoomResult'; requestId: string; success: boolean; error?: string }
  | { type: 'rejoinRoomResult'; requestId: string; success: boolean; error?: string; state?: GameState }
  | { type: 'selectActionResult'; requestId: string; success: boolean; error?: string }
  | { type: 'getGameStateResult'; requestId: string; state: GameState | null }
  | { type: 'gameState'; state: GameState };
