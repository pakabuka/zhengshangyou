const WebSocket = require('ws');
const PORT = process.env.PORT || 443; // Render provides the PORT environment variable

const wss = new WebSocket.Server({ port: PORT });

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
            case 'collect_bomb':  // handle bomb collection
                handleCollectBomb(ws, data);
                break;
            case 'leave':
                handleLeave(ws, data);
                break;
        }
    });

    ws.on('close', () => {
        handleDisconnect(ws);
    });
});

function handleJoin(ws, data) {
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
            lastPlayerWhoPlayed: null, // Track the last player who made a valid move
            passCount: 0 // Track how many players have passed
        };
    }

    const room = rooms[data.room];

    if (room.players.length < 5 && !room.players.some(player => player.name === data.playerName)) {
        room.players.push({ ws, name: data.playerName, hand: [], finished: false });

        // Notify all players in the room about the updated player list
        room.players.forEach(player => {
            player.ws.send(JSON.stringify({
                type: 'room_joined',
                players: room.players.map(p => ({ name: p.name, hand: p.hand, finished: p.finished }))
            }));
        });
    } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Room is full or name is already taken.' }));
    }
}

function handleReady(ws, data) {
    const room = rooms[data.room];
    if (room && room.players.length >= 2) {
        room.readyCount++;
        if (room.readyCount === room.players.length) {
            startGame(data.room);
        }
    }
}

function startGame(roomName) {
    const room = rooms[roomName];
    distributeCards(room);

    // Randomize the order of players
    room.order = shuffleArray([...room.players]);
    room.currentPlayerIndex = 0;
    room.currentCombination = null;
    room.previousPlay = null;
    room.lastPlayerWhoPlayed = null;

    // Notify all players of the start of the game and the order
    room.players.forEach(player => {
        player.ws.send(JSON.stringify({
            type: 'start_game',
            deck: player.hand,
            order: room.order.map(p => p.name),
            currentPlayer: room.order[room.currentPlayerIndex].name
        }));
    });
}

function distributeCards(room) {
    let deckCopy = [...room.deck];
    const numPlayers = room.players.length;
    const cardsPerPlayer = Math.floor(deckCopy.length / numPlayers);

    room.players.forEach(player => {
        player.hand = deckCopy.splice(0, cardsPerPlayer); // Deal cards and remove them from the deck copy
    });

    if (deckCopy.length > 0) {
        // In case the deck doesn't divide evenly, distribute remaining cards
        deckCopy.forEach((card, index) => {
            room.players[index % numPlayers].hand.push(card);
        });
    }
}

function handlePlayTurn(ws, data) {
    const room = rooms[data.room];
    const currentPlayer = room.order[room.currentPlayerIndex];

    // Ensure the player trying to play the cards is the current player
    if (currentPlayer.ws !== ws) {
        ws.send(JSON.stringify({ type: 'error', message: 'It is not your turn to play.' }));
        return;
    }

    // Update the current and previous play
    room.previousPlay = { cards: data.cards, type: getPlayType(data.cards) };
    room.currentCombination = data.cards;
    room.lastPlayerWhoPlayed = currentPlayer.name; // Track the last player who made a valid play
    room.passCount = 0; // Reset pass count when a valid move is made

    // Remove the played cards from the player's hand
    const playedCards = [];
    data.cards.forEach(card => {
        const cardIndex = currentPlayer.hand.findIndex(c => c.value === card);
        if (cardIndex !== -1) {
            playedCards.push(currentPlayer.hand.splice(cardIndex, 1)[0]); // Remove card from player's hand
        }
    });

    room.playedCards.push({ name: currentPlayer.name, cards: data.cards });

    // Notify all players about the updated card count
    room.players.forEach(player => {
        player.ws.send(JSON.stringify({ type: 'update_cards', playerName: currentPlayer.name, cardsLeft: currentPlayer.hand.length }));
    });

    // Check if the player has finished all their cards
    if (currentPlayer.hand.length === 0) {
        currentPlayer.finished = true;
        room.rankings.push(currentPlayer.name); // Add to rankings
        
        // Check if all other players pass on the last card
        if (room.passCount === room.players.filter(p => !p.finished && p.name !== currentPlayer.name).length) {
            room.previousPlay = null;
            room.currentCombination = null;
            room.playedCards = [];
            moveToNextPlayer(room);
            return;
        }
    }

    // Check if the game should end
    const remainingPlayers = room.players.filter(player => !player.finished);
    if (remainingPlayers.length <= 1) {
        // Add the last player to the rankings if there's one remaining
        if (remainingPlayers.length === 1) {
            room.rankings.push(remainingPlayers[0].name);
        }
        endGame(room);
        return;
    }

    // Move to the next player
    moveToNextPlayer(room);
}

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

    // Notify all players about the updated card count
    room.players.forEach(p => {
        p.ws.send(JSON.stringify({
            type: 'update_cards',
            playerName: player.name,
            cardsLeft: player.hand.length // Send the updated hand size
        }));
    });

    // Ensure the player remains active in the game
    player.finished = false; // Ensure the player is not marked as finished
}

function handlePassTurn(ws, data) {
    const room = rooms[data.room];
    const currentPlayer = room.order[room.currentPlayerIndex];

    // Ensure the player trying to pass the turn is the current player
    if (currentPlayer.ws !== ws) {
        ws.send(JSON.stringify({ type: 'error', message: 'It is not your turn to pass.' }));
        return;
    }

    // Increase the pass count
    room.passCount++;

    // Check if all other players have passed except the last player who made a valid play
    const remainingActivePlayers = room.players.filter(player => player.name !== room.lastPlayerWhoPlayed && !player.finished);
    if (room.passCount === remainingActivePlayers.length) {
        room.previousPlay = null;
        room.currentCombination = null;
        room.playedCards = []; // Reset the playedCards array
        room.passCount = 0;  // Reset the pass count
        
        // Check if the last player has finished their cards
        const lastPlayer = room.players.find(player => player.name === room.lastPlayerWhoPlayed);
        if (lastPlayer && lastPlayer.finished) {
            moveToNextPlayer(room);
            return;
        }
    }

    // Move to the next player
    moveToNextPlayer(room);
}

function moveToNextPlayer(room) {
    do {
        room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
    } while (room.order[room.currentPlayerIndex].finished);

    const nextPlayer = room.order[room.currentPlayerIndex];

    room.players.forEach(player => {
        player.ws.send(JSON.stringify({
            type: 'player_move',
            players: room.players.map(p => ({ name: p.name, hand: p.hand, finished: p.finished })),
            playedCards: room.playedCards,
            currentPlayer: nextPlayer.name,
            nextPlayer: room.order[(room.currentPlayerIndex + 1) % room.players.length].name
        }));
    });
}

function handleLeave(ws, data) {
    const room = rooms[data.room];
    if (room) {
        const leavingPlayer = room.players.find(player => player.ws === ws);
        if (leavingPlayer) {
            room.players = room.players.filter(player => player.ws !== ws);
            room.players.forEach(player => {
                player.ws.send(JSON.stringify({ type: 'player_left', message: `${leavingPlayer.name} has left the room.` }));
            });
            if (room.players.length === 0) {
                delete rooms[data.room];
            }
        }
    }
}

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
                    player.ws.send(JSON.stringify({ type: 'player_left', message: `${disconnectedPlayer.name} has disconnected.` }));
                });
            }
        }
    }
}

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

    return deck.sort(() => Math.random() - 0.5); // Randomize the deck only once
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function endGame(room) {
    room.players.forEach(player => {
        player.ws.send(JSON.stringify({
            type: 'game_over',
            rankings: room.rankings
        }));
    });
    delete rooms[room.name];
}

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

console.log('WebSocket server is running on ws://localhost:8080');
