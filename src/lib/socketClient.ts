'use client';

import { io, Socket } from 'socket.io-client';
import { GameState, Action } from './types';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      autoConnect: false,
    });
  }
  return socket;
}

export function connectSocket(): Socket {
  const socket = getSocket();
  if (!socket.connected) {
    socket.connect();
  }
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
  }
}

export function createRoom(nickname: string, callback: (roomId: string) => void): void {
  const socket = connectSocket();
  socket.emit('createRoom', nickname, callback);
}

export function joinRoom(
  roomId: string,
  nickname: string,
  callback: (success: boolean, error?: string) => void,
): void {
  const socket = connectSocket();
  socket.emit('joinRoom', roomId, nickname, callback);
}

export function selectAction(action: Action, callback: (success: boolean, error?: string) => void): void {
  const socket = getSocket();
  if (socket) {
    socket.emit('selectAction', action, callback);
  }
}

export function onGameState(callback: (state: GameState) => void): void {
  const socket = getSocket();
  if (socket) {
    socket.on('gameState', callback);
  }
}

export function offGameState(): void {
  const socket = getSocket();
  if (socket) {
    socket.off('gameState');
  }
}
