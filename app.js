
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

// =====================================
// 基本設定
// =====================================

const $ = id => document.getElementById(id);

const fmt = n =>
  Number(n || 0).toLocaleString('zh-TW');

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 16;
const MIN_ODDS = 1.01;
const MAX_ODDS = 10;

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

let authReady = false;
let authBusy = false;

// =====================================
// Firestore 即時監聽
// =====================================

const cleanup = () => {
  unsubs.forEach(f => f());
  unsubs = [];
};

const listen = (q, cb) => {
  const unsubscribe = onSnapshot(
    q,
    cb,
    e => toast('資料讀取失敗：' + e.message)
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

const validOdds = value =>
  Number.isFinite(value) &&
  value >= MIN_ODDS &&
  value <= MAX_ODDS &&
  Math.abs(
    value * 100 - Math.round(value * 100)
  ) < 0.000001;

// =====================================
// 更新畫面
// =====================================

function update() {
  const balance = profile?.balance ?? 0;

  $('balance').textContent =
    '🪙 ' + (profile ? fmt(balance) : '—');

  $('statBalance').textContent =
    profile ? fmt(balance) : '—';

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
// 預測市場：支援多選項
// =====================================

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
      node('div', statusText, 'small'),
      node('h3', m.title),
      node(
        'div',
        '封盤：' + dateText(m.closesAt),
        'small'
      )
    );

    const choices = node(
      'div',
      undefined,
      'choices'
    );

    const options = Array.isArray(m.options)
      ? m.options
      : [];

    options.forEach((option, index) => {
      const selected =
        selection?.id === m.id &&
        selection.choice === index;

      const button = node(
        'button',
        undefined,
        'choice' + (selected ? ' selected' : '')
      );

      button.type = 'button';

      const optionName = node(
        'span',
        option
      );

      const optionOdds = node(
        'b',
        Number(odds(m)[index] ?? 1.8).toFixed(2)
      );

      button.append(
        optionName,
        optionOdds
      );

      button.disabled = !open(m);

      button.onclick = () => {
        selection = {
          id: m.id,
          choice: index
        };

        update();
      };

      choices.append(button);
    });

    card.append(choices);
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

  const selectedOdds =
    Number(odds(m)[selection.choice] ?? 1.8);

  const amount =
    Number($('amount').value) || 0;

  $('selectedName').textContent =
    m.title +
    '｜' +
    m.options[selection.choice];

  $('selectedOdds').textContent =
    selectedOdds.toFixed(2);

  $('estimated').textContent =
    '🪙 ' +
    fmt(Math.floor(amount * selectedOdds));
}

// =====================================
// 我的預測紀錄
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
      `選項 ${b.choice + 1}`;

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
        `選擇：${optionName}｜投入 ${fmt(b.amount)} 幣｜固定賠率 ${Number(b.odds).toFixed(2)}`,
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

  docs.forEach((u, index) => {
    const row = node(
      'div',
      undefined,
      'rowline flex'
    );

    row.append(
      node(
        'span',
        `${index + 1}. ${u.name || '匿名熊貓'}`
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

  await runTransaction(db, async tx => {
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
            betData.amount * betData.odds
          )
        : 0;

    tx.update(betRef, {
      status: payout ? 'won' : 'lost',
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
// 批次逐筆結算
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
      if (d.data().status === 'pending') {
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
// 管理員賽事列表
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
      const button = node(
        'button',
        '🔒 立即封盤',
        'btn'
      );

      button.onclick = () =>
        actionMarket(m, 'close');

      card.append(button);
    }

    if (m.status === 'closed') {
      m.options.forEach((option, index) => {
        const button = node(
          'button',
          `公布結果：${option}`,
          'btn'
        );

        button.style.marginRight = '8px';
        button.style.marginBottom = '8px';

        button.onclick = () =>
          actionMarket(
            m,
            'settle',
            index
          );

        card.append(button);
      });
    }

    if (m.status === 'settled') {
      const button = node(
        'button',
        '💰 發放／補發虛擬幣',
        'btn'
      );

      button.onclick = () =>
        settleAll(m);

      card.append(button);
    }

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

        const expectedStatus =
          type === 'close'
            ? 'open'
            : 'closed';

        if (
          !snap.exists() ||
          snap.data().status !== expectedStatus
        ) {
          throw Error('賽事狀態已變更');
        }

        tx.update(
          marketRef,
          type === 'close'
            ? { status: 'closed' }
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

const authButton = $('authButton');

authButton.disabled = true;
authButton.textContent = '登入載入中…';

authButton.onclick = async () => {
  if (!authReady || authBusy) {
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
// Firebase 登入狀態監聽
// =====================================

onAuthStateChanged(
  auth,
  async u => {
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
            tx.set(userRef, {
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
            });
          }
        }
      );

      listen(userRef, snap => {
        profile = snap.data();
        update();
      });

      listen(
        collection(db, 'markets'),
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
        }
      );

      listen(
        query(
          collection(db, 'bets'),
          where('uid', '==', u.uid)
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

      listen(
        query(
          collection(db, 'users'),
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
  .forEach(button => {
    button.onclick = () => {
      if (
        button.dataset.tab ===
          'admin' &&
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
            x === button
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
          id !==
            button.dataset.tab
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
  .forEach(button => {
    button.onclick = () => {
      $('amount').value =
        button.dataset.amount;

      renderSelection();
    };
  });

// =====================================
// 玩家確認預測
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
        '每筆限 10～10,000 幣，且為 10 的倍數，請確認賽事及選項'
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

    const button =
      $('placeBet');

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

      await runTransaction(
        db,
        async tx => {
          const [userSnap, marketSnap] =
            await Promise.all([
              tx.get(userRef),
              tx.get(marketRef)
            ]);

          if (
            !userSnap.exists() ||
            !marketSnap.exists()
          ) {
            throw Error(
              '找不到玩家或賽事資料'
            );
          }

          const marketData =
            marketSnap.data();

          if (
            userSnap.data().balance <
              amount ||
            marketData.status !==
              'open' ||
            marketData.closesAt.toMillis() <=
              Date.now()
          ) {
            throw Error(
              '餘額不足或賽事已封盤'
            );
          }

          if (
            !Array.isArray(
              marketData.options
            ) ||
            choice >=
              marketData.options.length
          ) {
            throw Error(
              '預測選項無效'
            );
          }

          const marketOdds =
            Array.isArray(
              marketData.odds
            )
              ? marketData.odds
              : [1.8, 1.8];

          const selectedOdds =
            Number(
              marketOdds[choice]
            );

          if (
            !validOdds(
              selectedOdds
            )
          ) {
            throw Error(
              '賽事賠率設定無效'
            );
          }

          tx.set(betRef, {
            uid: user.uid,
            marketId: m.id,
            choice,
            amount,
            odds: selectedOdds,
            payout: 0,
            status: 'pending',
            createdAt:
              serverTimestamp()
          });

          tx.update(userRef, {
            balance:
              userSnap.data().balance -
              amount,

            lastBetId:
              betRef.id
          });
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
      button.disabled = false;
    }
  };

// =====================================
// 管理員：動態新增／刪除選項
// =====================================

const adminOptions =
  $('adminOptions');

const addOptionButton =
  $('addMarketOption');

function optionLabel(index) {
  return String.fromCharCode(
    65 + index
  );
}

function refreshAdminOptions() {
  const cards = [
    ...adminOptions.querySelectorAll(
      '.admin-option'
    )
  ];

  cards.forEach(
    (card, index) => {
      const title =
        card.querySelector(
          '.admin-option-actions strong'
        );

      if (title) {
        title.textContent =
          `選項 ${optionLabel(index)}`;
      }

      const removeButton =
        card.querySelector(
          '.admin-option-remove'
        );

      if (removeButton) {
        removeButton.disabled =
          cards.length <=
          MIN_OPTIONS;
      }
    }
  );

  addOptionButton.disabled =
    cards.length >=
    MAX_OPTIONS;

  addOptionButton.textContent =
    cards.length >=
    MAX_OPTIONS
      ? '已達 16 個選項上限'
      : `＋ 新增一個選項（目前 ${cards.length}/${MAX_OPTIONS}）`;
}

function createAdminOption(
  name = '',
  odd = '1.80'
) {
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

  const title = node(
    'strong',
    '新增選項'
  );

  const removeButton = node(
    'button',
    '移除',
    'btn admin-option-remove'
  );

  removeButton.type =
    'button';

  removeButton.onclick =
    () => {
      const count =
        adminOptions.querySelectorAll(
          '.admin-option'
        ).length;

      if (
        count <=
        MIN_OPTIONS
      ) {
        toast(
          '每場賽事至少需要兩個選項'
        );

        return;
      }

      card.remove();
      refreshAdminOptions();
    };

  actions.append(
    title,
    removeButton
  );

  const nameLabel = node(
    'label',
    '選項名稱'
  );

  const nameInput = node(
    'input'
  );

  nameInput.className =
    'field';

  nameInput.type =
    'text';

  nameInput.maxLength =
    40;

  nameInput.placeholder =
    '例如：T1';

  nameInput.value =
    name;

  nameInput.dataset.field =
    'option-name';

  const oddsLabel = node(
    'label',
    '賠率'
  );

  const oddsInput = node(
    'input'
  );

  oddsInput.className =
    'field';

  oddsInput.type =
    'number';

  oddsInput.min =
    '1.01';

  oddsInput.max =
    '10';

  oddsInput.step =
    '0.01';

  oddsInput.inputMode =
    'decimal';

  oddsInput.value =
    odd;

  oddsInput.dataset.field =
    'option-odds';

  card.append(
    actions,
    nameLabel,
    nameInput,
    oddsLabel,
    oddsInput
  );

  return card;
}

// 原本 HTML 內建的 A、B 選項
// 保留原本輸入框，避免影響舊版結構
function initializeAdminOptions() {
  const existingCards = [
    ...adminOptions.querySelectorAll(
      '.admin-option'
    )
  ];

  existingCards.forEach(
    card => {
      const nameInput =
        card.querySelector(
          'input:not([type="number"])'
        );

      const oddsInput =
        card.querySelector(
          'input[type="number"]'
        );

      if (nameInput) {
        nameInput.dataset.field =
          'option-name';
      }

      if (oddsInput) {
        oddsInput.dataset.field =
          'option-odds';
      }

      const actions =
        card.querySelector(
          '.admin-option-actions'
        );

      if (
        actions &&
        !actions.querySelector(
          '.admin-option-remove'
        )
      ) {
        const removeButton =
          node(
            'button',
            '移除',
            'btn admin-option-remove'
          );

        removeButton.type =
          'button';

        removeButton.onclick =
          () => {
            const count =
              adminOptions.querySelectorAll(
                '.admin-option'
              ).length;

            if (
              count <=
              MIN_OPTIONS
            ) {
              toast(
                '每場賽事至少需要兩個選項'
              );

              return;
            }

            card.remove();
            refreshAdminOptions();
          };

        actions.append(
          removeButton
        );
      }
    }
  );

  refreshAdminOptions();
}

addOptionButton.onclick =
  () => {
    const count =
      adminOptions.querySelectorAll(
        '.admin-option'
      ).length;

    if (
      count >=
      MAX_OPTIONS
    ) {
      toast(
        '每場賽事最多 16 個選項'
      );

      return;
    }

    adminOptions.append(
      createAdminOption()
    );

    refreshAdminOptions();
  };

initializeAdminOptions();

// =====================================
// 管理員：建立多選項賽事
// =====================================

$('createMarket').onclick =
  async () => {
    if (!user || !isAdmin) {
      toast(
        '只有管理員可以建立賽事'
      );

      return;
    }

    const title =
      $('newTitle').value.trim();

    const local =
      $('newClose').value;

    const cards = [
      ...adminOptions.querySelectorAll(
        '.admin-option'
      )
    ];

    const options = [];
    const customOdds = [];

    for (const card of cards) {
      const nameInput =
        card.querySelector(
          '[data-field="option-name"]'
        );

      const oddsInput =
        card.querySelector(
          '[data-field="option-odds"]'
        );

      const name =
        nameInput?.value.trim() ||
        '';

      const rawOdds =
        oddsInput?.value.trim() ||
        '';

      const odd =
        Number(rawOdds);

      if (
        !name ||
        name.length > 40
      ) {
        toast(
          '每個選項都必須填寫名稱，最多 40 字'
        );

        return;
      }

      if (
        !rawOdds ||
        !validOdds(odd)
      ) {
        toast(
          '賠率請輸入 1.01～10.00，最多兩位小數'
        );

        return;
      }

      options.push(name);
      customOdds.push(odd);
    }

    if (
      cards.length <
        MIN_OPTIONS ||
      cards.length >
        MAX_OPTIONS
    ) {
      toast(
        '每場賽事必須設定 2～16 個選項'
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

    const closeDate =
      new Date(local);

    if (
      title.length < 4 ||
      title.length > 120 ||
      !local ||
      !Number.isFinite(
        closeDate.getTime()
      ) ||
      closeDate <= new Date()
    ) {
      toast(
        '請填寫有效的賽事標題及未來封盤時間'
      );

      return;
    }

    const button =
      $('createMarket');

    button.disabled = true;

    try {
      const marketRef =
        doc(
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
        '多選項賽事建立完成！'
      );

      $('newTitle').value =
        '';

      // 建立完成後恢復為預設兩個選項
      adminOptions.replaceChildren(
        createAdminOption(
          '會',
          '1.80'
        ),
        createAdminOption(
          '不會',
          '1.80'
        )
      );

      refreshAdminOptions();

    } catch (e) {
      toast(
        '建立賽事失敗：' +
        e.message
      );

    } finally {
      button.disabled =
        false;
    }
  };

// =====================================
// 每 30 秒更新市場狀態
// =====================================

setInterval(
  () => {
    if (user) {
      update();
    }
  },
  30000
);
