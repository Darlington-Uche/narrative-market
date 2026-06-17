/* ═══════════════════════════════════════════════════════════
   NARRATIVE MARKET — app.js
═══════════════════════════════════════════════════════════ */

const API = 'http://localhost:3001';

/* ══ STATE ══ */
let state = {
  wallet: null,        // { publicKey, privateKey }
  profile: { name: '', pic: '' }, // { name, pic: dataURL }
  solBalance: 0,
  narratives: [],      // all narratives from DB
  currentNarrative: null,
  likedIds: new Set(JSON.parse(localStorage.getItem('liked') || '[]')),
  chartInstance: null,
  tradeTab: 'buy',
  userTokenBalance: 0,  // current narrative's token balance for sell slider
  profilePicTempBuy: '', // staged base64 during wallet creation
  profilePicTempEdit: '', // staged base64 during edit profile
};

const PROFILES_KEY = 'nm_profiles'; // localStorage cache of {pubkey: {name,pic}}

function getProfilesCache() {
  try { return JSON.parse(localStorage.getItem(PROFILES_KEY) || '{}'); } catch(_) { return {}; }
}
function setProfileCache(pubkey, profile) {
  const all = getProfilesCache();
  all[pubkey] = profile;
  localStorage.setItem(PROFILES_KEY, JSON.stringify(all));
}
function getProfile(pubkey) {
  if (state.wallet && pubkey === state.wallet.publicKey && state.profile) return state.profile;
  const all = getProfilesCache();
  return all[pubkey] || null;
}

/* ══════════════════════════════════════════════
   INIT
══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('nw');
  if (saved) {
    try {
      state.wallet = JSON.parse(saved);
      const cached = getProfilesCache()[state.wallet.publicKey];
      if (cached) state.profile = cached;
      enterApp();
    } catch(_) {}
  }
  attachGlobalClickFlash();
});

/* ══ BLUE CLICK FLASH — attaches to every button/clickable on the page ══ */
function attachGlobalClickFlash() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button, .feed-card, .market-book, .holding-row, .glass-nav-link, .bomb-btn, .bomb-btn-large, .copy-btn, .my-profile-btn');
    if (!el) return;
    el.classList.remove('flash-click');
    // restart animation
    void el.offsetWidth;
    el.classList.add('flash-click');
    setTimeout(() => el.classList.remove('flash-click'), 460);
  }, true);
}

/* ══════════════════════════════════════════════
   WALLET
══════════════════════════════════════════════ */
async function createWallet() {
  try {
    showToast('creating wallet...');
    const res = await fetch(`${API}/api/create-wallet`, { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state.wallet = { publicKey: data.publicKey, privateKey: data.privateKey };
    localStorage.setItem('nw', JSON.stringify(state.wallet));
    document.getElementById('walletAddrDisplay').textContent = data.publicKey;
    document.getElementById('walletInfo').classList.remove('hidden');
    showToast('wallet created');
  } catch(e) {
    showToast('error: ' + e.message);
  }
}

function showImport() {
  document.getElementById('importForm').classList.toggle('hidden');
}

async function importWallet() {
  const key = document.getElementById('importKey').value.trim();
  if (!key) return showToast('paste a private key first');
  try {
    const res = await fetch(`${API}/api/import-wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ privateKey: key })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state.wallet = { publicKey: data.publicKey, privateKey: data.privateKey };
    localStorage.setItem('nw', JSON.stringify(state.wallet));
    document.getElementById('walletAddrDisplay').textContent = data.publicKey;
    document.getElementById('walletInfo').classList.remove('hidden');
    showToast('wallet imported');
  } catch(e) {
    showToast('error: ' + e.message);
  }
}

async function enterApp() {
  document.getElementById('walletModal').classList.remove('active');
  document.getElementById('walletModal').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  // Save profile from the setup fields if present (first-time flow)
  const nameInput = document.getElementById('profileNameInput');
  if (nameInput && nameInput.value.trim()) {
    state.profile = {
      name: nameInput.value.trim().slice(0, 20),
      pic: state.profilePicTempBuy || (state.profile?.pic || ''),
    };
    setProfileCache(state.wallet.publicKey, state.profile);
    pushProfileToServer();
  } else if (!state.profile?.name) {
    state.profile = state.profile || { name: '', pic: '' };
  }

  const pub = state.wallet.publicKey;
  document.getElementById('navWalletShort').textContent = pub.slice(0,4) + '…' + pub.slice(-4);
  document.getElementById('holdingsAddr').textContent = pub;

  updateMyProfileBtn();
  refreshBalance();
  loadFeed();
  setInterval(refreshBalance, 30000);
}

async function pushProfileToServer() {
  if (!state.wallet) return;
  try {
    await fetch(`${API}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pubkey: state.wallet.publicKey,
        name: state.profile?.name || '',
        pic:  state.profile?.pic  || '',
      })
    });
  } catch(_) {}
}

function updateMyProfileBtn() {
  const btn = document.getElementById('myProfileBtn');
  if (!btn) return;
  if (state.profile?.pic) {
    btn.style.backgroundImage = `url(${state.profile.pic})`;
  } else {
    btn.style.backgroundImage = 'none';
  }
}

/* ── Resize/compress image to keep payload small (max ~300px, jpeg q0.7) ── */
function compressImage(dataUrl, maxSize = 300, quality = 0.7) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxSize) { height *= maxSize / width; width = maxSize; }
      else if (height > maxSize) { width *= maxSize / height; height = maxSize; }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/* ── Profile pic select (initial wallet setup) ── */
function handleProfilePicSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const compressed = await compressImage(ev.target.result);
    state.profilePicTempBuy = compressed;
    const img = document.getElementById('profilePicPreview');
    img.src = compressed;
    img.classList.remove('hidden');
    document.getElementById('profilePicPlaceholder').classList.add('hidden');
  };
  reader.readAsDataURL(file);
}

/* ── Edit Profile modal ── */
function openEditProfile() {
  document.getElementById('editProfileModal').classList.remove('hidden');
  document.getElementById('editProfileNameInput').value = state.profile?.name || '';
  const img = document.getElementById('editProfilePicPreview');
  const ph  = document.getElementById('editProfilePicPlaceholder');
  if (state.profile?.pic) {
    img.src = state.profile.pic;
    img.classList.remove('hidden');
    ph.classList.add('hidden');
  } else {
    img.classList.add('hidden');
    ph.classList.remove('hidden');
  }
  state.profilePicTempEdit = state.profile?.pic || '';
}
function closeEditProfile() {
  document.getElementById('editProfileModal').classList.add('hidden');
}
function handleEditProfilePicSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const compressed = await compressImage(ev.target.result);
    state.profilePicTempEdit = compressed;
    const img = document.getElementById('editProfilePicPreview');
    img.src = compressed;
    img.classList.remove('hidden');
    document.getElementById('editProfilePicPlaceholder').classList.add('hidden');
  };
  reader.readAsDataURL(file);
}
async function saveProfile() {
  const name = document.getElementById('editProfileNameInput').value.trim().slice(0, 20);
  state.profile = { name, pic: state.profilePicTempEdit || '' };
  setProfileCache(state.wallet.publicKey, state.profile);
  updateMyProfileBtn();
  closeEditProfile();
  showToast('saving profile...');
  try {
    const res = await fetch(`${API}/api/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubkey: state.wallet.publicKey, name, pic: state.profile.pic })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    showToast('profile saved');
  } catch(e) {
    showToast('error: ' + e.message);
  }
  loadFeed(); // refresh so own posts show new name/pic
}

async function refreshBalance() {
  if (!state.wallet) return;
  try {
    const res = await fetch(`${API}/api/balance/${state.wallet.publicKey}`);
    const data = await res.json();
    if (data.error) return;
    state.solBalance = data.solBalance;
    document.getElementById('navSolBal').textContent = data.solBalance.toFixed(3) + ' SOL';
    document.getElementById('holdingsSol').textContent = data.solBalance.toFixed(4) + ' SOL';
    document.getElementById('holdingsUsd').textContent = '$' + data.totalUsdValue.toFixed(2);
    renderHoldings(data.tokens || []);
  } catch(_) {}
}

function copyAddr() {
  navigator.clipboard.writeText(state.wallet.publicKey).then(() => showToast('address copied'));
}

/* ══════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════ */
function switchPage(page, el) {
  document.querySelectorAll('.page').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });
  document.querySelectorAll('.glass-nav-link').forEach(l => l.classList.remove('active'));
  const target = document.getElementById('page-' + page);
  if (target) { target.classList.add('active'); target.classList.remove('hidden'); }
  if (el) el.classList.add('active');

  if (page === 'market') loadMarket();
  if (page === 'holdings') {
    if (!state.narratives.length) loadFeed();
    refreshBalance();
  }
}

/* ══════════════════════════════════════════════
   FEED
══════════════════════════════════════════════ */
async function loadFeed() {
  try {
    const res = await fetch(`${API}/api/narratives`);
    const data = await res.json();
    state.narratives = data.narratives || [];
    renderFeed(state.narratives);
  } catch(e) {
    document.getElementById('feedList').innerHTML = '<div class="feed-loading">could not load narratives.</div>';
  }
}

function renderFeed(narratives) {
  const list = document.getElementById('feedList');
  if (!narratives.length) {
    list.innerHTML = '<div class="feed-loading">no narratives yet. write the first one.</div>';
    return;
  }
  list.innerHTML = '';
  narratives.forEach(n => {
    const card = buildFeedCard(n);
    list.appendChild(card);
  });
}

function buildFeedCard(n) {
  const div = document.createElement('div');
  div.className = 'feed-card';
  div.dataset.id = n.id;

  const liked = state.likedIds.has(n.id);
  const avatar = avatarHTML(n.authorKey, 32, n);
  const anon = anonLabel(n.authorKey);
  const name = displayName(n.authorKey, n);
  const timeStr = timeAgo(n.createdAt);
  const inMarket = n.inMarket;
  const likes = n.likes || 0;

  div.innerHTML = `
    <div class="feed-card-header">
      ${avatar}
      <div class="feed-meta">
        ${name ? `<span class="feed-display-name">${escHtml(name)}</span>` : ''}
        <span class="feed-anon">${anon}</span>
        <span class="feed-time">${timeStr}</span>
      </div>
    </div>
    <div class="feed-text-wrap">
      <div class="feed-text">${escHtml(n.text)}</div>
      <div class="feed-blur-overlay"></div>
    </div>
    <div class="feed-card-footer">
      <span class="feed-in-market ${inMarket ? 'listed' : ''}">${inMarket ? '◆ IN MARKET' : '◇ not listed'}</span>
      <div class="bomb-row">
        <button class="bomb-btn ${liked ? 'liked' : ''}" data-id="${n.id}" onclick="toggleLikeFeed('${n.id}', event)">
          <svg class="bomb-svg" width="18" height="18" viewBox="0 0 32 32" fill="currentColor">
            <circle cx="14" cy="18" r="10"/>
            <path d="M14 8 Q20 2 26 6 Q28 10 24 12" stroke="currentColor" stroke-width="2" fill="none"/>
            <circle cx="26" cy="5" r="2" fill="#ff3b00"/>
          </svg>
          <span class="like-count-${n.id}">${likes}</span>
        </button>
      </div>
    </div>
  `;

  // Single click on collapsed text → expand. Single click on expanded text → contract.
  // Double click anywhere on the card → open full narrative panel.
  const textWrap = div.querySelector('.feed-text-wrap');
  textWrap.addEventListener('click', (e) => {
    e.stopPropagation();
    div.classList.toggle('expanded');
  });

  div.addEventListener('dblclick', (e) => {
    if (e.target.closest('.bomb-btn')) return;
    openNarrativePanel(n);
  });

  return div;
}

async function toggleLikeFeed(id, e) {
  if (e) e.stopPropagation();
  const targetId = id || state.currentNarrative?.id;
  if (!targetId) return;

  const already = state.likedIds.has(targetId);
  const delta = already ? -1 : 1;

  if (already) state.likedIds.delete(targetId);
  else state.likedIds.add(targetId);
  localStorage.setItem('liked', JSON.stringify([...state.likedIds]));

  // update UI
  document.querySelectorAll(`[data-id="${targetId}"]`).forEach(btn => {
    btn.classList.toggle('liked', !already);
  });
  document.querySelectorAll(`.like-count-${targetId}`).forEach(el => {
    el.textContent = Math.max(0, parseInt(el.textContent || '0') + delta);
  });
  if (document.getElementById('panelLikes')) {
    const cur = parseInt(document.getElementById('panelLikes').textContent || '0');
    document.getElementById('panelLikes').textContent = Math.max(0, cur + delta);
  }

  try {
    await fetch(`${API}/api/narratives/${targetId}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delta })
    });
  } catch(_) {}
}

/* ══════════════════════════════════════════════
   WRITE MODAL
══════════════════════════════════════════════ */
function openWriteModal() {
  document.getElementById('writeModal').classList.remove('hidden');
  document.getElementById('narrativeInput').focus();
}
function closeWriteModal() {
  document.getElementById('writeModal').classList.add('hidden');
  document.getElementById('narrativeInput').value = '';
  document.getElementById('wordCount').textContent = '0 words';
  document.getElementById('submitNarrativeBtn').disabled = true;
}

function checkWordCount() {
  const text = document.getElementById('narrativeInput').value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const btn = document.getElementById('submitNarrativeBtn');
  document.getElementById('wordCount').textContent = `${words} words`;
  btn.disabled = words < 30;
  if (words < 30) {
    document.getElementById('wordCount').style.color = '#c8bfad';
  } else {
    document.getElementById('wordCount').style.color = '#2d7a2d';
  }
}

async function submitNarrative() {
  const text = document.getElementById('narrativeInput').value.trim();
  const words = text.split(/\s+/).length;
  if (words < 30) return showToast('need at least 30 words');
  if (!state.wallet) return showToast('connect wallet first');

  const btn = document.getElementById('submitNarrativeBtn');
  btn.disabled = true;
  btn.textContent = 'publishing...';

  try {
    const res = await fetch(`${API}/api/narratives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, authorKey: state.wallet.publicKey })
    });
    const data = await res.json();
    
    // ── GEMINI VERIFICATION CHECK ──
    if (data.error || data.code === 'NOT_A_STORY' || data.code === 'LOW_QUALITY') {
      // Show the AI verification error
      let errorMsg = data.error || 'This text does not appear to be a proper story or narrative.';
      if (data.verification) {
        errorMsg += `\nAI Score: ${(data.verification.score * 100).toFixed(0)}%`;
        if (data.verification.reason) {
          errorMsg += `\nReason: ${data.verification.reason}`;
        }
      }
      showToast('❌ ' + errorMsg);
      btn.disabled = false;
      btn.textContent = 'publish';
      return;
    }
    
    if (data.error) throw new Error(data.error);
    
    // Show verification score if available
    if (data.verification) {
      showToast(` Narrative published`);
    } else {
      showToast(' narrative published');
    }
    
    closeWriteModal();
    await loadFeed();
  } catch(e) {
    showToast('error: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'publish';
  }
}

/* ══════════════════════════════════════════════
   NARRATIVE PANEL
══════════════════════════════════════════════ */
function openNarrativePanel(n) {
  state.currentNarrative = n;
  const panel = document.getElementById('narrativePanel');
  panel.classList.remove('hidden');

  // Populate
  document.getElementById('panelText').textContent = n.text;
  document.getElementById('panelDate').textContent = timeAgo(n.createdAt);
  document.getElementById('panelLikes').textContent = n.likes || 0;
  document.getElementById('panelPrice').textContent = '$' + (n.price || 0.10).toFixed(3);
  document.getElementById('panelHolders').textContent = n.holders || 0;

  const authorEl = document.getElementById('panelAuthorAvatar');
  authorEl.innerHTML = avatarHTML(n.authorKey, 40, n);
  const aName = displayName(n.authorKey, n);
  document.getElementById('panelAuthorName').textContent = aName || anonLabel(n.authorKey);

  // Author block (below chart)
  document.getElementById('authorBlockAvatar').innerHTML = avatarHTML(n.authorKey, 36, n);
  document.getElementById('authorBlockName').textContent = aName || anonLabel(n.authorKey);

  const liked = state.likedIds.has(n.id);
  document.getElementById('panelBombBtn').classList.toggle('liked', liked);
  document.getElementById('panelBombBtn').onclick = () => toggleLikeFeed(n.id, null);

  const change = n.priceChange || 0;
  const changeEl = document.getElementById('panelChange');
  changeEl.textContent = (change >= 0 ? '+' : '') + change.toFixed(1) + '%';
  changeEl.className = 'stat-val ' + (change >= 0 ? 'up' : 'down');

  // Chart
  renderPriceChart(n.priceHistory || generateFlatHistory(n.price || 0.10));

  // Reset trade card to BUY tab
  switchTradeTab('buy');
  document.getElementById('buySlider').value = 0;
  document.getElementById('sellSlider').value = 0;
  updateBuySlider(0);
  updateSellSlider(0);
  document.getElementById('tradeStatus').textContent = '';

  // Load user's SOL + token balance for sliders
  loadTradeBalances(n);

  requestAnimationFrame(() => {
    panel.classList.add('open');
  });
}

async function loadTradeBalances(n) {
  document.getElementById('buyAvailSol').textContent = (state.solBalance || 0).toFixed(3);
  try {
    const res = await fetch(`${API}/api/balance/${state.wallet.publicKey}`);
    const data = await res.json();
    if (data.error) return;
    state.solBalance = data.solBalance;
    document.getElementById('buyAvailSol').textContent = data.solBalance.toFixed(3);
    const tok = (data.tokens || []).find(t => t.narrativeId === n.id);
    state.userTokenBalance = tok ? tok.balance : 0;
    document.getElementById('sellAvailTokens').textContent = state.userTokenBalance.toFixed(2);
  } catch(_) {}
}

function closeNarrativePanel() {
  const panel = document.getElementById('narrativePanel');
  panel.classList.remove('open');
  setTimeout(() => {
    panel.classList.add('hidden');
    state.currentNarrative = null;
    if (state.chartInstance) { state.chartInstance.destroy(); state.chartInstance = null; }
  }, 380);
}

/* ══════════════════════════════════════════════
   PRICE CHART
══════════════════════════════════════════════ */
function renderPriceChart(history) {
  const canvas = document.getElementById('narrativeChart');
  const ctx = canvas.getContext('2d');

  if (state.chartInstance) state.chartInstance.destroy();

  const labels = history.map((_, i) => i);
  const prices = history.map(p => p.price);
  const latest = prices[prices.length - 1];

  document.getElementById('chartPriceTip').textContent = '$' + latest.toFixed(4);

  // Draw manually — notebook style
  const W = canvas.offsetWidth || 340;
  const H = 180;
  canvas.width = W;
  canvas.height = H;

  const pad = { top: 16, right: 16, bottom: 24, left: 40 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;

  const minP = Math.min(...prices) * 0.98;
  const maxP = Math.max(...prices) * 1.02;

  ctx.clearRect(0, 0, W, H);

  // Ruled lines (notebook)
  ctx.strokeStyle = '#c8bfad';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (chartH / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    const val = maxP - ((maxP - minP) / 4) * i;
    ctx.fillStyle = '#c8bfad';
    ctx.font = '9px Space Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText('$' + val.toFixed(3), pad.left - 4, y + 3);
  }

  // Price line
  const pts = prices.map((p, i) => ({
    x: pad.left + (i / (prices.length - 1)) * chartW,
    y: pad.top + chartH - ((p - minP) / (maxP - minP)) * chartH
  }));

  // Fill under line
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pad.top + chartH);
  pts.forEach(pt => ctx.lineTo(pt.x, pt.y));
  ctx.lineTo(pts[pts.length-1].x, pad.top + chartH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(10,10,10,0.06)';
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  pts.forEach((pt, i) => {
    if (i === 0) return;
    const prev = pts[i-1];
    const cx = (prev.x + pt.x) / 2;
    ctx.bezierCurveTo(cx, prev.y, cx, pt.y, pt.x, pt.y);
  });
  ctx.strokeStyle = '#0a0a0a';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Latest dot
  const last = pts[pts.length - 1];
  ctx.beginPath();
  ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#0a0a0a';
  ctx.fill();

  // Vertical line to latest
  ctx.beginPath();
  ctx.moveTo(last.x, last.y);
  ctx.lineTo(last.x, pad.top + chartH);
  ctx.strokeStyle = 'rgba(10,10,10,0.2)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
}

function generateFlatHistory(price) {
  const pts = [];
  let p = price;
  for (let i = 0; i < 20; i++) {
    p += (Math.random() - 0.48) * p * 0.05;
    pts.push({ price: Math.max(0.001, p), t: Date.now() - (20 - i) * 3600000 });
  }
  pts.push({ price, t: Date.now() });
  return pts;
}

/* ══════════════════════════════════════════════
   TRADE CARD — tabs + sliders
══════════════════════════════════════════════ */
function switchTradeTab(tab) {
  state.tradeTab = tab;
  document.getElementById('tabBuy').classList.toggle('active', tab === 'buy');
  document.getElementById('tabSell').classList.toggle('active', tab === 'sell');
  document.getElementById('buyPanel').classList.toggle('hidden', tab !== 'buy');
  document.getElementById('sellPanel').classList.toggle('hidden', tab !== 'sell');
  document.getElementById('tradeStatus').textContent = '';
}

function updateBuySlider(pct) {
  const avail = state.solBalance || 0;
  const amount = (avail * (pct / 100));
  document.getElementById('buyAmountDisplay').textContent = amount.toFixed(4) + ' SOL';
  state.buyAmountSol = amount;
}
function setBuyPercent(pct) {
  document.getElementById('buySlider').value = pct;
  updateBuySlider(pct);
}

function updateSellSlider(pct) {
  document.getElementById('sellAmountDisplay').textContent = pct + '%';
  state.sellPercent = parseInt(pct);
}
function setSellPercent(pct) {
  document.getElementById('sellSlider').value = pct;
  updateSellSlider(pct);
}

async function executeBuy() {
  const n = state.currentNarrative;
  if (!n) return;
  const solAmt = state.buyAmountSol || 0;
  if (!solAmt || solAmt <= 0) return showToast('move the slider to set an amount');
  if (solAmt > state.solBalance) return showToast('insufficient SOL balance');

  setTradeStatus('processing buy...');
  try {
    const res = await fetch(`${API}/api/narratives/${n.id}/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ privateKey: state.wallet.privateKey, solAmount: solAmt })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    setTradeStatus(`✓ bought ${data.tokenAmount?.toFixed(2)} tokens`);
    showToast('buy confirmed');
    document.getElementById('buySlider').value = 0;
    updateBuySlider(0);
    refreshBalance();
    loadTradeBalances(n);
  } catch(e) {
    setTradeStatus('error: ' + e.message);
    showToast('buy failed');
  }
}

async function executeSell() {
  const n = state.currentNarrative;
  if (!n) return;
  const percent = state.sellPercent || 0;
  if (!percent || percent <= 0) return showToast('move the slider to set a sell %');

  setTradeStatus(`selling ${percent}%...`);
  try {
    const res = await fetch(`${API}/api/narratives/${n.id}/sell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ privateKey: state.wallet.privateKey, sellPercent: percent })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    setTradeStatus(`✓ received ${data.netSol?.toFixed(4)} SOL`);
    showToast('sell confirmed');
    document.getElementById('sellSlider').value = 0;
    updateSellSlider(0);
    refreshBalance();
    loadTradeBalances(n);
  } catch(e) {
    setTradeStatus('error: ' + e.message);
    showToast('sell failed');
  }
}

function setTradeStatus(msg) {
  document.getElementById('tradeStatus').textContent = msg;
}

/* ══════════════════════════════════════════════
   MARKET PAGE
══════════════════════════════════════════════ */
async function loadMarket() {
  const list = document.getElementById('marketList');
  list.innerHTML = '<div class="feed-loading">loading market...</div>';
  try {
    const res = await fetch(`${API}/api/narratives?market=true`);
    const data = await res.json();
    const mNarratives = (data.narratives || []).filter(n => n.inMarket);
    if (!mNarratives.length) {
      list.innerHTML = '<div class="feed-loading">no narratives in market yet.</div>';
      return;
    }
    list.innerHTML = '';
    mNarratives.forEach((n, idx) => {
      const book = buildMarketBook(n, idx);
      list.appendChild(book);
    });
  } catch(e) {
    list.innerHTML = '<div class="feed-loading">could not load market.</div>';
  }
}

function buildMarketBook(n, idx) {
  const div = document.createElement('div');
  div.className = 'market-book';
  const anon = anonLabel(n.authorKey);
  const name = displayName(n.authorKey, n);
  const timeStr = timeAgo(n.createdAt);
  const likes = n.likes || 0;
  const price = n.price || 0.10;
  const change = n.priceChange || 0;
  const canvasId = `mChart_${n.id}`;

  div.innerHTML = `
    <div class="market-book-left">
      <div class="mbl-header">
        ${avatarHTML(n.authorKey, 28, n)}
        <div>
          ${name ? `<div class="mbl-name">${escHtml(name)}</div>` : ''}
          <div class="mbl-anon">${anon}</div>
          <div class="mbl-time">${timeStr}</div>
        </div>
      </div>
      <div class="mbl-text">${escHtml(n.text)}</div>
      <div class="mbl-footer">
        <div class="mbl-bomb">
          <svg width="14" height="14" viewBox="0 0 32 32" fill="currentColor">
            <circle cx="14" cy="18" r="10"/>
            <path d="M14 8 Q20 2 26 6 Q28 10 24 12" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <circle cx="26" cy="5" r="2" fill="#ff3b00"/>
          </svg>
          ${likes}
        </div>
        <div class="mbl-id">NR-${String(idx + 1).padStart(3,'0')}</div>
      </div>
    </div>
    <div class="market-book-right">
      <div class="mbr-chart">
        <canvas id="${canvasId}" height="120"></canvas>
      </div>
      <div class="mbr-stats">
        <div class="mbr-stat">
          <div class="mbr-stat-label">PRICE</div>
          <div class="mbr-stat-val">$${price.toFixed(3)}</div>
        </div>
        <div class="mbr-stat">
          <div class="mbr-stat-label">24H</div>
          <div class="mbr-stat-val" style="color:${change >= 0 ? '#2d7a2d':'#ff3b00'}">${change >= 0 ? '+' : ''}${change.toFixed(1)}%</div>
        </div>
      </div>
    </div>
  `;

  div.addEventListener('click', () => openNarrativePanel(n));

  setTimeout(() => {
    const c = document.getElementById(canvasId);
    if (c) drawMiniChart(c, n.priceHistory || generateFlatHistory(price));
  }, 50);

  return div;
}

function drawMiniChart(canvas, history) {
  const ctx = canvas.getContext('2d');
  const W = canvas.parentElement.offsetWidth || 200;
  const H = 120;
  canvas.width = W; canvas.height = H;

  const prices = history.map(p => p.price);
  const minP = Math.min(...prices) * 0.97;
  const maxP = Math.max(...prices) * 1.03;
  const pad = { top: 8, right: 8, bottom: 8, left: 8 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;

  ctx.clearRect(0, 0, W, H);

  const pts = prices.map((p, i) => ({
    x: pad.left + (i / (prices.length - 1)) * cW,
    y: pad.top + cH - ((p - minP) / (maxP - minP)) * cH
  }));

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pad.top + cH);
  pts.forEach(pt => ctx.lineTo(pt.x, pt.y));
  ctx.lineTo(pts[pts.length-1].x, pad.top + cH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(10,10,10,0.05)';
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  pts.forEach((pt, i) => {
    if (i === 0) return;
    const prev = pts[i-1];
    const cx = (prev.x + pt.x) / 2;
    ctx.bezierCurveTo(cx, prev.y, cx, pt.y, pt.x, pt.y);
  });
  ctx.strokeStyle = '#0a0a0a';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const last = pts[pts.length - 1];
  ctx.beginPath();
  ctx.arc(last.x, last.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#0a0a0a';
  ctx.fill();
}

/* ══════════════════════════════════════════════
   HOLDINGS
══════════════════════════════════════════════ */
function renderHoldings(tokens) {
  const list = document.getElementById('holdingsList');

  if (!tokens || !tokens.length) {
    list.innerHTML = '<div class="empty-holdings">no narratives held yet. buy into the market.</div>';
    return;
  }

  list.innerHTML = '';
  tokens.forEach(t => {
    const row = document.createElement('div');
    row.className = 'holding-row';
    const price = t.price || 0.10;
    const change = t.priceChange || 0;
    row.innerHTML = `
      <div class="holding-left">
        <div class="holding-name">NR-${t.narrativeId?.slice(0,8) || '—'}</div>
        <div class="holding-preview">${escHtml(t.text?.slice(0,60) || '')}...</div>
        <div class="holding-preview" style="margin-top:2px">${t.balance.toFixed(2)} tokens</div>
      </div>
      <div class="holding-right">
        <div class="holding-price">$${t.usdValue.toFixed(2)}</div>
        <div class="holding-change ${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '+' : ''}${change.toFixed(1)}%</div>
      </div>
    `;
    row.addEventListener('click', () => {
      const n = state.narratives.find(x => x.id === t.narrativeId);
      if (n) openNarrativePanel(n);
    });
    list.appendChild(row);
  });
}

/* ══════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════ */
function avatarHTML(key, size, n) {
  if (!key) return `<div class="feed-avatar" style="width:${size}px;height:${size}px"><div class="feed-avatar-placeholder">?</div></div>`;

  // Prefer server-synced data on the narrative itself (works cross-device for all viewers)
  const pic = (n && n.authorPic) || getProfile(key)?.pic;
  if (pic) {
    return `<div class="feed-avatar" style="width:${size}px;height:${size}px"><img src="${pic}" alt=""></div>`;
  }

  // Generate deterministic pattern avatar from key
  const seed = key.charCodeAt(0) + key.charCodeAt(1) + key.charCodeAt(key.length-1);
  const patterns = ['◆','■','▲','●','★','◉','▪','◈'];
  const pattern = patterns[seed % patterns.length];
  const bgShades = ['#0a0a0a','#1a1a1a','#2a2a2a','#111111'];
  const bg = bgShades[seed % bgShades.length];
  return `<div class="feed-avatar" style="width:${size}px;height:${size}px;background:${bg};display:flex;align-items:center;justify-content:center;color:#f5f0e8;font-size:${size/3}px;font-family:'Space Mono',monospace;">${pattern}</div>`;
}

function displayName(key, n) {
  if (n && n.authorName) return n.authorName;
  return getProfile(key)?.name || '';
}

function anonLabel(key) {
  if (!key) return 'anon';
  const words = ['ghost','void','shade','echo','null','ink','fog','dusk','ash','rift'];
  const nums = ['#'+key.slice(-3), '#'+key.slice(0,3)];
  const w = words[(key.charCodeAt(0) + key.charCodeAt(2)) % words.length];
  const n = nums[key.charCodeAt(1) % 2];
  return w + ' ' + n;
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  const hr  = Math.floor(diff / 3600000);
  const day = Math.floor(diff / 86400000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  if (hr < 24)  return `${hr}h ago`;
  return `${day}d ago`;
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}

/* ── Close panel on Escape ── */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!document.getElementById('narrativePanel').classList.contains('hidden')) closeNarrativePanel();
    if (!document.getElementById('writeModal').classList.contains('hideen')) closeWriteModal();
  }
});