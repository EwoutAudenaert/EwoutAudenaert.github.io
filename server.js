// server.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const rooms = new Map();

function createDeck() {
  const values = [];

  addValues(values, -2, 5);
  addValues(values, -1, 10);
  addValues(values, 0, 15);

  for (let n = 1; n <= 12; n++) {
    addValues(values, n, 10);
  }

  return shuffle(values);
}

function addValues(arr, value, amount) {
  for (let i = 0; i < amount; i++) arr.push(value);
}

function shuffle(arr) {
  const copy = [...arr];

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

function createRoom(roomId) {
  return {
    id: roomId,
    clients: [null, null],
    game: null
  };
}

function createGame() {
  const deck = createDeck();

  const players = [
    { name: "Speler links", short: "Links", board: [] },
    { name: "Speler rechts", short: "Rechts", board: [] }
  ];

  for (const p of players) {
    for (let i = 0; i < 12; i++) {
      p.board.push({
        value: deck.pop(),
        open: false,
        removed: false
      });
    }

    const first = Math.floor(Math.random() * 12);
    let second = Math.floor(Math.random() * 12);

    while (second === first) {
      second = Math.floor(Math.random() * 12);
    }

    p.board[first].open = true;
    p.board[second].open = true;
  }

  return {
    deck,
    discard: [deck.pop()],
    players,
    current: 0,
    phase: "choosePile",
    drawnCard: null,
    tookDiscard: false,
    finalTurns: false,
    finalStarter: null,
    gameOver: false,
    message: "Nieuw spel. Speler links begint."
  };
}

function sanitizeGameForPlayer(game, playerIndex) {
  if (!game) return null;

  return {
    deckCount: game.deck.length,
    discardTop: topDiscard(game),
    players: game.players.map((player, pIndex) => ({
      name: player.name,
      short: player.short,
      board: player.board.map(card => ({
        value: card.open || card.removed || game.gameOver ? card.value : null,
        open: card.open || game.gameOver,
        removed: card.removed
      })),
      visibleScore: visibleScore(player),
      finalScore: game.gameOver ? finalScore(player) : null,
      isYou: pIndex === playerIndex
    })),
    current: game.current,
    yourIndex: playerIndex,
    phase: game.phase,
    drawnCard: game.drawnCard,
    tookDiscard: game.tookDiscard,
    gameOver: game.gameOver,
    message: game.message
  };
}

function topDiscard(game) {
  return game.discard[game.discard.length - 1];
}

function visibleScore(player) {
  return player.board.reduce((sum, c) => {
    if (c.open && !c.removed) return sum + c.value;
    return sum;
  }, 0);
}

function finalScore(player) {
  return player.board.reduce((sum, c) => {
    if (!c.removed) return sum + c.value;
    return sum;
  }, 0);
}

function allOpen(player) {
  return player.board.every(c => c.open || c.removed);
}

function clearColumns(game, playerIndex) {
  const player = game.players[playerIndex];

  for (let col = 0; col < 4; col++) {
    const indexes = [col, col + 4, col + 8];
    const cards = indexes.map(i => player.board[i]);

    if (
      cards.every(c => c.open && !c.removed) &&
      cards[0].value === cards[1].value &&
      cards[1].value === cards[2].value
    ) {
      for (const i of indexes) {
        player.board[i].removed = true;
      }

      game.message = `${player.short} verwijderde een kolom met drie keer ${cards[0].value}.`;
    }
  }
}

function recycleDiscard(game) {
  if (game.discard.length <= 1) return;

  const keep = game.discard.pop();
  game.deck = shuffle(game.discard);
  game.discard = [keep];
  game.message = "Aflegstapel werd opnieuw geschud tot trekstapel.";
}

function nextTurn(game) {
  const player = game.players[game.current];

  clearColumns(game, game.current);

  if (allOpen(player) && !game.finalTurns) {
    game.finalTurns = true;
    game.finalStarter = game.current;
    game.message = `${player.name} heeft alles open. De andere speler krijgt nog één beurt.`;
  }

  if (game.finalTurns && game.current !== game.finalStarter) {
    endGame(game);
    return;
  }

  game.current = 1 - game.current;
  game.phase = "choosePile";
  game.drawnCard = null;
  game.tookDiscard = false;

  if (!game.gameOver) {
    game.message += ` ${game.players[game.current].name} is aan zet.`;
  }
}

function endGame(game) {
  game.gameOver = true;

  for (const p of game.players) {
    p.board.forEach(c => {
      if (!c.removed) c.open = true;
    });
  }

  const left = finalScore(game.players[0]);
  const right = finalScore(game.players[1]);

  let result = "Gelijkspel.";
  if (left < right) result = "Speler links wint.";
  if (right < left) result = "Speler rechts wint.";

  game.message = `Einde ronde. Links: ${left} punten. Rechts: ${right} punten. ${result}`;
}

function broadcast(room) {
  for (let i = 0; i < 2; i++) {
    const client = room.clients[i];

    if (client && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: "state",
        state: sanitizeGameForPlayer(room.game, i)
      }));
    }
  }
}

function sendError(ws, message) {
  ws.send(JSON.stringify({
    type: "error",
    message
  }));
}

function handleAction(room, playerIndex, action) {
  const game = room.game;

  if (!game) return;
  if (game.gameOver && action.type !== "newGame") return;
  if (action.type !== "newGame" && game.current !== playerIndex) {
    game.message = "Niet jouw beurt.";
    return;
  }

  if (action.type === "newGame") {
    room.game = createGame();
    return;
  }

  if (action.type === "drawDeck") {
    if (game.phase !== "choosePile") return;

    if (!game.deck.length) {
      recycleDiscard(game);
    }

    game.drawnCard = game.deck.pop();
    game.tookDiscard = false;
    game.phase = "replaceWithDrawn";
    game.message = `${game.players[playerIndex].short} trok een kaart.`;

    return;
  }

  if (action.type === "takeDiscard") {
    if (game.phase !== "choosePile") return;

    game.drawnCard = game.discard.pop();
    game.tookDiscard = true;
    game.phase = "replaceWithDiscard";
    game.message = `${game.players[playerIndex].short} neemt ${game.drawnCard} van de aflegstapel.`;

    return;
  }

  if (action.type === "discardDrawn") {
    if (game.phase !== "replaceWithDrawn" || game.tookDiscard) return;

    const value = game.drawnCard;
    game.discard.push(value);
    game.drawnCard = null;
    game.phase = "revealAfterDiscard";
    game.message = `${game.players[playerIndex].short} legde ${value} af. Draai nu een gesloten kaart open.`;

    return;
  }

  if (action.type === "cardClick") {
    const index = action.index;
    const card = game.players[playerIndex].board[index];

    if (!card || card.removed) return;

    if (game.phase === "replaceWithDrawn" || game.phase === "replaceWithDiscard") {
      const old = card.value;

      card.value = game.drawnCard;
      card.open = true;

      game.discard.push(old);
      game.drawnCard = null;
      game.phase = "choosePile";
      game.message = `${game.players[playerIndex].short} wisselde en legde ${old} af.`;

      nextTurn(game);
      return;
    }

    if (game.phase === "revealAfterDiscard") {
      if (card.open) return;

      card.open = true;
      game.phase = "choosePile";
      game.message = `${game.players[playerIndex].short} draaide ${card.value} open.`;

      nextTurn(game);
    }
  }
}

wss.on("connection", ws => {
  let room = null;
  let playerIndex = null;

  ws.on("message", raw => {
    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === "join") {
      const roomId = String(data.room || "default").trim().slice(0, 32);

      if (!rooms.has(roomId)) {
        rooms.set(roomId, createRoom(roomId));
      }

      room = rooms.get(roomId);

      if (!room.clients[0]) {
        playerIndex = 0;
      } else if (!room.clients[1]) {
        playerIndex = 1;
      } else {
        sendError(ws, "Deze kamer is vol.");
        return;
      }

      room.clients[playerIndex] = ws;

      if (!room.game) {
        room.game = createGame();
      }

      ws.send(JSON.stringify({
        type: "joined",
        playerIndex,
        roomId
      }));

      room.game.message = playerIndex === 0
        ? "Speler links is verbonden. Wacht op speler rechts."
        : "Speler rechts is verbonden. Speler links begint.";

      broadcast(room);
      return;
    }

    if (data.type === "action") {
      if (!room || playerIndex === null) return;

      handleAction(room, playerIndex, data.action);
      broadcast(room);
    }
  });

  ws.on("close", () => {
    if (!room || playerIndex === null) return;

    room.clients[playerIndex] = null;

    if (room.game) {
      room.game.message = `${playerIndex === 0 ? "Speler links" : "Speler rechts"} is losgekoppeld.`;
      broadcast(room);
    }

    if (!room.clients[0] && !room.clients[1]) {
      rooms.delete(room.id);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server draait op http://localhost:${PORT}`);
});
