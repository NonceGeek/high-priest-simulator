import type { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { Action, PlayerId, Room } from './types';
import { createGameState, resolveRound } from './gameLogic';
import type { ClientMessage, ServerMessage } from './wsProtocol';

type Client = {
  id: string;
  ws: WebSocket;
  roomId?: string;
  playerId?: PlayerId;
};

const WS_OPEN = 1;

export class GameHub {
  private rooms = new Map<string, Room>();
  private clients = new Map<string, Client>();

  handleConnection(ws: WebSocket): void {
    const client: Client = { id: uuidv4(), ws };
    this.clients.set(client.id, client);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        this.handleMessage(client, msg);
      } catch (err) {
        console.error('Invalid WebSocket message:', err);
      }
    });

    ws.on('close', () => {
      this.handleDisconnect(client);
      this.clients.delete(client.id);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
    });
  }

  private send(client: Client, msg: ServerMessage): void {
    if (client.ws.readyState === WS_OPEN) {
      client.ws.send(JSON.stringify(msg));
    }
  }

  private sendToSocketId(socketId: string | undefined, msg: ServerMessage): void {
    if (!socketId) return;
    const client = this.clients.get(socketId);
    if (client) {
      this.send(client, msg);
    }
  }

  private sendToRoom(roomId: string, msg: ServerMessage): void {
    Array.from(this.clients.values()).forEach((client) => {
      if (client.roomId === roomId) {
        this.send(client, msg);
      }
    });
  }

  private handleMessage(client: Client, msg: ClientMessage): void {
    switch (msg.type) {
      case 'createRoom':
        this.createRoom(client, msg.requestId);
        break;
      case 'joinRoom':
        this.joinRoom(client, msg.roomId, msg.requestId);
        break;
      case 'rejoinRoom':
        this.rejoinRoom(client, msg.roomId, msg.playerId, msg.requestId);
        break;
      case 'selectAction':
        this.selectAction(client, msg.action, msg.requestId);
        break;
      case 'getGameState':
        this.getGameState(client, msg.requestId);
        break;
    }
  }

  private createRoom(client: Client, requestId: string): void {
    const roomId = uuidv4().slice(0, 8);
    const gameState = createGameState(roomId);

    this.rooms.set(roomId, {
      id: roomId,
      gameState,
      createdAt: Date.now(),
    });

    client.roomId = roomId;
    client.playerId = 'player1';
    gameState.players.player1.socketId = client.id;
    gameState.gameLog.push(`Room ${roomId} created. Waiting for player 2...`);

    this.send(client, { type: 'createRoomResult', requestId, roomId });
    console.log(`Room ${roomId} created by ${client.id}`);
  }

  private joinRoom(client: Client, roomId: string, requestId: string): void {
    const room = this.rooms.get(roomId);

    if (!room) {
      this.send(client, { type: 'joinRoomResult', requestId, success: false, error: 'Room not found' });
      return;
    }

    if (room.gameState.players.player2.socketId) {
      this.send(client, { type: 'joinRoomResult', requestId, success: false, error: 'Room is full' });
      return;
    }

    if (room.gameState.status !== 'waiting') {
      this.send(client, { type: 'joinRoomResult', requestId, success: false, error: 'Game already started' });
      return;
    }

    client.roomId = roomId;
    client.playerId = 'player2';
    room.gameState.players.player2.socketId = client.id;
    room.gameState.status = 'playing';
    room.gameState.gameLog.push('Player 2 joined. Game started!');

    this.send(client, { type: 'joinRoomResult', requestId, success: true });
    this.sendToRoom(roomId, { type: 'gameState', state: room.gameState });
    console.log(`Player 2 joined room ${roomId}`);
  }

  private rejoinRoom(client: Client, roomId: string, playerId: PlayerId, requestId: string): void {
    const room = this.rooms.get(roomId);

    if (!room) {
      this.send(client, {
        type: 'rejoinRoomResult',
        requestId,
        success: false,
        error: 'Room not found',
      });
      return;
    }

    const existingSocketId = room.gameState.players[playerId].socketId;
    if (existingSocketId && existingSocketId !== client.id) {
      const existing = this.clients.get(existingSocketId);
      if (existing && existing.ws.readyState === WS_OPEN) {
        this.send(client, {
          type: 'rejoinRoomResult',
          requestId,
          success: false,
          error: 'Player slot already connected',
        });
        return;
      }
    }

    client.roomId = roomId;
    client.playerId = playerId;
    room.gameState.players[playerId].socketId = client.id;
    room.gameState.gameLog.push(`${playerId} rejoined`);

    this.send(client, {
      type: 'rejoinRoomResult',
      requestId,
      success: true,
      state: room.gameState,
    });

    const otherPlayerId = playerId === 'player1' ? 'player2' : 'player1';
    this.sendToSocketId(room.gameState.players[otherPlayerId].socketId, {
      type: 'gameState',
      state: room.gameState,
    });
  }

  private selectAction(client: Client, action: Action, requestId: string): void {
    const roomId = client.roomId;
    const playerId = client.playerId;

    if (!roomId || !playerId) {
      this.send(client, { type: 'selectActionResult', requestId, success: false, error: 'Not in a room' });
      return;
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      this.send(client, { type: 'selectActionResult', requestId, success: false, error: 'Room not found' });
      return;
    }

    if (room.gameState.status !== 'playing') {
      this.send(client, { type: 'selectActionResult', requestId, success: false, error: 'Game not in progress' });
      return;
    }

    const player = room.gameState.players[playerId];

    if (action.type === 'card') {
      const canPlay = player.hand.some((c) => c.id === action.cardId);
      if (!canPlay) {
        this.send(client, { type: 'selectActionResult', requestId, success: false, error: 'Card not in hand' });
        return;
      }
    } else if (action.type === 'desperateStrike') {
      if (player.hand.length > 0) {
        this.send(client, {
          type: 'selectActionResult',
          requestId,
          success: false,
          error: 'Cannot use desperate strike with cards in hand',
        });
        return;
      }
      if (
        action.populationCost < 1 ||
        action.populationCost > 3 ||
        action.populationCost > player.population
      ) {
        this.send(client, {
          type: 'selectActionResult',
          requestId,
          success: false,
          error: 'Invalid population cost',
        });
        return;
      }
    }

    room.gameState.selectedActions[playerId] = action;
    room.gameState.gameLog.push(`${playerId} has selected an action`);

    this.send(client, { type: 'selectActionResult', requestId, success: true });
    this.send(client, { type: 'gameState', state: room.gameState });

    const otherPlayerId = playerId === 'player1' ? 'player2' : 'player1';
    const otherPlayer = room.gameState.players[otherPlayerId];
    this.sendToSocketId(otherPlayer.socketId, {
      type: 'gameState',
      state: {
        ...room.gameState,
        gameLog: [...room.gameState.gameLog, 'Opponent has selected an action'],
      },
    });

    if (room.gameState.selectedActions.player1 && room.gameState.selectedActions.player2) {
      setTimeout(() => {
        room.gameState = resolveRound(room.gameState);
        this.sendToRoom(roomId, { type: 'gameState', state: room.gameState });
      }, 1000);
    }
  }

  private getGameState(client: Client, requestId: string): void {
    const roomId = client.roomId;

    if (!roomId) {
      this.send(client, { type: 'getGameStateResult', requestId, state: null });
      return;
    }

    const room = this.rooms.get(roomId);
    this.send(client, {
      type: 'getGameStateResult',
      requestId,
      state: room?.gameState ?? null,
    });
  }

  private handleDisconnect(client: Client): void {
    const roomId = client.roomId;
    const playerId = client.playerId;

    if (roomId && playerId) {
      const room = this.rooms.get(roomId);
      if (room && room.gameState.players[playerId].socketId === client.id) {
        room.gameState.players[playerId].socketId = undefined;
        room.gameState.gameLog.push(`${playerId} disconnected`);

        const otherPlayerId = playerId === 'player1' ? 'player2' : 'player1';
        this.sendToSocketId(room.gameState.players[otherPlayerId].socketId, {
          type: 'gameState',
          state: room.gameState,
        });
      }
    }

    console.log('Client disconnected:', client.id);
  }
}

const globalForHub = globalThis as unknown as { __gameHub?: GameHub };

export function getGameHub(): GameHub {
  if (!globalForHub.__gameHub) {
    globalForHub.__gameHub = new GameHub();
  }
  return globalForHub.__gameHub;
}
