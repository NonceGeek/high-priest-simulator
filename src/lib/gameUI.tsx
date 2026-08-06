import { Card, CardType, GameState, Player, PlayerId, RevealedAction, RoundReveal } from './types';
import {
  getCardName,
  NUWA_DRAW_LOG_PREFIX,
  canPlaySacrificeChiyou,
  canPlaySacrificeNuwa,
  getPlayerLogName,
  buildPendingReveal,
} from './gameLogic';

interface GameUIProps {
  gameState: GameState;
  playerId: PlayerId;
  onActionSelect: (action: any) => void;
}

export function getCardDescription(type: CardType): string {
  const descriptions: Record<CardType, string> = {
    raid: '从敌方部落转移 1 人口至你的部落',
    nightRaid: '对敌方部落造成 3 点人口伤害',
    nightWatch: '抵消敌方夜袭或劫掠，若对方夜袭则对敌方部落造成 1 点伤害',
    sacrificeChiyou: '献祭 2 俘虏→6 伤，1 俘虏→4 伤，2 人口→4 伤（按优先级自动选择）',
    sacrificeNuwa: '从弃牌堆随机抽取 1 张牌（需至少 3 张牌）',
  };
  return descriptions[type];
}

/** 512×768 (2:3) downscales of the full-res art in public/cards. */
export const CARD_IMAGES: Record<CardType, string> = {
  raid: '/cards/thumbs/jl.jpg',
  nightRaid: '/cards/thumbs/yx.jpg',
  nightWatch: '/cards/thumbs/sy.jpg',
  sacrificeChiyou: '/cards/thumbs/xsyxj.jpg',
  sacrificeNuwa: '/cards/thumbs/xnwjs.jpg',
};

export function getCardColor(type: CardType): string {
  const colors: Record<CardType, string> = {
    raid: 'bg-red-600',
    nightRaid: 'bg-purple-600',
    nightWatch: 'bg-blue-600',
    sacrificeChiyou: 'bg-gray-800',
    sacrificeNuwa: 'bg-green-600',
  };
  return colors[type];
}

export function CardComponent({ card, onClick, disabled }: { card: Card; onClick?: () => void; disabled?: boolean }) {
  const colorClass = getCardColor(card.type);
  
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${colorClass} text-white p-4 rounded-lg shadow-lg hover:scale-105 transition-transform disabled:opacity-50 disabled:cursor-not-allowed min-w-[140px]`}
    >
      <div className="font-bold text-lg mb-2">{getCardName(card.type)}</div>
      <div className="text-sm opacity-90">{getCardDescription(card.type)}</div>
    </button>
  );
}

export function playerRoleLabel(id: PlayerId): string {
  return id === 'player1' ? 'Player1' : 'Player2';
}

export function PlayerInfo({ player, isCurrentPlayer }: { player: Player; isCurrentPlayer: boolean }) {
  const displayName = player.nickname?.trim() || (isCurrentPlayer ? '你' : '对手');
  const faceUpDiscards = player.faceUpDiscards ?? [];

  return (
    <div className={`p-4 rounded-lg ${isCurrentPlayer ? 'bg-blue-900' : 'bg-red-900'} text-white`}>
      <div className="font-bold text-xl mb-2">
        {displayName}
        {isCurrentPlayer && <span className="text-base font-normal opacity-80">（我）</span>}
        {' '}
        <span className="text-base font-normal opacity-80">({playerRoleLabel(player.id)})</span>
      </div>
      <div className="space-y-1">
        <div>人口: <span className="font-bold text-2xl">{player.population}</span></div>
        <div>手牌: {player.hand.length}</div>
        <div>弃牌数量总计: {player.discardPile.length}</div>
        {faceUpDiscards.length > 0 && (
          <div>弃牌堆里的牌: &nbsp;
            {faceUpDiscards.map((type) => getCardName(type)).join('、')}
          </div>
        )}
        <div>俘虏: {player.captives.length}</div>
      </div>
    </div>
  );
}

/** Show own Nuwa draw card; hide opponent's card name in the console. */
export function formatLogEntryForViewer(
  entry: string,
  viewerId: PlayerId,
  gameState: GameState,
): string {
  if (!entry.startsWith(NUWA_DRAW_LOG_PREFIX + '|')) {
    return entry;
  }

  const parts = entry.split('|');
  if (parts.length < 3) {
    return entry;
  }

  const drawerId = parts[1] as PlayerId;
  const cardType = parts[2] as CardType;
  const drawerName = getPlayerLogName(gameState, drawerId);

  if (drawerId === viewerId) {
    return `${drawerName} 抽取了 ${getCardName(cardType)}`;
  }

  return `${drawerName} 抽取了一张牌`;
}

export function GameLog({
  log,
  viewerId,
  gameState,
}: {
  log: string[];
  viewerId: PlayerId;
  gameState: GameState;
}) {
  return (
    <div className="bg-gray-800 text-white p-4 rounded-lg h-64 overflow-y-auto">
      <div className="font-bold mb-2">游戏日志</div>
      <div className="space-y-1 text-sm">
        {log.map((entry, index) => {
          const display = formatLogEntryForViewer(entry, viewerId, gameState);
          return (
            <div key={index} className={display.startsWith('---') ? 'font-bold text-yellow-400 mt-2' : ''}>
              {display}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DesperateStrikePanel({
  player,
  opponent,
  onSelect,
}: {
  player: Player;
  opponent: Player;
  onSelect: (cost: number) => void;
}) {
  if (player.hand.length > 0 || opponent.hand.length === 0) {
    return null;
  }
  
  const maxCost = Math.min(3, player.population);
  if (maxCost < 1) {
    return null;
  }
  
  return (
    <div className="bg-orange-900 text-white p-4 rounded-lg">
      <div className="font-bold mb-2">垂死一搏（最后一轮）</div>
      <div className="mb-2">选择投入人口 (1-{maxCost})</div>
      <div className="flex gap-2">
        {Array.from({ length: maxCost }, (_, i) => i + 1).map(cost => (
          <button
            key={cost}
            onClick={() => onSelect(cost)}
            className="bg-orange-600 hover:bg-orange-700 px-4 py-2 rounded"
          >
            {cost}
          </button>
        ))}
      </div>
    </div>
  );
}

function revealDisplayName(gameState: GameState, viewerId: PlayerId, playerId: PlayerId): string {
  const nickname = gameState.players[playerId].nickname?.trim();
  return nickname || (playerId === viewerId ? '你' : '对手');
}

export function RevealedActionView({
  action,
  gameState,
  viewerId,
}: {
  action: RevealedAction;
  gameState: GameState;
  viewerId: PlayerId;
}) {
  const isViewer = action.playerId === viewerId;
  const cardName = action.cardType ? getCardName(action.cardType) : '垂死一搏';
  const imageSrc = action.cardType ? CARD_IMAGES[action.cardType] : null;

  return (
    <div
      className={`flex-1 rounded-lg p-4 border-2 ${
        isViewer ? 'bg-blue-950/60 border-blue-500' : 'bg-red-950/60 border-red-500'
      }`}
    >
      <div className="text-sm opacity-80 mb-2">
        {revealDisplayName(gameState, viewerId, action.playerId)}{' '}
        <span className="opacity-70">({playerRoleLabel(action.playerId)})</span>
      </div>

      <div className="flex gap-4">
        <div className="w-[120px] shrink-0">
          {imageSrc ? (
            <img
              src={imageSrc}
              alt={cardName}
              width={120}
              height={180}
              className={`w-full aspect-[2/3] object-contain rounded-md border border-gray-600 bg-gray-900 ${
                action.cancelled ? 'opacity-50 grayscale' : ''
              }`}
            />
          ) : (
            <div className="w-full aspect-[2/3] rounded-md border border-orange-500 bg-orange-900/70 flex flex-col items-center justify-center text-center px-2">
              <div className="text-lg font-bold">垂死</div>
              <div className="text-lg font-bold">一搏</div>
              {action.populationCost !== undefined && (
                <div className="text-sm mt-2 opacity-90">投入 {action.populationCost} 人口</div>
              )}
            </div>
          )}
        </div>

        <div className="min-w-0">
          <div className="font-bold text-lg mb-1">
            {cardName}
            {action.cancelled && <span className="ml-2 text-sm text-gray-400">已被抵消</span>}
          </div>
          {action.cardType && (
            <div className="text-sm text-gray-300 mb-2">{getCardDescription(action.cardType)}</div>
          )}
          {action.effectText && (
            <div className="text-sm">
              <span className="text-yellow-400">结算：</span>
              {action.effectText}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function RoundRevealPanel({
  reveal,
  gameState,
  viewerId,
}: {
  reveal: RoundReveal;
  gameState: GameState;
  viewerId: PlayerId;
}) {
  const opponentId: PlayerId = viewerId === 'player1' ? 'player2' : 'player1';

  return (
    <div className="bg-gray-800/70 border border-gray-600 rounded-lg p-4 mb-8">
      <div className="text-center font-bold text-xl mb-4">
        {reveal.resolved ? `Round ${reveal.round} 结算` : `Round ${reveal.round} 双方揭示`}
      </div>
      <div className="flex flex-col md:flex-row gap-4 items-stretch">
        <RevealedActionView
          action={reveal.actions[viewerId]}
          gameState={gameState}
          viewerId={viewerId}
        />
        <div className="flex items-center justify-center text-2xl font-bold text-yellow-400">VS</div>
        <RevealedActionView
          action={reveal.actions[opponentId]}
          gameState={gameState}
          viewerId={viewerId}
        />
      </div>
    </div>
  );
}

export function GameUI({ gameState, playerId, onActionSelect }: GameUIProps) {
  const currentPlayer = gameState.players[playerId];
  const opponentId = playerId === 'player1' ? 'player2' : 'player1';
  const opponent = gameState.players[opponentId];
  
  const hasSelectedAction = gameState.selectedActions[playerId] !== null;
  
  // Both actions locked → reveal immediately; afterwards keep the settled round on screen.
  const reveal = buildPendingReveal(gameState) ?? gameState.lastReveal;
  
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-gray-700 text-white p-8">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-2">大祭司模拟器</h1>
          <div className="text-xl">Round {gameState.currentRound}</div>
          {gameState.status === 'finished' && (
            <div className="text-2xl font-bold mt-4 text-yellow-400">
              {gameState.winner === 'draw' ? '平局!' : `${gameState.winner === playerId ? '你赢了!' : '你输了!'}`}
            </div>
          )}
        </div>
        
        <div className="grid grid-cols-2 gap-8 mb-8">
          <PlayerInfo player={currentPlayer} isCurrentPlayer={true} />
          <PlayerInfo player={opponent} isCurrentPlayer={false} />
        </div>
        
        {reveal && (
          <RoundRevealPanel reveal={reveal} gameState={gameState} viewerId={playerId} />
        )}
        
        {gameState.status === 'playing' && !hasSelectedAction && (
          <div className="mb-8">
            <div className="text-xl font-bold mb-4">选择你的行动:</div>
            <div className="flex flex-wrap gap-4 mb-4">
              {currentPlayer.hand.map(card => (
                <CardComponent
                  key={card.id}
                  card={card}
                  disabled={
                    (card.type === 'sacrificeChiyou' && !canPlaySacrificeChiyou(currentPlayer)) ||
                    (card.type === 'sacrificeNuwa' && !canPlaySacrificeNuwa(gameState))
                  }
                  onClick={() => onActionSelect({ type: 'card', cardId: card.id })}
                />
              ))}
            </div>
            
            {currentPlayer.hand.length === 0 && (
              <DesperateStrikePanel
                player={currentPlayer}
                opponent={opponent}
                onSelect={(cost) => onActionSelect({ type: 'desperateStrike', populationCost: cost })}
              />
            )}
          </div>
        )}
        
        {hasSelectedAction && gameState.status === 'playing' && (
          <div className="bg-green-900 text-white p-4 rounded-lg mb-8 text-center">
            <div className="text-xl font-bold">
              {reveal && !reveal.resolved ? '双方已揭示，正在结算...' : '已选择行动，等待对手...'}
            </div>
          </div>
        )}
        
        <GameLog log={gameState.gameLog} viewerId={playerId} gameState={gameState} />
      </div>
    </div>
  );
}
