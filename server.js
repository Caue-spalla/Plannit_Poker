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
    editAfterReveal: new Set(), // socketIds liberados a alterar o voto após revelar
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
    return { average: '-', median: '-', mode: '-', min: '-', max: '-', stdDev: '-', consensus: false, outliers: [], distribution: {}, confidence: '-', agreementIndex: '-', totalVoters: 0 };
  }

  const sorted = [...numericVotes].sort((a, b) => a - b);
  const n = sorted.length;
  
  const avg = numericVotes.reduce((a, b) => a + b, 0) / n;
  const min = sorted[0];
  const max = sorted[n - 1];
  const consensus = new Set(numericVotes).size === 1;

  // Median
  const median = n % 2 === 0 
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 
    : sorted[Math.floor(n / 2)];

  // Mode (most frequent value)
  const freq = {};
  numericVotes.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
  const maxFreq = Math.max(...Object.values(freq));
  const modes = Object.keys(freq).filter(k => freq[k] === maxFreq).map(Number);
  const mode = modes.length === n ? null : modes; // null if all unique

  // Standard deviation
  const variance = numericVotes.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / n;
  const stdDev = Math.sqrt(variance);

  // Coefficient of variation (dispersion relative to mean)
  const cv = avg !== 0 ? (stdDev / avg) * 100 : 0;

  // 95% confidence interval (t-distribution approximation for small samples)
  const standardError = stdDev / Math.sqrt(n);
  const tValue = n <= 2 ? 12.71 : n <= 5 ? 2.78 : n <= 10 ? 2.26 : n <= 20 ? 2.09 : 1.96;
  const ciLow = avg - tValue * standardError;
  const ciHigh = avg + tValue * standardError;

  // Distribution (count per value from all votes including non-numeric)
  const distribution = {};
  Object.values(allVotes).forEach(v => {
    distribution[v] = (distribution[v] || 0) + 1;
  });

  // Agreement index (1 - normalized entropy): 1 = full consensus, 0 = max spread
  const totalVotes = Object.values(distribution).reduce((a, b) => a + b, 0);
  let entropy = 0;
  Object.values(distribution).forEach(count => {
    const p = count / totalVotes;
    if (p > 0) entropy -= p * Math.log2(p);
  });
  const maxEntropy = Math.log2(totalVotes);
  const agreementIndex = maxEntropy > 0 ? 1 - (entropy / maxEntropy) : 1;

  // Outlier detection
  const threshold = Math.max(stdDev * 1.2, avg * 0.3);
  const outliers = [];
  for (const [oderId, vote] of Object.entries(allVotes)) {
    const num = parseFloat(vote);
    if (!isNaN(num) && Math.abs(num - avg) > threshold && n > 2) {
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
    median: median % 1 === 0 ? median : median.toFixed(1),
    mode,
    min,
    max,
    stdDev: stdDev.toFixed(2),
    cv: cv.toFixed(1),
    confidence: { low: Math.max(0, ciLow).toFixed(1), high: ciHigh.toFixed(1) },
    consensus,
    outliers,
    distribution,
    agreementIndex: (agreementIndex * 100).toFixed(0),
    totalVoters: n
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
    const isModerator = room.participants.size === 0 && !room.moderator;
    
    currentUser = {
      id: socket.id,
      name: userName,
      isSpectator: isModerator ? true : isSpectator,  // Host always enters as spectator
      isModerator
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
      votedIds: Array.from(room.votes.keys()),
      editableIds: Array.from(room.editAfterReveal),
      you: currentUser
    });

    // Notify others
    socket.to(roomId).emit('participant-joined', currentUser);
    io.to(roomId).emit('participant-count', room.participants.size);
  });

  socket.on('vote', ({ value }) => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    if (!room || currentUser.isSpectator) return;

    // Após o reveal, só quem foi liberado pelo moderador (ou o próprio moderador) pode alterar o voto
    if (room.revealed && !currentUser.isModerator && !room.editAfterReveal.has(socket.id)) {
      socket.emit('edit-denied', {
        message: 'O moderador não liberou você para alterar o voto após revelar.'
      });
      return;
    }

    const hadVote = room.votes.has(socket.id);
    room.votes.set(socket.id, value);
    
    // Build list of who has voted (IDs only, no values)
    const votedIds = Array.from(room.votes.keys());
    
    // Check if all voters have voted (auto-reveal)
    const totalVoters = Array.from(room.participants.values())
      .filter(p => !p.isSpectator).length;
    const allVoted = room.votes.size >= totalVoters && totalVoters > 0;

    // If votes are already revealed, broadcast the updated values + stats
    if (room.revealed) {
      const votes = Object.fromEntries(room.votes);
      const numericVotes = Object.values(votes)
        .map(v => parseFloat(v))
        .filter(v => !isNaN(v));
      const stats = computeStats(numericVotes, votes, room);

      io.to(currentRoom).emit('votes-revealed', { votes, stats });
      io.to(currentRoom).emit('vote-cast', {
        oderId: socket.id,
        votedIds,
        isChange: hadVote,
        totalVotes: room.votes.size,
        totalVoters
      });
    } else if (allVoted) {
      // Auto-reveal when everyone has voted
      room.revealed = true;
      const votes = Object.fromEntries(room.votes);
      const numericVotes = Object.values(votes)
        .map(v => parseFloat(v))
        .filter(v => !isNaN(v));
      const stats = computeStats(numericVotes, votes, room);

      io.to(currentRoom).emit('vote-cast', {
        oderId: socket.id,
        votedIds,
        isChange: hadVote,
        totalVotes: room.votes.size,
        totalVoters
      });
      io.to(currentRoom).emit('votes-revealed', { votes, stats });
    } else {
      // Notify all: who voted + counts (allows real-time tracking)
      io.to(currentRoom).emit('vote-cast', {
        oderId: socket.id,
        votedIds,
        isChange: hadVote,
        totalVotes: room.votes.size,
        totalVoters
      });
    }
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
    room.editAfterReveal.clear();
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
    room.editAfterReveal.delete(targetId);
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

    // Se virou espectador, também perde a liberação de edição pós-reveal
    if (target.isSpectator) {
      room.editAfterReveal.delete(targetId);
    }

    io.to(currentRoom).emit('spectator-toggled', { 
      targetId, 
      isSpectator: target.isSpectator,
      name: target.name 
    });
  });

  socket.on('toggle-edit-permission', ({ targetId }) => {
    if (!currentRoom || !currentUser) return;
    const room = rooms.get(currentRoom);
    if (!room || !currentUser.isModerator) return;

    const target = room.participants.get(targetId);
    if (!target || target.isSpectator) return;

    const allowed = !room.editAfterReveal.has(targetId);
    if (allowed) {
      room.editAfterReveal.add(targetId);
    } else {
      room.editAfterReveal.delete(targetId);
    }

    io.to(currentRoom).emit('edit-permission-changed', {
      targetId,
      canEditAfterReveal: allowed,
      name: target.name,
      editableIds: Array.from(room.editAfterReveal)
    });
  });



  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    room.participants.delete(socket.id);
    room.votes.delete(socket.id);
    room.editAfterReveal.delete(socket.id);

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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🥤 Jorbe Poker™ rodando em http://localhost:${PORT} — Guaraná gelado!`);
});
