const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

const DOMINO_DECK = [
  [0,0],[0,1],[0,2],[0,3],[0,4],[0,5],[0,6],
  [1,1],[1,2],[1,3],[1,4],[1,5],[1,6],
  [2,2],[2,3],[2,4],[2,5],[2,6],
  [3,3],[3,4],[3,5],[3,6],
  [4,4],[4,5],[4,6],[5,5],[5,6],[6,6]
];

const AVATARS = ['🐶', '🐱', '🦊', '🦁', '🐸', '🐼', '🐯', '🤖', '👾', '🐻'];
const BG_COLORS = ['#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#9b59b6', '#e84393'];

function getRandomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function shuffleDeck(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

const isTwinCard = ([top, bottom]) => top === bottom;

function evaluateHand2Cards(cards) {
  if (!cards || cards.length < 2) return null;
  const [card1, card2] = cards;
  const totalDots = card1[0] + card1[1] + card2[0] + card2[1];
  const value = totalDots % 10;
  const isDoubleTwin = isTwinCard(card1) && isTwinCard(card2);

  let highestTwin = -1;
  if (isTwinCard(card1)) highestTwin = Math.max(highestTwin, card1[0]);
  if (isTwinCard(card2)) highestTwin = Math.max(highestTwin, card2[0]);

  return { value, isDoubleTwin, highestTwin, totalDots };
}

const rooms = {};

function getPlayerBySocketId(socketId) {
  for (const roomId in rooms) {
    const player = rooms[roomId].players.find(p => p.socketId === socketId);
    if (player) return { player, room: rooms[roomId] };
  }
  return { player: null, room: null };
}

io.on('connection', (socket) => {
  socket.on('join_room', ({ playerName }) => {
    const roomId = 'FREE_BET';

    if (!rooms[roomId]) {
      rooms[roomId] = { 
        roomId, 
        status: 'WAITING', 
        players: [],
        dealerIndex: 0,
        autoStartTimer: null,
        turnTimer: null
      };
    }

    const room = rooms[roomId];
    if (room.players.length >= 6) return socket.emit('error_msg', 'Meja penuh! Maksimal 6 pemain.');

    const takenSeats = room.players.map(p => p.seatIndex);
    let assignedSeat = 0;
    while (takenSeats.includes(assignedSeat)) assignedSeat++;

    const pName = playerName || `Player ${assignedSeat + 1}`;
    const newPlayer = {
      socketId: socket.id,
      name: pName,
      avatar: getRandomItem(AVATARS),
      color: getRandomItem(BG_COLORS),
      seatIndex: assignedSeat,
      hand: [],
      revealedCards: [false, false],
      isFullyRevealed: false,
      winStreak: 0,
      isSpectator: room.status !== 'WAITING'
    };

    room.players.push(newPlayer);
    socket.join(roomId);

    io.to(roomId).emit('sys_message', `${pName} bergabung ke meja.`);
    broadcastRoomState(roomId);
    checkAutoStart(room);
  });

  socket.on('toggle_spectator', () => {
    const { player, room } = getPlayerBySocketId(socket.id);
    if (!player || !room) return;

    if (room.status !== 'WAITING' && room.status !== 'SHOWDOWN') {
      return socket.emit('error_msg', 'Ubah mode penonton hanya bisa saat ronde selesai!');
    }

    player.isSpectator = !player.isSpectator;
    player.hand = [];
    player.revealedCards = [false, false];
    player.isFullyRevealed = false;
    
    const activePlayers = room.players.filter(p => !p.isSpectator);
    if (activePlayers.length < 2 && room.status !== 'WAITING') {
      clearRoomTimers(room);
      room.status = 'WAITING';
    }

    broadcastRoomState(room.roomId);
    checkAutoStart(room);
  });

  socket.on('switch_seat', ({ targetSeatIndex }) => {
    const { player, room } = getPlayerBySocketId(socket.id);
    if (!player || !room) return;

    if (room.status !== 'WAITING' && room.status !== 'SHOWDOWN') {
      return socket.emit('error_msg', 'Pindah kursi hanya bisa dilakukan saat ronde selesai!');
    }

    if (targetSeatIndex < 0 || targetSeatIndex > 5) return;

    const isSeatOccupied = room.players.some(p => p.seatIndex === targetSeatIndex);
    if (isSeatOccupied) return socket.emit('error_msg', 'Kursi tersebut sudah terisi!');

    player.seatIndex = targetSeatIndex;
    broadcastRoomState(room.roomId);
  });

  socket.on('send_chat', ({ message }) => {
    const { player, room } = getPlayerBySocketId(socket.id);
    if (!player || !room || !message.trim()) return;

    io.to(room.roomId).emit('new_chat', {
      sender: player.name,
      color: player.color,
      message: message.trim().substring(0, 60)
    });
  });

  socket.on('reveal_single_card', ({ cardIndex }) => {
    const { player, room } = getPlayerBySocketId(socket.id);
    if (!player || !player.hand || room.status !== 'PLAYING' || player.isSpectator) return;

    player.revealedCards[cardIndex] = true;

    if (player.revealedCards[0] && player.revealedCards[1]) {
      player.isFullyRevealed = true;
    }

    broadcastRoomState(room.roomId);
    checkAllPlayersRevealed(room);
  });

  socket.on('dealer_continue', () => {
    const roomId = 'FREE_BET';
    const room = rooms[roomId];
    if (!room || room.status !== 'SHOWDOWN') return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (player && player.isDealer) {
      const activePlayers = room.players.filter(p => !p.isSpectator);
      if (activePlayers.length >= 2) {
        startNewRound(room);
      } else {
        room.status = 'WAITING';
        broadcastRoomState(roomId);
        checkAutoStart(room);
      }
    }
  });

  socket.on('send_reaction', ({ type, content }) => {
    const { player, room } = getPlayerBySocketId(socket.id);
    if (player && room) {
      io.to(room.roomId).emit('broadcast_reaction', {
        seatIndex: player.seatIndex,
        type,
        content
      });
    }
  });

  socket.on('disconnect', () => {
    const { player, room } = getPlayerBySocketId(socket.id);
    if (room && player) {
      const pName = player.name;
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        io.to(room.roomId).emit('sys_message', `${pName} keluar dari meja.`);

        if (room.players.length === 0) {
          clearRoomTimers(room);
          delete rooms[room.roomId];
        } else {
          const activePlayers = room.players.filter(p => !p.isSpectator);
          
          if (room.status !== 'WAITING' && activePlayers.length < 2) {
            clearRoomTimers(room);
            room.status = 'WAITING';
            room.players.forEach(p => p.isSpectator = false);
            io.to(room.roomId).emit('sys_message', `Pemain tidak cukup. Menunggu pemain baru...`);
          } else if (room.status === 'PLAYING') {
            checkAllPlayersRevealed(room);
          }

          broadcastRoomState(room.roomId);
          checkAutoStart(room);
        }
      }
    }
  });
});

function clearRoomTimers(room) {
  if (room.autoStartTimer) {
    clearInterval(room.autoStartTimer);
    room.autoStartTimer = null;
  }
  if (room.turnTimer) {
    clearInterval(room.turnTimer);
    room.turnTimer = null;
  }
}

function checkAllPlayersRevealed(room) {
  if (!room || room.status !== 'PLAYING') return;

  const activePlayers = room.players.filter(p => !p.isSpectator);
  const allRevealed = activePlayers.length > 0 && activePlayers.every(p => p.isFullyRevealed);

  if (allRevealed) {
    clearRoomTimers(room);
    setTimeout(() => {
      if (room.status === 'PLAYING') handleShowdown(room);
    }, 400);
  }
}

function checkAutoStart(room) {
  const activePlayers = room.players.filter(p => !p.isSpectator);
  if (room.status === 'WAITING' && activePlayers.length >= 2 && !room.autoStartTimer) {
    let countdown = 5;
    io.to(room.roomId).emit('timer_sync', { sec: countdown, maxSec: 5 });

    room.autoStartTimer = setInterval(() => {
      countdown--;
      if (countdown > 0) {
        io.to(room.roomId).emit('timer_sync', { sec: countdown, maxSec: 5 });
      } else {
        clearRoomTimers(room);
        const currentActive = room.players.filter(p => !p.isSpectator);
        if (currentActive.length >= 2) startNewRound(room);
        else {
          room.status = 'WAITING';
          broadcastRoomState(room.roomId);
        }
      }
    }, 1000);
  }
}

function startNewRound(room) {
  clearRoomTimers(room);
  
  const activePlayers = room.players.filter(p => !p.isSpectator);
  if (activePlayers.length < 2) {
    room.status = 'WAITING';
    broadcastRoomState(room.roomId);
    return;
  }

  room.status = 'PLAYING';
  const deck = shuffleDeck(DOMINO_DECK);

  let activeDealerIdx = room.dealerIndex || 0;
  let attempts = 0;
  do {
    activeDealerIdx = (activeDealerIdx + 1) % room.players.length;
    attempts++;
  } while (room.players[activeDealerIdx] && room.players[activeDealerIdx].isSpectator && attempts < room.players.length);

  room.dealerIndex = activeDealerIdx;

  room.players.forEach((player, idx) => {
    if (!player.isSpectator) {
      player.isDealer = (idx === room.dealerIndex);
      player.hand = [deck.pop(), deck.pop()];
      player.revealedCards = [false, false];
      player.isFullyRevealed = false;
      player.evalData = evaluateHand2Cards(player.hand);
    } else {
      player.isDealer = false;
      player.hand = [];
      player.revealedCards = [false, false];
      player.isFullyRevealed = false;
      player.evalData = null;
    }
  });

  broadcastRoomState(room.roomId, true);
  startPlayPhase(room);
}

function startPlayPhase(room) {
  let timeLeft = 20;
  io.to(room.roomId).emit('timer_sync', { sec: timeLeft, maxSec: 20 });

  room.turnTimer = setInterval(() => {
    timeLeft--;
    if (timeLeft > 0 && room.status === 'PLAYING') {
      io.to(room.roomId).emit('timer_sync', { sec: timeLeft, maxSec: 20 });
    } else {
      clearRoomTimers(room);
      if (room.status === 'PLAYING') {
        room.players.forEach(p => {
          if (!p.isSpectator) {
            p.revealedCards = [true, true];
            p.isFullyRevealed = true;
          }
        });
        handleShowdown(room);
      }
    }
  }, 1000);
}

function compareHands(p1, p2) {
  const evalA = p1.evalData;
  const evalB = p2.evalData;

  if (evalA.isDoubleTwin && !evalB.isDoubleTwin) return -1;
  if (!evalA.isDoubleTwin && evalB.isDoubleTwin) return 1;
  if (evalA.isDoubleTwin && evalB.isDoubleTwin) return evalB.highestTwin - evalA.highestTwin;

  if (evalA.value !== evalB.value) return evalB.value - evalA.value;
  if (evalA.highestTwin !== evalB.highestTwin) return evalB.highestTwin - evalA.highestTwin;
  if (evalA.totalDots !== evalB.totalDots) return evalB.totalDots - evalA.totalDots;
  return 0;
}

function handleShowdown(room) {
  clearRoomTimers(room);
  room.status = 'SHOWDOWN';
  room.players.forEach(p => { 
    if (!p.isSpectator) {
      p.revealedCards = [true, true];
      p.isFullyRevealed = true;
    }
  });

  const activePlayers = room.players.filter(p => !p.isSpectator && p.evalData);
  if (activePlayers.length === 0) return;

  const dealer = activePlayers.find(p => p.isDealer) || activePlayers[0];

  const winners = [];
  activePlayers.forEach(p => {
    if (p.socketId === dealer.socketId) return;
    const res = compareHands(p, dealer);
    if (res < 0) winners.push(p);
  });

  if (winners.length === 0) winners.push(dealer);

  room.players.forEach(p => {
    const isWin = winners.some(w => w.socketId === p.socketId);
    if (isWin) p.winStreak += 1;
    else p.winStreak = 0;
  });

  broadcastRoomState(room.roomId);

  io.to(room.roomId).emit('showdown_results', { winners: winners.map(w => w.name) });
  io.to(room.roomId).emit('timer_sync', { sec: 0, maxSec: 20 });
}

function broadcastRoomState(roomId, isNewDeal = false) {
  const room = rooms[roomId];
  if (!room) return;

  const dealerPlayer = room.players.find(p => p.isDealer);
  const dealerSeat = dealerPlayer ? dealerPlayer.seatIndex : 0;

  room.players.forEach(p => {
    const sanitizedPlayers = room.players.map(other => {
      const isSelf = (other.socketId === p.socketId);
      const isShowdown = (room.status === 'SHOWDOWN');

      return {
        name: other.name,
        avatar: other.avatar,
        color: other.color,
        seatIndex: other.seatIndex,
        isDealer: other.isDealer,
        winStreak: other.winStreak,
        revealedCards: other.revealedCards,
        isFullyRevealed: other.isFullyRevealed,
        isSpectator: other.isSpectator,
        hand: (isSelf || isShowdown || other.isFullyRevealed) ? other.hand : null,
        evalData: (isSelf || isShowdown || other.isFullyRevealed) ? other.evalData : null,
        hasHand: !other.isSpectator && other.hand && other.hand.length === 2
      };
    });

    io.to(p.socketId).emit('room_state_updated', {
      status: room.status,
      mySeatIndex: p.seatIndex,
      dealerSeatIndex: dealerSeat,
      players: sanitizedPlayers,
      isNewDeal
    });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server Qiu Jalan di port ${PORT}`));
