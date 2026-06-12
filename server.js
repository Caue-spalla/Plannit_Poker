require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const ROOM_SECRET = process.env.ROOM_SECRET || 'newm-poker-2024';

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// In-memory room storage
const rooms = new Map();

// Deck presets
const hoursSequential = Array.from({ length: 50 }, (_, i) => `${i + 1}h`).concat(['?', '☕']);

const DECKS = {
  fibonacci: ['0', '1', '2', '3', '5', '8', '13', '21', '34', '55', '89', '?', '☕'],
  tshirt: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '?', '☕'],
  powers: ['0', '1', '2', '4', '8', '16', '32', '64', '?', '☕'],
  hours: ['0', '1', '2', '4', '6', '8', '12', '16', '24', '32', '40', '?', '☕'],
  hours_sequential: hoursSequential
};

// API: Create room
app.post('/api/rooms', express.json(), (req, res) => {
  const { name, deck = 'fibonacci', moderatorName, secret } = req.body;

  if (!secret || secret !== ROOM_SECRET) {
    return res.status(403).json({ error: 'Chave de criação inválida' });
  }

  const roomId = uuidv4().slice(0, 8);
  
  rooms.set(roomId, {
    id: roomId,
    name: name || `Sala ${roomId}`,
    deck: DECKS[deck] || DECKS.fibonacci,
    deckType: deck,
    moderator: null,
    moderatorName: moderatorName || 'Moderador',
    participants: new Map(),
    votes: new Map(),
    revealed: false,
    revoteAllowed: false,
    revoteTargets: [],
    currentStory: '',
    createdAt: Date.now()
  });

  res.json({ roomId, url: `/room/${roomId}` });
});

// API: Get room info
app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  
  res.json({
    id: room.id,
    name: room.name,
    deckType: room.deckType,
    deck: room.deck,
    currentStory: room.currentStory,
    participantCount: room.participants.size
  });
});

// Serve room page
app.get('/room/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// Compute stats with outlier detection
function computeStats(numericVotes, allVotes, room) {
  if (numericVotes.length === 0) {
    return { average: '-', min: '-', max: '-', consensus: false, outliers: [] };
  }

  const avg = numericVotes.reduce((a, b) => a + b, 0) / numericVotes.length;
  const min = Math.min(...numericVotes);
  const max = Math.max(...numericVotes);
  const consensus = new Set(numericVotes).size === 1;

  // Outlier detection: votes that deviate more than 1 standard deviation from mean
  const stdDev = Math.sqrt(
    numericVotes.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / numericVotes.length
  );
  const threshold = Math.max(stdDev * 1.2, avg * 0.3); // At least 30% from average

  const outliers = [];
  for (const [oderId, vote] of Object.entries(allVotes)) {
    const num = parseFloat(vote);
    if (!isNaN(num) && Math.abs(num - avg) > threshold && numericVotes.length > 2) {
      const participant = room.participants.get(oderId);
      outliers.push({
        oderId,
        name: participant ? participant.name : 'Desconhecido',
        vote,
        deviation: (num - avg).toFixed(1)
      });
    }
  }

  return {
    average: avg.toFixed(1),
    min,
    max,
    consensus,
    outliers
  };
}

// Socket.IO
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUser = null;

  socket.on('join-room', ({ roomId, userName, isSpectator = false }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', { message: 'Sala não encontrada' });
      return;
    }

    currentRoom = roomId;
    currentUser = {
      id: socket.id,
      name: userName,
      isSpectator,
      isModerator: room.participants.size === 0 && !room.moderator
    };

    // First person to join becomes moderator
    if (!room.moderator) {
      room.moderator = socket.id;
      currentUser.isModerator = true;
    }

    room.participants.set(socket.id, currentUser);
    socket.join(roomId);

    // Send room state to the new participant
    socket.emit('room-state', {
      room: {
        id: room.id,
        name: room.name,
        deck: room.deck,
        deckType: room.deckType,
        currentStory: room.currentStory,
        revealed: room.revealed
      },
      participants: Array.from(room.participants.values()),
      votes: room.revealed 
        ? Object.fromEntries(room.votes)
        : Object.fromEntries(
            Array.from(room.votes.entries()).map(([id]) => [id, '✓'])
          ),
      you: currentUser
    });

    // Notify others
    socket.to(roomId).emit('participant-joined', currentUser);
    io.to(roomId).emit('participant-count', room.participants.size);
  });

  socket.on('vote', ({ value }) => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    if (!room || room.revealed || currentUser.isSpectator) return;

    room.votes.set(socket.id, value);
    
    // Notify all that someone voted (but not the value)
    io.to(currentRoom).emit('vote-cast', {
      oderId: socket.id,
      totalVotes: room.votes.size,
      totalVoters: Array.from(room.participants.values())
        .filter(p => !p.isSpectator).length
    });
  });

  socket.on('reveal', () => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    if (!room || !currentUser.isModerator) return;

    room.revealed = true;
    const votes = Object.fromEntries(room.votes);
    
    // Calculate stats
    const numericVotes = Object.values(votes)
      .map(v => parseFloat(v))
      .filter(v => !isNaN(v));
    
    const stats = computeStats(numericVotes, votes, room);

    io.to(currentRoom).emit('votes-revealed', { votes, stats });
  });

  socket.on('new-round', ({ story = '' } = {}) => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    if (!room || !currentUser.isModerator) return;

    room.votes.clear();
    room.revealed = false;
    room.revoteAllowed = false;
    room.revoteTargets = [];
    room.currentStory = story;

    io.to(currentRoom).emit('round-reset', { story });
  });

  socket.on('update-story', ({ story }) => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    if (!room || !currentUser.isModerator) return;

    room.currentStory = story;
    io.to(currentRoom).emit('story-updated', { story });
  });

  socket.on('transfer-moderator', ({ targetId }) => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    if (!room || !currentUser.isModerator) return;

    const target = room.participants.get(targetId);
    if (!target) return;

    currentUser.isModerator = false;
    target.isModerator = true;
    room.moderator = targetId;

    io.to(currentRoom).emit('moderator-changed', {
      newModeratorId: targetId,
      newModeratorName: target.name
    });
  });

  socket.on('kick-participant', ({ targetId }) => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    if (!room || !currentUser.isModerator) return;

    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.emit('kicked');
      targetSocket.leave(currentRoom);
    }
    
    room.participants.delete(targetId);
    room.votes.delete(targetId);
    io.to(currentRoom).emit('participant-left', { id: targetId });
    io.to(currentRoom).emit('participant-count', room.participants.size);
  });

  socket.on('toggle-spectator', ({ targetId }) => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    if (!room || !currentUser.isModerator) return;

    const target = room.participants.get(targetId);
    if (!target) return;

    target.isSpectator = !target.isSpectator;
    
    // Remove vote if becoming spectator
    if (target.isSpectator) {
      room.votes.delete(targetId);
    }

    io.to(currentRoom).emit('spectator-toggled', { 
      targetId, 
      isSpectator: target.isSpectator,
      name: target.name 
    });
  });

  socket.on('allow-revote', () => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    if (!room || !currentUser.isModerator || !room.revealed) return;

    room.revoteAllowed = true;
    // All non-spectator participants can revote
    const allVoters = Array.from(room.participants.values())
      .filter(p => !p.isSpectator)
      .map(p => p.id);
    room.revoteTargets = allVoters;

    // Clear all votes
    room.votes.clear();

    io.to(currentRoom).emit('revote-allowed', { targetIds: allVoters });
  });

  socket.on('revote', ({ value }) => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.revoteAllowed) return;
    if (!room.revoteTargets.includes(socket.id)) return;

    room.votes.set(socket.id, value);

    // Check if all targets have revoted
    const allRevoted = room.revoteTargets.every(id => room.votes.has(id));
    
    if (allRevoted) {
      room.revoteAllowed = false;
      const votes = Object.fromEntries(room.votes);
      
      const numericVotes = Object.values(votes)
        .map(v => parseFloat(v))
        .filter(v => !isNaN(v));
      
      const stats = computeStats(numericVotes, votes, room);

      io.to(currentRoom).emit('revote-complete', { votes, stats });
    } else {
      io.to(currentRoom).emit('revote-cast', { oderId: socket.id });
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    room.participants.delete(socket.id);
    room.votes.delete(socket.id);

    // Transfer moderator if needed
    if (room.moderator === socket.id && room.participants.size > 0) {
      const newMod = room.participants.values().next().value;
      newMod.isModerator = true;
      room.moderator = newMod.id;
      io.to(currentRoom).emit('moderator-changed', {
        newModeratorId: newMod.id,
        newModeratorName: newMod.name
      });
    }

    io.to(currentRoom).emit('participant-left', { id: socket.id });
    io.to(currentRoom).emit('participant-count', room.participants.size);

    // Cleanup empty rooms after 5 minutes
    if (room.participants.size === 0) {
      setTimeout(() => {
        const r = rooms.get(currentRoom);
        if (r && r.participants.size === 0) {
          rooms.delete(currentRoom);
        }
      }, 5 * 60 * 1000);
    }
  });
});

// Cleanup old rooms every hour
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.participants.size === 0 && now - room.createdAt > 3600000) {
      rooms.delete(id);
    }
  }
}, 3600000);

server.listen(PORT, () => {
  console.log(`🥤 Jorbe Poker™ rodando em http://localhost:${PORT} — Guaraná gelado!`);
});
