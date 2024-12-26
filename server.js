// server.js

const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

// Initialize Express app
const app = express();

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Create an HTTP server
const server = http.createServer(app);

// Initialize WebSocket server instance
const wss = new WebSocket.Server({ server });

// Port configuration
const PORT = process.env.PORT || 8080;

// WebSocket connection handling
let rooms = {};

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        const data = JSON.parse(message);
        switch (data.type) {
            case 'join':
                handleJoin(ws, data);
                break;
            case 'ready':
                handleReady(ws, data);
                break;
            case 'play_turn':
                handlePlayTurn(ws, data);
                break;
            case 'pass_turn':
                handlePassTurn(ws, data);
                break;
            case 'collect_bomb':
                handleCollectBomb(ws, data);
                break;
            case 'leave':
                handleLeave(ws, data);
                break;
            default:
                ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type.' }));
        }
    });

    ws.on('close', () => {
        handleDisconnect(ws);
    });
});

server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});

/** 
 * JOIN ROOM 
 * Updated to send distinct messages: "room_full" or "duplicate_name" 
 */
function handleJoin(ws, data) {
    // If the room doesn't exist, create it
    if (!rooms[data.room]) {
        rooms[data.room] = {
            players: [],
            deck: createDeck(),
            currentPlayerIndex: 0,
            readyCount: 0,
            playedCards: [],
            order: [],
            rankings: [],
            currentCombination: null,
            previousPlay: null,
            lastPlayerWhoPlayed: null,
            passCount: 0
        };
    }

    const room = rooms[data.room];

    // Check if the room is full (5-player limit here)
    if (room.players.length >= 5) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'room_full'  // <--- Distinct error message
        }));
        return;
    }

    // Check if this player name is already taken
    if (room.players.some(player => player.name === data.playerName)) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'duplicate_name' // <--- Distinct error message
        }));
        return;
    }

    // Otherwise, add the player
    room.players.push({ ws, name: data.playerName, hand: [], finished: false });

    // Notify all players in the room about the updated player list
    room.players.forEach(player => {
        player.ws.send(JSON.stringify({
            type: 'room_joined',
            players: room.players.map(p => ({
                name: p.name,
                hand: p.hand,
                finished: p.finished
            }))
        }));
    });
}

/**
 * READY
 */
function handleReady(ws, data) {
    const room = rooms[data.room];
    if (room && room.players.length >= 2) {
        room.readyCount++;
        if (room.readyCount === room.players.length) {
            startGame(data.room);
        }
    }
}

/**
 * START GAME
 */
function startGame(roomName) {
    const room = rooms[roomName];
    distributeCards(room);

    // Randomize the order of players
    room.order = shuffleArray([...room.players]);
    room.currentPlayerIndex = 0;
    room.currentCombination = null;
    room.previousPlay = null;
    room.lastPlayerWhoPlayed = null;

    // Notify all players that the game has started
    room.players.forEach(player => {
        player.ws.send(JSON.stringify({
            type: 'start_game',
            deck: player.hand,
            order: room.order.map(p => p.name),
            currentPlayer: room.order[room.currentPlayerIndex].name
        }));
    });
}

/**
 * DISTRIBUTE CARDS
 */
function distributeCards(room) {
    let deckCopy = [...room.deck];
    const numPlayers = room.players.length;
    const cardsPerPlayer = Math.floor(deckCopy.length / numPlayers);

    room.players.forEach(player => {
        player.hand = deckCopy.splice(0, cardsPerPlayer); // Deal cards
    });

    // If some cards remain, distribute them one by one
    if (deckCopy.length > 0) {
        deckCopy.forEach((card, index) => {
            room.players[index % numPlayers].hand.push(card);
        });
    }
}

/**
 * PLAY TURN
 */
function handlePlayTurn(ws, data) {
    const room = rooms[data.room];
    const currentPlayer = room.order[room.currentPlayerIndex];

    // Ensure the right person is playing
    if (currentPlayer.ws !== ws) {
        ws.send(JSON.stringify({ type: 'error', message: 'It is not your turn to play.' }));
        return;
    }

    // Update the "previousPlay" and "currentCombination"
    room.previousPlay = { cards: data.cards, type: getPlayType(data.cards) };
    room.currentCombination = data.cards;
    room.lastPlayerWhoPlayed = currentPlayer.name;
    room.passCount = 0; // Reset pass count on valid move

    // Remove played cards from the player's hand
    const playedCards = [];
    data.cards.forEach(card => {
        const cardIndex = currentPlayer.hand.findIndex(c => c.value === card);
        if (cardIndex !== -1) {
            playedCards.push(currentPlayer.hand.splice(cardIndex, 1)[0]);
        }
    });

    // Track played cards in "playedCards" array
    room.playedCards.push({ name: currentPlayer.name, cards: data.cards });

    // Notify all players about updated card counts
    room.players.forEach(player => {
        player.ws.send(JSON.stringify({
            type: 'update_cards',
            playerName: currentPlayer.name,
            cardsLeft: currentPlayer.hand.length
        }));
    });

    // If this player finished
    if (currentPlayer.hand.length === 0) {
        currentPlayer.finished = true;
        room.rankings.push(currentPlayer.name);

        // Check if all other players pass on the last card
        if (room.passCount === room.players.filter(p => !p.finished && p.name !== currentPlayer.name).length) {
            room.previousPlay = null;
            room.currentCombination = null;
            room.playedCards = [];
            moveToNextPlayer(room);
            return;
        }
    }

    // Check if game ends
    const remainingPlayers = room.players.filter(p => !p.finished);
    if (remainingPlayers.length <= 1) {
        // If there's exactly 1 left, add them to the ranking
        if (remainingPlayers.length === 1) {
            room.rankings.push(remainingPlayers[0].name);
        }
        endGame(room);
        return;
    }

    // Move to next player
    moveToNextPlayer(room);
}

/**
 * COLLECT BOMB
 */
function handleCollectBomb(ws, data) {
    const room = rooms[data.room];
    const player = room.players.find(p => p.name === data.playerName);

    if (!player) {
        ws.send(JSON.stringify({ type: 'error', message: 'Player not found in room.' }));
        return;
    }

    // Add the bomb cards to the player's hand
    data.bombCards.forEach(cardValue => {
        player.hand.push({ value: cardValue });
    });

    // Notify all players
    room.players.forEach(p => {
        p.ws.send(JSON.stringify({
            type: 'update_cards',
            playerName: player.name,
            cardsLeft: player.hand.length
        }));
    });

    player.finished = false; // Ensure player is not marked finished
}

/**
 * PASS TURN
 */
function handlePassTurn(ws, data) {
    const room = rooms[data.room];
    const currentPlayer = room.order[room.currentPlayerIndex];

    if (currentPlayer.ws !== ws) {
        ws.send(JSON.stringify({ type: 'error', message: 'It is not your turn to pass.' }));
        return;
    }

    room.passCount++;

    // Check if all other active players have passed
    const remainingActivePlayers = room.players.filter(
        p => p.name !== room.lastPlayerWhoPlayed && !p.finished
    );
    if (room.passCount === remainingActivePlayers.length) {
        room.previousPlay = null;
        room.currentCombination = null;
        room.playedCards = [];
        room.passCount = 0;

        // If the last player who played is finished, just move on
        const lastPlayer = room.players.find(p => p.name === room.lastPlayerWhoPlayed);
        if (lastPlayer && lastPlayer.finished) {
            moveToNextPlayer(room);
            return;
        }
    }

    moveToNextPlayer(room);
}

/**
 * MOVE TO NEXT PLAYER
 */
function moveToNextPlayer(room) {
    do {
        room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
    } while (room.order[room.currentPlayerIndex].finished);

    const nextPlayer = room.order[room.currentPlayerIndex];

    room.players.forEach(player => {
        player.ws.send(JSON.stringify({
            type: 'player_move',
            players: room.players.map(p => ({
                name: p.name,
                hand: p.hand,
                finished: p.finished
            })),
            playedCards: room.playedCards,
            currentPlayer: nextPlayer.name,
            nextPlayer: room.order[(room.currentPlayerIndex + 1) % room.players.length].name
        }));
    });
}

/**
 * HANDLE LEAVE
 */
function handleLeave(ws, data) {
    const room = rooms[data.room];
    if (room) {
        const leavingPlayer = room.players.find(player => player.ws === ws);
        if (leavingPlayer) {
            room.players = room.players.filter(player => player.ws !== ws);
            room.players.forEach(player => {
                player.ws.send(JSON.stringify({
                    type: 'player_left',
                    message: `${leavingPlayer.name} has left the room.`
                }));
            });
            if (room.players.length === 0) {
                delete rooms[data.room];
            }
        }
    }
}

/**
 * HANDLE DISCONNECT
 */
function handleDisconnect(ws) {
    for (let roomName in rooms) {
        const room = rooms[roomName];
        const disconnectedPlayer = room.players.find(player => player.ws === ws);
        if (disconnectedPlayer) {
            room.players = room.players.filter(player => player.ws !== ws);
            if (room.players.length === 0) {
                delete rooms[roomName];
            } else {
                room.players.forEach(player => {
                    player.ws.send(JSON.stringify({
                        type: 'player_left',
                        message: `${disconnectedPlayer.name} has disconnected.`
                    }));
                });
            }
        }
    }
}

/**
 * CREATE DECK
 */
function createDeck() {
    const values = ['3', '2', 'A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4'];
    const deck = [];

    // Create 4 of each value
    values.forEach(value => {
        for (let i = 0; i < 4; i++) {
            deck.push({ value });
        }
    });

    // Add 2 Jokers
    deck.push({ value: 'Red Joker' });
    deck.push({ value: 'Black Joker' });

    // Randomize the deck once
    return deck.sort(() => Math.random() - 0.5);
}

/**
 * SHUFFLE ARRAY
 */
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

/**
 * END GAME
 */
function endGame(room) {
    room.players.forEach(player => {
        player.ws.send(JSON.stringify({
            type: 'game_over',
            rankings: room.rankings
        }));
    });
    delete rooms[room.name];
}

/**
 * GET PLAY TYPE
 */
function getPlayType(cards) {
    if (cards.length === 2) {
        return 'Pair';
    }
    if (cards.length === 3) {
        return 'Regular Bomb';
    }
    if (cards.length === 4) {
        return 'Ultra Bomb';
    }
    if (cards.length === 1) {
        return 'Single';
    }
    return 'Other';
}

// Serve the index.html on GET '/'
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve the index.html on GET '/'
app.get('/rules.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'rules.html'));
});

console.log('WebSocket server is running on http://localhost:8080');
