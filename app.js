
import {initializeApp} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {getAuth,GoogleAuthProvider,signInWithPopup,signOut,onAuthStateChanged} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {getFirestore,doc,collection,query,where,orderBy,limit,onSnapshot,runTransaction,serverTimestamp,Timestamp,getDocs,setDoc} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import {firebaseConfig} from './config.js';

// =====================================
// 基本設定
// =====================================

const $ = id => document.getElementById(id);

const fmt = n =>
  Number(n || 0).toLocaleString('zh-TW');

const allowed = u =>
  !!u &&
  u.emailVerified === true &&
  u.providerData.some(
    p => p.providerId === 'google.com'
  );

let toastTimer = null;

const toast = s => {
  const el = $('toast');
  el.textContent = s;
  el.style.display = 'block';

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    el.style.display = 'none';
  }, 4200);
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let user = null;
let profile = null;
let markets = [];
let bets = [];
let selection = null;
let isAdmin = false;
let unsubs = [];

// =====================================
// 市場投注趨勢
// =====================================

let marketStats = {};
let adminAllBets = [];
let adminBetsUnsub = null;
let statsPublishTimer = null;
let statsPublishing = false;
let statsQueued = false;
let publishedSignature = '';
let adminBetsLoaded = false;

const stopAdminStats = () => {
  if (adminBetsUnsub) {
    adminBetsUnsub();
    adminBetsUnsub = null;
  }

  clearTimeout(statsPublishTimer);

  adminAllBets = [];
  adminBetsLoaded = false;
  publishedSignature = '';
  statsQueued = false;
};

const statsSignature = () =>
  JSON.stringify([
    markets.map(m => [
      m.id,
      m.options?.length
    ]),
    adminAllBets
      .map(b => [
        b.id,
        b.marketId,
        b.uid,
        b.choice,
        b.amount
      ])
      .sort((a, b) =>
        a[0].localeCompare(b[0])
      )
  ]);

// 計算單一賽事的投注統計
function statsFromBets(m, records) {
  const amounts =
    Array(m.options.length).fill(0);

  const members = Array.from(
    {length: m.options.length},
    () => new Set()
  );

  let totalAmount = 0;
  let totalBets = 0;

  for (const b of records) {
    if (
      b.marketId !== m.id ||
      !Number.isInteger(b.choice) ||
      b.choice < 0 ||
      b.choice >= amounts.length ||
      !Number.isSafeInteger(b.amount) ||
      b.amount < 0 ||
      typeof b.uid !== 'string'
    ) {
      continue;
    }

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

// 管理員將統計發布到 Firestore
async function publishStats(force = false) {
  if (
    !user ||
    !isAdmin ||
    !adminBetsLoaded ||
    !markets.length
  ) {
    return;
  }

  if (statsPublishing) {
    statsQueued = true;
    return;
  }

  const sig = statsSignature();

  if (!force && sig === publishedSignature) {
    return;
  }

  statsPublishing = true;

  try {
    for (const m of markets) {
      if (
        !Array.isArray(m.options) ||
        m.options.length < 2
      ) {
        continue;
      }

      const data = statsFromBets(
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

    publishedSignature = sig;

    if (force) {
      toast('市場投注趨勢同步完成！');
    }

  } catch (e) {
    toast(
      '市場統計更新失敗：' +
      e.message
    );

  } finally {
    statsPublishing = false;

    if (statsQueued) {
      statsQueued = false;
      queueStatsPublish();
    }
  }
}

function queueStatsPublish() {
  if (!isAdmin || !adminBetsLoaded) {
    return;
  }

  clearTimeout(statsPublishTimer);

  if (statsPublishing) {
    statsQueued = true;
    return;
  }

  statsPublishTimer = setTimeout(
    () => publishStats(),
    1300
  );
}

// 管理員監聽所有投注
function startAdminStats() {
  if (
    adminBetsUnsub ||
    !user ||
    !isAdmin
  ) {
    return;
  }

  adminBetsUnsub = onSnapshot(
    collection(db, 'bets'),

    snap => {
      adminAllBets = snap.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));

      adminBetsLoaded = true;
      queueStatsPublish();
    },

    e => {
      adminBetsLoaded = false;

      toast(
        '管理員統計讀取失敗：' +
        e.message
      );
    }
  );
}

// =====================================
// Firestore 監聽與工具
// =====================================

const cleanup = () => {
  unsubs.forEach(f => f());
  unsubs = [];
};

const listen = (q, cb) => {
  const unsubscribe = onSnapshot(
    q,
    cb,
    e => toast(
      '資料讀取失敗：' +
      e.message
    )
  );

  unsubs.push(unsubscribe);
};

const node = (tag, content, cls) => {
  const e = document.createElement(tag);

  if (content !== undefined) {
    e.textContent = content;
  }

  if (cls) {
    e.className = cls;
  }

  return e;
};

const odds = m =>
  Array.isArray(m.odds)
    ? m.odds
    : [1.8, 1.8];

const dateText = t =>
  t?.toDate
    ? t.toDate().toLocaleString('zh-TW')
    : '未設定';

const open = m =>
  m.status === 'open' &&
  m.closesAt?.toMillis() > Date.now();

// =====================================
// 市場趨勢 CSS
// 不需要另外修改 index.html
// =====================================

const statsCss = document.createElement('style');

statsCss.textContent = `
.panda-stats {
  margin-top:18px;
  padding:15px;
  background:#10291d;
  border:1px solid #355543;
  border-radius:12px;
}

.panda-stats-heading {
  font-weight:800;
  margin-bottom:11px;
  color:#b4f0c7;
}

.panda-stats-summary {
  font-size:13px;
  margin-bottom:14px;
  color:#d9f4e2;
  line-height:1.7;
}

.panda-stat-line {
  margin:12px 0;
}

.panda-stat-top {
  display:flex;
  justify-content:space-between;
  gap:12px;
  font-size:13px;
  margin-bottom:6px;
}

.panda-stat-top span {
  overflow-wrap:anywhere;
}

.panda-stat-top strong {
  color:#8cf2b2;
  white-space:nowrap;
}

.panda-stat-track {
  height:9px;
  background:#30483a;
  border-radius:99px;
  overflow:hidden;
  margin-bottom:6px;
}

.panda-stat-fill {
  height:100%;
  background:#81e9a6;
  border-radius:99px;
  transition:width .25s;
}

.panda-stat-foot {
  color:#a4b7ac;
  font-size:11px;
  line-height:1.6;
  margin-top:14px;
}
`;

document.head.append(statsCss);

// =====================================
// 更新主要畫面
// =====================================

function update() {
  const bal = profile?.balance ?? 0;

  $('balance').textContent =
    '🪙 ' + (profile ? fmt(bal) : '—');

  $('statBalance').textContent =
    profile ? fmt(bal) : '—';

  $('statBets').textContent =
    profile ? fmt(bets.length) : '—';

  $('statOpen').textContent =
    fmt(markets.filter(open).length);

  renderMarkets();
  renderSelection();
  renderBets();
  renderAdmin();
}

// =====================================
// 顯示各選項投注趨勢
// =====================================

function renderStats(m) {
  const box = node(
    'section',
    undefined,
    'panda-stats'
  );

  box.append(
    node(
      'div',
      '📊 市場投注趨勢',
      'panda-stats-heading'
    )
  );

  const data = marketStats[m.id];

  if (
    !data ||
    !Array.isArray(data.amounts) ||
    data.amounts.length !== m.options.length ||
    !Array.isArray(data.counts) ||
    data.counts.length !== m.options.length
  ) {
    box.append(
      node(
        'div',
        '統計尚未發布，等待管理員同步。',
        'small'
      )
    );

    return box;
  }

  const total =
    Number(data.totalAmount) || 0;

  box.append(
    node(
      'div',
      `總投注額：🪙 ${fmt(total)}｜投注筆數：${fmt(data.totalBets)}`,
      'panda-stats-summary'
    )
  );

  m.options.forEach((name, i) => {
    const amount =
      Number(data.amounts[i]) || 0;

    const people =
      Number(data.counts[i]) || 0;

    const percent =
      total > 0
        ? amount / total * 100
        : 0;

    const line = node(
      'div',
      undefined,
      'panda-stat-line'
    );

    const top = node(
      'div',
      undefined,
      'panda-stat-top'
    );

    top.append(
      node('span', name),
      node(
        'strong',
        percent.toFixed(1) + '%'
      )
    );

    const track = node(
      'div',
      undefined,
      'panda-stat-track'
    );

    const fill = node(
      'div',
      undefined,
      'panda-stat-fill'
    );

    fill.style.width =
      percent.toFixed(3) + '%';

    track.append(fill);

    line.append(
      top,
      track,
      node(
        'div',
        `🪙 ${fmt(amount)}｜${fmt(people)} 位不重複玩家`,
        'small'
      )
    );

    box.append(line);
  });

  box.append(
    node(
      'div',
      '資料更新：' +
        dateText(data.updatedAt) +
        '｜依累計投注金額計算；同一玩家可支持多個選項',
      'panda-stat-foot'
    )
  );

  return box;
}

// =====================================
// 預測市場
// =====================================

function renderMarkets() {
  const box = $('markets');
  box.replaceChildren();

  if (!user) {
    box.textContent =
      '請先使用 Google 帳號登入';
    return;
  }

  if (!markets.length) {
    box.textContent =
      '尚無賽事，等待管理員建立。';
    return;
  }

  for (const m of markets) {
    const card = node(
      'article',
      undefined,
      'card market'
    );

    const statusText =
      m.status === 'settled'
        ? '✅ 已公布結果'
        : open(m)
          ? '🟢 開放預測'
          : '🔒 已封盤';

    card.append(
      node(
        'div',
        statusText,
        'small'
      ),

      node('h3', m.title),

      node(
        'div',
        '封盤：' +
          dateText(m.closesAt),
        'small'
      )
    );

    const choices = node(
      'div',
      undefined,
      'choices'
    );

    (m.options || []).forEach(
      (opt, i) => {
        const selected =
          selection?.id === m.id &&
          selection.choice === i;

        const b = node(
          'button',
          undefined,
          'choice' +
            (selected ? ' selected' : '')
        );

        b.type = 'button';

        b.append(
          node('span', opt),
          node(
            'b',
            Number(
              odds(m)[i] ?? 1.8
            ).toFixed(2)
          )
        );

        b.disabled = !open(m);

        b.onclick = () => {
          selection = {
            id: m.id,
            choice: i
          };

          update();
        };

        choices.append(b);
      }
    );

    card.append(
      choices,
      renderStats(m)
    );

    box.append(card);
  }
}

// =====================================
// 預測單
// =====================================

function renderSelection() {
  const m = markets.find(
    x => x.id === selection?.id
  );

  const valid =
    m &&
    open(m) &&
    Number.isInteger(selection?.choice) &&
    selection.choice >= 0 &&
    selection.choice < m.options.length;

  $('betForm').classList.toggle(
    'hidden',
    !valid
  );

  $('selection').classList.toggle(
    'hidden',
    !!valid
  );

  if (!valid) {
    $('selection').textContent =
      '選擇開放市場的預測選項';

    return;
  }

  const o = Number(
    odds(m)[selection.choice]
  );

  const amount =
    Number($('amount').value) || 0;

  $('selectedName').textContent =
    m.title +
    '｜' +
    m.options[selection.choice];

  $('selectedOdds').textContent =
    o.toFixed(2);

  $('estimated').textContent =
    '🪙 ' +
    fmt(Math.floor(amount * o));
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
    box.textContent = '尚無預測紀錄';
    return;
  }

  for (const b of bets) {
    const m = markets.find(
      x => x.id === b.marketId
    );

    const line = node(
      'div',
      undefined,
      'rowline'
    );

    const optionName =
      m?.options?.[b.choice] ??
      `選項 ${Number(b.choice) + 1}`;

    const statusName = {
      pending: '待結算',
      won: '🎉 預測成功',
      lost: '未命中'
    }[b.status] || b.status;

    line.append(
      node(
        'strong',
        m?.title || '歷史市場'
      ),

      node(
        'div',
        `選擇：${optionName}｜投入 ${fmt(b.amount)} 幣｜固定賠率 ${b.odds}`,
        'small'
      ),

      node(
        'div',
        `狀態：${statusName}｜已發放 ${fmt(b.payout)} 幣`,
        'small'
      )
    );

    box.append(line);
  }
}

// =====================================
// 排行榜
// =====================================

function renderRanking(docs) {
  const box = $('leaderboard');
  box.replaceChildren();

  if (!user) {
    box.textContent = '請先登入';
    return;
  }

  if (!docs.length) {
    box.textContent = '暫無玩家';
    return;
  }

  docs.forEach((u, i) => {
    const row = node(
      'div',
      undefined,
      'rowline flex'
    );

    row.append(
      node(
        'span',
        `${i + 1}. ${u.name || '匿名熊貓'}`
      ),

      node(
        'strong',
        '🪙 ' + fmt(u.balance)
      )
    );

    box.append(row);
  });
}

// =====================================
// 單筆結算
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

  await runTransaction(
    db,
    async tx => {
      const [betSnap, userSnap] =
        await Promise.all([
          tx.get(betRef),
          tx.get(userRef)
        ]);

      if (
        !betSnap.exists() ||
        betSnap.data().status !== 'pending' ||
        !userSnap.exists()
      ) {
        return;
      }

      const betData = betSnap.data();

      const payout =
        betData.choice === m.result
          ? Math.trunc(
              betData.amount *
              betData.odds
            )
          : 0;

      tx.update(betRef, {
        status: payout ? 'won' : 'lost',
        payout
      });

      tx.update(userRef, {
        balance:
          userSnap.data().balance +
          payout,

        lastSettleId: b.id
      });
    }
  );
}

// =====================================
// 批次結算
// =====================================

async function settleAll(m) {
  if (
    !confirm(
      `為「${m.title}」逐筆結算尚未處理的預測？請勿關閉頁面。`
    )
  ) {
    return;
  }

  try {
    const snap = await getDocs(
      query(
        collection(db, 'bets'),
        where('marketId', '==', m.id)
      )
    );

    let count = 0;

    for (const d of snap.docs) {
      if (
        d.data().status === 'pending'
      ) {
        await settleBet(
          {
            id: d.id,
            ...d.data()
          },
          m
        );

        count++;
      }
    }

    toast(
      `結算處理完成：${count} 筆。可再次執行補處理。`
    );

  } catch (e) {
    toast(
      '結算中斷，可重新執行：' +
      e.message
    );
  }
}

// =====================================
// 管理後台賽事列表
// =====================================

function renderAdmin() {
  const box = $('adminMarkets');
  box.replaceChildren();

  if (!isAdmin) {
    return;
  }

  for (const m of markets) {
    const card = node(
      'div',
      undefined,
      'card market'
    );

    card.append(
      node('strong', m.title),

      node(
        'p',
        `狀態：${m.status}｜封盤：${dateText(m.closesAt)}`,
        'small'
      )
    );

    if (m.status === 'open') {
      const b = node(
        'button',
        '🔒 立即封盤',
        'btn'
      );

      b.onclick = () =>
        actionMarket(m, 'close');

      card.append(b);
    }

    if (m.status === 'closed') {
      (m.options || []).forEach(
        (opt, i) => {
          const b = node(
            'button',
            `公布結果：${opt}`,
            'btn'
          );

          b.style.marginRight = '8px';
          b.style.marginBottom = '8px';

          b.onclick = () =>
            actionMarket(
              m,
              'settle',
              i
            );

          card.append(b);
        }
      );
    }

    if (m.status === 'settled') {
      const b = node(
        'button',
        '💰 發放／補發虛擬幣',
        'btn'
      );

      b.onclick = () =>
        settleAll(m);

      card.append(b);
    }

    const statsButton = node(
      'button',
      '📊 立即同步投注趨勢',
      'btn'
    );

    statsButton.style.margin =
      '8px 8px 0 0';

    statsButton.onclick = () =>
      publishStats(true);

    card.append(statsButton);
    box.append(card);
  }
}

// =====================================
// 管理員封盤／公布結果
// =====================================

async function actionMarket(
  m,
  type,
  result
) {
  const message =
    type === 'close'
      ? '確定立即封盤？'
      : `確定公布「${m.options[result]}」為結果？結果不可撤銷。`;

  if (!confirm(message)) {
    return;
  }

  try {
    await runTransaction(
      db,
      async tx => {
        const marketRef = doc(
          db,
          'markets',
          m.id
        );

        const snap =
          await tx.get(marketRef);

        const expected =
          type === 'close'
            ? 'open'
            : 'closed';

        if (
          !snap.exists() ||
          snap.data().status !== expected
        ) {
          throw Error(
            '賽事狀態已變更'
          );
        }

        tx.update(
          marketRef,
          type === 'close'
            ? {status: 'closed'}
            : {
                status: 'settled',
                result
              }
        );
      }
    );

    toast('操作完成');

  } catch (e) {
    toast(e.message);
  }
}

// =====================================
// Google 登入
// =====================================

const authButton =
  $('authButton');

let authReady = false;
let authBusy = false;

authButton.disabled = true;
authButton.textContent =
  '登入載入中…';

authButton.onclick =
  async () => {
    if (
      !authReady ||
      authBusy
    ) {
      return;
    }

    authBusy = true;
    authButton.disabled = true;

    try {
      if (auth.currentUser) {
        await signOut(auth);

      } else {
        const provider =
          new GoogleAuthProvider();

        provider.setCustomParameters({
          prompt: 'select_account'
        });

        const result =
          await signInWithPopup(
            auth,
            provider
          );

        if (!allowed(result.user)) {
          await signOut(auth);

          toast(
            '請使用已驗證的 Google 帳號登入'
          );
        }
      }

    } catch (e) {
      if (
        e.code !==
          'auth/popup-closed-by-user' &&
        e.code !==
          'auth/cancelled-popup-request'
      ) {
        toast(
          'Google 登入失敗：' +
          e.message
        );
      }

    } finally {
      authBusy = false;
      authButton.disabled = !authReady;
    }
  };

// =====================================
// 登入狀態與資料監聽
// =====================================

onAuthStateChanged(
  auth,
  async u => {
    authReady = true;
    authButton.disabled = authBusy;

    if (u && !allowed(u)) {
      await signOut(auth);

      toast(
        'Google 帳號驗證失敗'
      );

      return;
    }

    cleanup();
    stopAdminStats();

    marketStats = {};
    user = u;
    profile = null;
    markets = [];
    bets = [];
    selection = null;
    isAdmin = false;

    $('who').textContent =
      u?.displayName ||
      '尚未登入';

    authButton.textContent =
      u ? '登出' : 'Google 登入';

    $('adminTab').classList.add(
      'hidden'
    );

    if (!u) {
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

      await runTransaction(
        db,
        async tx => {
          const snap =
            await tx.get(userRef);

          if (!snap.exists()) {
            tx.set(
              userRef,
              {
                name:
                  (
                    u.displayName ||
                    '熊貓玩家'
                  ).slice(0, 80),

                balance: 10000,
                lastBetId: '',
                lastSettleId: '',
                createdAt:
                  serverTimestamp()
              }
            );
          }
        }
      );

      // 玩家餘額
      listen(
        userRef,
        snap => {
          profile = snap.data();
          update();
        }
      );

      // 所有預測賽事
      listen(
        collection(
          db,
          'markets'
        ),

        snap => {
          markets = snap.docs.map(
            d => ({
              id: d.id,
              ...d.data()
            })
          );

          markets.sort(
            (a, b) =>
              (
                b.createdAt?.seconds ||
                0
              ) -
              (
                a.createdAt?.seconds ||
                0
              )
          );

          update();
          queueStatsPublish();
        }
      );

      // 公開市場統計
      listen(
        collection(
          db,
          'marketStats'
        ),

        snap => {
          marketStats =
            Object.fromEntries(
              snap.docs.map(
                d => [
                  d.id,
                  d.data()
                ]
              )
            );

          renderMarkets();
        }
      );

      // 自己的投注紀錄
      listen(
        query(
          collection(
            db,
            'bets'
          ),
          where(
            'uid',
            '==',
            u.uid
          )
        ),

        snap => {
          bets = snap.docs
            .map(d => ({
              id: d.id,
              ...d.data()
            }))
            .sort(
              (a, b) =>
                (
                  b.createdAt?.seconds ||
                  0
                ) -
                (
                  a.createdAt?.seconds ||
                  0
                )
            );

          update();
        }
      );

      // 熊貓幣排行榜
      listen(
        query(
          collection(
            db,
            'users'
          ),

          orderBy(
            'balance',
            'desc'
          ),

          limit(50)
        ),

        snap => {
          renderRanking(
            snap.docs.map(
              d => d.data()
            )
          );
        }
      );

      // 管理員身分
      listen(
        doc(
          db,
          'admins',
          u.uid
        ),

        snap => {
          isAdmin = snap.exists();

          $('adminTab').classList.toggle(
            'hidden',
            !isAdmin
          );

          renderAdmin();

          if (isAdmin) {
            startAdminStats();

          } else {
            stopAdminStats();
          }
        }
      );

    } catch (e) {
      toast(
        '登入初始化失敗：' +
        e.message
      );
    }
  }
);

// =====================================
// 頁面切換
// =====================================

document
  .querySelectorAll('[data-tab]')
  .forEach(b => {
    b.onclick = () => {
      if (
        b.dataset.tab === 'admin' &&
        !isAdmin
      ) {
        return;
      }

      document
        .querySelectorAll(
          '[data-tab]'
        )
        .forEach(x => {
          x.classList.toggle(
            'active',
            x === b
          );
        });

      [
        'home',
        'bets',
        'ranking',
        'admin'
      ].forEach(id => {
        $(id).classList.toggle(
          'hidden',
          id !== b.dataset.tab
        );
      });
    };
  });

// =====================================
// 投注金額
// =====================================

$('amount').oninput =
  renderSelection;

document
  .querySelectorAll(
    '[data-amount]'
  )
  .forEach(b => {
    b.onclick = () => {
      $('amount').value =
        b.dataset.amount;

      renderSelection();
    };
  });

// =====================================
// 玩家確認投注
// =====================================

$('placeBet').onclick =
  async () => {
    const m = markets.find(
      x => x.id === selection?.id
    );

    const amount = Number(
      $('amount').value
    );

    const choice =
      selection?.choice;

    if (
      !m ||
      !open(m) ||
      !Number.isInteger(choice) ||
      choice < 0 ||
      choice >= m.options.length ||
      !Number.isSafeInteger(amount) ||
      amount < 10 ||
      amount > 10000 ||
      amount % 10 !== 0
    ) {
      toast(
        '請選擇有效選項；每筆限 10～10,000 幣，且為 10 的倍數'
      );

      return;
    }

    if (
      amount >
      (profile?.balance || 0)
    ) {
      toast('熊貓幣不足');
      return;
    }

    if (
      !confirm(
        `確認投入 ${fmt(amount)} 幣預測「${m.options[choice]}」？`
      )
    ) {
      return;
    }

    const btn =
      $('placeBet');

    btn.disabled = true;

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

      await runTransaction(
        db,
        async tx => {
          const [us, ms] =
            await Promise.all([
              tx.get(userRef),
              tx.get(marketRef)
            ]);

          if (
            !us.exists() ||
            !ms.exists()
          ) {
            throw Error(
              '找不到玩家或賽事資料'
            );
          }

          const marketData =
            ms.data();

          if (
            us.data().balance <
              amount ||
            marketData.status !==
              'open' ||
            marketData.closesAt.toMillis() <=
              Date.now() ||
            !Array.isArray(
              marketData.options
            ) ||
            choice >=
              marketData.options.length ||
            marketData.options[choice] !==
              m.options[choice]
          ) {
            throw Error(
              '餘額不足、選項已變更或賽事已封盤'
            );
          }

          const o =
            (
              marketData.odds ||
              [1.8, 1.8]
            )[choice];

          if (
            typeof o !== 'number' ||
            !Number.isFinite(o) ||
            o < 1.01 ||
            o > 10
          ) {
            throw Error(
              '賠率資料異常'
            );
          }

          tx.set(
            betRef,
            {
              uid: user.uid,
              marketId: m.id,
              choice,
              amount,
              odds: o,
              payout: 0,
              status: 'pending',
              createdAt:
                serverTimestamp()
            }
          );

          tx.update(
            userRef,
            {
              balance:
                us.data().balance -
                amount,

              lastBetId:
                betRef.id
            }
          );
        }
      );

      toast(
        '預測成功！已鎖定固定賠率'
      );

      selection = null;
      update();

    } catch (e) {
      toast(
        '預測失敗：' +
        e.message
      );

    } finally {
      btn.disabled = false;
    }
  };

// =====================================
// 管理員：動態新增與移除選項
// =====================================

const optionBox =
  $('adminOptions');

const addOptionButton =
  $('addMarketOption');

const MAX_OPTIONS = 16;

let nextOptionId = 2;

function optionCards() {
  return Array.from(
    optionBox.querySelectorAll(
      '.admin-option'
    )
  );
}

function refreshOptionLabels() {
  const cards = optionCards();

  cards.forEach((card, i) => {
    const heading =
      card.querySelector(
        '.admin-option-actions strong'
      );

    if (heading) {
      heading.textContent =
        `選項 ${i + 1}`;
    }

    let remove =
      card.querySelector(
        '.admin-option-remove'
      );

    if (!remove) {
      remove = node(
        'button',
        '移除',
        'btn admin-option-remove'
      );

      remove.type = 'button';

      card
        .querySelector(
          '.admin-option-actions'
        )
        .append(remove);
    }

    remove.disabled =
      cards.length <= 2;

    remove.onclick = () => {
      if (
        optionCards().length <= 2
      ) {
        return;
      }

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

addOptionButton.onclick = () => {
  if (
    optionCards().length >=
    MAX_OPTIONS
  ) {
    toast(
      '每場最多 16 個選項'
    );

    return;
  }

  const id = nextOptionId++;

  const card = node(
    'div',
    undefined,
    'admin-option'
  );

  const actions = node(
    'div',
    undefined,
    'admin-option-actions'
  );

  actions.append(
    node('strong', '新選項')
  );

  const nameLabel = node(
    'label',
    '選項名稱'
  );

  nameLabel.htmlFor =
    `optionName${id}`;

  const nameInput = node(
    'input',
    undefined,
    'field'
  );

  nameInput.id =
    `optionName${id}`;

  nameInput.maxLength = 40;

  nameInput.placeholder =
    '例如：T1';

  const oddsLabel = node(
    'label',
    '賠率'
  );

  oddsLabel.htmlFor =
    `optionOdds${id}`;

  const oddsInput = node(
    'input',
    undefined,
    'field'
  );

  oddsInput.id =
    `optionOdds${id}`;

  oddsInput.type = 'number';
  oddsInput.min = '1.01';
  oddsInput.max = '10';
  oddsInput.step = '0.01';
  oddsInput.value = '1.80';
  oddsInput.inputMode = 'decimal';

  card.append(
    actions,
    nameLabel,
    nameInput,
    oddsLabel,
    oddsInput
  );

  optionBox.append(card);

  refreshOptionLabels();
  nameInput.focus();
};

refreshOptionLabels();

// =====================================
// 管理員：建立多選項賽事
// =====================================

$('createMarket').onclick =
  async () => {
    if (!isAdmin) {
      toast(
        '只有管理員可以建立賽事'
      );

      return;
    }

    const title =
      $('newTitle').value.trim();

    const local =
      $('newClose').value;

    const cards =
      optionCards();

    const options = cards.map(
      card =>
        card.querySelector(
          'input:not([type="number"])'
        )?.value.trim() ?? ''
    );

    const oddsInputs =
      cards.map(
        card =>
          card.querySelector(
            'input[type="number"]'
          )
      );

    const customOdds =
      oddsInputs.map(
        input =>
          Number(input?.value)
      );

    const closeDate =
      new Date(local);

    if (
      title.length < 4 ||
      title.length > 120 ||
      !local ||
      Number.isNaN(
        closeDate.getTime()
      ) ||
      closeDate <= new Date() ||
      cards.length < 2 ||
      cards.length > MAX_OPTIONS ||
      !options.every(
        x =>
          x.length > 0 &&
          x.length <= 40
      )
    ) {
      toast(
        '請填寫有效的賽事資料、2～16 個選項及未來封盤時間'
      );

      return;
    }

    if (
      new Set(options).size !==
      options.length
    ) {
      toast(
        '選項名稱不可重複'
      );

      return;
    }

    const oddsValid =
      customOdds.every(
        o =>
          Number.isFinite(o) &&
          o >= 1.01 &&
          o <= 10 &&
          Math.abs(
            o * 100 -
            Math.round(o * 100)
          ) < 0.000001
      );

    if (
      oddsInputs.some(
        input =>
          !input ||
          input.value.trim() === ''
      ) ||
      !oddsValid
    ) {
      toast(
        '賠率請輸入 1.01～10.00，最多兩位小數'
      );

      return;
    }

    const btn =
      $('createMarket');

    btn.disabled = true;

    try {
      const marketRef = doc(
        collection(
          db,
          'markets'
        )
      );

      await runTransaction(
        db,
        async tx => {
          tx.set(
            marketRef,
            {
              title,
              options,

              closesAt:
                Timestamp.fromDate(
                  closeDate
                ),

              status: 'open',
              odds: customOdds,

              createdAt:
                serverTimestamp()
            }
          );
        }
      );

      toast(
        '賽事建立完成！'
      );

      $('newTitle').value = '';

    } catch (e) {
      toast(
        '建立賽事失敗：' +
        e.message
      );

    } finally {
      btn.disabled = false;
    }
  };

// =====================================
// 定期更新封盤狀態
// =====================================

setInterval(
  () => {
    if (user) {
      update();
    }
  },
  30000
);
