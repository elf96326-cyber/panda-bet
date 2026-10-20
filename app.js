
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {
  getFirestore,
  doc,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  Timestamp,
  getDocs
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

import { firebaseConfig } from './config.js';

const $ = id => document.getElementById(id);
const fmt = n => Number(n || 0).toLocaleString('zh-TW');

const allowed = u =>
  !!u &&
  u.emailVerified === true &&
  u.providerData.some(p => p.providerId === 'google.com');

const toast = s => {
  $('toast').textContent = s;
  $('toast').style.display = 'block';
  setTimeout(() => $('toast').style.display = 'none', 4200);
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

const cleanup = () => {
  unsubs.forEach(f => f());
  unsubs = [];
};

const listen = (q, cb) =>
  unsubs.push(
    onSnapshot(q, cb, e => toast('資料讀取失敗：' + e.message))
  );

const node = (tag, content, cls) => {
  const e = document.createElement(tag);
  if (content !== undefined) e.textContent = content;
  if (cls) e.className = cls;
  return e;
};

const odds = m => m.odds || [1.8, 1.8];

const dateText = t =>
  t?.toDate ? t.toDate().toLocaleString('zh-TW') : '未設定';

const open = m =>
  m.status === 'open' &&
  m.closesAt?.toMillis() > Date.now();

function update() {
  const bal = profile?.balance ?? 0;

  $('balance').textContent = '🪙 ' + (profile ? fmt(bal) : '—');
  $('statBalance').textContent = profile ? fmt(bal) : '—';
  $('statBets').textContent = profile ? fmt(bets.length) : '—';
  $('statOpen').textContent = fmt(markets.filter(open).length);

  renderMarkets();
  renderSelection();
  renderBets();
  renderAdmin();
}

function renderMarkets() {
  const box = $('markets');
  box.replaceChildren();

  if (!user) {
    box.textContent = '請先使用 Google 帳號登入';
    return;
  }

  if (!markets.length) {
    box.textContent = '尚無賽事，等待管理員建立。';
    return;
  }

  for (const m of markets) {
    const card = node('article', undefined, 'card market');

    card.append(
      node(
        'div',
        m.status === 'settled'
          ? '✅ 已公布結果'
          : open(m)
            ? '🟢 開放預測'
            : '🔒 已封盤',
        'small'
      ),
      node('h3', m.title),
      node('div', '封盤：' + dateText(m.closesAt), 'small')
    );

    const choices = node('div', undefined, 'choices');

    m.options.forEach((opt, i) => {
      const b = node(
        'button',
        undefined,
        'choice' +
          (selection?.id === m.id && selection.choice === i
            ? ' selected'
            : '')
      );

      b.append(
        node('span', opt),
        node('b', Number(odds(m)[i]).toFixed(2))
      );

      b.disabled = !open(m);

      b.onclick = () => {
        selection = { id: m.id, choice: i };
        update();
      };

      choices.append(b);
    });

    card.append(choices);
    box.append(card);
  }
}

function renderSelection() {
  const m = markets.find(x => x.id === selection?.id);
  const valid = m && open(m);

  $('betForm').classList.toggle('hidden', !valid);
  $('selection').classList.toggle('hidden', !!valid);

  if (!valid) {
    $('selection').textContent = '選擇開放市場的預測選項';
    return;
  }

  const o = odds(m)[selection.choice];
  const amount = Number($('amount').value) || 0;

  $('selectedName').textContent =
    m.title + '｜' + m.options[selection.choice];

  $('selectedOdds').textContent = Number(o).toFixed(2);
  $('estimated').textContent = '🪙 ' + fmt(Math.floor(amount * o));
}

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
    const m = markets.find(x => x.id === b.marketId);
    const line = node('div', undefined, 'rowline');

    line.append(
      node('strong', m?.title || '歷史市場'),
      node(
        'div',
        `選擇：${m?.options?.[b.choice] || b.choice}｜投入 ${fmt(b.amount)} 幣｜固定賠率 ${b.odds}`,
        'small'
      ),
      node(
        'div',
        `狀態：${
          {
            pending: '待結算',
            won: '🎉 預測成功',
            lost: '未命中'
          }[b.status] || b.status
        }｜已發放 ${fmt(b.payout)} 幣`,
        'small'
      )
    );

    box.append(line);
  }
}

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
    const row = node('div', undefined, 'rowline flex');

    row.append(
      node('span', `${i + 1}. ${u.name || '匿名熊貓'}`),
      node('strong', '🪙 ' + fmt(u.balance))
    );

    box.append(row);
  });
}

async function settleBet(b, m) {
  const bRef = doc(db, 'bets', b.id);
  const uRef = doc(db, 'users', b.uid);

  await runTransaction(db, async tx => {
    const [bs, us] = await Promise.all([
      tx.get(bRef),
      tx.get(uRef)
    ]);

    if (
      !bs.exists() ||
      bs.data().status !== 'pending' ||
      !us.exists()
    ) return;

    const payout =
      bs.data().choice === m.result
        ? Math.trunc(bs.data().amount * bs.data().odds)
        : 0;

    tx.update(bRef, {
      status: payout ? 'won' : 'lost',
      payout
    });

    tx.update(uRef, {
      balance: us.data().balance + payout,
      lastSettleId: b.id
    });
  });
}

async function settleAll(m) {
  if (
    !confirm(
      `為「${m.title}」逐筆結算尚未處理的預測？請勿關閉頁面。`
    )
  ) return;

  try {
    const snap = await getDocs(
      query(
        collection(db, 'bets'),
        where('marketId', '==', m.id)
      )
    );

    let count = 0;

    for (const d of snap.docs) {
      if (d.data().status === 'pending') {
        await settleBet(
          { id: d.id, ...d.data() },
          m
        );
        count++;
      }
    }

    toast(`結算處理完成：${count} 筆。可再次執行補處理。`);
  } catch (e) {
    toast('結算中斷，可重新執行：' + e.message);
  }
}

function renderAdmin() {
  const box = $('adminMarkets');
  box.replaceChildren();

  if (!isAdmin) return;

  for (const m of markets) {
    const card = node('div', undefined, 'card market');

    card.append(
      node('strong', m.title),
      node(
        'p',
        `狀態：${m.status}｜封盤：${dateText(m.closesAt)}`,
        'small'
      )
    );

    if (m.status === 'open') {
      const b = node('button', '🔒 立即封盤', 'btn');

      b.onclick = () => actionMarket(m, 'close');
      card.append(b);
    }

    if (m.status === 'closed') {
      m.options.forEach((opt, i) => {
        const b = node(
          'button',
          `公布結果：${opt}`,
          'btn'
        );

        b.style.marginRight = '8px';
        b.onclick = () => actionMarket(m, 'settle', i);
        card.append(b);
      });
    }

    if (m.status === 'settled') {
      const b = node(
        'button',
        '💰 發放／補發虛擬幣',
        'btn'
      );

      b.onclick = () => settleAll(m);
      card.append(b);
    }

    box.append(card);
  }
}

async function actionMarket(m, type, result) {
  if (
    !confirm(
      type === 'close'
        ? '確定立即封盤？'
        : `確定公布「${m.options[result]}」為結果？結果不可撤銷。`
    )
  ) return;

  try {
    await runTransaction(db, async tx => {
      const r = doc(db, 'markets', m.id);
      const s = await tx.get(r);

      if (
        !s.exists() ||
        s.data().status !==
          (type === 'close' ? 'open' : 'closed')
      ) {
        throw Error('賽事狀態已變更');
      }

      tx.update(
        r,
        type === 'close'
          ? { status: 'closed' }
          : { status: 'settled', result }
      );
    });

    toast('操作完成');
  } catch (e) {
    toast(e.message);
  }
}

// =====================================
// Google 登入按鈕修正版
// =====================================

const authButton = $('authButton');

let authReady = false;
let authBusy = false;

// Firebase 尚未確認登入狀態前，先停用按鈕
authButton.disabled = true;
authButton.textContent = '登入載入中…';

authButton.onclick = async () => {
  if (!authReady || authBusy) return;

  authBusy = true;
  authButton.disabled = true;

  try {
    if (auth.currentUser) {
      // 已登入：登出
      await signOut(auth);
    } else {
      // 尚未登入：直接開啟 Google 帳號選擇視窗
      const provider = new GoogleAuthProvider();

      provider.setCustomParameters({
        prompt: 'select_account'
      });

      const result = await signInWithPopup(
        auth,
        provider
      );

      if (!allowed(result.user)) {
        await signOut(auth);
        toast('請使用已驗證的 Google 帳號登入');
      }
    }
  } catch (e) {
    if (
      e.code !== 'auth/popup-closed-by-user' &&
      e.code !== 'auth/cancelled-popup-request'
    ) {
      toast('Google 登入失敗：' + e.message);
    }
  } finally {
    authBusy = false;
    authButton.disabled = !authReady;
  }
};

// =====================================
// Firebase 登入狀態監聽
// =====================================

onAuthStateChanged(auth, async u => {
  authReady = true;
  authButton.disabled = authBusy;

  if (u && !allowed(u)) {
    await signOut(auth);
    toast('Google 帳號驗證失敗');
    return;
  }

  cleanup();

  user = u;
  profile = null;
  markets = [];
  bets = [];
  selection = null;
  isAdmin = false;

  $('who').textContent =
    u?.displayName || '尚未登入';

  authButton.textContent =
    u ? '登出' : 'Google 登入';

  $('adminTab').classList.add('hidden');

  if (!u) {
    renderRanking([]);
    update();
    return;
  }

  try {
    const r = doc(db, 'users', u.uid);

    await runTransaction(db, async tx => {
      const s = await tx.get(r);

      if (!s.exists()) {
        tx.set(r, {
          name: (u.displayName || '熊貓玩家').slice(0, 80),
          balance: 10000,
          lastBetId: '',
          lastSettleId: '',
          createdAt: serverTimestamp()
        });
      }
    });

    listen(r, s => {
      profile = s.data();
      update();
    });

    listen(collection(db, 'markets'), s => {
      markets = s.docs.map(d => ({
        id: d.id,
        ...d.data()
      }));

      markets.sort(
        (a, b) =>
          (b.createdAt?.seconds || 0) -
          (a.createdAt?.seconds || 0)
      );

      update();
    });

    listen(
      query(
        collection(db, 'bets'),
        where('uid', '==', u.uid)
      ),
      s => {
        bets = s.docs
          .map(d => ({
            id: d.id,
            ...d.data()
          }))
          .sort(
            (a, b) =>
              (b.createdAt?.seconds || 0) -
              (a.createdAt?.seconds || 0)
          );

        update();
      }
    );

    listen(
      query(
        collection(db, 'users'),
        orderBy('balance', 'desc'),
        limit(50)
      ),
      s => renderRanking(
        s.docs.map(d => d.data())
      )
    );

    listen(doc(db, 'admins', u.uid), s => {
      isAdmin = s.exists();

      $('adminTab').classList.toggle(
        'hidden',
        !isAdmin
      );

      renderAdmin();
    });

  } catch (e) {
    toast('登入初始化失敗：' + e.message);
  }
});

// =====================================
// 頁面切換
// =====================================

document.querySelectorAll('[data-tab]').forEach(b => {
  b.onclick = () => {
    if (
      b.dataset.tab === 'admin' &&
      !isAdmin
    ) return;

    document.querySelectorAll('[data-tab]').forEach(x => {
      x.classList.toggle('active', x === b);
    });

    ['home', 'bets', 'ranking', 'admin'].forEach(id => {
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

$('amount').oninput = renderSelection;

document.querySelectorAll('[data-amount]').forEach(b => {
  b.onclick = () => {
    $('amount').value = b.dataset.amount;
    renderSelection();
  };
});

// =====================================
// 確認預測
// =====================================

$('placeBet').onclick = async () => {
  const m = markets.find(
    x => x.id === selection?.id
  );

  const amount = Number($('amount').value);

  if (
    !m ||
    !open(m) ||
    !Number.isSafeInteger(amount) ||
    amount < 10 ||
    amount > 10000 ||
    amount % 10 !== 0
  ) {
    toast('每筆限 10～10,000 幣，且為 10 的倍數');
    return;
  }

  if (amount > (profile?.balance || 0)) {
    toast('熊貓幣不足');
    return;
  }

  if (
    !confirm(
      `確認投入 ${fmt(amount)} 幣預測「${m.options[selection.choice]}」？`
    )
  ) return;

  const btn = $('placeBet');
  btn.disabled = true;

  try {
    const bRef = doc(collection(db, 'bets'));
    const uRef = doc(db, 'users', user.uid);
    const mRef = doc(db, 'markets', m.id);
    const choice = selection.choice;

    await runTransaction(db, async tx => {
      const [us, ms] = await Promise.all([
        tx.get(uRef),
        tx.get(mRef)
      ]);

      if (
        !us.exists() ||
        !ms.exists() ||
        us.data().balance < amount ||
        ms.data().status !== 'open' ||
        ms.data().closesAt.toMillis() <= Date.now()
      ) {
        throw Error('餘額不足或賽事已封盤');
      }

      const o = ms.data().odds[choice];

      tx.set(bRef, {
        uid: user.uid,
        marketId: m.id,
        choice,
        amount,
        odds: o,
        payout: 0,
        status: 'pending',
        createdAt: serverTimestamp()
      });

      tx.update(uRef, {
        balance: us.data().balance - amount,
        lastBetId: bRef.id
      });
    });

    toast('預測成功！已鎖定固定賠率');
    selection = null;
    update();

  } catch (e) {
    toast('預測失敗：' + e.message);
  } finally {
    btn.disabled = false;
  }
};

// =====================================
// 管理員建立賽事：自訂 A、B 賠率
// =====================================

$('createMarket').onclick = async () => {
  const title = $('newTitle').value.trim();

  const options = [
    $('newA').value.trim(),
    $('newB').value.trim()
  ];

  const local = $('newClose').value;

  const oddsA = Number($('newOddsA').value);
  const oddsB = Number($('newOddsB').value);

  const customOdds = [oddsA, oddsB];

  if (
    title.length < 4 ||
    title.length > 120 ||
    !options.every(
      x => x.length > 0 && x.length <= 40
    ) ||
    !local ||
    !Number.isFinite(new Date(local).getTime()) ||
    new Date(local) <= new Date()
  ) {
    toast('請填寫有效的賽事資料及未來封盤時間');
    return;
  }

  const validOdds = customOdds.every(o =>
    Number.isFinite(o) &&
    o >= 1.01 &&
    o <= 10 &&
    Math.abs(
      o * 100 - Math.round(o * 100)
    ) < 0.000001
  );

  if (
    $('newOddsA').value.trim() === '' ||
    $('newOddsB').value.trim() === '' ||
    !validOdds
  ) {
    toast('賠率請輸入 1.01～10.00，最多兩位小數');
    return;
  }

  try {
    const r = doc(collection(db, 'markets'));

    await runTransaction(db, async tx => {
      tx.set(r, {
        title,
        options,
        closesAt: Timestamp.fromDate(
          new Date(local)
        ),
        status: 'open',
        odds: customOdds,
        createdAt: serverTimestamp()
      });
    });

    toast('賽事建立完成！');
    $('newTitle').value = '';

  } catch (e) {
    toast('建立賽事失敗：' + e.message);
  }
};

// 每 30 秒更新開放市場狀態
setInterval(() => {
  if (user) update();
}, 30000);
