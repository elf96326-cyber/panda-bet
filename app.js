
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup,
  signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {
getFirestore, doc, collection, query, where,
orderBy, limit, onSnapshot, runTransaction,
serverTimestamp, Timestamp, getDocs, setDoc
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { firebaseConfig } from './config.js';

// =====================================
// PANDA BET｜完整程式
// 單一賽事置頂版
// =====================================

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = id => document.getElementById(id);
const fmt = n => Number(n || 0).toLocaleString('zh-TW');
const money = n => '🪙 ' + fmt(n);
const MAX_OPTIONS = 16;

// 全站唯一置頂設定文件
const pinRef = doc(db, 'siteSettings', 'featuredMarket');

let user = null;
let profile = null;
let markets = [];
let bets = [];
let marketStats = {};
let selection = null;
let isAdmin = false;
let pinnedMarketId = '';
let authReady = false;
let authBusy = false;

let unsubs = [];
let adminBetsUnsub = null;
let adminAllBets = [];
let adminBetsLoaded = false;
let statsTimer = null;
let statsPublishing = false;
let statsQueued = false;
let publishedSignature = '';
let toastTimer = null;
let grantPlayers = [];
let grantBusy = false;
const expandedMarketStats = new Set();
// =====================================
// 共用工具
// =====================================

function toast(message) {
  const el = $('toast');
  if (!el) return;

  el.textContent = message;
  el.style.display = 'block';

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.style.display = 'none';
  }, 4500);
}

function element(tag, text = null, className = '') {
  const el = document.createElement(tag);
  if (text !== null) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function verifiedGoogle(u) {
  return !!u &&
    u.emailVerified === true &&
    u.providerData.some(
      p => p.providerId === 'google.com'
    );
}

function formatDate(value) {
  if (!value?.toDate) return '未設定';
  return value.toDate().toLocaleString('zh-TW');
}

function marketOpen(m) {
  return m.status === 'open' &&
    m.closesAt?.toMillis?.() > Date.now();
}

function marketOdds(m) {
  return Array.isArray(m.odds)
    ? m.odds
    : [1.8, 1.8];
}

function listen(target, callback) {
  const unsubscribe = onSnapshot(
    target,
    callback,
    error => toast('資料讀取失敗：' + error.message)
  );
  unsubs.push(unsubscribe);
}

function cleanup() {
  unsubs.forEach(fn => fn());
  unsubs = [];
}

// =====================================
// 排序：唯一置頂優先
// =====================================

function sortedMarkets() {
  return [...markets].sort((a, b) => {
    const aPinned = a.id === pinnedMarketId ? 1 : 0;
    const bPinned = b.id === pinnedMarketId ? 1 : 0;

    if (aPinned !== bPinned) {
      return bPinned - aPinned;
    }

    const aTime = a.createdAt?.toMillis?.() || 0;
    const bTime = b.createdAt?.toMillis?.() || 0;

    return bTime - aTime;
  });
}

// =====================================
// 頁面切換
// =====================================

function switchTab(tab) {
  if (tab === 'admin' && !isAdmin) return;

  document.querySelectorAll('[data-tab]').forEach(button => {
    button.classList.toggle(
      'active',
      button.dataset.tab === tab
    );
  });

  ['home', 'bets', 'ranking', 'admin'].forEach(id => {
    $(id)?.classList.toggle('hidden', id !== tab);
  });
}

document.querySelectorAll('[data-tab]').forEach(button => {
  button.addEventListener('click', () => {
    switchTab(button.dataset.tab);
  });
});

// =====================================
// 補充樣式
// =====================================

const style = document.createElement('style');

style.textContent = `
.panda-pinned-market{
  border:2px solid #81e9a6!important;
  box-shadow:0 0 0 1px rgba(129,233,166,.12);
}
.panda-pin-badge{
  display:inline-block;
  padding:6px 11px;
  margin-bottom:12px;
  background:#81e9a6;
  color:#0b2115;
  font-size:12px;
  font-weight:900;
  border-radius:99px;
}
.panda-stats{
  margin-top:18px;
  padding:16px;
  background:#10291d;
  border:1px solid #355543;
  border-radius:13px;
}
.panda-stats-title{
  color:#b4f0c7;
  font-size:15px;
  font-weight:800;
  margin-bottom:12px;
}
.panda-stats-summary{
  color:#d9f4e2;
  font-size:13px;
  line-height:1.8;
  margin-bottom:14px;
}
.panda-stat-item{
  margin:13px 0;
}
.panda-stat-heading{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  font-size:13px;
  margin-bottom:7px;
}
.panda-stat-heading span{
  overflow-wrap:anywhere;
}
.panda-stat-heading strong{
  color:#8cf2b2;
  white-space:nowrap;
}
.panda-stat-track{
  height:9px;
  background:#30483a;
  border-radius:99px;
  overflow:hidden;
  margin-bottom:6px;
}
.panda-stat-fill{
  height:100%;
  background:#81e9a6;
  border-radius:99px;
}
.panda-stat-detail{
  color:#a4b7ac;
  font-size:12px;
}
.panda-stat-updated{
  color:#a4b7ac;
  font-size:11px;
  line-height:1.7;
  margin-top:15px;
}
.panda-admin-actions{
  display:flex;
  gap:8px;
  flex-wrap:wrap;
  margin-top:12px;
}
.panda-admin-actions button{
  margin:0;
}
.panda-pin-button{
  border-color:#81e9a6!important;
}
`;

document.head.append(style);

// =====================================
// 投注統計
// =====================================

function calculateMarketStats(m, records) {
  const length = m.options.length;
  const amounts = Array(length).fill(0);
  const members = Array.from(
    { length },
    () => new Set()
  );

  let totalAmount = 0;
  let totalBets = 0;

  for (const b of records) {
    if (
      b.marketId !== m.id ||
      !Number.isInteger(b.choice) ||
      b.choice < 0 ||
      b.choice >= length ||
      !Number.isSafeInteger(b.amount) ||
      b.amount < 0 ||
      typeof b.uid !== 'string'
    ) continue;

    amounts[b.choice] += b.amount;
    members[b.choice].add(b.uid);
    totalAmount += b.amount;
    totalBets++;
  }

  return {
    amounts,
    counts: members.map(set => set.size),
    totalAmount,
    totalBets
  };
}

function statsSignature() {
  return JSON.stringify({
    markets: markets.map(m => [
      m.id,
      m.options?.length
    ]),
    bets: adminAllBets
      .map(b => [
        b.id, b.marketId, b.uid,
        b.choice, b.amount
      ])
      .sort((a, b) => a[0].localeCompare(b[0]))
  });
}

async function publishStats(force = false) {
  if (!user || !isAdmin || !adminBetsLoaded) {
    if (force) toast('管理員投注資料尚未載入');
    return;
  }

  if (statsPublishing) {
    statsQueued = true;
    return;
  }

  const signature = statsSignature();

  if (!force && signature === publishedSignature) {
    return;
  }

  statsPublishing = true;

  try {
    for (const m of markets) {
      if (
        !Array.isArray(m.options) ||
        m.options.length < 2
      ) continue;

      const data = calculateMarketStats(
        m,
        adminAllBets
      );

      await setDoc(
        doc(db, 'marketStats', m.id),
        {
          ...data,
          updatedAt: serverTimestamp()
        }
      );
    }

    publishedSignature = signature;

    if (force) {
      toast('📊 市場投注趨勢同步完成');
    }

  } catch (error) {
    toast('統計同步失敗：' + error.message);

  } finally {
    statsPublishing = false;

    if (statsQueued) {
      statsQueued = false;
      queueStatsPublish();
    }
  }
}

function queueStatsPublish() {
  if (!isAdmin || !adminBetsLoaded) return;

  clearTimeout(statsTimer);

  if (statsPublishing) {
    statsQueued = true;
    return;
  }

  statsTimer = setTimeout(() => {
    publishStats();
  }, 1300);
}

function stopAdminStats() {
  if (adminBetsUnsub) {
    adminBetsUnsub();
    adminBetsUnsub = null;
  }

  clearTimeout(statsTimer);

  adminAllBets = [];
  adminBetsLoaded = false;
  statsQueued = false;
  publishedSignature = '';
}

function startAdminStats() {
  if (!user || !isAdmin || adminBetsUnsub) return;

  adminBetsUnsub = onSnapshot(
    collection(db, 'bets'),
    snapshot => {
      adminAllBets = snapshot.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));

      adminBetsLoaded = true;
      queueStatsPublish();
    },
    error => {
      adminBetsLoaded = false;
      toast('管理員投注資料讀取失敗：' + error.message);
    }
  );
}

// =====================================
// 市場投注趨勢畫面
// =====================================

function renderStats(m) {
  const box = element('div', null, 'panda-stats');

  box.append(
    element(
      'div',
      '📊 市場投注趨勢',
      'panda-stats-title'
    )
  );

  const data = marketStats[m.id];

  if (
    !data ||
    !Array.isArray(data.amounts) ||
    !Array.isArray(data.counts) ||
    data.amounts.length !== m.options.length ||
    data.counts.length !== m.options.length
  ) {
    box.append(
      element(
        'div',
        '尚無公開統計，等待管理員同步。',
        'small'
      )
    );
    return box;
  }

  const total = Number(data.totalAmount) || 0;

  box.append(
    element(
      'div',
      `總投注額：${money(total)}｜投注筆數：${fmt(data.totalBets)}`,
      'panda-stats-summary'
    )
  );

  m.options.forEach((name, i) => {
    const amount = Number(data.amounts[i]) || 0;
    const people = Number(data.counts[i]) || 0;
    const percent = total > 0
      ? amount / total * 100
      : 0;

    const item = element(
      'div',
      null,
      'panda-stat-item'
    );

    const heading = element(
      'div',
      null,
      'panda-stat-heading'
    );

    heading.append(
      element('span', name),
      element('strong', percent.toFixed(1) + '%')
    );

    const track = element(
      'div',
      null,
      'panda-stat-track'
    );

    const fill = element(
      'div',
      null,
      'panda-stat-fill'
    );

    fill.style.width = Math.max(
      0,
      Math.min(100, percent)
    ) + '%';

    track.append(fill);

    item.append(
      heading,
      track,
      element(
        'div',
        `${money(amount)}｜${fmt(people)} 位不重複玩家`,
        'panda-stat-detail'
      )
    );

    box.append(item);
  });

  box.append(
    element(
      'div',
      `最後同步：${formatDate(data.updatedAt)}｜同一玩家支持不同選項會分別計入人數`,
      'panda-stat-updated'
    )
  );

  return box;
}

// =====================================
// 畫面更新
// =====================================

function update() {
  const balance = profile?.balance ?? 0;

  $('balance').textContent =
    profile ? money(balance) : '🪙 —';

  $('statBalance').textContent =
    profile ? fmt(balance) : '—';

  $('statBets').textContent =
    profile ? fmt(bets.length) : '—';

  $('statOpen').textContent =
    fmt(markets.filter(marketOpen).length);

  renderMarkets();
  renderSelection();
  renderBets();
  renderAdmin();
}

// =====================================
// 預測市場
// =====================================

function renderMarkets() {
  const box = $('markets');
  box.replaceChildren();

  if (!user) {
    box.textContent = '請先使用 Google 帳號登入';
    return;
  }

  if (!markets.length) {
    box.textContent = '目前尚無預測賽事';
    return;
  }

  // 唯一置頂市場排第一，其餘新到舊
  for (const m of sortedMarkets()) {
    const pinned = m.id === pinnedMarketId;

    const card = element(
      'article',
      null,
      'card market' +
        (pinned ? ' panda-pinned-market' : '')
    );

    if (pinned) {
      card.append(
        element(
          'div',
          '📌 置頂賽事',
          'panda-pin-badge'
        )
      );
    }

    const status =
      m.status === 'settled'
        ? '✅ 已公布結果'
        : marketOpen(m)
          ? '🟢 開放預測'
          : '🔒 已封盤';

    card.append(
      element('div', status, 'small'),
      element('h3', m.title),
      element(
        'div',
        '封盤時間：' + formatDate(m.closesAt),
        'small'
      )
    );
// 已公布結果：直接顯示正確答案
if (
  m.status === 'settled' &&
  Number.isInteger(m.result) &&
  m.result >= 0 &&
  m.result < (m.options?.length || 0)
) {
  const resultBox = element(
    'div',
    `🏆 正確答案：${m.options[m.result]}`
  );

  resultBox.style.background = '#183C53';
  resultBox.style.border = '1px solid #7DC9F4';
  resultBox.style.borderRadius = '10px';
  resultBox.style.padding = '12px 14px';
  resultBox.style.margin = '12px 0';
  resultBox.style.color = '#A9DDF8';
  resultBox.style.fontWeight = '800';
  resultBox.style.fontSize = '15px';

  card.append(resultBox);
}
   
    const choices = element(
      'div',
      null,
      'choices'
    );

    (m.options || []).forEach((name, i) => {
      const selected =
        selection?.id === m.id &&
        selection.choice === i;

      const button = element(
        'button',
        null,
        'choice' +
          (selected ? ' selected' : '')
      );

      button.type = 'button';

      button.append(
        element('span', name),
        element(
          'b',
          Number(
            marketOdds(m)[i] ?? 1.8
          ).toFixed(2)
        )
      );

      button.disabled = !marketOpen(m);

button.addEventListener('click', () => {
  selection = {
    id: m.id,
    choice: i
  };

  update();
  openBetSheet();
});

      choices.append(button);
    });

    card.append(choices);


    // 市場投注趨勢：預設收合，保留各賽事展開狀態
    const statsToggle = element(
      'button',
      '',
      'btn'
    );

    statsToggle.type = 'button';
    statsToggle.style.width = '100%';
    statsToggle.style.marginTop = '14px';
    statsToggle.style.textAlign = 'center';

    const statsContent = element('div');

    function refreshStatsDisplay() {
      const expanded = expandedMarketStats.has(m.id);

      statsContent.classList.toggle('hidden', !expanded);

      statsToggle.textContent = expanded
        ? '📊 收合市場投注趨勢 ▴'
        : '📊 查看市場投注趨勢 ▾';

      statsToggle.setAttribute(
        'aria-expanded',
        String(expanded)
      );

      if (expanded) {
        statsContent.replaceChildren(renderStats(m));
      } else {
        statsContent.replaceChildren();
      }
    }

    statsToggle.addEventListener('click', () => {
      if (expandedMarketStats.has(m.id)) {
        expandedMarketStats.delete(m.id);
      } else {
        expandedMarketStats.add(m.id);
      }

      refreshStatsDisplay();
    });

    refreshStatsDisplay();

    card.append(statsToggle, statsContent);
    box.append(card);
  }
}


/* =====================================
   手機版：底部彈出式預測單
   ===================================== */

function openBetSheet(){
  if(window.innerWidth > 740) return;

  document.getElementById('betSheet')
    ?.classList.add('is-open');

  document.getElementById('betSheetBackdrop')
    ?.classList.add('is-open');

  document.body.classList.add('bet-sheet-open');
}

function closeBetSheet(){
  document.getElementById('betSheet')
    ?.classList.remove('is-open');

  document.getElementById('betSheetBackdrop')
    ?.classList.remove('is-open');

  document.body.classList.remove('bet-sheet-open');
}

document.getElementById('closeBetSheet')
  ?.addEventListener('click',closeBetSheet);

document.getElementById('betSheetBackdrop')
  ?.addEventListener('click',closeBetSheet);

window.addEventListener('keydown',event=>{
  if(event.key === 'Escape'){
    closeBetSheet();
  }
});

window.addEventListener('resize',()=>{
  if(window.innerWidth > 740){
    closeBetSheet();
  }
});


// =====================================
// 預測單
// =====================================

function renderSelection() {
  const m = markets.find(
    x => x.id === selection?.id
  );

  const valid =
    !!m &&
    marketOpen(m) &&
    Number.isInteger(selection?.choice) &&
    selection.choice >= 0 &&
    selection.choice < m.options.length;

  $('betForm').classList.toggle('hidden', !valid);
  $('selection').classList.toggle('hidden', valid);

  if (!valid) {
    $('selection').textContent =
      '選擇開放市場的預測選項';
    return;
  }

  const o = Number(
    marketOdds(m)[selection.choice]
  );

  const amount = Number(
    $('amount').value
  ) || 0;

  $('selectedName').textContent =
    m.title + '｜' +
    m.options[selection.choice];

  $('selectedOdds').textContent =
    o.toFixed(2);

  $('estimated').textContent =
    money(Math.floor(amount * o));
}

// =====================================
// 我的投注紀錄
// =====================================

function renderBets() {
  const box = $('betHistory');
  box.replaceChildren();

  if (!user) {
    box.textContent = '請先登入';
    return;
  }

  if (!bets.length) {
    box.textContent = '目前沒有投注紀錄';
    return;
  }

  for (const b of bets) {
    const m = markets.find(
      x => x.id === b.marketId
    );

    const name =
      m?.options?.[b.choice] ??
      `選項 ${Number(b.choice) + 1}`;

    const status = {
      pending: '待結算',
      won: '🎉 預測成功',
      lost: '未命中'
    }[b.status] || b.status;

    const row = element(
      'div',
      null,
      'rowline'
    );

    row.append(
      element(
        'strong',
        m?.title || '歷史市場'
      ),
      element(
        'div',
        `選擇：${name}｜投入 ${fmt(b.amount)} 幣｜固定賠率 ${b.odds}`,
        'small'
      ),
      element(
        'div',
        `狀態：${status}｜已發放 ${fmt(b.payout)} 幣`,
        'small'
      )
    );

    box.append(row);
  }
}

// =====================================
// 排行榜
// =====================================

function renderRanking(players) {
  const box = $('leaderboard');
  box.replaceChildren();

  if (!user) {
    box.textContent = '請先登入';
    return;
  }

  if (!players.length) {
    box.textContent = '目前沒有玩家';
    return;
  }

  players.forEach((p, i) => {
    const row = element(
      'div',
      null,
      'rowline flex'
    );

    row.append(
      element(
        'span',
        `${i + 1}. ${p.name || '匿名熊貓'}`
      ),
      element(
        'strong',
        money(p.balance)
      )
    );

    box.append(row);
  });
}

// =====================================
// Google 登入
// =====================================

const authButton = $('authButton');

authButton.disabled = true;
authButton.textContent = '登入載入中…';

authButton.addEventListener('click', async () => {
  if (!authReady || authBusy) return;

  authBusy = true;
  authButton.disabled = true;

  try {
    if (auth.currentUser) {
      await signOut(auth);
    } else {
      const provider = new GoogleAuthProvider();

      provider.setCustomParameters({
        prompt: 'select_account'
      });

      const result = await signInWithPopup(
        auth,
        provider
      );

      if (!verifiedGoogle(result.user)) {
        await signOut(auth);
        toast('請使用已驗證的 Google 帳號');
      }
    }
  } catch (error) {
    if (
      error.code !== 'auth/popup-closed-by-user' &&
      error.code !== 'auth/cancelled-popup-request'
    ) {
      toast('登入失敗：' + error.message);
    }
  } finally {
    authBusy = false;
    authButton.disabled = !authReady;
  }
});

// =====================================
// 登入與即時資料監聽
// =====================================

onAuthStateChanged(auth, async u => {
  authReady = true;
  authButton.disabled = authBusy;

  if (u && !verifiedGoogle(u)) {
    await signOut(auth);
    toast('Google 帳號驗證失敗');
    return;
  }

cleanup();
stopAdminStats();
stopCoinGrantListeners();
expandedMarketStats.clear();

  user = u;
  profile = null;
  markets = [];
  bets = [];
  marketStats = {};
  selection = null;
  pinnedMarketId = '';
  isAdmin = false;

  $('who').textContent =
    u?.displayName || '尚未登入';

  authButton.textContent =
    u ? '登出' : 'Google 登入';

  $('adminTab').classList.add('hidden');

  if (!u) {
    switchTab('home');
    renderRanking([]);
    update();
    return;
  }

  try {
    const userRef = doc(
      db,
      'users',
      u.uid
    );

    await runTransaction(db, async tx => {
      const snapshot = await tx.get(userRef);

      if (!snapshot.exists()) {
        tx.set(userRef, {
  name: (
    u.displayName || '熊貓玩家'
  ).slice(0, 80),
  balance: 10000,
  lastBetId: '',
  lastSettleId: '',
  lastGrantId: '',
  createdAt: serverTimestamp()
});
      }
    });

    // 玩家資料
    listen(userRef, snapshot => {
      profile = snapshot.data() || null;
      update();
    });

    // 賽事資料
    listen(
      collection(db, 'markets'),
      snapshot => {
        markets = snapshot.docs.map(d => ({
          id: d.id,
          ...d.data()
        }));

        update();
        queueStatsPublish();
      }
    );

    // 唯一置頂設定
    listen(pinRef, snapshot => {
      pinnedMarketId = snapshot.exists()
        ? snapshot.data().marketId || ''
        : '';

      update();
    });

    // 公開投注趨勢
    listen(
      collection(db, 'marketStats'),
      snapshot => {
        marketStats = Object.fromEntries(
          snapshot.docs.map(d => [
            d.id,
            d.data()
          ])
        );

        renderMarkets();
      }
    );

    // 個人投注
    listen(
      query(
        collection(db, 'bets'),
        where('uid', '==', u.uid)
      ),
      snapshot => {
        bets = snapshot.docs.map(d => ({
          id: d.id,
          ...d.data()
        }));

        bets.sort(
          (a, b) =>
            (b.createdAt?.seconds || 0) -
            (a.createdAt?.seconds || 0)
        );

        update();
      }
    );

    // 排行榜
    listen(
      query(
        collection(db, 'users'),
        orderBy('balance', 'desc'),
        limit(50)
      ),
      snapshot => {
        renderRanking(
          snapshot.docs.map(d => d.data())
        );
      }
    );

    // 管理員權限
    listen(
      doc(db, 'admins', u.uid),
      snapshot => {
        isAdmin = snapshot.exists();

        $('adminTab').classList.toggle(
          'hidden',
          !isAdmin
        );

        renderAdmin();

        if (isAdmin) {
  startAdminStats();
  startCoinGrantListeners();
  renderGrantPreview();
} else {
  stopAdminStats();
  stopCoinGrantListeners();
  renderGrantPreview();
}
      }
    );

  } catch (error) {
    toast('初始化失敗：' + error.message);
  }
});

// =====================================
// 投注金額快捷鍵
// =====================================

$('amount').addEventListener(
  'input',
  renderSelection
);

document.querySelectorAll('[data-amount]').forEach(button => {
  button.addEventListener('click', () => {
    $('amount').value = button.dataset.amount;
    renderSelection();
  });
});

// =====================================
// 玩家投注
// =====================================

$('placeBet').addEventListener('click', async () => {
  if (!user) {
    toast('請先登入');
    return;
  }

  const m = markets.find(
    x => x.id === selection?.id
  );

  const choice = selection?.choice;
  const amount = Number($('amount').value);

  if (
    !m ||
    !marketOpen(m) ||
    !Number.isInteger(choice) ||
    choice < 0 ||
    choice >= m.options.length ||
    !Number.isSafeInteger(amount) ||
    amount < 10 ||
    amount > 10000 ||
    amount % 10 !== 0
  ) {
    toast('每筆限 10～10,000 幣，且須為 10 的倍數');
    return;
  }

  if (amount > (profile?.balance || 0)) {
    toast('熊貓幣不足');
    return;
  }

  if (!confirm(
    `確認投入 ${fmt(amount)} 幣預測「${m.options[choice]}」？`
  )) return;

  const button = $('placeBet');
  button.disabled = true;

  try {
    const betRef = doc(
      collection(db, 'bets')
    );

    const userRef = doc(
      db,
      'users',
      user.uid
    );

    const marketRef = doc(
      db,
      'markets',
      m.id
    );

    await runTransaction(db, async tx => {
      const [us, ms] = await Promise.all([
        tx.get(userRef),
        tx.get(marketRef)
      ]);

      if (!us.exists() || !ms.exists()) {
        throw Error('玩家或賽事資料不存在');
      }

      const md = ms.data();

      if (
        us.data().balance < amount ||
        md.status !== 'open' ||
        md.closesAt.toMillis() <= Date.now() ||
        !Array.isArray(md.options) ||
        choice >= md.options.length ||
        md.options[choice] !== m.options[choice]
      ) {
        throw Error('餘額不足、選項已變更或賽事已封盤');
      }

      const o = (
        md.odds || [1.8, 1.8]
      )[choice];

      if (
        typeof o !== 'number' ||
        !Number.isFinite(o) ||
        o < 1.01 ||
        o > 10
      ) {
        throw Error('賠率資料異常');
      }

      tx.set(betRef, {
        uid: user.uid,
        marketId: m.id,
        choice,
        amount,
        odds: o,
        payout: 0,
        status: 'pending',
        createdAt: serverTimestamp()
      });

      tx.update(userRef, {
        balance:
          us.data().balance - amount,
        lastBetId: betRef.id
      });
    });

    toast('🎉 預測成功！');

    selection = null;
closeBetSheet();
update();
    
  } catch (error) {
    toast('預測失敗：' + error.message);

  } finally {
    button.disabled = false;
  }
});

// =====================================
// 管理員：動態選項
// =====================================

const optionBox = $('adminOptions');
const addOptionButton = $('addMarketOption');

let nextOptionId = 2;

function optionCards() {
  return Array.from(
    optionBox.querySelectorAll(
      '.admin-option'
    )
  );
}

function createOptionCard(name = '', odd = '1.80') {
  const id = ++nextOptionId;

  const card = element(
    'div',
    null,
    'admin-option'
  );

  const actions = element(
    'div',
    null,
    'admin-option-actions'
  );

  actions.append(
    element('strong', '新選項')
  );

  const nameLabel = element(
    'label',
    '選項名稱'
  );

  const nameInput = element('input');

  nameInput.id = 'optionName' + id;
  nameInput.className = 'field';
  nameInput.type = 'text';
  nameInput.maxLength = 40;
  nameInput.placeholder = '例如：T1';
  nameInput.value = name;
  nameLabel.htmlFor = nameInput.id;

  const oddsLabel = element(
    'label',
    '賠率'
  );

  const oddsInput = element('input');

  oddsInput.id = 'optionOdds' + id;
  oddsInput.className = 'field';
  oddsInput.type = 'number';
  oddsInput.min = '1.01';
  oddsInput.max = '10';
  oddsInput.step = '0.01';
  oddsInput.inputMode = 'decimal';
  oddsInput.value = odd;
  oddsLabel.htmlFor = oddsInput.id;

  card.append(
    actions,
    nameLabel,
    nameInput,
    oddsLabel,
    oddsInput
  );

  return card;
}

function refreshOptionLabels() {
  const cards = optionCards();

  cards.forEach((card, i) => {
    let actions = card.querySelector(
      '.admin-option-actions'
    );

    if (!actions) {
      actions = element(
        'div',
        null,
        'admin-option-actions'
      );

      card.prepend(actions);
    }

    let heading = actions.querySelector('strong');

    if (!heading) {
      heading = element('strong');
      actions.prepend(heading);
    }

    heading.textContent = `選項 ${i + 1}`;

    let remove = actions.querySelector(
      '.admin-option-remove'
    );

    if (!remove) {
      remove = element(
        'button',
        '移除',
        'btn admin-option-remove'
      );

      remove.type = 'button';
      actions.append(remove);
    }

    remove.disabled = cards.length <= 2;

    remove.onclick = () => {
      if (optionCards().length <= 2) return;

      card.remove();
      refreshOptionLabels();
    };
  });

  addOptionButton.disabled =
    cards.length >= MAX_OPTIONS;

  addOptionButton.textContent =
    cards.length >= MAX_OPTIONS
      ? '已達 16 個選項上限'
      : '＋ 新增一個選項';
}

addOptionButton.addEventListener('click', event => {
  event.preventDefault();

  if (optionCards().length >= MAX_OPTIONS) {
    toast('每場最多 16 個選項');
    return;
  }

  const card = createOptionCard();

  optionBox.append(card);
  refreshOptionLabels();

  card.querySelector(
    'input[type="text"]'
  )?.focus();
});

refreshOptionLabels();

// =====================================
// 管理員：建立賽事
// =====================================

$('createMarket').addEventListener('click', async () => {
  if (!isAdmin) {
    toast('只有管理員可以建立賽事');
    return;
  }

  const title = $('newTitle').value.trim();
  const local = $('newClose').value;
  const closeDate = new Date(local);
  const cards = optionCards();

  const options = [];
  const odds = [];

  for (const card of cards) {
    const nameInput = card.querySelector(
      'input:not([type="number"])'
    );

    const oddInput = card.querySelector(
      'input[type="number"]'
    );

    options.push(
      nameInput?.value.trim() || ''
    );

    odds.push(
      oddInput?.value.trim() === ''
        ? NaN
        : Number(oddInput.value)
    );
  }

  if (title.length < 4 || title.length > 120) {
    toast('賽事標題需為 4～120 個字');
    return;
  }

  if (
    cards.length < 2 ||
    cards.length > MAX_OPTIONS
  ) {
    toast('每場需設定 2～16 個選項');
    return;
  }

  if (
    options.some(name =>
      name.length < 1 ||
      name.length > 40
    )
  ) {
    toast('每個選項名稱需為 1～40 個字');
    return;
  }

  if (new Set(options).size !== options.length) {
    toast('選項名稱不可重複');
    return;
  }

  if (
    odds.some(o =>
      !Number.isFinite(o) ||
      o < 1.01 ||
      o > 10 ||
      Math.abs(
        o * 100 - Math.round(o * 100)
      ) > 0.000001
    )
  ) {
    toast('賠率限 1.01～10.00，最多兩位小數');
    return;
  }

  if (
    !local ||
    Number.isNaN(closeDate.getTime()) ||
    closeDate.getTime() <= Date.now()
  ) {
    toast('請設定未來的封盤時間');
    return;
  }

  const button = $('createMarket');
  button.disabled = true;

  try {
    const ref = doc(
      collection(db, 'markets')
    );

    await runTransaction(db, async tx => {
      tx.set(ref, {
        title,
        options,
        odds,
        closesAt: Timestamp.fromDate(closeDate),
        status: 'open',
        createdAt: serverTimestamp()
      });
    });

    toast('🎉 賽事建立完成');

    $('newTitle').value = '';

    optionCards()
      .slice(2)
      .forEach(card => card.remove());

    optionCards().forEach((card, i) => {
      const nameInput = card.querySelector(
        'input:not([type="number"])'
      );

      const oddInput = card.querySelector(
        'input[type="number"]'
      );

      if (nameInput) {
        nameInput.value =
          i === 0 ? '會' : '不會';
      }

      if (oddInput) {
        oddInput.value = '1.80';
      }
    });

    refreshOptionLabels();

  } catch (error) {
    toast('建立賽事失敗：' + error.message);

  } finally {
    button.disabled = false;
  }
});

// =====================================
// 管理員：唯一置頂
// =====================================

async function togglePin(m) {
  if (!user || !isAdmin) {
    toast('只有管理員可以設定置頂');
    return;
  }

  const wasPinned = pinnedMarketId === m.id;

  const message = wasPinned
    ? `確定取消「${m.title}」的置頂？`
    : `確定將「${m.title}」設為全站唯一置頂賽事？`;

  if (!confirm(message)) return;

  try {
    // 單一文件 + 交易
    // 所有管理員共用同一個置頂 ID
    await runTransaction(db, async tx => {
      const snapshot = await tx.get(pinRef);

      const currentId = snapshot.exists()
        ? snapshot.data().marketId || ''
        : '';

      const nextId =
        currentId === m.id
          ? ''
          : m.id;

      tx.set(pinRef, {
        marketId: nextId,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid
      });
    });

    toast(
      wasPinned
        ? '📌 已取消置頂'
        : '📌 已設為全站唯一置頂賽事'
    );

  } catch (error) {
    toast('置頂設定失敗：' + error.message);
  }
}

// =====================================
// 管理員：封盤與公布結果
// =====================================

async function actionMarket(m, type, result = null) {
  const message = type === 'close'
    ? `確定封盤「${m.title}」？`
    : `確定公布「${m.options[result]}」為正確結果？此操作無法撤銷。`;

  if (!confirm(message)) return;

  try {
    const ref = doc(
      db,
      'markets',
      m.id
    );

    await runTransaction(db, async tx => {
      const snapshot = await tx.get(ref);

      const expected =
        type === 'close'
          ? 'open'
          : 'closed';

      if (
        !snapshot.exists() ||
        snapshot.data().status !== expected
      ) {
        throw Error('賽事狀態已變更');
      }

      if (type === 'close') {
        tx.update(ref, {
          status: 'closed'
        });
      } else {
        tx.update(ref, {
          status: 'settled',
          result
        });
      }
    });

    toast('操作完成');

  } catch (error) {
    toast('操作失敗：' + error.message);
  }
}

// =====================================
// 管理員：單筆結算
// =====================================

async function settleBet(b, m) {
  const betRef = doc(
    db,
    'bets',
    b.id
  );

  const userRef = doc(
    db,
    'users',
    b.uid
  );

  await runTransaction(db, async tx => {
    const [betSnap, userSnap] = await Promise.all([
      tx.get(betRef),
      tx.get(userRef)
    ]);

    if (
      !betSnap.exists() ||
      betSnap.data().status !== 'pending' ||
      !userSnap.exists()
    ) return;

    const data = betSnap.data();

    const won =
      data.choice === m.result;

    const payout = won
      ? Math.trunc(
          data.amount * data.odds
        )
      : 0;

    tx.update(betRef, {
      status: won ? 'won' : 'lost',
      payout
    });

    tx.update(userRef, {
      balance:
        userSnap.data().balance + payout,
      lastSettleId: b.id
    });
  });
}

// =====================================
// 管理員：批次結算
// =====================================

async function settleAll(m) {
  if (!confirm(
    `確定結算「${m.title}」的投注？請等待處理完成。`
  )) return;

  try {
    const snapshot = await getDocs(
      query(
        collection(db, 'bets'),
        where('marketId', '==', m.id)
      )
    );

    let count = 0;

    for (const d of snapshot.docs) {
      if (d.data().status !== 'pending') continue;

      await settleBet({
        id: d.id,
        ...d.data()
      }, m);

      count++;
    }

    toast(
      `結算完成，處理 ${count} 筆投注`
    );

  } catch (error) {
    toast(
      '結算中斷，可重新執行：' +
      error.message
    );
  }
}

// =====================================
// 管理員：賽事管理列表
// =====================================

function renderAdmin() {
  const box = $('adminMarkets');
  box.replaceChildren();

  if (!isAdmin) return;

  if (!markets.length) {
    box.textContent = '目前尚無賽事';
    return;
  }

  for (const m of sortedMarkets()) {
    const pinned =
      m.id === pinnedMarketId;

    const card = element(
      'div',
      null,
      'card market' +
        (pinned ? ' panda-pinned-market' : '')
    );

    if (pinned) {
      card.append(
        element(
          'div',
          '📌 目前置頂',
          'panda-pin-badge'
        )
      );
    }

    card.append(
      element('strong', m.title),
      element(
        'p',
        `狀態：${m.status}｜封盤：${formatDate(m.closesAt)}`,
        'small'
      )
    );

    const actions = element(
      'div',
      null,
      'panda-admin-actions'
    );

    // 新增：置頂／取消置頂
    const pinButton = element(
      'button',
      pinned
        ? '📌 取消置頂'
        : '📌 設為置頂',
      'btn panda-pin-button'
    );

    pinButton.type = 'button';

    pinButton.addEventListener('click', () => {
      togglePin(m);
    });

    actions.append(pinButton);

    // 原本：立即封盤
    if (m.status === 'open') {
      const button = element(
        'button',
        '🔒 立即封盤',
        'btn'
      );

      button.addEventListener('click', () => {
        actionMarket(m, 'close');
      });

      actions.append(button);
    }

    // 原本：公布結果
    if (m.status === 'closed') {
      (m.options || []).forEach((name, i) => {
        const button = element(
          'button',
          '公布結果：' + name,
          'btn'
        );

        button.addEventListener('click', () => {
          actionMarket(m, 'settle', i);
        });

        actions.append(button);
      });
    }

    // 原本：發放熊貓幣
    if (m.status === 'settled') {
      const button = element(
        'button',
        '💰 發放／補發熊貓幣',
        'btn'
      );

      button.addEventListener('click', () => {
        settleAll(m);
      });

      actions.append(button);
    }

    // 原本：同步投注趨勢
    const statsButton = element(
      'button',
      '📊 立即同步投注趨勢',
      'btn'
    );

    statsButton.addEventListener('click', () => {
      publishStats(true);
    });

    actions.append(statsButton);

    card.append(actions);
    box.append(card);
  }
}

// =====================================
// 封盤時間更新
// =====================================

setInterval(() => {
  if (user) update();
}, 30000);



/* =====================================
   管理員：熊貓幣發放中心
   單一玩家／全體玩家
   ===================================== */

let grantUsersUnsub = null;
let grantHistoryUnsub = null;
let grantPlayersLoaded = false;

// 每位管理員各自保存未完成的批次
function bulkGrantStorageKey() {
  return 'pandaBetBulkGrant_' + (user?.uid || '');
}

function getPendingBulkGrant() {
  if (!user) return null;

  try {
    const raw = localStorage.getItem(bulkGrantStorageKey());
    if (!raw) return null;

    const batch = JSON.parse(raw);

    if (
      !batch ||
      typeof batch.id !== 'string' ||
      !batch.id ||
      batch.adminUid !== user.uid ||
      !Array.isArray(batch.playerIds) ||
      !batch.playerIds.length ||
      new Set(batch.playerIds).size !== batch.playerIds.length ||
      batch.playerIds.some(id => typeof id !== 'string' || !id) ||
      !Number.isSafeInteger(batch.amount) ||
      batch.amount < 1 ||
      batch.amount > 100000 ||
      typeof batch.reason !== 'string' ||
      !batch.reason.trim() ||
      batch.reason.length > 120
    ) {
      return null;
    }

    return batch;
  } catch {
    return null;
  }
}

function savePendingBulkGrant(batch) {
  localStorage.setItem(
    bulkGrantStorageKey(),
    JSON.stringify(batch)
  );
}

function clearPendingBulkGrant() {
  localStorage.removeItem(bulkGrantStorageKey());
}

// 玩家下拉選單
function renderGrantPlayers() {
  const select = $('grantPlayer');
  if (!select) return;

  const previous = select.value;

  select.replaceChildren(
    new Option(
      grantPlayersLoaded ? '請選擇玩家' : '載入玩家中…',
      ''
    )
  );

  grantPlayers.forEach(p => {
    select.add(new Option(
      `${p.name || '匿名熊貓'}｜🪙 ${fmt(p.balance)}｜${p.id.slice(0, 8)}…`,
      p.id
    ));
  });

  if (grantPlayers.some(p => p.id === previous)) {
    select.value = previous;
  }

  renderGrantPreview();
}

// 發放預覽與按鈕狀態
function renderGrantPreview() {
  const mode = $('grantMode')?.value || 'single';
  const all = mode === 'all';
  const pending = getPendingBulkGrant();

  $('grantPlayerField')?.classList.toggle('hidden', all);
  $('grantSubmit')?.classList.toggle('hidden', all);
  $('grantAllSubmit')?.classList.toggle('hidden', !all);

  const selected = grantPlayers.find(
    p => p.id === $('grantPlayer')?.value
  );

  const rawAmount = $('grantAmount')?.value ?? '';
  const amount = Number(rawAmount);
  const reason = $('grantReason')?.value.trim() || '';

  const validAmount =
    rawAmount !== '' &&
    Number.isSafeInteger(amount) &&
    amount >= 1 &&
    amount <= 100000;

  const validReason =
    reason.length >= 1 &&
    reason.length <= 120;

  const validSingleBalance =
    !!selected &&
    Number.isSafeInteger(selected.balance) &&
    selected.balance >= 0 &&
    Number.isSafeInteger(selected.balance + amount);

  const validAllBalances =
    grantPlayersLoaded &&
    grantPlayers.length > 0 &&
    grantPlayers.every(p =>
      Number.isSafeInteger(p.balance) &&
      p.balance >= 0 &&
      Number.isSafeInteger(p.balance + amount)
    );

  const total = amount * grantPlayers.length;
  const validTotal = Number.isSafeInteger(total);

  const preview = $('grantPreview');

  if (preview) {
    if (all) {
      preview.textContent =
        validAmount && validAllBalances && validTotal
          ? `👥 發放人數：${fmt(grantPlayers.length)} 人`
            + `｜每人：${money(amount)}`
            + `｜總發放：${money(total)}`
            + `｜原因：${reason || '尚未填寫'}`
          : '請確認玩家名單及發放金額。';
    } else {
      preview.textContent =
        selected && validAmount && validSingleBalance
          ? `玩家：${selected.name || '匿名熊貓'}`
            + `｜原餘額：${money(selected.balance)}`
            + `｜補發：${money(amount)}`
            + `｜發放後：${money(selected.balance + amount)}`
          : '請選擇玩家並輸入 1～100,000 的整數金額。';
    }

    if (pending) {
      preview.textContent +=
        `\n⚠️ 尚有未完成的全體發放批次，請先繼續完成。`;
      preview.style.whiteSpace = 'pre-line';
    }
  }

  const singleButton = $('grantSubmit');
  if (singleButton) {
    singleButton.disabled =
      !isAdmin ||
      grantBusy ||
      !!pending ||
      !selected ||
      !validAmount ||
      !validSingleBalance ||
      !validReason;
  }

  const allButton = $('grantAllSubmit');
  if (allButton) {
    allButton.disabled =
      !isAdmin ||
      grantBusy ||
      !!pending ||
      !validAmount ||
      !validReason ||
      !validAllBalances ||
      !validTotal;
  }

  const resumeButton = $('grantAllResume');
  if (resumeButton) {
    resumeButton.classList.toggle(
      'hidden',
      !pending || !isAdmin
    );
    resumeButton.disabled = grantBusy;
  }

  if ($('grantMode')) {
    $('grantMode').disabled = grantBusy || !!pending;
  }

  if ($('grantAmount')) {
    $('grantAmount').disabled = grantBusy || !!pending;
  }

  if ($('grantReason')) {
    $('grantReason').disabled = grantBusy || !!pending;
  }
}

// 最近 50 筆紀錄
function renderGrantHistory(records) {
  const box = $('grantHistory');
  if (!box) return;

  box.replaceChildren();

  if (!records.length) {
    box.append(
      element('div', '目前沒有發放紀錄', 'muted')
    );
    return;
  }

  records.forEach(g => {
    const row = element('div', null, 'rowline');

    row.append(
      element(
        'strong',
        `${g.recipientName || '匿名熊貓'}｜+${fmt(g.amount)} 幣`
      ),
      element(
        'div',
        `原餘額 ${fmt(g.balanceBefore)} → 發放後 ${fmt(g.balanceAfter)}｜${g.reason || ''}`,
        'small'
      ),
      element(
        'div',
        `管理員：${g.adminName || g.adminUid || '未知'}｜${formatDate(g.createdAt)}`,
        'small'
      )
    );

    box.append(row);
  });
}

// 停止監聽
function stopCoinGrantListeners() {
  if (grantUsersUnsub) {
    grantUsersUnsub();
    grantUsersUnsub = null;
  }

  if (grantHistoryUnsub) {
    grantHistoryUnsub();
    grantHistoryUnsub = null;
  }

  grantPlayers = [];
  grantPlayersLoaded = false;
  renderGrantPlayers();
  renderGrantHistory([]);
}

// 開始監聽
function startCoinGrantListeners() {
  if (!user || !isAdmin) return;

  if (!grantUsersUnsub) {
    grantUsersUnsub = onSnapshot(
      collection(db, 'users'),
      snapshot => {
        grantPlayers = snapshot.docs
          .map(d => ({
            id: d.id,
            ...d.data()
          }))
          .sort((a, b) =>
            (a.name || '').localeCompare(
              b.name || '',
              'zh-Hant'
            )
          );

        grantPlayersLoaded = true;
        renderGrantPlayers();
      },
      error => {
        grantPlayersLoaded = false;
        renderGrantPreview();
        toast('玩家名單讀取失敗：' + error.message);
      }
    );
  }

  if (!grantHistoryUnsub) {
    grantHistoryUnsub = onSnapshot(
      query(
        collection(db, 'coinGrants'),
        orderBy('createdAt', 'desc'),
        limit(50)
      ),
      snapshot => {
        renderGrantHistory(
          snapshot.docs.map(d => ({
            id: d.id,
            ...d.data()
          }))
        );
      },
      error => toast(
        '發放紀錄讀取失敗：' + error.message
      )
    );
  }

  renderGrantPreview();

  const pending = getPendingBulkGrant();
  if (pending && $('grantStatus')) {
    $('grantStatus').textContent =
      '⚠️ 有尚未完成的全體發放批次';
  }
}

// 輸入時即時更新預覽
[
  'grantPlayer',
  'grantAmount',
  'grantReason',
  'grantMode'
].forEach(id => {
  $(id)?.addEventListener(
    id === 'grantPlayer' || id === 'grantMode'
      ? 'change'
      : 'input',
    renderGrantPreview
  );
});

// =====================================
// 共用：單一玩家安全發放交易
// =====================================

async function grantCoinsToPlayer({
  recipientUid,
  amount,
  reason,
  grantId
}) {
  if (!user || !isAdmin) {
    throw Error('管理員權限不足');
  }

  const adminUid = user.uid;
  const adminName = (
    user.displayName || '管理員'
  ).slice(0, 80);

  const grantRef = doc(db, 'coinGrants', grantId);
  const playerRef = doc(db, 'users', recipientUid);

  return runTransaction(db, async tx => {
    // 所有讀取先完成，再執行寫入
    const [grantSnap, playerSnap] = await Promise.all([
      tx.get(grantRef),
      tx.get(playerRef)
    ]);

    // 相同發放 ID 已存在：避免重複加幣
    if (grantSnap.exists()) {
      const existing = grantSnap.data();

      if (
        existing.recipientUid !== recipientUid ||
        existing.amount !== amount ||
        existing.reason !== reason ||
        existing.adminUid !== adminUid
      ) {
        throw Error('發放紀錄 ID 衝突');
      }

      return 'skipped';
    }

    if (!playerSnap.exists()) {
      throw Error(`玩家 ${recipientUid} 的帳戶不存在`);
    }

    const current = playerSnap.data();
    const before = current.balance;
    const after = before + amount;

    if (
      !Number.isSafeInteger(before) ||
      before < 0 ||
      !Number.isSafeInteger(after)
    ) {
      throw Error(`玩家 ${recipientUid} 的餘額資料異常`);
    }

    tx.set(grantRef, {
      recipientUid,
      recipientName: String(
        current.name || '匿名熊貓'
      ).slice(0, 80),
      amount,
      reason,
      balanceBefore: before,
      balanceAfter: after,
      adminUid,
      adminName,
      createdAt: serverTimestamp()
    });

    tx.update(playerRef, {
      balance: after,
      lastGrantId: grantRef.id
    });

    return 'granted';
  });
}

// =====================================
// 單一玩家發放
// =====================================

$('grantSubmit')?.addEventListener(
  'click',
  async () => {
    if (
      !user ||
      !isAdmin ||
      grantBusy ||
      getPendingBulkGrant() ||
      $('grantMode')?.value === 'all'
    ) return;

    const target = grantPlayers.find(
      p => p.id === $('grantPlayer').value
    );

    const rawAmount = $('grantAmount').value;
    const amount = Number(rawAmount);
    const reason = $('grantReason').value.trim();

    if (
      !target ||
      rawAmount === '' ||
      !Number.isSafeInteger(amount) ||
      amount < 1 ||
      amount > 100000 ||
      !reason ||
      reason.length > 120
    ) {
      toast('請確認玩家、金額與發放原因');
      return;
    }

    if (!confirm(
      `確定發放 ${fmt(amount)} 熊貓幣給「${target.name || '匿名熊貓'}」？\n原因：${reason}\n此操作不可撤銷。`
    )) return;

    grantBusy = true;
    renderGrantPreview();
    $('grantStatus').textContent = '發放處理中…';

    try {
      const grantRef = doc(
        collection(db, 'coinGrants')
      );

      await grantCoinsToPlayer({
        recipientUid: target.id,
        amount,
        reason,
        grantId: grantRef.id
      });

      $('grantStatus').textContent = '發放成功';
      $('grantReason').value = '活動獎勵';

      toast(`🪙 已發放 ${fmt(amount)} 幣`);
    } catch (error) {
      $('grantStatus').textContent = '發放失敗';
      toast('熊貓幣發放失敗：' + error.message);
    } finally {
      grantBusy = false;
      renderGrantPreview();
    }
  }
);

// =====================================
// 全體玩家：逐位發放與中斷續發
// =====================================

async function executeBulkGrant(batch) {
  if (
    !user ||
    !isAdmin ||
    grantBusy ||
    batch.adminUid !== user.uid
  ) return;

  grantBusy = true;
  renderGrantPreview();

  let granted = 0;
  let skipped = 0;

  try {
    for (let i = 0; i < batch.playerIds.length; i++) {
      if (
        !user ||
        !isAdmin ||
        user.uid !== batch.adminUid
      ) {
        throw Error('管理員登入狀態已變更');
      }

      const uid = batch.playerIds[i];

      $('grantStatus').textContent =
        `全體發放處理中：${fmt(i + 1)} / ${fmt(batch.playerIds.length)} 人`;

      const result = await grantCoinsToPlayer({
        recipientUid: uid,
        amount: batch.amount,
        reason: batch.reason,
        grantId: `${batch.id}_${uid}`
      });

      if (result === 'granted') {
        granted++;
      } else {
        skipped++;
      }
    }

    clearPendingBulkGrant();

    $('grantStatus').textContent =
      `🎉 全體發放完成！本次新增 ${fmt(granted)} 人，已發放略過 ${fmt(skipped)} 人。`;

    toast(
      `🎉 全體發放完成！每人 ${fmt(batch.amount)} 幣`
    );
  } catch (error) {
    $('grantStatus').textContent =
      `⚠️ 發放中斷：${error.message}。請點擊「繼續未完成的發放」。`;

    toast('全體發放尚未完成：' + error.message);
  } finally {
    grantBusy = false;
    renderGrantPreview();
  }
}

// 確認全體發放
$('grantAllSubmit')?.addEventListener(
  'click',
  async () => {
    if (
      !user ||
      !isAdmin ||
      grantBusy ||
      $('grantMode')?.value !== 'all'
    ) return;

    if (getPendingBulkGrant()) {
      toast('請先完成上一批全體發放');
      return;
    }

    const rawAmount = $('grantAmount').value;
    const amount = Number(rawAmount);
    const reason = $('grantReason').value.trim();

    if (
      rawAmount === '' ||
      !Number.isSafeInteger(amount) ||
      amount < 1 ||
      amount > 100000 ||
      !reason ||
      reason.length > 120
    ) {
      toast('請確認發放金額與原因');
      return;
    }

    if (
      !grantPlayersLoaded ||
      grantPlayers.length === 0 ||
      grantPlayers.some(p =>
        !Number.isSafeInteger(p.balance) ||
        p.balance < 0 ||
        !Number.isSafeInteger(p.balance + amount)
      )
    ) {
      toast('玩家名單或餘額異常，請先檢查');
      return;
    }

    const total = amount * grantPlayers.length;

    if (!Number.isSafeInteger(total)) {
      toast('總發放金額超出安全範圍');
      return;
    }

    const confirmed = confirm(
      `確定發放給全體玩家嗎？\n\n` +
      `發放人數：${fmt(grantPlayers.length)} 人\n` +
      `每人金額：${fmt(amount)} 幣\n` +
      `總發放：${fmt(total)} 幣\n` +
      `發放原因：${reason}\n\n` +
      `確認後將逐位發放，已成功的發放不可撤銷。`
    );

    if (!confirmed) return;

    const batchRef = doc(
      collection(db, 'coinGrants')
    );

    const batch = {
      id: batchRef.id,
      adminUid: user.uid,
      amount,
      reason,
      playerIds: grantPlayers.map(p => p.id)
    };

    try {
      // 發放前先儲存批次
      savePendingBulkGrant(batch);
    } catch {
      toast('無法保存發放批次，已取消操作');
      return;
    }

    await executeBulkGrant(batch);
  }
);

// 繼續未完成批次
$('grantAllResume')?.addEventListener(
  'click',
  async () => {
    if (!user || !isAdmin || grantBusy) return;

    const batch = getPendingBulkGrant();

    if (!batch) {
      toast('目前沒有待完成的發放批次');
      renderGrantPreview();
      return;
    }

    if (!confirm(
      `繼續上一批全體發放？\n\n` +
      `原始人數：${fmt(batch.playerIds.length)} 人\n` +
      `每人金額：${fmt(batch.amount)} 幣\n` +
      `原因：${batch.reason}\n\n` +
      `已成功發放的玩家將自動略過。`
    )) return;

    await executeBulkGrant(batch);
  }
);

// =====================================
// 初始畫面
// =====================================

renderRanking([]);
update();

