import { Server as SocketServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { GameState, Room, Action, PlayerId } from './types';
import { createGameState, resolveRound, getAvailableActions } from './gameLogic';
import { v4 as uuidv4 } from 'uuid';

const rooms = new Map<string, Room>();

export function setupSocketServer(httpServer: HTTPServer) {
  const io = new SocketServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('createRoom', (nickname: string, callback: (roomId: string) => void) => {
      const roomId = uuidv4().slice(0, 8);
      const gameState = createGameState(roomId);
      
      rooms.set(roomId, {
        id: roomId,
        gameState,
        createdAt: Date.now(),
      });
      
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerId = 'player1';
      
      gameState.players.player1.socketId = socket.id;
      gameState.players.player1.nickname = (nickname || '').trim().slice(0, 16) || '祭司';
      gameState.gameLog.push(`Room ${roomId} created. Waiting for player 2...`);
      
      callback(roomId);
      console.log(`Room ${roomId} created by ${socket.id}`);
    });

    socket.on('joinRoom', (roomId: string, nickname: string, callback: (success: boolean, error?: string) => void) => {
      const room = rooms.get(roomId);
      
      if (!room) {
        callback(false, 'Room not found');
        return;
      }
      
      if (room.gameState.players.player2.socketId) {
        callback(false, 'Room is full');
        return;
      }
      
      if (room.gameState.status !== 'waiting') {
        callback(false, 'Game already started');
        return;
      }
      
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.playerId = 'player2';
      
      room.gameState.players.player2.socketId = socket.id;
      room.gameState.players.player2.nickname = (nickname || '').trim().slice(0, 16) || '祭司';
      room.gameState.status = 'playing';
      room.gameState.gameLog.push('Player 2 joined. Game started!');
      
      callback(true);
      
      io.to(roomId).emit('gameState', room.gameState);
      console.log(`Player 2 joined room ${roomId}`);
    });

    socket.on('selectAction', (action: Action, callback: (success: boolean, error?: string) => void) => {
      const roomId = socket.data.roomId;
      const playerId = socket.data.playerId as PlayerId;
      
      if (!roomId) {
        callback(false, 'Not in a room');
        return;
      }
      
      const room = rooms.get(roomId);
      if (!room) {
        callback(false, 'Room not found');
        return;
      }
      
      if (room.gameState.status !== 'playing') {
        callback(false, 'Game not in progress');
        return;
      }
      
      const player = room.gameState.players[playerId];
      
      if (action.type === 'card') {
        const canPlay = player.hand.some(c => c.id === action.cardId);
        if (!canPlay) {
          callback(false, 'Card not in hand');
          return;
        }
      } else if (action.type === 'desperateStrike') {
        if (player.hand.length > 0) {
          callback(false, 'Cannot use desperate strike with cards in hand');
          return;
        }
        if (action.populationCost < 1 || action.populationCost > 3 || action.populationCost > player.population) {
          callback(false, 'Invalid population cost');
          return;
        }
      }
      
      room.gameState.selectedActions[playerId] = action;
      room.gameState.gameLog.push(`${playerId} has selected an action`);
      
      callback(true);
      
      io.to(socket.id).emit('gameState', room.gameState);
      
      const otherPlayerId = playerId === 'player1' ? 'player2' : 'player1';
      const otherPlayer = room.gameState.players[otherPlayerId];
      if (otherPlayer.socketId) {
        io.to(otherPlayer.socketId).emit('gameState', {
          ...room.gameState,
          gameLog: [...room.gameState.gameLog, 'Opponent has selected an action'],
        });
      }
      
      if (room.gameState.selectedActions.player1 && room.gameState.selectedActions.player2) {
        setTimeout(() => {
          room.gameState = resolveRound(room.gameState);
          io.to(roomId).emit('gameState', room.gameState);
        }, 1000);
      }
    });

    socket.on('getGameState', (callback: (state: GameState | null) => void) => {
      const roomId = socket.data.roomId;
      
      if (!roomId) {
        callback(null);
        return;
      }
      
      const room = rooms.get(roomId);
      if (!room) {
        callback(null);
        return;
      }
      
      callback(room.gameState);
    });

    socket.on('disconnect', () => {
      const roomId = socket.data.roomId;
      const playerId = socket.data.playerId as PlayerId;
      
      if (roomId && playerId) {
        const room = rooms.get(roomId);
        if (room) {
          room.gameState.players[playerId].socketId = undefined;
          room.gameState.gameLog.push(`${playerId} disconnected`);
          
          const otherPlayerId = playerId === 'player1' ? 'player2' : 'player1';
          const otherPlayer = room.gameState.players[otherPlayerId];
          if (otherPlayer.socketId) {
            io.to(otherPlayer.socketId).emit('gameState', room.gameState);
          }
        }
      }
      
      console.log('Client disconnected:', socket.id);
    });
  });

  return io;
}

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(roomId);
}

export function getAllRooms(): Room[] {
  return Array.from(rooms.values());
}
