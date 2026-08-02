'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createRoom, joinRoom, connectSocket, onGameState, offGameState } from '@/lib/socketClient';
import { GameState } from '@/lib/types';

export default function Home() {
  const router = useRouter();
  const [mode, setMode] = useState<'menu' | 'create' | 'join'>('menu');
  const [roomId, setRoomId] = useState('');
  const [joinRoomId, setJoinRoomId] = useState('');
  const [error, setError] = useState('');
  const [playerId, setPlayerId] = useState<'player1' | 'player2' | null>(null);

  useEffect(() => {
    const savedRoomId = localStorage.getItem('roomId');
    const savedPlayerId = localStorage.getItem('playerId') as 'player1' | 'player2' | null;
    
    if (savedRoomId && savedPlayerId) {
      setRoomId(savedRoomId);
      setPlayerId(savedPlayerId);
      
      connectSocket();
      
      onGameState((state: GameState) => {
        localStorage.setItem('gameState', JSON.stringify(state));
        if (state.status === 'playing') {
          router.push('/game');
        }
      });
    }
  }, [router]);

  const handleCreateRoom = () => {
    setError('');
    createRoom((newRoomId) => {
      setRoomId(newRoomId);
      setPlayerId('player1');
      localStorage.setItem('roomId', newRoomId);
      localStorage.setItem('playerId', 'player1');
      setMode('create');
      
      connectSocket();
      onGameState((state: GameState) => {
        localStorage.setItem('gameState', JSON.stringify(state));
        if (state.status === 'playing') {
          router.push('/game');
        }
      });
    });
  };

  const handleJoinRoom = () => {
    if (!joinRoomId.trim()) {
      setError('请输入房间号');
      return;
    }
    
    setError('');
    joinRoom(joinRoomId.trim(), (success, errorMsg) => {
      if (success) {
        setRoomId(joinRoomId.trim());
        setPlayerId('player2');
        localStorage.setItem('roomId', joinRoomId.trim());
        localStorage.setItem('playerId', 'player2');
        
        connectSocket();
        onGameState((state: GameState) => {
          localStorage.setItem('gameState', JSON.stringify(state));
          router.push('/game');
        });
      } else {
        setError(errorMsg || '加入房间失败');
      }
    });
  };

  if (mode === 'create' && roomId) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-900 to-gray-700 flex items-center justify-center">
        <div className="bg-gray-800 p-8 rounded-lg shadow-2xl text-center">
          <h1 className="text-3xl font-bold text-white mb-4">等待对手加入</h1>
          <div className="text-6xl font-mono text-yellow-400 mb-4">{roomId}</div>
          <p className="text-gray-300 mb-6">将此房间号分享给你的朋友</p>
          <button
            onClick={() => navigator.clipboard.writeText(roomId)}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg mr-2"
          >
            复制房间号
          </button>
          <button
            onClick={() => {
              localStorage.removeItem('roomId');
              localStorage.removeItem('playerId');
              setMode('menu');
              setRoomId('');
            }}
            className="bg-gray-600 hover:bg-gray-700 text-white px-6 py-2 rounded-lg"
          >
            返回
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-gray-700 flex items-center justify-center">
      <div className="bg-gray-800 p-8 rounded-lg shadow-2xl max-w-md w-full">
        <h1 className="text-4xl font-bold text-white text-center mb-8">大祭司模拟器</h1>
        
        {mode === 'menu' && (
          <div className="space-y-4">
            <button
              onClick={handleCreateRoom}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-lg font-bold text-lg"
            >
              创建房间
            </button>
            <button
              onClick={() => setMode('join')}
              className="w-full bg-green-600 hover:bg-green-700 text-white py-3 rounded-lg font-bold text-lg"
            >
              加入房间
            </button>
          </div>
        )}
        
        {mode === 'join' && (
          <div className="space-y-4">
            <input
              type="text"
              value={joinRoomId}
              onChange={(e) => setJoinRoomId(e.target.value)}
              placeholder="输入房间号"
              className="w-full p-3 rounded-lg bg-gray-700 text-white border border-gray-600 focus:border-blue-500 focus:outline-none"
            />
            {error && <div className="text-red-400 text-center">{error}</div>}
            <button
              onClick={handleJoinRoom}
              className="w-full bg-green-600 hover:bg-green-700 text-white py-3 rounded-lg font-bold text-lg"
            >
              加入
            </button>
            <button
              onClick={() => setMode('menu')}
              className="w-full bg-gray-600 hover:bg-gray-700 text-white py-3 rounded-lg"
            >
              返回
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
