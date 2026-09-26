const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co'; 
const SUPABASE_ANON_KEY = 'YOUR-PUBLIC-ANON-KEY';           
const EDGE_FUNCTION_CHAT = 'ai-chat';

const supabaseClient = (window.supabase && SUPABASE_URL.startsWith('https://') && !SUPABASE_URL.includes('YOUR-PROJECT'))
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

if (!supabaseClient) {
  console.warn(
    'Polymathal: Supabase is not configured yet (see SUPABASE_URL / SUPABASE_ANON_KEY in app.js). ' +
    'Running against local sample data so the interface can still be reviewed.'
  );
}



const state = {
  session: null,
  profile: null,          
  interests: [],        
  edges: [],              
  suggestions: [],
  diaryEntries: [],
  chatMessages: [],
  selectedInterestId: null,
  currentView: 'map',
  usingLocalSampleData: !supabaseClient,
};



const $ = (sel, root = document) => root.querySelector(sel);
const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function showLoader(show) {
  $('#global-loader').setAttribute('data-hidden', show ? 'false' : 'true');
}

function toast(message, kind = 'info') {
  const region = $('#toast-region');
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.kind = kind;
  el.textContent = message;
  region.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function showFieldError(scope, message) {
  const el = $(`[data-error-for="${scope}"]`);
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

function showFieldSuccess(scope, message) {
  const el = $(`[data-success-for="${scope}"]`);
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

function uid() {
  return 'id-' + Math.random().toString(36).slice(2, 10);
}

function friendlyError(err) {
  if (!err) return 'Something went wrong. Try again.';
  const msg = typeof err === 'string' ? err : (err.message || '');
  if (/invalid login credentials/i.test(msg)) return 'That email and password do not match.';
  if (/already registered/i.test(msg)) return 'An account with that email already exists.';
  if (/rate limit/i.test(msg)) return 'Too many attempts. Wait a moment and try again.';
  return msg || 'Something went wrong. Try again.';
}



function setAuthFormVisible(name) {
  ['signin', 'signup', 'reset', 'new-password'].forEach((n) => {
    $(`#form-${n}`).hidden = n !== name;
  });
}

$all('[data-goto]').forEach((btn) => {
  btn.addEventListener('click', () => setAuthFormVisible(btn.dataset.goto));
});

$('#form-signin').addEventListener('submit', async (e) => {
  e.preventDefault();
  showFieldError('signin', '');
  const form = e.target;
  const email = form.email.value.trim();
  const password = form.password.value;

  if (!supabaseClient) {
    return showFieldError('signin', 'Backend is not configured yet — see the SUPABASE_URL constant in app.js.');
  }

  showLoader(true);
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  showLoader(false);

  if (error) return showFieldError('signin', friendlyError(error));
  await onSignedIn(data.session);
});

$('#form-signup').addEventListener('submit', async (e) => {
  e.preventDefault();
  showFieldError('signup', '');
  const form = e.target;
  const username = form.username.value.trim().toLowerCase();
  const email = form.email.value.trim();
  const password = form.password.value;

  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return showFieldError('signup', 'Usernames can only use lowercase letters, numbers and underscores.');
  }
  if (!supabaseClient) {
    return showFieldError('signup', 'Backend is not configured yet — see the SUPABASE_URL constant in app.js.');
  }

  showLoader(true);
 
  const { data: existing } = await supabaseClient
    .from('profiles')
    .select('username')
    .eq('username', username)
    .maybeSingle();

  if (existing) {
    showLoader(false);
    return showFieldError('signup', 'That username is already taken.');
  }

  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: { data: { username } }, 
  });
  showLoader(false);

  if (error) return showFieldError('signup', friendlyError(error));

  if (!data.session) {
   
    toast('Check your email to confirm your account.', 'success');
    setAuthFormVisible('signin');
    return;
  }
  await onSignedIn(data.session);
});

$('#form-reset').addEventListener('submit', async (e) => {
  e.preventDefault();
  showFieldError('reset', '');
  showFieldSuccess('reset', '');
  const email = e.target.email.value.trim();

  if (!supabaseClient) {
    return showFieldError('reset', 'Backend is not configured yet — see the SUPABASE_URL constant in app.js.');
  }

  showLoader(true);
  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });
  showLoader(false);

  if (error) return showFieldError('reset', friendlyError(error));
  showFieldSuccess('reset', 'If that email has an account, a reset link is on its way.');
});

$('#form-new-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  showFieldError('new-password', '');
  const password = e.target.password.value;

  showLoader(true);
  const { error } = await supabaseClient.auth.updateUser({ password });
  showLoader(false);

  if (error) return showFieldError('new-password', friendlyError(error));
  toast('Password updated. Signed in.', 'success');
  const { data } = await supabaseClient.auth.getSession();
  await onSignedIn(data.session);
});

$('#btn-sign-out').addEventListener('click', async () => {
  if (supabaseClient) await supabaseClient.auth.signOut();
  state.session = null;
  state.profile = null;
  $('#app-view').hidden = true;
  $('#auth-view').hidden = false;
  setAuthFormVisible('signin');
});

async function onSignedIn(session) {
  state.session = session;
  await loadProfile();
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  $('#current-username').textContent = state.profile ? '@' + state.profile.username : '';
  await Promise.all([loadInterests(), loadSuggestions(), loadDiary()]);
  renderMap();
  renderSuggestionBadge();
}

async function loadProfile() {
  if (!supabaseClient) {
    state.profile = { id: 'local-user', username: 'you', broad_status_public: false };
    return;
  }
  const { data, error } = await supabaseClient
    .from('profiles')
    .select('id, username, broad_status_public')
    .eq('id', state.session.user.id)
    .single();
  if (error) {
    toast('Could not load your profile.', 'error');
    return;
  }
  state.profile = data;
}



const VIEW_TITLES = {
  map: 'Interest map',
  chat: 'Chat',
  diary: 'Diary',
  search: 'Find people',
  settings: 'Settings',
};

function goToView(name) {
  state.currentView = name;
  $all('.view').forEach((v) => { v.hidden = true; });
  $(`#view-${name}`).hidden = false;
  $('#view-title').textContent = VIEW_TITLES[name] || '';
  $all('.nav-item[data-view]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === name);
  });

  if (name === 'settings') populateSettingsForm();
}

$all('.nav-item[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => goToView(btn.dataset.view));
});
$all('[data-goto-view]').forEach((btn) => {
  btn.addEventListener('click', () => goToView(btn.dataset.gotoView));
});



const MAP_PADDING = 60;
const NODE_RADIUS = 26;

const STATUS_COLORS = {
  curious: '#7C93F5',
  learning: '#E3A868',
  comfortable: '#7FCBA4',
  dormant: '#707A8C',
};

async function loadInterests() {
  if (!supabaseClient) {
    state.interests = sampleInterests();
    state.edges = sampleEdges();
    return;
  }
  const [{ data: interests, error: interestsErr }, { data: edges, error: edgesErr }] = await Promise.all([
    supabaseClient.from('interests').select('*').eq('owner_id', state.session.user.id),
    supabaseClient.from('interest_edges').select('*').eq('owner_id', state.session.user.id),
  ]);
  if (interestsErr || edgesErr) {
    toast('Could not load your interest map.', 'error');
    return;
  }
  state.interests = interests || [];
  state.edges = edges || [];
  layoutMissingPositions();
}

function layoutMissingPositions() {
  const needsLayout = state.interests.filter((n) => n.x == null || n.y == null);
  if (!needsLayout.length) return;
  const cx = 420, cy = 280, r = 180;
  needsLayout.forEach((node, i) => {
    const angle = (i / Math.max(needsLayout.length, 1)) * Math.PI * 2;
    node.x = cx + r * Math.cos(angle);
    node.y = cy + r * Math.sin(angle);
  });
}

function renderMap(targetSvg, nodesOverride, edgesOverride, readOnly = false) {
  const svg = targetSvg || $('#map-svg');
  const nodes = nodesOverride || state.interests;
  const edges = edgesOverride || state.edges;

  svg.innerHTML = '';
  const emptyState = svg === $('#map-svg') ? $('#map-empty') : null;

  if (!nodes.length) {
    if (emptyState) emptyState.hidden = false;
    return;
  }
  if (emptyState) emptyState.hidden = true;

  const bounds = svg.getBoundingClientRect();
  const width = Math.max(bounds.width, 320);
  const height = Math.max(bounds.height, 320);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  
  const xs = nodes.map((n) => n.x || 0);
  const ys = nodes.map((n) => n.y || 0);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);

  const project = (node) => ({
    x: MAP_PADDING + ((node.x - minX) / spanX) * (width - MAP_PADDING * 2),
    y: MAP_PADDING + ((node.y - minY) / spanY) * (height - MAP_PADDING * 2),
  });

  const positioned = new Map(nodes.map((n) => [n.id, project(n)]));

  const edgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  edges.forEach((edge) => {
    const a = positioned.get(edge.source_id);
    const b = positioned.get(edge.target_id);
    if (!a || !b) return;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    line.setAttribute('class', 'edge-line');
    edgeGroup.appendChild(line);
  });
  svg.appendChild(edgeGroup);

  const nodeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  nodes.forEach((node) => {
    const pos = positioned.get(node.id);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'node-group' +
      (node.id === state.selectedInterestId ? ' is-selected' : '') +
      (node.is_public ? ' is-public' : ''));
    g.setAttribute('transform', `translate(${pos.x}, ${pos.y})`);
    g.dataset.id = node.id;

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', NODE_RADIUS);
    circle.setAttribute('class', 'node-circle');
    g.appendChild(circle);

    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('r', 4);
    dot.setAttribute('cx', NODE_RADIUS - 6);
    dot.setAttribute('cy', -(NODE_RADIUS - 6));
    dot.setAttribute('fill', STATUS_COLORS[node.status] || STATUS_COLORS.curious);
    dot.setAttribute('class', 'node-status-dot');
    g.appendChild(dot);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('class', 'node-label');
    label.setAttribute('y', NODE_RADIUS + 16);
    label.textContent = truncateLabel(node.name);
    g.appendChild(label);

    if (!readOnly) {
      g.addEventListener('click', () => openInspector(node.id));
      makeDraggable(g, node, svg, () => renderMap(svg, nodes, edges, readOnly));
    }

    nodeGroup.appendChild(g);
  });
  svg.appendChild(nodeGroup);
}

function truncateLabel(name) {
  return name.length > 16 ? name.slice(0, 15) + '…' : name;
}

function makeDraggable(g, node, svg, onMove) {
  let dragging = false;
  let start = null;

  g.addEventListener('pointerdown', (e) => {
    dragging = true;
    start = { px: e.clientX, py: e.clientY, x: node.x, y: node.y };
    g.setPointerCapture(e.pointerId);
  });
  g.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const scaleX = svg.viewBox.baseVal.width / svg.getBoundingClientRect().width;
    const scaleY = svg.viewBox.baseVal.height / svg.getBoundingClientRect().height;
    node.x = start.x + (e.clientX - start.px) * scaleX;
    node.y = start.y + (e.clientY - start.py) * scaleY;
    onMove();
  });
  const finish = async (e) => {
    if (!dragging) return;
    dragging = false;
    if (supabaseClient) {
      await supabaseClient.from('interests').update({ x: node.x, y: node.y }).eq('id', node.id);
    }
  };
  g.addEventListener('pointerup', finish);
  g.addEventListener('pointercancel', finish);
}

$('#filter-public-only').addEventListener('change', (e) => {
  const nodes = e.target.checked ? state.interests.filter((n) => n.is_public) : state.interests;
  const ids = new Set(nodes.map((n) => n.id));
  const edges = state.edges.filter((edge) => ids.has(edge.source_id) && ids.has(edge.target_id));
  renderMap($('#map-svg'), nodes, edges);
});

window.addEventListener('resize', () => {
  if (state.currentView === 'map') renderMap();
});



function openInspector(interestId) {
  state.selectedInterestId = interestId;
  const node = state.interests.find((n) => n.id === interestId);
  if (!node) return;

  $('#inspector-title').textContent = node.name;
  $('#inspector-category').textContent = node.category || 'Uncategorized';
  $('#inspector-status').value = node.status || 'curious';
  $('#inspector-public').checked = !!node.is_public;
  $('#inspector-notes').value = node.notes || '';

  const connections = state.edges
    .filter((e) => e.source_id === node.id || e.target_id === node.id)
    .map((e) => (e.source_id === node.id ? e.target_id : e.source_id))
    .map((id) => state.interests.find((n) => n.id === id))
    .filter(Boolean);

  const list = $('#inspector-connections-list');
  list.innerHTML = '';
  if (!connections.length) {
    const li = document.createElement('li');
    li.textContent = 'No connections yet';
    list.appendChild(li);
  } else {
    connections.forEach((c) => {
      const li = document.createElement('li');
      li.textContent = c.name;
      list.appendChild(li);
    });
  }

  $('#node-inspector').hidden = false;
  renderMap();
}

$('#btn-close-inspector').addEventListener('click', () => {
  state.selectedInterestId = null;
  $('#node-inspector').hidden = true;
  renderMap();
});

$('#btn-save-interest').addEventListener('click', async () => {
  const node = state.interests.find((n) => n.id === state.selectedInterestId);
  if (!node) return;

  node.status = $('#inspector-status').value;
  node.is_public = $('#inspector-public').checked;
  node.notes = $('#inspector-notes').value;

  if (supabaseClient) {
    showLoader(true);
    const { error } = await supabaseClient
      .from('interests')
      .update({ status: node.status, is_public: node.is_public, notes: node.notes })
      .eq('id', node.id);
    showLoader(false);
    if (error) return toast('Could not save changes.', 'error');
  }
  toast('Saved.', 'success');
  renderMap();
});

$('#btn-delete-interest').addEventListener('click', async () => {
  const node = state.interests.find((n) => n.id === state.selectedInterestId);
  if (!node) return;
  if (!confirm(`Remove "${node.name}" from your map? This cannot be undone.`)) return;

  if (supabaseClient) {
    showLoader(true);
    const { error } = await supabaseClient.from('interests').delete().eq('id', node.id);
    showLoader(false);
    if (error) return toast('Could not remove interest.', 'error');
  }
  state.interests = state.interests.filter((n) => n.id !== node.id);
  state.edges = state.edges.filter((e) => e.source_id !== node.id && e.target_id !== node.id);
  state.selectedInterestId = null;
  $('#node-inspector').hidden = true;
  renderMap();
});



async function loadSuggestions() {
  if (!supabaseClient) {
    state.suggestions = [];
    return;
  }
  const { data, error } = await supabaseClient
    .from('interest_suggestions')
    .select('*')
    .eq('owner_id', state.session.user.id)
    .eq('status', 'pending');
  if (error) return;
  state.suggestions = data || [];
}

function renderSuggestionBadge() {
  const badge = $('#suggestion-count');
  const count = state.suggestions.length;
  badge.hidden = count === 0;
  badge.textContent = String(count);
}

function renderSuggestionsModal() {
  const list = $('#suggestions-list');
  list.innerHTML = '';
  if (!state.suggestions.length) {
    const li = document.createElement('li');
    li.className = 'suggestion-row';
    li.textContent = 'Nothing waiting for review.';
    list.appendChild(li);
    return;
  }
  state.suggestions.forEach((s) => {
    const li = document.createElement('li');
    li.className = 'suggestion-row';
    li.innerHTML = `
      <div class="suggestion-info">
        <span class="suggestion-name"></span>
        <span class="suggestion-reason"></span>
      </div>
      <div class="suggestion-actions">
        <button class="btn btn-secondary" data-action="approve">Add</button>
        <button class="btn btn-ghost" data-action="reject">Dismiss</button>
      </div>
    `;
    li.querySelector('.suggestion-name').textContent = s.name;
    li.querySelector('.suggestion-reason').textContent = s.reason || 'Noticed in a recent conversation';
    li.querySelector('[data-action="approve"]').addEventListener('click', () => resolveSuggestion(s.id, 'approved'));
    li.querySelector('[data-action="reject"]').addEventListener('click', () => resolveSuggestion(s.id, 'rejected'));
    list.appendChild(li);
  });
}

async function resolveSuggestion(suggestionId, decision) {
  const suggestion = state.suggestions.find((s) => s.id === suggestionId);
  if (!suggestion) return;

  showLoader(true);
  if (decision === 'approved') {
    if (supabaseClient) {
      const { data, error } = await supabaseClient
        .from('interests')
        .insert({
          owner_id: state.session.user.id,
          name: suggestion.name,
          category: suggestion.category,
          status: 'curious',
          is_public: false,
        })
        .select()
        .single();
      if (!error && data) {
        state.interests.push(data);
        if (suggestion.related_interest_id) {
          const { data: edge } = await supabaseClient
            .from('interest_edges')
            .insert({ owner_id: state.session.user.id, source_id: suggestion.related_interest_id, target_id: data.id })
            .select()
            .single();
          if (edge) state.edges.push(edge);
        }
      }
    } else {
      const newNode = { id: uid(), name: suggestion.name, category: suggestion.category, status: 'curious', is_public: false, x: 420 + Math.random() * 80, y: 280 + Math.random() * 80 };
      state.interests.push(newNode);
    }
  }

  if (supabaseClient) {
    await supabaseClient.from('interest_suggestions').update({ status: decision }).eq('id', suggestionId);
  }
  state.suggestions = state.suggestions.filter((s) => s.id !== suggestionId);
  showLoader(false);

  renderSuggestionBadge();
  renderSuggestionsModal();
  renderMap();
  toast(decision === 'approved' ? 'Added to your map.' : 'Dismissed.', 'success');
}

$('#btn-review-suggestions').addEventListener('click', () => {
  renderSuggestionsModal();
  $('#suggestions-modal').hidden = false;
});
$('#btn-close-suggestions').addEventListener('click', () => { $('#suggestions-modal').hidden = true; });



$('#btn-add-interest').addEventListener('click', () => {
  $('#add-interest-name').value = '';
  $('#add-interest-category').value = '';
  showFieldError('add-interest', '');
  $('#add-interest-modal').hidden = false;
});
$('#btn-close-add-interest').addEventListener('click', () => { $('#add-interest-modal').hidden = true; });

$('#btn-confirm-add-interest').addEventListener('click', async () => {
  const name = $('#add-interest-name').value.trim();
  const category = $('#add-interest-category').value.trim();
  if (!name) return showFieldError('add-interest', 'Give this interest a name.');

  showLoader(true);
  let node;
  if (supabaseClient) {
    const { data, error } = await supabaseClient
      .from('interests')
      .insert({ owner_id: state.session.user.id, name, category, status: 'curious', is_public: false })
      .select()
      .single();
    showLoader(false);
    if (error) return showFieldError('add-interest', 'Could not add this interest.');
    node = data;
  } else {
    showLoader(false);
    node = { id: uid(), name, category, status: 'curious', is_public: false, x: 420 + (Math.random() - 0.5) * 200, y: 280 + (Math.random() - 0.5) * 200 };
  }
  state.interests.push(node);
  $('#add-interest-modal').hidden = true;
  renderMap();
  toast('Added to your map.', 'success');
});



function renderChatLog() {
  const log = $('#chat-log');
  const empty = $('#chat-empty');
  log.querySelectorAll('.chat-bubble').forEach((el) => el.remove());
  empty.hidden = state.chatMessages.length > 0;

  state.chatMessages.forEach((m) => {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble from-${m.role === 'user' ? 'user' : 'assistant'}${m.pending ? ' is-pending' : ''}`;
    bubble.textContent = m.content;
    log.appendChild(bubble);
  });
  log.scrollTop = log.scrollHeight;
}

const chatInput = $('#chat-input');
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
});
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});
$('#btn-send-chat').addEventListener('click', sendChatMessage);

async function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  chatInput.style.height = 'auto';

  state.chatMessages.push({ role: 'user', content: text });
  renderChatLog();

  if (supabaseClient) {
    await supabaseClient.from('conversation_messages').insert({ owner_id: state.session.user.id, role: 'user', content: text });
  }

  const pending = { role: 'assistant', content: 'Thinking…', pending: true };
  state.chatMessages.push(pending);
  renderChatLog();

  try {
    let replyText;
    let newSuggestions = [];

    if (supabaseClient) {
     
      const { data, error } = await supabaseClient.functions.invoke(EDGE_FUNCTION_CHAT, {
        body: { message: text },
      });
      if (error) throw error;
      replyText = data.reply;
      newSuggestions = data.suggestions || [];
    } else {
    
      replyText = "That's noted. Once this is connected to Supabase, this reply will come from your Edge Function.";
    }

    pending.content = replyText;
    pending.pending = false;
    renderChatLog();

    if (supabaseClient) {
      await supabaseClient.from('conversation_messages').insert({ owner_id: state.session.user.id, role: 'assistant', content: replyText });
    }

    if (newSuggestions.length) {
      state.suggestions.push(...newSuggestions);
      renderSuggestionBadge();
      toast('The assistant noticed something for your map. Review it when ready.', 'info');
    }
  } catch (err) {
    pending.content = 'Something went wrong reaching the assistant.';
    pending.pending = false;
    renderChatLog();
  }
}



async function loadDiary() {
  if (!supabaseClient) {
    state.diaryEntries = [];
    return;
  }
  const { data, error } = await supabaseClient
    .from('diary_entries')
    .select('*')
    .eq('owner_id', state.session.user.id)
    .order('created_at', { ascending: false });
  if (error) return;
  state.diaryEntries = data || [];
  renderDiary();
}

function renderDiary() {
  const list = $('#diary-list');
  const empty = $('#diary-empty');
  list.querySelectorAll('.diary-entry').forEach((el) => el.remove());
  empty.hidden = state.diaryEntries.length > 0;

  state.diaryEntries.forEach((entry) => {
    const el = document.createElement('div');
    el.className = 'diary-entry';
    const date = new Date(entry.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    el.innerHTML = `<span class="diary-entry-date"></span><div class="diary-entry-body"></div>`;
    el.querySelector('.diary-entry-date').textContent = date;
    el.querySelector('.diary-entry-body').textContent = entry.body;
    list.appendChild(el);
  });
}



$('#btn-search-username').addEventListener('click', searchUsernames);
$('#search-username').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchUsernames(); });

async function searchUsernames() {
  const query = $('#search-username').value.trim().toLowerCase();
  const results = $('#search-results');
  results.innerHTML = '';
  if (!query) return;

  if (!supabaseClient) {
    results.innerHTML = '<p class="empty-body">Connect Supabase to search real users.</p>';
    return;
  }

  showLoader(true);
 
  const { data, error } = await supabaseClient
    .from('public_profiles')
    .select('username')
    .ilike('username', `%${query}%`)
    .limit(10);
  showLoader(false);

  if (error || !data || !data.length) {
    results.innerHTML = '<p class="empty-body">No matching users.</p>';
    return;
  }

  data.forEach((row) => {
    const el = document.createElement('div');
    el.className = 'search-result-row';
    el.innerHTML = `<span>@${row.username}</span>`;
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary';
    btn.textContent = 'View profile';
    btn.addEventListener('click', () => openPublicProfile(row.username));
    el.appendChild(btn);
    results.appendChild(el);
  });
}

async function openPublicProfile(username) {
  showLoader(true);
  const { data: profile, error: profileErr } = await supabaseClient
    .from('public_profiles')
    .select('username, broad_status_public')
    .eq('username', username)
    .single();

  const { data: interests, error: interestsErr } = await supabaseClient
    .from('interests')
    .select('id, name, category, status, x, y, owner_id')
    .eq('is_public', true)
    .eq('owner_id', profile ? profile.owner_id : null);
  showLoader(false);

  if (profileErr || !profile) return toast('Could not load that profile.', 'error');

  $('#public-profile-username').textContent = '@' + profile.username;
  $('#public-profile-status').textContent = profile.broad_status_public ? 'Actively exploring several interests' : '';

  const svg = $('#public-map-svg');
  const empty = $('#public-profile-empty');
  if (!interestsErr && interests && interests.length) {
    empty.hidden = true;
    renderMap(svg, interests, [], true);
  } else {
    empty.hidden = false;
    svg.innerHTML = '';
  }

  $('#search-results').parentElement.querySelectorAll('.search-bar, .search-results').forEach((el) => el.hidden = true);
  $('#public-profile').hidden = false;
}

$('#btn-back-to-search').addEventListener('click', () => {
  $('#public-profile').hidden = true;
  $all('.search-bar, .search-results').forEach((el) => el.hidden = false);
});



function populateSettingsForm() {
  if (!state.profile) return;
  $('#settings-username').value = state.profile.username || '';
  $('#settings-email').value = state.session ? state.session.user.email : '';
  $('#settings-broad-status-public').checked = !!state.profile.broad_status_public;
}

$('#btn-save-profile').addEventListener('click', async () => {
  const username = $('#settings-username').value.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return toast('Usernames can only use lowercase letters, numbers and underscores.', 'error');
  }
  showLoader(true);
  if (supabaseClient) {
    const { error } = await supabaseClient
      .from('profiles')
      .update({ username, broad_status_public: $('#settings-broad-status-public').checked })
      .eq('id', state.session.user.id);
    showLoader(false);
    if (error) return toast('Could not save. That username may already be taken.', 'error');
  } else {
    showLoader(false);
  }
  state.profile.username = username;
  state.profile.broad_status_public = $('#settings-broad-status-public').checked;
  $('#current-username').textContent = '@' + username;
  showFieldSuccess('settings-profile', 'Saved.');
  toast('Profile updated.', 'success');
});

$('#settings-broad-status-public').addEventListener('change', async (e) => {
  if (!supabaseClient || !state.profile) return;
  await supabaseClient.from('profiles').update({ broad_status_public: e.target.checked }).eq('id', state.session.user.id);
});

$('#btn-change-password').addEventListener('click', async () => {
  const password = $('#settings-new-password').value;
  if (password.length < 8) return toast('Password needs at least 8 characters.', 'error');

  showLoader(true);
  if (supabaseClient) {
    const { error } = await supabaseClient.auth.updateUser({ password });
    showLoader(false);
    if (error) return toast('Could not update password.', 'error');
  } else {
    showLoader(false);
  }
  $('#settings-new-password').value = '';
  showFieldSuccess('settings-password', 'Password updated.');
  toast('Password updated.', 'success');
});



function sampleInterests() {
  return [
    { id: 'n1', name: 'Byzantine history', category: 'history', status: 'learning', is_public: true, notes: '', x: 300, y: 180 },
    { id: 'n2', name: 'Mosaic art', category: 'art', status: 'curious', is_public: true, notes: '', x: 500, y: 160 },
    { id: 'n3', name: 'Cartography', category: 'craft', status: 'comfortable', is_public: false, notes: '', x: 420, y: 340 },
    { id: 'n4', name: 'Old trade routes', category: 'history', status: 'curious', is_public: false, notes: '', x: 620, y: 300 },
  ];
}
function sampleEdges() {
  return [
    { source_id: 'n1', target_id: 'n2' },
    { source_id: 'n1', target_id: 'n3' },
    { source_id: 'n3', target_id: 'n4' },
  ];
}



async function bootstrap() {
  showLoader(true);

  if (supabaseClient) {
    const { data } = await supabaseClient.auth.getSession();
    if (data.session) {
      await onSignedIn(data.session);
    }
    supabaseClient.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        $('#auth-view').hidden = false;
        $('#app-view').hidden = true;
        setAuthFormVisible('new-password');
      }
    });
  }

  showLoader(false);
}

bootstrap();
