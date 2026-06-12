// === Plannit Poker - Room Client ===
const socket = io();
const roomId = window.location.pathname.split('/').pop();

let state = {
  room: null,
  participants: [],
  votes: {},
  you: null,
  selectedCard: null,
  revealed: false,
  revoteMode: false,
  revoteTargets: []
};

// === DOM Elements ===
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// === Initialize ===
function init() {
  const savedName = localStorage.getItem('plannit-poker-user');
  const isSpectator = localStorage.getItem('plannit-poker-spectator') === 'true';

  if (savedName) {
    joinRoom(savedName, isSpectator);
    $('#name-modal').style.display = 'none';
    $('#room-app').style.display = 'grid';
  } else {
    $('#name-modal').style.display = 'flex';
  }

  // Name form
  $('#name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#modal-name').value.trim();
    const spectator = $('#modal-spectator').checked;
    if (!name) return;

    localStorage.setItem('plannit-poker-user', name);
    localStorage.setItem('plannit-poker-name', name);
    if (spectator) localStorage.setItem('plannit-poker-spectator', 'true');

    joinRoom(name, spectator);
    $('#name-modal').style.display = 'none';
    $('#room-app').style.display = 'grid';
  });

  // Buttons
  $('#btn-copy-link').addEventListener('click', copyLink);
  $('#btn-leave').addEventListener('click', () => {
    localStorage.removeItem('plannit-poker-user');
    localStorage.removeItem('plannit-poker-spectator');
    window.location.href = '/';
  });
  $('#btn-reveal').addEventListener('click', () => socket.emit('reveal'));
  $('#btn-new-round').addEventListener('click', newRound);
  $('#btn-set-story').addEventListener('click', setStory);
  $('#btn-allow-revote').addEventListener('click', allowRevote);

  // Keyboard shortcut
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.you?.isModerator && state.revealed) {
      newRound();
    }
  });
}

function joinRoom(userName, isSpectator) {
  socket.emit('join-room', { roomId, userName, isSpectator });
}

// === Socket Events ===
socket.on('room-state', (data) => {
  state.room = data.room;
  state.participants = data.participants;
  state.votes = data.votes;
  state.you = data.you;
  state.revealed = data.room.revealed;
  renderAll();
});

socket.on('participant-joined', (participant) => {
  state.participants.push(participant);
  renderParticipants();
  renderTable();
  showToast(`${participant.name} entrou na sala`);
});

socket.on('participant-left', ({ id }) => {
  const p = state.participants.find(p => p.id === id);
  state.participants = state.participants.filter(p => p.id !== id);
  delete state.votes[id];
  renderParticipants();
  renderTable();
  if (p) showToast(`${p.name} saiu da sala`);
});

socket.on('participant-count', (count) => {
  $('#participant-count').textContent = `${count} participante${count !== 1 ? 's' : ''}`;
});

socket.on('vote-cast', ({ totalVotes, totalVoters }) => {
  renderTable();
});

socket.on('votes-revealed', ({ votes, stats }) => {
  state.votes = votes;
  state.revealed = true;
  state.lastStats = stats;
  renderTable();
  renderStats(stats);
  renderOutliers(stats.outliers || []);
  
  if (state.you?.isModerator) {
    $('#btn-reveal').style.display = 'none';
    $('#btn-new-round').style.display = '';
  }
});

socket.on('round-reset', ({ story }) => {
  state.votes = {};
  state.revealed = false;
  state.selectedCard = null;
  state.revoteMode = false;
  state.revoteTargets = [];
  state.room.currentStory = story;

  $('#stats-panel').style.display = 'none';
  $('#outliers-panel').style.display = 'none';
  $('#revote-notice').style.display = 'none';
  renderTable();
  renderDeck();
  renderStory();

  if (state.you?.isModerator) {
    $('#btn-reveal').style.display = '';
    $('#btn-new-round').style.display = 'none';
  }
});

socket.on('story-updated', ({ story }) => {
  state.room.currentStory = story;
  renderStory();
});

socket.on('moderator-changed', ({ newModeratorId, newModeratorName }) => {
  state.participants.forEach(p => {
    p.isModerator = (p.id === newModeratorId);
  });
  if (state.you.id === newModeratorId) {
    state.you.isModerator = true;
    showToast('Você agora é o moderador!');
  } else {
    state.you.isModerator = false;
  }
  renderAll();
});

socket.on('spectator-toggled', ({ targetId, isSpectator, name }) => {
  const p = state.participants.find(p => p.id === targetId);
  if (p) p.isSpectator = isSpectator;
  
  if (targetId === state.you?.id) {
    state.you.isSpectator = isSpectator;
    if (isSpectator) {
      showToast('Você agora é observador');
      state.selectedCard = null;
    } else {
      showToast('Você agora é jogador');
    }
  } else {
    showToast(`${name} agora é ${isSpectator ? 'observador' : 'jogador'}`);
  }
  
  renderAll();
});

socket.on('revote-allowed', ({ targetIds }) => {
  state.revoteMode = true;
  state.revoteTargets = targetIds;
  
  // Clear all votes in local state
  state.votes = {};
  state.selectedCard = null;
  
  if (targetIds.includes(state.you?.id)) {
    $('#revote-notice').style.display = 'block';
    showToast('Revote aberto! Escolha sua nova carta.');
  }
  
  renderTable();
  renderDeck();
});

socket.on('revote-cast', ({ oderId }) => {
  state.votes[oderId] = '✓';
  renderTable();
});

socket.on('revote-complete', ({ votes, stats }) => {
  state.votes = votes;
  state.revoteMode = false;
  state.revoteTargets = [];
  $('#revote-notice').style.display = 'none';
  
  renderTable();
  renderStats(stats);
  renderOutliers(stats.outliers || []);
  showToast('Revote concluído!');
});

socket.on('kicked', () => {
  alert('Você foi removido da sala pelo moderador.');
  window.location.href = '/';
});

socket.on('error', ({ message }) => {
  alert(message);
  window.location.href = '/';
});

// === Render Functions ===
function renderAll() {
  $('#room-name').textContent = state.room.name;
  document.title = `${state.room.name} - Jorbe Poker™`;

  if (state.you?.isModerator) {
    $('#room-app').classList.add('is-moderator');
    $('#moderator-controls').style.display = 'flex';
    $('#story-edit').style.display = 'flex';
    
    if (state.revealed) {
      $('#btn-reveal').style.display = 'none';
      $('#btn-new-round').style.display = '';
    } else {
      $('#btn-reveal').style.display = '';
      $('#btn-new-round').style.display = 'none';
    }
  } else {
    $('#room-app').classList.remove('is-moderator');
    $('#moderator-controls').style.display = 'none';
    $('#story-edit').style.display = 'none';
  }

  if (state.you?.isSpectator) {
    $('#deck-section').classList.add('spectator');
  } else {
    $('#deck-section').classList.remove('spectator');
  }

  renderStory();
  renderDeck();
  renderTable();
  renderParticipants();
}

function renderStory() {
  const story = state.room.currentStory;
  $('#story-text').textContent = story || 'Nenhuma história definida';
  if (state.you?.isModerator) {
    $('#story-input').value = story || '';
  }
}

function renderDeck() {
  const deck = state.room.deck;
  const container = $('#card-deck');
  container.innerHTML = '';

  // Check if user can vote
  const canVote = !state.you?.isSpectator && 
    (!state.revealed || (state.revoteMode && state.revoteTargets.includes(state.you?.id)));

  deck.forEach(value => {
    const card = document.createElement('div');
    card.className = 'poker-card' + (state.selectedCard === value ? ' selected' : '');
    if (!canVote) card.classList.add('disabled');
    card.textContent = value;
    card.addEventListener('click', () => {
      if (canVote) selectCard(value);
    });
    container.appendChild(card);
  });
}

function renderTable() {
  const container = $('#poker-table');
  container.innerHTML = '';

  const voters = state.participants.filter(p => !p.isSpectator);

  voters.forEach(p => {
    const seat = document.createElement('div');
    seat.className = 'table-seat';

    const card = document.createElement('div');
    card.className = 'seat-card';

    const isOutlier = state.revealed && state.lastStats?.outliers?.some(o => o.oderId === p.id);
    const isRevoteTarget = state.revoteMode && state.revoteTargets.includes(p.id);

    if (isRevoteTarget && !state.votes[p.id]) {
      card.classList.add('revoting');
      card.textContent = '🔄';
    } else if (state.revealed && state.votes[p.id]) {
      card.classList.add('revealed');
      if (isOutlier) card.classList.add('outlier');
      card.textContent = state.votes[p.id];
    } else if (state.votes[p.id]) {
      card.classList.add('voted');
      card.textContent = '✓';
    } else {
      card.classList.add('not-voted');
      card.textContent = '?';
    }

    const name = document.createElement('div');
    name.className = 'seat-name';
    if (p.id === state.you?.id) name.classList.add('is-you');
    if (p.isModerator) name.classList.add('is-moderator');
    if (isOutlier) name.classList.add('is-outlier');
    name.textContent = p.id === state.you?.id ? `${p.name} (você)` : p.name;

    seat.appendChild(card);
    seat.appendChild(name);
    container.appendChild(seat);
  });
}

function renderParticipants() {
  const list = $('#participants-list');
  list.innerHTML = '';

  state.participants.forEach(p => {
    const li = document.createElement('li');
    
    const info = document.createElement('div');
    info.className = 'participant-info';
    
    const avatar = document.createElement('div');
    avatar.className = 'participant-avatar';
    avatar.textContent = p.name.charAt(0).toUpperCase();
    
    const nameSpan = document.createElement('span');
    nameSpan.className = 'participant-name';
    nameSpan.textContent = p.name;

    info.appendChild(avatar);
    info.appendChild(nameSpan);

    const badges = document.createElement('div');
    badges.className = 'participant-badges';

    if (p.id === state.you?.id) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-you';
      badge.textContent = 'Você';
      badges.appendChild(badge);
    }
    if (p.isModerator) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-mod';
      badge.textContent = 'Mod';
      badges.appendChild(badge);
    }
    if (p.isSpectator) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-spectator';
      badge.textContent = 'Observador';
      badges.appendChild(badge);
    }
    if (state.votes[p.id] && !p.isSpectator) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-voted';
      badge.textContent = '✓';
      badges.appendChild(badge);
    }

    li.appendChild(info);
    li.appendChild(badges);

    // Moderator actions
    if (state.you?.isModerator && p.id !== state.you.id) {
      const actions = document.createElement('div');
      actions.className = 'mod-actions';

      // Toggle spectator/player
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'mod-action-btn toggle-spectator-btn';
      toggleBtn.title = p.isSpectator ? 'Tornar jogador' : 'Tornar observador';
      toggleBtn.textContent = p.isSpectator ? '🎮' : '👁️';
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('toggle-spectator', { targetId: p.id });
      });

      const transferBtn = document.createElement('button');
      transferBtn.className = 'mod-action-btn';
      transferBtn.title = 'Transferir moderação';
      transferBtn.textContent = '⭐';
      transferBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Transferir moderação para ${p.name}?`)) {
          socket.emit('transfer-moderator', { targetId: p.id });
        }
      });

      const kickBtn = document.createElement('button');
      kickBtn.className = 'mod-action-btn';
      kickBtn.title = 'Remover da sala';
      kickBtn.textContent = '✕';
      kickBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Remover ${p.name} da sala?`)) {
          socket.emit('kick-participant', { targetId: p.id });
        }
      });

      actions.appendChild(toggleBtn);
      actions.appendChild(transferBtn);
      actions.appendChild(kickBtn);
      li.appendChild(actions);
    }

    // Self toggle (moderator can toggle themselves)
    if (state.you?.isModerator && p.id === state.you.id) {
      const actions = document.createElement('div');
      actions.className = 'mod-actions mod-actions-self';

      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'mod-action-btn toggle-spectator-btn';
      toggleBtn.title = p.isSpectator ? 'Voltar a jogar' : 'Apenas observar';
      toggleBtn.textContent = p.isSpectator ? '🎮' : '👁️';
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('toggle-spectator', { targetId: p.id });
      });

      actions.appendChild(toggleBtn);
      li.appendChild(actions);
    }

    list.appendChild(li);
  });
}

function renderStats(stats) {
  $('#stats-panel').style.display = 'flex';
  $('#stat-avg').textContent = stats.average;
  $('#stat-min').textContent = stats.min;
  $('#stat-max').textContent = stats.max;
  
  if (stats.consensus) {
    $('#stat-consensus-wrap').style.display = 'flex';
  } else {
    $('#stat-consensus-wrap').style.display = 'none';
  }

  state.lastStats = stats;
}

function renderOutliers(outliers) {
  const panel = $('#outliers-panel');
  const list = $('#outliers-list');
  const btn = $('#btn-allow-revote');

  // Always show revote button for moderator after reveal
  if (state.you?.isModerator && state.revealed) {
    btn.style.display = 'inline-flex';
  } else {
    btn.style.display = 'none';
  }

  if (!outliers || outliers.length === 0) {
    panel.style.display = state.you?.isModerator && state.revealed ? 'block' : 'none';
    list.innerHTML = '';
    return;
  }

  panel.style.display = 'block';
  list.innerHTML = '';

  outliers.forEach(o => {
    const item = document.createElement('div');
    item.className = 'outlier-item';
    
    const deviation = parseFloat(o.deviation);
    const direction = deviation > 0 ? '↑' : '↓';
    const absDeviation = Math.abs(deviation);

    item.innerHTML = `
      <span class="outlier-name">${o.name}</span>
      <span class="outlier-vote">${o.vote}</span>
      <span class="outlier-deviation ${deviation > 0 ? 'high' : 'low'}">
        ${direction} ${absDeviation}h da média
      </span>
    `;
    list.appendChild(item);
  });
}

// === Actions ===
function selectCard(value) {
  if (state.you?.isSpectator) return;
  
  // Normal voting
  if (!state.revealed && !state.revoteMode) {
    if (state.selectedCard === value) {
      state.selectedCard = null;
      delete state.votes[state.you.id];
    } else {
      state.selectedCard = value;
      state.votes[state.you.id] = '✓';
      socket.emit('vote', { value });
    }
  }
  
  // Revote mode
  if (state.revoteMode && state.revoteTargets.includes(state.you?.id)) {
    state.selectedCard = value;
    state.votes[state.you.id] = '✓';
    socket.emit('revote', { value });
  }

  renderDeck();
  renderTable();
  renderParticipants();
}

function newRound() {
  const story = $('#story-input')?.value?.trim() || '';
  socket.emit('new-round', { story });
}

function setStory() {
  const story = $('#story-input').value.trim();
  socket.emit('update-story', { story });
}

function allowRevote() {
  socket.emit('allow-revote');
}

function copyLink() {
  const url = window.location.href;
  navigator.clipboard.writeText(url).then(() => {
    showToast('Link copiado! Compartilhe com o time.');
  }).catch(() => {
    const input = document.createElement('input');
    input.value = url;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
    showToast('Link copiado!');
  });
}

// === Toast ===
function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// === Start ===
init();
