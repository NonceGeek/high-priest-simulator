import { Card, CardType, GameState, Player, PlayerId } from './types';
import { getCardName } from './gameLogic';

interface GameUIProps {
  gameState: GameState;
  playerId: PlayerId;
  onActionSelect: (action: any) => void;
}

export function getCardDescription(type: CardType): string {
  const descriptions: Record<CardType, string> = {
    raid: '从敌方部落转移 1 人口至你的部落',
    nightRaid: '对敌方部落造成 3 点人口伤害',
    nightWatch: '抵消敌方夜袭或劫掠，若对方夜袭则造成 1 点伤害',
    sacrificeChiyou: '牺牲 2 人口造成 4 伤害，或牺牲 2 俘虏造成 6 伤害',
    sacrificeNuwa: '从弃牌堆随机抽取 1 张牌（需至少 3 张牌）',
  };
  return descriptions[type];
}

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

export function PlayerInfo({ player, isCurrentPlayer, label }: { player: Player; isCurrentPlayer: boolean; label: string }) {
  return (
    <div className={`p-4 rounded-lg ${isCurrentPlayer ? 'bg-blue-900' : 'bg-red-900'} text-white`}>
      <div className="font-bold text-xl mb-2">{label}</div>
      <div className="space-y-1">
        <div>人口: <span className="font-bold text-2xl">{player.population}</span></div>
        <div>手牌: {player.hand.length}</div>
        <div>弃牌堆: {player.discardPile.length}</div>
        <div>俘虏: {player.captives.length}</div>
      </div>
    </div>
  );
}

export function GameLog({ log }: { log: string[] }) {
  return (
    <div className="bg-gray-800 text-white p-4 rounded-lg h-64 overflow-y-auto">
      <div className="font-bold mb-2">游戏日志</div>
      <div className="space-y-1 text-sm">
        {log.map((entry, index) => (
          <div key={index} className={entry.startsWith('---') ? 'font-bold text-yellow-400 mt-2' : ''}>
            {entry}
          </div>
        ))}
      </div>
    </div>
  );
}

export function DesperateStrikePanel({ player, onSelect }: { player: Player; onSelect: (cost: number) => void }) {
  if (player.hand.length > 0) {
    return null;
  }
  
  const maxCost = Math.min(3, player.population);
  
  return (
    <div className="bg-orange-900 text-white p-4 rounded-lg">
      <div className="font-bold mb-2">垂死一搏</div>
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

export function GameUI({ gameState, playerId, onActionSelect }: GameUIProps) {
  const currentPlayer = gameState.players[playerId];
  const opponentId = playerId === 'player1' ? 'player2' : 'player1';
  const opponent = gameState.players[opponentId];
  
  const hasSelectedAction = gameState.selectedActions[playerId] !== null;
  
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
          <PlayerInfo player={currentPlayer} isCurrentPlayer={true} label="你" />
          <PlayerInfo player={opponent} isCurrentPlayer={false} label="对手" />
        </div>
        
        {gameState.status === 'playing' && !hasSelectedAction && (
          <div className="mb-8">
            <div className="text-xl font-bold mb-4">选择你的行动:</div>
            <div className="flex flex-wrap gap-4 mb-4">
              {currentPlayer.hand.map(card => (
                <CardComponent
                  key={card.id}
                  card={card}
                  onClick={() => onActionSelect({ type: 'card', cardId: card.id })}
                />
              ))}
            </div>
            
            {currentPlayer.hand.length === 0 && (
              <DesperateStrikePanel
                player={currentPlayer}
                onSelect={(cost) => onActionSelect({ type: 'desperateStrike', populationCost: cost })}
              />
            )}
          </div>
        )}
        
        {hasSelectedAction && gameState.status === 'playing' && (
          <div className="bg-green-900 text-white p-4 rounded-lg mb-8 text-center">
            <div className="text-xl font-bold">已选择行动，等待对手...</div>
          </div>
        )}
        
        <GameLog log={gameState.gameLog} />
      </div>
    </div>
  );
}
