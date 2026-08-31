// === Plannit Poker - Room Client ===
const socket = io();
const roomId = window.location.pathname.split('/').pop();

let state = {
  room: null,
  participants: [],
  votes: {},
  votedIds: [],
  editableIds: [],
  you: null,
  selectedCard: null,
  revealed: false
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
  state.votedIds = data.votedIds || [];
  state.editableIds = data.editableIds || [];
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

socket.on('vote-cast', ({ oderId, votedIds, isChange, totalVotes, totalVoters }) => {
  state.votedIds = votedIds;
  // Mark voted in local state for display
  if (!state.revealed) {
    state.votes[oderId] = '✓';
  }
  renderTable();
  renderParticipants();
  
  // Show toast for vote changes
  if (isChange && oderId !== state.you?.id) {
    const p = state.participants.find(p => p.id === oderId);
    if (p) showToast(`${p.name} alterou o voto`);
  }
});

socket.on('votes-revealed', ({ votes, stats }) => {
  state.votes = votes;
  state.revealed = true;
  state.lastStats = stats;
  renderTable();
  renderDeck();
  renderStats(stats);
  renderOutliers(stats.outliers || []);
  renderParticipants();
  
  if (state.you?.isModerator) {
    $('#btn-reveal').style.display = 'none';
    $('#btn-new-round').style.display = '';
  }
});

socket.on('round-reset', ({ story }) => {
  state.votes = {};
  state.votedIds = [];
  state.revealed = false;
  state.selectedCard = null;
  state.room.currentStory = story;

  $('#stats-panel').style.display = 'none';
  $('#outliers-panel').style.display = 'none';
  renderTable();
  renderDeck();
  renderStory();
  renderParticipants();

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

socket.on('edit-permission-changed', ({ targetId, canEditAfterReveal, name, editableIds }) => {
  state.editableIds = editableIds || [];

  if (targetId === state.you?.id) {
    if (canEditAfterReveal) {
      showToast('✏️ O moderador liberou você para alterar o voto após revelar.');
    } else {
      showToast('🔒 O moderador bloqueou a alteração do seu voto após revelar.');
      // Se estava com uma carta em edição pós-reveal, reflete o valor já registrado
      if (state.revealed) state.selectedCard = state.votes[state.you.id] ?? null;
    }
  } else if (state.you?.isModerator) {
    showToast(`${name} ${canEditAfterReveal ? 'liberado' : 'bloqueado'} para editar após revelar`);
  }

  renderDeck();
  renderParticipants();
});

socket.on('edit-denied', ({ message }) => {
  showToast(`🔒 ${message}`);
  // Ressincroniza a carta selecionada com o voto de fato registrado
  state.selectedCard = state.votes[state.you?.id] ?? null;
  renderDeck();
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

  // Before reveal: anyone (non-spectator) votes. After reveal: só moderador ou liberados.
  const canVote = canChangeVote();

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
    const hasVoted = state.votedIds.includes(p.id) || !!state.votes[p.id];

    if (state.revealed && state.votes[p.id]) {
      card.classList.add('revealed');
      if (isOutlier) card.classList.add('outlier');
      card.textContent = state.votes[p.id];
    } else if (hasVoted) {
      card.classList.add('voted');
      card.textContent = '🥤';
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

    // Vote status indicator below name
    const status = document.createElement('div');
    status.className = 'seat-status';
    if (state.revealed) {
      status.textContent = '';
    } else if (hasVoted) {
      status.textContent = '✓ Votou';
      status.classList.add('has-voted');
    } else {
      status.textContent = 'Aguardando...';
      status.classList.add('waiting');
    }

    seat.appendChild(card);
    seat.appendChild(name);
    seat.appendChild(status);
    container.appendChild(seat);
  });

  // Update vote counter in header
  const totalVoted = voters.filter(p => state.votedIds.includes(p.id) || !!state.votes[p.id]).length;
  const totalVoters = voters.length;
  const counter = $('#vote-counter');
  if (counter) {
    counter.textContent = state.revealed ? '' : `${totalVoted}/${totalVoters} votaram`;
    counter.style.display = state.revealed ? 'none' : 'inline-block';
  }
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
    if (state.revealed && !p.isSpectator && state.editableIds.includes(p.id)) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-can-edit';
      badge.title = 'Liberado para alterar o voto após revelar';
      badge.textContent = '✏️';
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

      // Liberar/revogar alteração de voto após revelar (só faz sentido após o reveal, para jogadores)
      if (state.revealed && !p.isSpectator) {
        const canEdit = state.editableIds.includes(p.id);
        const editBtn = document.createElement('button');
        editBtn.className = 'mod-action-btn edit-permission-btn' + (canEdit ? ' active' : '');
        editBtn.title = canEdit ? 'Bloquear alteração do voto após revelar' : 'Liberar alteração do voto após revelar';
        editBtn.textContent = canEdit ? '🔓' : '🔒';
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          socket.emit('toggle-edit-permission', { targetId: p.id });
        });
        actions.appendChild(editBtn);
      }

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

  // Detailed stats panel for moderator
  renderModeratorStats(stats);
}

function renderModeratorStats(stats) {
  const panel = $('#mod-stats-panel');
  if (!panel) return;
  
  if (!state.you?.isModerator || !state.revealed) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';

  // Indices
  const indices = $('#mod-stats-indices');
  indices.innerHTML = `
    <div class="mod-stat-row">
      <div class="mod-stat-item">
        <span class="mod-stat-label">Mediana</span>
        <span class="mod-stat-value">${stats.median}</span>
        <span class="mod-stat-hint">Valor central (menos sensível a extremos)</span>
      </div>
      <div class="mod-stat-item">
        <span class="mod-stat-label">Moda</span>
        <span class="mod-stat-value">${stats.mode ? stats.mode.join(', ') : 'Sem repetição'}</span>
        <span class="mod-stat-hint">Valor mais votado pelo time</span>
      </div>
    </div>
    <div class="mod-stat-row">
      <div class="mod-stat-item">
        <span class="mod-stat-label">Desvio Padrão (σ)</span>
        <span class="mod-stat-value">${stats.stdDev}</span>
        <span class="mod-stat-hint">Dispersão dos votos em torno da média — menor = mais alinhado</span>
      </div>
      <div class="mod-stat-item">
        <span class="mod-stat-label">Coef. Variação</span>
        <span class="mod-stat-value">${stats.cv}%</span>
        <span class="mod-stat-hint">${parseFloat(stats.cv) < 30 ? '✅ Baixa dispersão' : parseFloat(stats.cv) < 60 ? '⚠️ Dispersão moderada' : '🔴 Alta dispersão'} — compara o desvio relativo à média</span>
      </div>
    </div>
    <div class="mod-stat-row">
      <div class="mod-stat-item">
        <span class="mod-stat-label">Intervalo de Confiança (95%)</span>
        <span class="mod-stat-value">${stats.confidence.low} – ${stats.confidence.high}</span>
        <span class="mod-stat-hint">Com 95% de confiança, a estimativa real está neste intervalo</span>
      </div>
      <div class="mod-stat-item">
        <span class="mod-stat-label">Índice de Concordância</span>
        <span class="mod-stat-value">${stats.agreementIndex}%</span>
        <span class="mod-stat-hint">${parseInt(stats.agreementIndex) > 70 ? '✅ Time alinhado' : parseInt(stats.agreementIndex) > 40 ? '⚠️ Alguma divergência' : '🔴 Muita divergência'} — 100% = consenso total</span>
      </div>
    </div>
  `;

  // Distribution chart
  const chartContainer = $('#mod-stats-chart');
  chartContainer.innerHTML = '';

  if (stats.distribution) {
    const entries = Object.entries(stats.distribution).sort((a, b) => {
      const numA = parseFloat(a[0]);
      const numB = parseFloat(b[0]);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return a[0].localeCompare(b[0]);
    });
    
    const maxCount = Math.max(...entries.map(e => e[1]));

    entries.forEach(([value, count]) => {
      const bar = document.createElement('div');
      bar.className = 'chart-bar-wrap';
      
      const pct = (count / maxCount) * 100;
      bar.innerHTML = `
        <div class="chart-label">${value}</div>
        <div class="chart-bar-bg">
          <div class="chart-bar-fill" style="width: ${pct}%"></div>
        </div>
        <div class="chart-count">${count} voto${count > 1 ? 's' : ''}</div>
      `;
      chartContainer.appendChild(bar);
    });
  }
}

function renderOutliers(outliers) {
  const panel = $('#outliers-panel');
  const list = $('#outliers-list');

  if (!outliers || outliers.length === 0) {
    panel.style.display = 'none';
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

// Can the current user cast/change their vote right now?
function canChangeVote() {
  if (state.you?.isSpectator) return false;
  // Before reveal: everyone votes freely. After reveal: only moderator or those liberados.
  if (!state.revealed) return true;
  return state.you?.isModerator || state.editableIds.includes(state.you?.id);
}

// === Actions ===
function selectCard(value) {
  if (state.you?.isSpectator) return;

  // After reveal, only allow if the moderator liberou este participante
  if (state.revealed && !canChangeVote()) {
    showToast('🔒 O moderador não liberou você para alterar o voto após revelar.');
    return;
  }

  // Toggle: clicking the same card deselects it
  if (state.selectedCard === value) {
    return;
  }
  
  // Select or change vote
  state.selectedCard = value;
  if (!state.votedIds.includes(state.you.id)) {
    state.votedIds.push(state.you.id);
  }
  if (!state.revealed) {
    state.votes[state.you.id] = '✓';
  } else {
    state.votes[state.you.id] = value;
  }
  socket.emit('vote', { value });

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
