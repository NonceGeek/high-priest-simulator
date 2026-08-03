"use strict";
'use client';
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSocket = getSocket;
exports.connectSocket = connectSocket;
exports.disconnectSocket = disconnectSocket;
exports.createRoom = createRoom;
exports.joinRoom = joinRoom;
exports.selectAction = selectAction;
exports.onGameState = onGameState;
exports.offGameState = offGameState;
const socket_io_client_1 = require("socket.io-client");
let socket = null;
function getSocket() {
    if (!socket) {
        socket = (0, socket_io_client_1.io)({
            autoConnect: false,
        });
    }
    return socket;
}
function connectSocket() {
    const socket = getSocket();
    if (!socket.connected) {
        socket.connect();
    }
    return socket;
}
function disconnectSocket() {
    if (socket) {
        socket.disconnect();
    }
}
function createRoom(callback) {
    const socket = connectSocket();
    socket.emit('createRoom', callback);
}
function joinRoom(roomId, callback) {
    const socket = connectSocket();
    socket.emit('joinRoom', roomId, callback);
}
function selectAction(action, callback) {
    const socket = getSocket();
    if (socket) {
        socket.emit('selectAction', action, callback);
    }
}
function onGameState(callback) {
    const socket = getSocket();
    if (socket) {
        socket.on('gameState', callback);
    }
}
function offGameState() {
    const socket = getSocket();
    if (socket) {
        socket.off('gameState');
    }
}
