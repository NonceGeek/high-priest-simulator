/** 显示游戏大厅，并通过服务器签发的凭证创建、加入和恢复房间。 */
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  createRoom, joinRoom, connectSocket, onGameState, offGameState,
  getStoredSession, getGameState, getSocket, clearRoomSession,
} from '@/lib/socketClient';
import { GameState } from '@/lib/types';
import {
  resolveInitialNickname,
  setStoredNickname,
  MAX_NICKNAME_LENGTH,
} from '@/lib/nickname';
import { resolveRandomSlogan } from '@/lib/slogan';

/**
 * 渲染大厅及等待对手的页面。
 * @returns 大厅 React 元素。
 * @Callers Next.js 首页路由。
 */
export default function Home() {
  const router = useRouter();
  const [mode, setMode] = useState<'menu' | 'create' | 'join'>('menu');
  const [roomId, setRoomId] = useState('');
  const [joinRoomId, setJoinRoomId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [nickname, setNickname] = useState('');
  const [nicknameReady, setNicknameReady] = useState(false);
  const [hasSavedNickname, setHasSavedNickname] = useState(false);
  const [editingNickname, setEditingNickname] = useState(false);
  const [draftNickname, setDraftNickname] = useState('');
  const [slogan, setSlogan] = useState('');

  useEffect(() => {
    let cancelled = false;
    let latestRoom = '';
    let latestRevision = -1;

    void (async () => {
      const [{ nickname: name, isStored }, tagline] = await Promise.all([
        resolveInitialNickname(),
        resolveRandomSlogan(),
      ]);
      if (cancelled) return;

      setNickname(name);
      setDraftNickname(name);
      setHasSavedNickname(isStored);
      setEditingNickname(!isStored);
      setNicknameReady(true);
      setSlogan(tagline);
    })().catch((cause: Error) => { if (!cancelled) setError(cause.message); });

    /**
     * 根据服务器状态恢复等待房间或进入对局。
     * @param state 当前权威游戏状态。
     * @returns 无返回值。
     * @Callers gameState 广播、restoreRoom。
     */
    function receiveState(state: GameState): void {
      if (cancelled) return;
      if (!getStoredSession()) return;
      if (latestRoom === state.id && state.revision < latestRevision) return;
      latestRoom = state.id;
      latestRevision = state.revision;
      setRoomId(state.id);
      if (state.status === 'waiting') setMode('create');
      else router.push('/game');
    }
    /**
     * 连接建立后重新读取权威房间状态。
     * @returns 无返回值。
     * @Callers Socket.IO connect 事件及首页初始化。
     */
    function restoreRoom(): void {
      setError('');
      if (getStoredSession()) {
        void getGameState().then(receiveState).catch((cause: Error) => setError(cause.message));
      }
    }
    /**
     * 显示连接或服务器操作失败的原因。
     * @param cause Socket.IO 报告的错误。
     * @returns 无返回值。
     * @Callers Socket.IO connect_error 事件。
     */
    function connectionFailed(cause: Error): void { setError(cause.message); }
    /**
     * 等待房间中断线时提示正在恢复。
     * @returns 无返回值。
     * @Callers Socket.IO disconnect 事件。
     */
    function disconnected(): void {
      if (getStoredSession()) setError('连接已断开，正在恢复房间连接');
    }
    const client = getSocket();
    onGameState(receiveState);
    client.on('connect', restoreRoom);
    client.on('connect_error', connectionFailed);
    client.on('disconnect', disconnected);
    if (getStoredSession()) {
      if (client.connected) restoreRoom();
      else connectSocket();
    }

    return () => {
      cancelled = true;
      offGameState(receiveState);
      client.off('connect', restoreRoom);
      client.off('connect_error', connectionFailed);
      client.off('disconnect', disconnected);
    };
  }, [router]);

  /**
   * 保存通过输入校验的昵称。
   * @param value 当前输入昵称。
   * @returns 已清理的昵称。
   * @Callers handleSaveNickname、handleCreateRoom、handleJoinRoom。
   */
  const persistNickname = (value: string) => {
    const cleaned = setStoredNickname(value);
    setNickname(cleaned);
    setDraftNickname(cleaned);
    setHasSavedNickname(true);
    setEditingNickname(false);
    return cleaned;
  };

  /**
   * 校验并保存编辑中的昵称。
   * @returns 无返回值。
   * @Callers 昵称保存按钮。
   */
  const handleSaveNickname = () => {
    const trimmed = draftNickname.trim();
    if (!trimmed) {
      setError('请输入昵称');
      return;
    }
    setError('');
    persistNickname(trimmed);
  };

  /**
   * 请求创建房间，成功后显示等待页面。
   * @returns 异步完成通知。
   * @Callers 创建房间按钮。
   */
  const handleCreateRoom = async () => {
    setError('');
    const value = (editingNickname ? draftNickname : nickname).trim();
    if (!value) { setError('请输入昵称'); return; }
    const name = persistNickname(value);
    setBusy(true);
    await createRoom(name).then((session) => {
      setRoomId(session.roomId);
      setMode('create');
    }).catch((cause: Error) => setError(cause.message)).finally(() => setBusy(false));
  };

  /**
   * 请求加入房间，保存会话后进入对局。
   * @returns 异步完成通知。
   * @Callers 加入按钮。
   */
  const handleJoinRoom = async () => {
    if (!joinRoomId.trim()) {
      setError('请输入房间号');
      return;
    }

    setError('');
    const value = (editingNickname ? draftNickname : nickname).trim();
    if (!value) { setError('请输入昵称'); return; }
    const name = persistNickname(value);
    setBusy(true);
    await joinRoom(joinRoomId.trim(), name).then(() => router.push('/game'))
      .catch((cause: Error) => setError(cause.message)).finally(() => setBusy(false));
  };

  const nicknameField = (
    <div className="mb-6">
      <label className="block text-gray-300 text-sm mb-2">昵称</label>
      {!nicknameReady ? (
        <div className="text-gray-400 text-sm">加载中...</div>
      ) : editingNickname ? (
        <div className="space-y-2">
          <input
            type="text"
            value={draftNickname}
            onChange={(e) => setDraftNickname(e.target.value.slice(0, MAX_NICKNAME_LENGTH))}
            maxLength={MAX_NICKNAME_LENGTH}
            placeholder="输入你的昵称"
            className="w-full p-3 rounded-lg bg-gray-700 text-white border border-gray-600 focus:border-blue-500 focus:outline-none"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSaveNickname}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg"
            >
              保存
            </button>
            {hasSavedNickname && (
              <button
                type="button"
                onClick={() => {
                  setDraftNickname(nickname);
                  setEditingNickname(false);
                  setError('');
                }}
                className="flex-1 bg-gray-600 hover:bg-gray-700 text-white px-4 py-2 rounded-lg"
              >
                取消
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-gray-700 border border-gray-600">
          <span className="text-white font-medium truncate">{nickname}</span>
          <button
            type="button"
            onClick={() => {
              setDraftNickname(nickname);
              setEditingNickname(true);
            }}
            className="shrink-0 bg-gray-600 hover:bg-gray-500 text-white px-3 py-1.5 rounded-lg text-sm"
          >
            修改昵称
          </button>
        </div>
      )}
    </div>
  );

  if (mode === 'create' && roomId) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-900 to-gray-700 flex items-center justify-center">
        <div className="bg-gray-800 p-8 rounded-lg shadow-2xl text-center">
          <h1 className="text-3xl font-bold text-white mb-4">等待对手加入</h1>
          <p className="text-gray-300 mb-2">
            {nickname} <span className="opacity-70">(Player1)</span>
          </p>
          <div className="text-6xl font-mono text-yellow-400 mb-4">{roomId}</div>
          <p className="text-gray-300 mb-6">将此房间号分享给你的朋友</p>
          {error && <div role="alert" className="text-red-400 mb-4">
            {error}
            <button onClick={() => connectSocket()} className="ml-3 underline">重新连接</button>
          </div>}
          <button
            onClick={() => void navigator.clipboard.writeText(roomId).catch((cause: Error) => setError(cause.message))}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg mr-2"
          >
            复制房间号
          </button>
          <button
            onClick={() => {
              clearRoomSession();
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
        {slogan && (
          <div className="text-gray-300 text-center mb-8 italic">
            —— {slogan}
          </div>
        )}

        {nicknameField}
        {error && <div role="alert" className="text-red-400 text-center mb-4">
          {error}
          <button onClick={() => {
            clearRoomSession();
            setRoomId('');
            setMode('menu');
            setError('');
          }} className="block mx-auto mt-2 underline">退出原房间并重新开始</button>
        </div>}

        {mode === 'menu' && (
          <div className="space-y-4">
            <button
              onClick={handleCreateRoom}
              disabled={!nicknameReady || busy}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-3 rounded-lg font-bold text-lg"
            >
              创建房间
            </button>
            <button
              onClick={() => setMode('join')}
              disabled={!nicknameReady || busy}
              className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white py-3 rounded-lg font-bold text-lg"
            >
              加入房间
            </button>
            <a
              href="/rules.html"
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full text-center bg-gray-700 hover:bg-gray-600 text-gray-200 py-3 rounded-lg font-bold text-lg"
            >
              规则书 📖 
            </a>
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
            <button
              onClick={handleJoinRoom}
              disabled={busy}
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
