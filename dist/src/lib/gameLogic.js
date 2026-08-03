"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NUWA_DRAW_LOG_PREFIX = void 0;
exports.createCard = createCard;
exports.createPlayer = createPlayer;
exports.createGameState = createGameState;
exports.getCardName = getCardName;
exports.canPlayCard = canPlayCard;
exports.canDesperateStrike = canDesperateStrike;
exports.getAvailableActions = getAvailableActions;
exports.resolveRound = resolveRound;
exports.formatNuwaDrawLogMarker = formatNuwaDrawLogMarker;
exports.drawCardFromDiscard = drawCardFromDiscard;
const uuid_1 = require("uuid");
const INITIAL_POPULATION = 15;
const STARTING_CARDS = [
    'raid',
    'raid',
    'nightRaid',
    'nightRaid',
    'nightWatch',
    'nightWatch',
    'sacrificeChiyou',
    'sacrificeNuwa',
];
function createCard(type, owner) {
    return {
        id: (0, uuid_1.v4)(),
        type,
        owner,
    };
}
function createPlayer(id) {
    const hand = STARTING_CARDS.map(type => createCard(type, id));
    return {
        id,
        population: INITIAL_POPULATION,
        hand,
        discardPile: [],
        captives: [],
    };
}
function createGameState(roomId) {
    return {
        id: roomId,
        players: {
            player1: createPlayer('player1'),
            player2: createPlayer('player2'),
        },
        currentRound: 1,
        status: 'waiting',
        winner: null,
        selectedActions: {
            player1: null,
            player2: null,
        },
        gameLog: ['Game created. Waiting for players...'],
        nuwaDrawHistory: [],
    };
}
function getCardName(type) {
    const names = {
        raid: '劫掠',
        nightRaid: '夜袭',
        nightWatch: '守夜',
        sacrificeChiyou: '向蚩尤献祭',
        sacrificeNuwa: '向女娲祭祀',
    };
    return names[type];
}
function canPlayCard(player, cardId) {
    return player.hand.some(card => card.id === cardId);
}
function canDesperateStrike(player) {
    return player.hand.length === 0 && player.population > 0;
}
function getAvailableActions(player) {
    const actions = [];
    player.hand.forEach(card => {
        actions.push({ type: 'card', cardId: card.id });
    });
    if (canDesperateStrike(player)) {
        const maxCost = Math.min(3, player.population);
        for (let i = 1; i <= maxCost; i++) {
            actions.push({ type: 'desperateStrike', populationCost: i });
        }
    }
    return actions;
}
function resolveRound(state) {
    const newState = JSON.parse(JSON.stringify(state));
    const { players, selectedActions } = newState;
    const action1 = selectedActions.player1;
    const action2 = selectedActions.player2;
    if (!action1 || !action2) {
        return newState;
    }
    const p1 = newState.players.player1;
    const p2 = newState.players.player2;
    const log = [
        `\n--- Round ${newState.currentRound} ---`,
        `玩家1: 人口 ${p1.population} | 俘虏 ${p1.captives.length}    玩家2: 人口 ${p2.population} | 俘虏 ${p2.captives.length}`
    ];
    let effect1 = resolveAction(newState, 'player1', action1, log);
    let effect2 = resolveAction(newState, 'player2', action2, log);
    applyCounterEffects(newState, action1, action2, effect1, effect2, log);
    const raid1 = resolveRaidIntent(newState, 'player1', effect1, log);
    const raid2 = resolveRaidIntent(newState, 'player2', effect2, log);
    applyAllEffects(newState, 'player1', effect1, raid1, 'player2', effect2, raid2, log);
    moveCardsToDiscard(newState, action1, action2);
    const p1After = newState.players.player1;
    const p2After = newState.players.player2;
    log.push(`玩家1: 人口 ${p1After.population} | 俘虏 ${p1After.captives.length}    玩家2: 人口 ${p2After.population} | 俘虏 ${p2After.captives.length}`);
    checkWinCondition(newState, log);
    newState.gameLog.push(...log);
    newState.selectedActions = { player1: null, player2: null };
    newState.currentRound++;
    return newState;
}
function resolveRaidIntent(state, playerId, effect, log) {
    if (effect.type !== 'raid' || effect.cancelled || effect.captivesGained === 0) {
        return { active: false, rescue: false };
    }
    const opponentId = playerId === 'player1' ? 'player2' : 'player1';
    const opponent = state.players[opponentId];
    const ownCaptivesHeldByOpponent = opponent.captives.filter(c => c.originalOwner === playerId);
    if (ownCaptivesHeldByOpponent.length > 0) {
        log.push(`${playerId} 夺回 1 名族人`);
        return { active: true, rescue: true };
    }
    else {
        log.push(`${playerId} 掳掠 1 名人口`);
        return { active: true, rescue: false };
    }
}
function applyAllEffects(state, pid1, effect1, raid1, pid2, effect2, raid2, log) {
    const p1 = state.players[pid1];
    const p2 = state.players[pid2];
    if (!effect1.cancelled) {
        p1.population += effect1.populationChange;
        p2.population -= effect1.opponentDamage;
        if (effect1.captivesLost > 0) {
            p1.captives = p1.captives.slice(effect1.captivesLost);
        }
    }
    if (!effect2.cancelled) {
        p2.population += effect2.populationChange;
        p1.population -= effect2.opponentDamage;
        if (effect2.captivesLost > 0) {
            p2.captives = p2.captives.slice(effect2.captivesLost);
        }
    }
    if (raid1.active && raid1.rescue) {
        p2.captives = p2.captives.filter(c => !(c.originalOwner === pid1 && c.currentController === pid2));
    }
    else if (raid1.active && !raid1.rescue) {
        p2.population -= 1;
        p1.captives.push({ originalOwner: pid2, currentController: pid1 });
    }
    if (raid2.active && raid2.rescue) {
        p1.captives = p1.captives.filter(c => !(c.originalOwner === pid2 && c.currentController === pid1));
    }
    else if (raid2.active && !raid2.rescue) {
        p1.population -= 1;
        p2.captives.push({ originalOwner: pid1, currentController: pid2 });
    }
    if (effect1.cancelled) {
        log.push(`${pid1} 的行动被抵消`);
    }
    if (effect2.cancelled) {
        log.push(`${pid2} 的行动被抵消`);
    }
    if (effect1.cardDrawn) {
        handleCardDraw(state, pid1, log);
    }
    if (effect2.cardDrawn) {
        handleCardDraw(state, pid2, log);
    }
    p1.population = Math.max(0, p1.population);
    p2.population = Math.max(0, p2.population);
}
/** Marker prefix so the client can filter opponent card names in the console. */
exports.NUWA_DRAW_LOG_PREFIX = '__NUWA_DRAW__';
function formatNuwaDrawLogMarker(playerId, cardType) {
    return `${exports.NUWA_DRAW_LOG_PREFIX}|${playerId}|${cardType}`;
}
function handleCardDraw(state, playerId, log) {
    if (!state.nuwaDrawHistory) {
        state.nuwaDrawHistory = [];
    }
    const allDiscards = [...state.players.player1.discardPile, ...state.players.player2.discardPile];
    const eligibleCards = allDiscards.filter(c => c.type !== 'sacrificeNuwa');
    if (eligibleCards.length > 0) {
        const randomIndex = Math.floor(Math.random() * eligibleCards.length);
        const drawnCard = eligibleCards[randomIndex];
        drawnCard.owner = playerId;
        state.players[playerId].hand.push(drawnCard);
        state.players.player1.discardPile = state.players.player1.discardPile.filter(c => c.id !== drawnCard.id);
        state.players.player2.discardPile = state.players.player2.discardPile.filter(c => c.id !== drawnCard.id);
        state.nuwaDrawHistory.push({
            round: state.currentRound,
            playerId,
            cardType: drawnCard.type,
            cardId: drawnCard.id,
        });
        // Full draw info stays in nuwaDrawHistory / localStorage; log marker is filtered per viewer.
        log.push(formatNuwaDrawLogMarker(playerId, drawnCard.type));
    }
}
function resolveAction(state, playerId, action, log) {
    const player = state.players[playerId];
    const opponentId = playerId === 'player1' ? 'player2' : 'player1';
    const effect = {
        type: action.type === 'card' ? player.hand.find(c => c.id === action.cardId).type : 'desperateStrike',
        cancelled: false,
        populationChange: 0,
        opponentDamage: 0,
        captivesGained: 0,
        captivesLost: 0,
        cardDrawn: false,
    };
    if (action.type === 'desperateStrike') {
        log.push(`${playerId} 发动垂死一搏，投入 ${action.populationCost} 人口`);
        effect.populationChange = -action.populationCost;
        effect.opponentDamage = action.populationCost;
        return effect;
    }
    const card = player.hand.find(c => c.id === action.cardId);
    log.push(`${playerId} 打出 ${getCardName(card.type)}`);
    switch (card.type) {
        case 'nightRaid':
            effect.opponentDamage = 3;
            break;
        case 'nightWatch':
            effect.populationChange = 0;
            break;
        case 'raid':
            effect.captivesGained = 1;
            break;
        case 'sacrificeChiyou':
            const captivesAvailable = player.captives.length;
            if (captivesAvailable >= 2) {
                effect.captivesLost = 2;
                effect.opponentDamage = 6;
                log.push(`${playerId} 献祭 2 名俘虏，造成 6 点伤害`);
            }
            else {
                effect.populationChange = -2;
                effect.opponentDamage = 4;
                log.push(`${playerId} 血祭本族 2 人口，造成 4 点伤害`);
            }
            break;
        case 'sacrificeNuwa':
            const totalDiscard = state.players.player1.discardPile.length + state.players.player2.discardPile.length;
            if (totalDiscard >= 3) {
                effect.cardDrawn = true;
                log.push(`${playerId} 从弃牌堆抽取 1 张牌`);
            }
            break;
    }
    return effect;
}
function applyCounterEffects(state, action1, action2, effect1, effect2, log) {
    const type1 = action1.type === 'card' ? state.players.player1.hand.find(c => c.id === action1.cardId)?.type : null;
    const type2 = action2.type === 'card' ? state.players.player2.hand.find(c => c.id === action2.cardId)?.type : null;
    if (type1 === 'nightWatch') {
        if (type2 === 'nightRaid') {
            effect2.cancelled = true;
            effect2.opponentDamage = 0;
            effect1.opponentDamage = 1;
            log.push('守夜抵消了夜袭！对敌方造成 1 点伤害');
        }
        else if (type2 === 'raid') {
            effect2.cancelled = true;
            effect2.captivesGained = 0;
            log.push('守夜抵消了劫掠！');
        }
    }
    if (type2 === 'nightWatch') {
        if (type1 === 'nightRaid') {
            effect1.cancelled = true;
            effect1.opponentDamage = 0;
            effect2.opponentDamage = 1;
            log.push('守夜抵消了夜袭！对敌方造成 1 点伤害');
        }
        else if (type1 === 'raid') {
            effect1.cancelled = true;
            effect1.captivesGained = 0;
            log.push('守夜抵消了劫掠！');
        }
    }
}
function moveCardsToDiscard(state, action1, action2) {
    if (action1.type === 'card') {
        const card = state.players.player1.hand.find(c => c.id === action1.cardId);
        if (card) {
            state.players.player1.hand = state.players.player1.hand.filter(c => c.id !== action1.cardId);
            state.players.player1.discardPile.push(card);
        }
    }
    if (action2.type === 'card') {
        const card = state.players.player2.hand.find(c => c.id === action2.cardId);
        if (card) {
            state.players.player2.hand = state.players.player2.hand.filter(c => c.id !== action2.cardId);
            state.players.player2.discardPile.push(card);
        }
    }
}
function checkWinCondition(state, log) {
    const p1Dead = state.players.player1.population <= 0;
    const p2Dead = state.players.player2.population <= 0;
    if (p1Dead && p2Dead) {
        state.status = 'finished';
        state.winner = 'draw';
        log.push('\n=== 游戏结束：平局！ ===');
    }
    else if (p1Dead) {
        state.status = 'finished';
        state.winner = 'player2';
        log.push('\n=== 游戏结束：玩家 2 获胜！ ===');
    }
    else if (p2Dead) {
        state.status = 'finished';
        state.winner = 'player1';
        log.push('\n=== 游戏结束：玩家 1 获胜！ ===');
    }
}
function drawCardFromDiscard(state, playerId) {
    const allDiscards = [...state.players.player1.discardPile, ...state.players.player2.discardPile];
    const eligibleCards = allDiscards.filter(c => c.type !== 'sacrificeNuwa');
    if (eligibleCards.length === 0) {
        return null;
    }
    const randomIndex = Math.floor(Math.random() * eligibleCards.length);
    const drawnCard = eligibleCards[randomIndex];
    drawnCard.owner = playerId;
    state.players[playerId].hand.push(drawnCard);
    state.players.player1.discardPile = state.players.player1.discardPile.filter(c => c.id !== drawnCard.id);
    state.players.player2.discardPile = state.players.player2.discardPile.filter(c => c.id !== drawnCard.id);
    return drawnCard;
}
