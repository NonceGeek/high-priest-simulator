"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GameHub = void 0;
exports.getGameHub = getGameHub;
const uuid_1 = require("uuid");
const gameLogic_1 = require("./gameLogic");
const WS_OPEN = 1;
class GameHub {
    constructor() {
        this.rooms = new Map();
        this.clients = new Map();
    }
    handleConnection(ws) {
        const client = { id: (0, uuid_1.v4)(), ws };
        this.clients.set(client.id, client);
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(client, msg);
            }
            catch (err) {
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
    send(client, msg) {
        if (client.ws.readyState === WS_OPEN) {
            client.ws.send(JSON.stringify(msg));
        }
    }
    sendToSocketId(socketId, msg) {
        if (!socketId)
            return;
        const client = this.clients.get(socketId);
        if (client) {
            this.send(client, msg);
        }
    }
    sendToRoom(roomId, msg) {
        Array.from(this.clients.values()).forEach((client) => {
            if (client.roomId === roomId) {
                this.send(client, msg);
            }
        });
    }
    handleMessage(client, msg) {
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
    createRoom(client, requestId) {
        const roomId = (0, uuid_1.v4)().slice(0, 8);
        const gameState = (0, gameLogic_1.createGameState)(roomId);
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
    joinRoom(client, roomId, requestId) {
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
    rejoinRoom(client, roomId, playerId, requestId) {
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
    selectAction(client, action, requestId) {
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
        }
        else if (action.type === 'desperateStrike') {
            if (player.hand.length > 0) {
                this.send(client, {
                    type: 'selectActionResult',
                    requestId,
                    success: false,
                    error: 'Cannot use desperate strike with cards in hand',
                });
                return;
            }
            if (action.populationCost < 1 ||
                action.populationCost > 3 ||
                action.populationCost > player.population) {
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
                room.gameState = (0, gameLogic_1.resolveRound)(room.gameState);
                this.sendToRoom(roomId, { type: 'gameState', state: room.gameState });
            }, 1000);
        }
    }
    getGameState(client, requestId) {
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
    handleDisconnect(client) {
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
exports.GameHub = GameHub;
const globalForHub = globalThis;
function getGameHub() {
    if (!globalForHub.__gameHub) {
        globalForHub.__gameHub = new GameHub();
    }
    return globalForHub.__gameHub;
}
