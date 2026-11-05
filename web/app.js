/*
 * 界面层：把 core.js 算出的结果画出来，并通过 WebView2 消息和 C# 外壳通信。
 * 所有用户数据都走 textContent / DOM 属性，整个界面不使用 innerHTML，
 * 存档内容因此不可能被当成代码执行。
 */
(function () {
  'use strict';

  const C = window.Core;
  const webview = window.chrome && window.chrome.webview;
  const boot = window.__HOST__ || {};
  const STORAGE_KEY = 'work-encourager';
  const SIZES = { mini: { w: 300 }, card: { w: 324 }, panel: { w: 396, h: 720 } };
  const STATUS_TEXT = {
    working: '工作中',
    lunch: '午休中',
    overtime: '该下班了',
    before: '还没上班',
    settled: '已下班',
    rest: '休息中',
    leave: '休假中',
  };
  const TABS = [
    ['schedule', '排班'],
    ['wishes', '心愿'],
    ['records', '记录'],
    ['settings', '参数设置'],
  ];

  const post = (msg) => {
    if (webview) webview.postMessage(msg);
  };

  function readSaved() {
    let text = boot.data;
    if (text == null && !webview) {
      try {
        text = localStorage.getItem(STORAGE_KEY);
      } catch (e) {
        text = null;
      }
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  const hasSavedData = !!readSaved();
  const state = C.normalizeState(readSaved(), Date.now());
  if (!(state.salary.monthly > 0)) {
    // 还没配置好：直接打开参数设置页填月薪。
    state.ui.view = 'panel';
    state.ui.tab = 'settings';
  } else if (state.ui.view === 'panel') {
    // 上次退出时停在展开面板，这次启动（可能是开机自启）也回到不占地方的小窗。
    state.ui.view = 'card';
  }

  function save() {
    const text = JSON.stringify(state);
    if (webview) {
      post({ type: 'save', data: text });
    } else {
      try {
        localStorage.setItem(STORAGE_KEY, text);
      } catch (e) {
        /* 预览环境没有存储时忽略 */
      }
    }
  }

  const initial = new Date();
  const ui = {
    card: {},
    cardKey: null,
    calendar: { y: initial.getFullYear(), m: initial.getMonth() },
    records: { y: initial.getFullYear(), m: initial.getMonth() },
    brush: `shift:${state.schedule.shifts[0].id}`,
    lastShift: state.schedule.shifts[0].id,
    half: null,
    editingRecord: null,
    wishRefs: new Map(),
    surplusRef: null,
    tabLive: null,
    dragId: null,
    dialog: null,
    autostart: boot.autostart === true,
    autostartEl: null,
    tooltipAt: 0,
    lastWin: '',
    day: C.dateKey(initial),
    audio: null,
  };

  /* ---------- DOM 工具 ---------- */
  const $ = (sel) => document.querySelector(sel);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k in el && k !== 'list') el[k] = v;
        else el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid);
    }
    return el;
  }

  const setText = (el, text) => {
    if (el && el.textContent !== text) el.textContent = text;
  };

  /* 1.5 显示成 1.5，8 显示成 8，不带多余的小数。 */
  const fmtNumber = (n) => String(Math.round(n * 100) / 100);

  const ICONS = {
    pin: 'M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6z M12 15v6',
    shrink: 'M4 14h6v6 M20 10h-6V4 M14 10l7-7 M3 21l7-7',
    grow: 'M15 3h6v6 M9 21H3v-6 M21 3l-7 7 M3 21l7-7',
    menu: 'M4 6h16 M4 12h16 M4 18h16',
    collapse: 'M6 15l6-6 6 6',
    close: 'M6 6l12 12 M18 6L6 18',
    eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    eyeOff: 'M3 3l18 18 M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.1 3.9 M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a10.6 10.6 0 0 0 5.4-1.4 M9.9 9.9a3 3 0 0 0 4.2 4.2',
    up: 'M6 15l6-6 6 6',
    down: 'M6 9l6 6 6-6',
    left: 'M15 6l-6 6 6 6',
    right: 'M9 6l6 6-6 6',
    edit: 'M4 20h4L19 9l-4-4L4 16v4z M13.5 6.5l4 4',
    trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
    plus: 'M12 5v14 M5 12h14',
    grip: 'M9 6h.01 M15 6h.01 M9 12h.01 M15 12h.01 M9 18h.01 M15 18h.01',
    check: 'M5 12l5 5 9-10',
    gift: 'M4 11h16v9H4z M3 7h18v4H3z M12 7v13 M12 7c-1-3-5-4-6-2s2 2 6 2z M12 7c1-3 5-4 6-2s-2 2-6 2z',
  };

  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  function iconButton(name, label, onclick, opts) {
    const o = opts || {};
    return h('button', { class: `icon-btn${o.active ? ' active' : ''}`, title: label, 'aria-label': label, disabled: !!o.disabled, onclick }, icon(name));
  }

  function segmented(options, value, onChange) {
    const wrap = h('div', { class: 'seg', role: 'group' });
    const paint = (current) => {
      for (const btn of wrap.children) btn.classList.toggle('on', btn.dataset.value === current);
    };
    for (const [v, label] of options) {
      const btn = h('button', {
        onclick: () => {
          paint(v);
          onChange(v);
        },
      }, label);
      btn.dataset.value = v;
      wrap.append(btn);
    }
    paint(value);
    return wrap;
  }

  /* ---------- 窗口 ---------- */
  function syncWindow() {
    const view = state.ui.view;
    let height = view === 'panel' ? SIZES.panel.h : Math.ceil($('#app').getBoundingClientRect().height);
    if (ui.dialog) height = Math.max(height, ui.dialog.box.scrollHeight + 22);
    const width = SIZES[view].w;
    const key = `${width}x${height}|${state.ui.pinned}|${state.ui.yieldFullscreen}`;
    if (key === ui.lastWin) return;
    ui.lastWin = key;
    post({ type: 'window', width, height, topmost: state.ui.pinned, yieldFullscreen: state.ui.yieldFullscreen });
  }

  function startDrag(e) {
    if (e.button !== 0 || e.target.closest('button, input, select, label, summary')) return;
    post({ type: 'drag' });
  }

  function setView(view) {
    state.ui.view = view;
    save();
    render();
  }

  function openTab(tab) {
    state.ui.tab = tab;
    if (tab === 'records') C.markReviewed(state);
    state.ui.view = 'panel';
    save();
    render();
  }

  function togglePin() {
    state.ui.pinned = !state.ui.pinned;
    save();
    ui.cardKey = null;
    frame();
    syncWindow();
  }

  function toggleMoney() {
    state.ui.hideMoney = !state.ui.hideMoney;
    save();
    ui.cardKey = null;
    frame();
  }

  function hideToTray() {
    if (!state.ui.trayHintShown) {
      state.ui.trayHintShown = true;
      save();
      post({ type: 'notify', title: '上班鼓励器还在运行', body: '点击右下角托盘图标可以重新打开，右键可以退出。', popup: false });
    }
    post({ type: 'hide' });
  }

  function chime() {
    if (!state.ui.sound) return;
    try {
      const ctx = ui.audio || (ui.audio = new AudioContext());
      [[660, 0], [880, 0.16], [1175, 0.32]].forEach(([freq, offset]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const t = ctx.currentTime + offset;
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.55);
      });
    } catch (e) {
      /* 没有音频设备时不影响其他功能 */
    }
  }

  /* ---------- 卡片 ---------- */
  function shiftText(inst) {
    return inst.workSegs.length ? `${C.fmtHM(inst.workStart)}–${C.fmtHM(inst.workEnd)}` : `${inst.shift.start}–${inst.shift.end}`;
  }

  function currentMonthUnscheduled(now) {
    if (state.schedule.mode !== 'monthly') return false;
    const d = new Date(now);
    return C.workDayCount(state.schedule, d.getFullYear(), d.getMonth()) === 0;
  }

  function cardKeyFor(st, now) {
    const head = C.activeWishes(state)[0];
    return [
      state.ui.view,
      st.kind,
      st.inst ? st.inst.key : '',
      C.markText(st.mark),
      state.ui.hideMoney,
      state.ui.pinned,
      state.salary.monthly > 0,
      C.unreviewedRecords(state).length,
      currentMonthUnscheduled(now),
      head ? head.id : '',
      head ? head.name : '',
      state.overtime.mode,
    ].join('|');
  }

  function renderBanners(now) {
    const out = [];
    if (!(state.salary.monthly > 0)) {
      out.push(h('div', { class: 'banner' }, h('span', null, '还没填月薪，金额暂时都是 0。'), h('button', { onclick: () => openTab('settings') }, '去填写')));
    }
    const unreviewed = C.unreviewedRecords(state).length;
    if (unreviewed > 0) {
      out.push(h('div', { class: 'banner' }, h('span', null, `有 ${unreviewed} 天没点下班，已按正常下班时间结算。`), h('button', { onclick: () => openTab('records') }, '核对')));
    }
    if (currentMonthUnscheduled(now)) {
      out.push(h('div', { class: 'banner' }, h('span', null, `${new Date(now).getMonth() + 1} 月还没排班。`), h('button', { onclick: () => openTab('schedule') }, '去排班')));
    }
    return out;
  }

  function renderAmount(c) {
    c.amountCur = h('span', { class: 'cur' }, '¥');
    c.amountInt = h('span', { class: 'int' });
    c.amountDec = h('span', { class: 'dec' });
    return h('div', { class: `amount${state.ui.hideMoney ? ' masked' : ''}` }, c.amountCur, c.amountInt, c.amountDec);
  }

  function heroLabel(st) {
    const mark = C.markText(st.mark);
    if (st.kind === 'before') return mark ? `${mark}，距离上班还有` : '距离上班还有';
    if (st.kind === 'rest') {
      const today = mark ? `今天${mark}` : '今天休息';
      return st.next ? `${today}，距离下次上班` : today;
    }
    if (st.kind === 'leave') return `今天${mark}`;
    if (st.kind === 'settled') return '今日已结算';
    return '今日已赚';
  }

  function renderHero(st, c) {
    c.heroLabel = h('div', { class: 'hero-label' }, heroLabel(st));
    c.heroSub = h('div', { class: 'hero-sub' });
    if (st.kind === 'before' || st.kind === 'rest') {
      c.countdown = h('div', { class: 'countdown' });
      return h('div', { class: 'hero' }, c.heroLabel, st.next && c.countdown, c.heroSub);
    }
    return h('div', { class: 'hero' }, c.heroLabel, renderAmount(c), c.heroSub);
  }

  function renderWishStrip(c) {
    const head = C.activeWishes(state)[0];
    if (!head) {
      const filled = C.filledWishes(state)[0];
      return h('button', { class: 'wish-strip empty', onclick: () => openTab('wishes') }, icon('gift'), filled ? `「${filled.name}」蓄满了，去看看` : '许一个小心愿');
    }
    c.wishMoney = h('span', { class: 'money' });
    c.wishBar = h('i');
    c.wishEta = h('div', { class: 'eta' });
    return h('button', { class: 'wish-strip', title: '查看心愿队列', onclick: () => openTab('wishes') },
      h('div', { class: 'row' }, h('span', { class: 'name' }, icon('gift'), h('span', null, head.name)), c.wishMoney),
      h('div', { class: 'progress' }, c.wishBar),
      c.wishEta);
  }

  function renderCard(st, now) {
    const top = $('#top');
    const view = state.ui.view;
    const c = {};
    ui.card = c;
    top.className = `kind-${st.kind}`;
    top.replaceChildren();

    if (view === 'mini') {
      c.dot = h('span', { class: 'dot' });
      c.miniAmount = h('span', { class: 'm-amount' });
      c.miniInfo = h('span', { class: 'm-info' });
      top.append(h('div', { class: 'mini', title: STATUS_TEXT[st.kind], onmousedown: startDrag },
        c.dot,
        c.miniAmount,
        c.miniInfo,
        h('span', { class: 'spacer' }),
        st.kind === 'overtime' && h('button', { class: 'btn primary', onclick: settleNow }, '下班结算'),
        iconButton('grow', '展开小窗', () => setView('card')),
        iconButton('close', '隐藏到托盘', hideToTray)));
      return;
    }

    c.dot = h('span', { class: 'dot' });
    c.status = h('span');
    c.time = h('span', { class: 'time' });
    c.date = h('span', { class: 'date' });

    top.append(
      h('header', { class: 'bar', onmousedown: startDrag },
        h('span', { class: 'status' }, c.dot, c.status),
        h('span', { class: 'spacer' }),
        iconButton(state.ui.hideMoney ? 'eyeOff' : 'eye', state.ui.hideMoney ? '显示金额' : '隐藏金额', toggleMoney, { active: state.ui.hideMoney }),
        iconButton('pin', state.ui.pinned ? '取消置顶' : '窗口置顶', togglePin, { active: state.ui.pinned }),
        view === 'card' && iconButton('shrink', '迷你模式', () => setView('mini')),
        iconButton(view === 'panel' ? 'collapse' : 'menu', view === 'panel' ? '收起' : '排班、心愿和记录', () => setView(view === 'panel' ? 'card' : 'panel')),
        iconButton('close', '隐藏到托盘', hideToTray)),
      h('div', { class: 'clock', onmousedown: startDrag }, c.time, c.date),
      ...renderBanners(now),
      renderHero(st, c));

    if (st.kind === 'working' || st.kind === 'lunch' || st.kind === 'overtime') {
      c.bar = h('i');
      c.progressLeft = h('span');
      c.progressRight = h('span');
      top.append(h('div', { class: 'shift-progress' },
        h('div', { class: 'progress' }, c.bar),
        h('div', { class: 'progress-text' }, c.progressLeft, c.progressRight)));
    }
    if (st.kind === 'overtime') {
      top.append(h('div', { class: 'card-actions' }, h('button', { class: 'btn primary', onclick: settleNow }, '下班结算')));
    } else if (st.kind === 'working' || st.kind === 'lunch') {
      top.append(h('div', { class: 'card-actions right' }, h('button', { class: 'link quiet', onclick: settleNow }, '提前下班')));
    }
    if (view === 'card') top.append(renderWishStrip(c));
    top.append(h('div', { class: 'card-end' }));
  }

  function fillAmount(c, value) {
    if (state.ui.hideMoney) {
      setText(c.amountInt, '••••••');
      setText(c.amountDec, '');
      return;
    }
    const text = C.fmtMoney(value, 4);
    setText(c.amountInt, text.slice(0, -2));
    setText(c.amountDec, text.slice(-2));
  }

  function etaText(item, blocked, now) {
    if (blocked === 'no-salary') return '填好月薪后才能计算';
    if (blocked === 'no-share') return '存入比例是 0，暂时不会积累';
    if (item.remaining <= 1e-6) return '今天就能蓄满，结算后入账';
    if (!item.reachable) return '当前排班下算不出完成时间';
    const estimate = item.projected ? '，未排班的月份按已有安排估算' : '';
    return `还需工作 ${C.fmtWork(item.workSeconds)} · 预计 ${C.fmtEta(item.eta, now)}${estimate}`;
  }

  function nextText(next) {
    return `${C.fmtDate(next.workStart)} ${C.fmtHM(next.workStart)} 上班`;
  }

  function updateCard(st, now, fc) {
    const c = ui.card;
    const hide = state.ui.hideMoney;
    setText(c.time, C.fmtClock(now));
    setText(c.date, C.fmtDate(now));
    setText(c.status, st.kind === 'leave' ? C.markText(st.mark) : STATUS_TEXT[st.kind]);

    if (state.ui.view === 'mini') {
      updateMini(st, now, c, hide);
      return;
    }

    const markNote = st.mark ? `${C.markText(st.mark)} · ` : '';
    if (st.kind === 'working' || st.kind === 'lunch' || st.kind === 'overtime') {
      fillAmount(c, st.earn.total);
      c.bar.style.width = `${(st.progress * 100).toFixed(2)}%`;
    }
    if (st.kind === 'working') {
      const rate = hide || !(st.earn.rate > 0) ? '' : `每秒 +¥${C.fmtMoney(st.earn.rate, 4)} · `;
      setText(c.heroSub, `${rate}${markNote}班次 ${shiftText(st.inst)}`);
      setText(c.progressLeft, `距下班 ${C.fmtCountdown(st.inst.workEnd - now)}`);
      setText(c.progressRight, `${(st.progress * 100).toFixed(1)}%`);
    } else if (st.kind === 'lunch') {
      setText(c.heroSub, `午休 ${st.inst.shift.breakStart}–${st.inst.shift.breakEnd}，不计薪`);
      setText(c.progressLeft, `距下午上班 ${C.fmtCountdown(st.target - now)}`);
      setText(c.progressRight, `${(st.progress * 100).toFixed(1)}%`);
    } else if (st.kind === 'overtime') {
      setText(c.heroSub, hide || state.overtime.mode === 'none'
        ? (state.overtime.mode === 'none' ? '已到下班时间，不计加班费' : '已到下班时间')
        : `其中加班费 +¥${C.fmtMoney(st.earn.overtime)}`);
      setText(c.progressLeft, `已过下班时间 ${C.fmtDuration(st.earn.otSeconds)}`);
      setText(c.progressRight, shiftText(st.inst));
    } else if (st.kind === 'settled') {
      fillAmount(c, st.record.total);
      setText(c.heroSub, st.next ? `距离下次上班 ${C.fmtCountdown(st.target - now)} · ${C.fmtDate(st.next.workStart)}` : '后面还没有排班');
    } else if (st.kind === 'leave') {
      fillAmount(c, C.todayEarned(st));
      const ratio = `按 ${fmtNumber(st.inst.ratio * 100)}% 计薪`;
      setText(c.heroSub, st.next ? `${ratio} · 距下次上班 ${C.fmtCountdown(st.target - now)}` : ratio);
    } else if (st.kind === 'before') {
      setText(c.countdown, C.fmtCountdown(st.target - now));
      setText(c.heroSub, hide ? `今天 ${shiftText(st.inst)}` : `今天 ${shiftText(st.inst)} · 日薪 ¥${C.fmtMoney(st.wage)}`);
    } else {
      setText(c.countdown, st.next ? C.fmtCountdown(st.target - now) : '');
      setText(c.heroSub, st.next ? nextText(st.next) : '后面还没有排班');
    }

    if (c.wishEta && fc.items.length) {
      const item = fc.items[0];
      const pct = item.wish.budget > 0 ? (item.saved / item.wish.budget) * 100 : 0;
      setText(c.wishMoney, hide ? `${pct.toFixed(1)}%` : `¥${C.fmtMoney(item.saved)} / ¥${C.fmtMoney(item.wish.budget)}`);
      c.wishBar.style.width = `${Math.min(100, pct).toFixed(2)}%`;
      setText(c.wishEta, etaText(item, fc.blocked, now));
    }
  }

  function updateMini(st, now, c, hide) {
    const amountEl = c.miniAmount;
    const moneyText = (v, decimals) => (hide ? '¥ ••••' : `¥${C.fmtMoney(v, decimals)}`);
    amountEl.classList.toggle('time', st.kind === 'before' || st.kind === 'rest');
    if (st.kind === 'working') {
      setText(amountEl, moneyText(st.earn.total, 4));
      setText(c.miniInfo, `距下班 ${C.fmtCountdown(st.inst.workEnd - now)}`);
    } else if (st.kind === 'lunch') {
      setText(amountEl, moneyText(st.earn.total, 2));
      setText(c.miniInfo, `午休 ${C.fmtCountdown(st.target - now)}`);
    } else if (st.kind === 'overtime') {
      setText(amountEl, moneyText(st.earn.total, 2));
      setText(c.miniInfo, '');
    } else if (st.kind === 'settled') {
      setText(amountEl, moneyText(st.record.total, 2));
      setText(c.miniInfo, '今日已结算');
    } else if (st.kind === 'leave') {
      setText(amountEl, moneyText(C.todayEarned(st), 2));
      setText(c.miniInfo, `今天${C.markText(st.mark)}`);
    } else if (st.next) {
      setText(amountEl, C.fmtCountdown(st.target - now));
      setText(c.miniInfo, '后上班');
    } else {
      setText(amountEl, '休息中');
      setText(c.miniInfo, '还没有排班');
    }
  }

  /* ---------- 标签页 ---------- */
  function renderTabs() {
    const tabs = $('#tabs');
    tabs.replaceChildren();
    ui.tabLive = null;
    if (state.ui.view !== 'panel') return;
    const body = h('div', { class: 'tab-body' });
    tabs.append(
      h('nav', { class: 'tabbar', role: 'tablist' },
        TABS.map(([id, label]) => h('button', {
          class: state.ui.tab === id ? 'on' : '',
          role: 'tab',
          onclick: () => {
            state.ui.tab = id;
            if (id === 'records') C.markReviewed(state);
            save();
            ui.cardKey = null;
            renderTabs();
            frame();
          },
        }, label))),
      body);
    ui.wishRefs = new Map();
    ui.surplusRef = null;
    ui.autostartEl = null;
    ({ schedule: renderScheduleTab, wishes: renderWishesTab, records: renderRecordsTab, settings: renderSettingsTab })[state.ui.tab](body);
  }

  /* ----- 排班 ----- */
  function shiftClass(id) {
    const i = state.schedule.shifts.findIndex((x) => x.id === id);
    return `s${Math.max(0, i) % 4}`;
  }

  function brushOptions() {
    return [
      ...state.schedule.shifts.map((s, i) => ({ key: `shift:${s.id}`, kind: 'shift', id: s.id, label: s.name, cls: `s${i % 4}` })),
      { key: 'off', kind: 'off', label: '休息', cls: 'b-off' },
      ...Object.keys(C.MARK_NAMES).map((type) => ({ key: type, kind: 'mark', type, label: C.MARK_NAMES[type], cls: `m-${type}` })),
    ];
  }

  function currentBrush() {
    const options = brushOptions();
    return options.find((b) => b.key === ui.brush) || options[0];
  }

  /* 周选择和快捷填充用的班次：当前选中的班次，选的是假期时用最近用过的班次。 */
  function currentShiftId() {
    const b = currentBrush();
    if (b.kind === 'shift') return b.id;
    return C.shiftById(state.schedule, ui.lastShift) ? ui.lastShift : state.schedule.shifts[0].id;
  }

  function brushHint(b) {
    if (b.kind === 'shift') {
      const s = C.shiftById(state.schedule, b.id);
      return `点日期排「${s.name}」${s.start}–${s.end}，再点一次取消。`;
    }
    if (b.kind === 'off') return '点日期设为休息：这天不上班，也不算进当月排班天数。';
    const pct = fmtNumber(state.leave[b.type]);
    if (b.type === 'holiday') return `点日期标记节假日：休息，按 ${pct}% 计薪。`;
    const name = C.MARK_NAMES[b.type];
    if (!ui.half) return `点日期标记全天${name}：按 ${pct}% 计薪。`;
    const halves = C.shiftHalves(C.shiftById(state.schedule, currentShiftId()));
    const leaveHours = ui.half === 'am' ? halves.am : halves.pm;
    const workHours = ui.half === 'am' ? halves.pm : halves.am;
    const side = ui.half === 'am' ? '上午' : '下午';
    return `${side} ${fmtNumber(leaveHours)} 小时${name}，按 ${pct}% 计薪；另外 ${fmtNumber(workHours)} 小时正常上班。`;
  }

  function renderScheduleTab(body) {
    const summary = h('div', { class: 'summary' });
    const calendarBox = h('div');
    const brushBox = h('div');
    const modeBox = h('div');
    const note = h('p', { class: 'hint warn' });

    const refreshSummary = () => {
      const { y, m } = ui.calendar;
      const days = C.workDayCount(state.schedule, y, m);
      const wage = C.dailyWage(state, new Date(y, m, 1));
      const leave = C.monthLeaveDays(state, y, m);
      summary.replaceChildren(
        `${m + 1} 月排了 ${days} 天班`,
        wage > 0 ? ' · 日薪 ' : '',
        wage > 0 ? h('b', null, `¥${C.fmtMoney(wage)}`) : '',
        leave > 0 ? ` · 请假 ${fmtNumber(leave)} 天` : '',
        !(state.salary.monthly > 0) ? ' · 还没填月薪' : '');
    };

    const afterChange = () => {
      save();
      refreshSummary();
      renderCalendar(calendarBox, afterChange, onDayClick);
      ui.cardKey = null;
      frame();
    };

    const onDayClick = (date) => {
      const b = currentBrush();
      let brush = { kind: 'off' };
      if (b.kind === 'shift') brush = { kind: 'shift', id: b.id };
      else if (b.kind === 'mark') brush = { kind: 'mark', type: b.type, half: ui.half };
      const res = C.applyBrush(state, date, brush, Date.now());
      note.textContent = res.noShift ? `${C.fmtDate(date.getTime())}没有排班，只做标记，不影响工资。` : '';
      if (res.filled.length) celebrate(res.filled);
      afterChange();
    };

    const renderMode = () => {
      modeBox.replaceChildren();
      if (state.schedule.mode !== 'weekly') return;
      const order = [1, 2, 3, 4, 5, 6, 0];
      const row = h('div', { class: 'week-row' });
      const paintRow = () => {
        row.replaceChildren(...order.map((w) => {
          const id = state.schedule.weekly[w];
          return h('button', {
            class: id ? `on ${shiftClass(id)}` : '',
            'aria-pressed': id ? 'true' : 'false',
            onclick: () => {
              C.toggleWeekday(state, w, currentShiftId());
              paintRow();
              afterChange();
            },
          }, C.WEEK_NAMES[w].slice(1));
        }));
      };
      paintRow();
      modeBox.append(row);
    };

    const renderBrushes = () => {
      const current = currentBrush();
      const halfAllowed = current.kind === 'mark' && current.type !== 'holiday';
      const nodes = [
        h('div', { class: 'chips' }, brushOptions().map((b) => h('button', {
          class: `chip ${b.cls}${b.key === current.key ? ' on' : ''}`,
          'aria-pressed': b.key === current.key ? 'true' : 'false',
          onclick: () => {
            ui.brush = b.key;
            if (b.kind === 'shift') ui.lastShift = b.id;
            renderBrushes();
          },
        }, h('i'), b.label))),
      ];
      if (halfAllowed) {
        nodes.push(segmented([['full', '全天'], ['am', '上午'], ['pm', '下午']], ui.half || 'full', (v) => {
          ui.half = v === 'full' ? null : v;
          renderBrushes();
        }));
      }
      nodes.push(h('p', { class: 'hint' }, brushHint(current)));
      brushBox.replaceChildren(...nodes);
    };

    body.append(
      h('section', null,
        segmented([['weekly', '每周固定'], ['monthly', '每月手选']], state.schedule.mode, (v) => {
          state.schedule.mode = v;
          renderMode();
          afterChange();
        }),
        modeBox),
      h('section', null, brushBox),
      h('section', null, calendarBox, note, summary));

    renderBrushes();
    renderMode();
    renderCalendar(calendarBox, afterChange, onDayClick);
    refreshSummary();
  }

  function renderCalendar(box, onChange, onDayClick) {
    const { y, m } = ui.calendar;
    const schedule = state.schedule;
    const multi = schedule.shifts.length > 1;
    const todayKey = C.dateKey(new Date());
    const go = (delta) => {
      const d = new Date(y, m + delta, 1);
      ui.calendar = { y: d.getFullYear(), m: d.getMonth() };
      onChange();
    };

    const grid = h('div', { class: 'cal-grid' }, ['一', '二', '三', '四', '五', '六', '日'].map((t) => h('div', { class: 'cal-week' }, t)));
    const blanks = (new Date(y, m, 1).getDay() + 6) % 7;
    for (let i = 0; i < blanks; i++) grid.append(h('div'));

    const total = C.daysInMonth(y, m);
    for (let day = 1; day <= total; day++) {
      const date = new Date(y, m, day);
      const key = C.dateKey(date);
      const id = C.shiftIdFor(schedule, date);
      const shift = id ? C.shiftById(schedule, id) : null;
      const mark = schedule.marks[key] || null;
      const classes = ['cal-day'];
      if (mark) classes.push('marked', `m-${mark.type}`, shift ? 'has-shift' : 'no-shift');
      else if (shift) classes.push('work', shiftClass(id));
      if (key === todayKey) classes.push('today');
      if (key < todayKey) classes.push('past');
      if (schedule.mode === 'weekly' && schedule.exceptions[key]) classes.push('changed');
      if (state.records[key] && !state.records[key].voided) classes.push('settled');
      const parts = [C.fmtDate(date.getTime())];
      if (shift) parts.push(`${shift.name} ${shift.start}–${shift.end}`);
      if (mark) parts.push(C.markText(mark));
      if (!shift && !mark) parts.push('休息');
      const title = parts.join(' · ');
      let small = null;
      if (mark) small = C.markText(mark);
      else if (multi && shift) small = shift.name.slice(0, 2);
      grid.append(h('button', {
        class: classes.join(' '),
        title,
        'aria-label': title,
        'aria-pressed': shift ? 'true' : 'false',
        onclick: () => onDayClick(date),
      }, String(day), small ? h('small', null, small) : null));
    }

    const nodes = [
      h('div', { class: 'cal-head' },
        iconButton('left', '上个月', () => go(-1)),
        h('div', { class: 'cal-title' }, `${y} 年 ${m + 1} 月`),
        iconButton('right', '下个月', () => go(1))),
      grid,
    ];
    if (schedule.mode === 'monthly') {
      const prev = new Date(y, m - 1, 1);
      nodes.push(h('div', { class: 'cal-tools' },
        h('button', {
          class: 'btn small',
          onclick: () => {
            C.fillMonthWeekdays(state, y, m, currentShiftId());
            onChange();
          },
        }, '选周一至周五'),
        h('button', {
          class: 'btn small',
          disabled: !schedule.monthly[C.monthKey(prev.getFullYear(), prev.getMonth())],
          onclick: () => {
            C.copyPreviousMonth(state, y, m);
            onChange();
          },
        }, '复制上月'),
        h('button', {
          class: 'btn small',
          onclick: () => {
            C.clearMonth(state, y, m);
            onChange();
          },
        }, '清空')));
    }
    box.replaceChildren(...nodes);
  }

  /* ----- 心愿 ----- */
  function celebrate(filled) {
    chime();
    post({ type: 'notify', title: '心愿蓄满了', body: `${filled.map((w) => `「${w.name}」`).join('、')} 已经攒够了。`, popup: false });
  }

  function moveWishWithChoice(id, toIndex) {
    const plan = C.planWishMove(state, id, toIndex);
    if (!plan.changed) return;
    const finish = (mode) => {
      const filled = C.applyWishMove(state, id, toIndex, mode, Date.now());
      save();
      afterWishChange(filled);
    };
    if (!plan.choice) {
      finish('keep');
      return;
    }
    const { subjectName, targetName, amount } = plan.choice;
    openDialog({
      title: '已攒的进度怎么处理？',
      body: [
        h('p', null, `「${subjectName}」已经攒了 ¥${C.fmtMoney(amount)}，调整后它不再排在这个位置。`),
        h('p', { class: 'hint' }, '今天还没结算的收入不受影响，结算时按新的顺序存入。'),
      ],
      actions: [
        { label: `进度留给「${subjectName}」`, kind: 'primary', onClick: () => finish('keep') },
        { label: `转给「${targetName}」`, onClick: () => finish('transfer') },
        { label: '取消，不调整', kind: 'ghost' },
      ],
    });
  }

  function afterWishChange(filled) {
    if (filled && filled.length) celebrate(filled);
    ui.cardKey = null;
    renderTabs();
    frame();
  }

  function wishDialog(wish) {
    const name = h('input', { type: 'text', value: wish.name, maxLength: 40 });
    const budget = h('input', { type: 'number', min: 0, step: 100, value: Number(wish.budget.toFixed(2)) });
    const saved = h('input', { type: 'number', min: 0, step: 100, value: Number(wish.saved.toFixed(2)) });
    const error = h('p', { class: 'error-text' });
    openDialog({
      title: '编辑心愿',
      body: [
        h('label', null, '名称', name),
        h('label', null, '预算（元）', budget),
        h('label', null, '已攒金额（元），奖金和红包也可以加在这里', saved),
        error,
      ],
      actions: [
        {
          label: '保存',
          kind: 'primary',
          onClick: () => {
            const b = Number(budget.value);
            if (!name.value.trim()) {
              error.textContent = '请填写心愿名称';
              return false;
            }
            if (!(b > 0)) {
              error.textContent = '预算要大于 0';
              return false;
            }
            const filled = C.updateWish(state, wish.id, { name: name.value.trim(), budget: b, saved: Math.max(0, Number(saved.value) || 0) }, Date.now());
            save();
            afterWishChange(filled);
            return true;
          },
        },
        { label: '取消', kind: 'ghost' },
      ],
    });
  }

  function deleteWishDialog(wish) {
    const remove = (mode) => {
      const filled = C.removeWish(state, wish.id, mode, Date.now());
      save();
      afterWishChange(filled);
    };
    if (wish.saved <= 1e-6 || wish.achievedAt) {
      openDialog({
        title: `删除「${wish.name}」？`,
        body: [],
        actions: [
          { label: '删除', kind: 'danger', onClick: () => remove('drop') },
          { label: '取消', kind: 'ghost' },
        ],
      });
      return;
    }
    openDialog({
      title: `删除「${wish.name}」？`,
      body: [h('p', null, `它已经攒了 ¥${C.fmtMoney(wish.saved)}。`)],
      actions: [
        { label: '删除，把钱转给队列里的心愿', kind: 'primary', onClick: () => remove('transfer') },
        { label: '删除，已攒金额也不要了', kind: 'danger', onClick: () => remove('drop') },
        { label: '取消', kind: 'ghost' },
      ],
    });
  }

  function renderWishesTab(body) {
    const nameInput = h('input', { class: 'grow', type: 'text', placeholder: '想要什么？', maxLength: 40, 'aria-label': '心愿名称' });
    const budgetInput = h('input', { class: 'narrow', type: 'number', min: 0, step: 100, placeholder: '预算', 'aria-label': '心愿预算' });
    const addError = h('p', { class: 'error-text' });
    const add = () => {
      const name = nameInput.value.trim();
      const budget = Number(budgetInput.value);
      if (!name) {
        addError.textContent = '先写下心愿名称';
        nameInput.focus();
        return;
      }
      if (!(budget > 0)) {
        addError.textContent = '预算要大于 0';
        budgetInput.focus();
        return;
      }
      const { filled } = C.addWish(state, { name, budget }, Date.now());
      save();
      afterWishChange(filled);
      const again = $('.wish-add input');
      if (again) again.focus();
    };
    const onEnter = (e) => {
      if (e.key === 'Enter') add();
    };
    nameInput.addEventListener('keydown', onEnter);
    budgetInput.addEventListener('keydown', onEnter);

    const active = C.activeWishes(state);
    const filled = C.filledWishes(state);
    const achieved = C.achievedWishes(state);

    const list = h('div', { class: 'wish-list' }, active.map((w, i) => renderWishRow(w, i, active.length)));
    ui.surplusRef = h('p', { class: 'hint' });

    body.append(
      h('section', null,
        h('h3', null, '添加心愿'),
        h('div', { class: 'wish-add' }, nameInput, budgetInput, h('button', { class: 'btn primary', onclick: add }, '添加')),
        addError),
      h('section', null,
        h('h3', null, '心愿队列（拖动或用箭头调整先后）'),
        active.length ? list : h('p', { class: 'empty-note' }, '还没有排队的心愿'),
        ui.surplusRef));

    if (filled.length) {
      body.append(h('section', null,
        h('h3', null, '已蓄满'),
        h('div', { class: 'wish-list' }, filled.map((w) => h('div', { class: 'wish done' },
          h('div', { class: 'wish-top' },
            h('span', { class: 'wish-name' }, w.name),
            h('span', { class: 'hint' }, `¥${C.fmtMoney(w.budget)}`),
            h('span', { class: 'wish-actions' },
              iconButton('check', '已经实现了', () => {
                C.achieveWish(state, w.id, Date.now());
                save();
                afterWishChange();
              }),
              iconButton('edit', '编辑', () => wishDialog(w)),
              iconButton('trash', '删除', () => deleteWishDialog(w)))))))));
    }
    if (achieved.length) {
      body.append(h('section', null,
        h('details', null,
          h('summary', null, `已实现的心愿（${achieved.length}）`),
          achieved.map((w) => h('div', { class: 'achieved' },
            h('span', null, w.name),
            h('span', null, `¥${C.fmtMoney(w.budget)} · ${C.fmtEta(w.achievedAt, Date.now())}`))))));
    }
  }

  function renderWishRow(w, index, total) {
    const saved = h('b');
    const pct = h('span');
    const bar = h('i');
    const eta = h('div', { class: 'wish-eta' });
    ui.wishRefs.set(w.id, { saved, pct, bar, eta });

    const clearDrop = (el) => el.classList.remove('drop-before', 'drop-after');
    const row = h('div', {
      class: `wish${index === 0 ? ' head' : ''}`,
      draggable: true,
      ondragstart: (e) => {
        ui.dragId = w.id;
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      },
      ondragend: () => {
        ui.dragId = null;
        row.classList.remove('dragging');
      },
      ondragover: (e) => {
        if (!ui.dragId || ui.dragId === w.id) return;
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        row.classList.toggle('drop-after', after);
        row.classList.toggle('drop-before', !after);
      },
      ondragleave: () => clearDrop(row),
      ondrop: (e) => {
        e.preventDefault();
        const after = row.classList.contains('drop-after');
        clearDrop(row);
        if (!ui.dragId || ui.dragId === w.id) return;
        const from = C.activeWishes(state).findIndex((x) => x.id === ui.dragId);
        let to = index + (after ? 1 : 0);
        if (from < to) to--;
        moveWishWithChoice(ui.dragId, to);
      },
    },
    h('div', { class: 'wish-top' },
      h('span', { class: 'grip' }, icon('grip')),
      h('span', { class: 'wish-name', title: w.name }, w.name),
      index === 0 && h('span', { class: 'tag' }, '蓄力中'),
      h('span', { class: 'wish-actions' },
        iconButton('up', '往前排', () => moveWishWithChoice(w.id, index - 1), { disabled: index === 0 }),
        iconButton('down', '往后排', () => moveWishWithChoice(w.id, index + 1), { disabled: index === total - 1 }),
        iconButton('edit', '编辑', () => wishDialog(w)),
        iconButton('trash', '删除', () => deleteWishDialog(w)))),
    h('div', { class: 'wish-body' },
      h('div', { class: 'wish-amount' }, h('span', null, saved, ` / ¥${C.fmtMoney(w.budget)}`), pct),
      h('div', { class: 'progress' }, bar),
      eta));
    return row;
  }

  function updateWishLive(fc, now) {
    for (const item of fc.items) {
      const refs = ui.wishRefs.get(item.wish.id);
      if (!refs) continue;
      const pct = (item.saved / item.wish.budget) * 100;
      setText(refs.saved, `¥${C.fmtMoney(item.saved)}`);
      setText(refs.pct, `${pct.toFixed(1)}%`);
      refs.bar.style.width = `${Math.min(100, pct).toFixed(2)}%`;
      setText(refs.eta, etaText(item, fc.blocked, now));
    }
    if (ui.surplusRef) setText(ui.surplusRef, fc.surplus > 0.005 ? `还有 ¥${C.fmtMoney(fc.surplus)} 没地方存，添加新心愿时会自动转入。` : '');
  }

  /* ----- 记录 ----- */
  function toLocalInput(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${C.pad(d.getMonth() + 1)}-${C.pad(d.getDate())}T${C.pad(d.getHours())}:${C.pad(d.getMinutes())}`;
  }

  function renderRecordsTab(body) {
    const { y, m } = ui.records;
    const go = (delta) => {
      const d = new Date(y, m + delta, 1);
      ui.records = { y: d.getFullYear(), m: d.getMonth() };
      ui.editingRecord = null;
      renderTabs();
    };
    const stats = C.monthStats(state, y, m);
    const earnedEl = h('b');
    const detail = h('p', { class: 'hint' });
    ui.tabLive = (st, now) => {
      if (state.ui.reckon) {
        const r = C.monthReckon(state, y, m, now, st);
        setText(earnedEl, `¥${C.fmtMoney(r.total)}`);
        const parts = [`已结算 ¥${C.fmtMoney(r.settled)}`];
        if (r.live > 0) parts.push(`今天 ¥${C.fmtMoney(r.live)}`);
        if (r.estimatedDays > 0) parts.push(`补算 ${r.estimatedDays} 天 ¥${C.fmtMoney(r.estimated)}`);
        setText(detail, `${parts.join(' + ')}。补算只用于显示，不写入记录，也不存入心愿。`);
      } else {
        const live = st.earn && st.inst.key.startsWith(`${C.monthKey(y, m)}-`) ? st.earn.total : 0;
        setText(earnedEl, `¥${C.fmtMoney(stats.earned + live)}`);
        setText(detail, '');
      }
    };

    body.append(
      h('div', { class: 'cal-head' },
        iconButton('left', '上个月', () => go(-1)),
        h('div', { class: 'cal-title' }, `${y} 年 ${m + 1} 月`),
        iconButton('right', '下个月', () => go(1))),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('small', null, state.ui.reckon ? '本月累计' : '本月已赚'), earnedEl),
        h('div', { class: 'stat' }, h('small', null, '已结算天数'), h('b', null, `${stats.attended} / ${stats.scheduled}`)),
        h('div', { class: 'stat' }, h('small', null, '加班'), h('b', null, `${(stats.otSeconds / 3600).toFixed(1)} 小时`))),
      h('label', { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: state.ui.reckon,
          onchange: (e) => {
            state.ui.reckon = e.target.checked;
            save();
            renderTabs();
            frame();
          },
        }),
        '从 1 号起核算（没有结算记录的排班日也算上）'),
      detail,
      stats.rows.length
        ? h('div', { class: 'rec-list' }, stats.rows.map((r) => renderRecordRow(r)))
        : h('p', { class: 'empty-note' }, '这个月还没有结算记录'));
  }

  function recordTimeText(r) {
    if (r.voided) return '不计薪';
    if (!r.workSegs.length) return '全天';
    return `${C.fmtHM(r.workSegs[0][0])}–${C.fmtHM(r.clockOut)}`;
  }

  function renderRecordRow(r) {
    const open = ui.editingRecord === r.key;
    const row = h('div', { class: `rec${r.voided ? ' void' : ''}` },
      h('button', {
        class: 'rec-main',
        'aria-expanded': open ? 'true' : 'false',
        onclick: () => {
          ui.editingRecord = open ? null : r.key;
          renderTabs();
        },
      },
      h('span', { class: 'rec-date' }, C.fmtDate(C.parseDateKey(r.key).getTime())),
      h('span', { class: 'rec-time' }, recordTimeText(r)),
      r.mark && h('span', { class: 'tag muted' }, C.markText(r.mark)),
      r.auto && h('span', { class: 'tag' }, '自动'),
      h('span', { class: 'rec-total' }, `¥${C.fmtMoney(r.total)}`)));
    if (!open) return row;

    const leaveOnly = !r.workSegs.length;
    const input = h('input', { type: 'datetime-local', value: toLocalInput(r.clockOut), 'aria-label': '实际下班时间' });
    const error = h('p', { class: 'error-text' });
    const detail = [`${r.shiftName} · 日薪 ¥${C.fmtMoney(r.wage)}`, `正常 ¥${C.fmtMoney(r.normal)}`, `加班 ¥${C.fmtMoney(r.overtime)}`];
    if (r.leaveSeconds > 0) detail.push(`假期 ¥${C.fmtMoney(r.leavePay)}`);

    const save_ = () => {
      const at = new Date(input.value).getTime();
      if (!Number.isFinite(at)) {
        error.textContent = '请选择有效的时间';
        return;
      }
      if (at < r.start) {
        error.textContent = '下班时间不能早于上班时间';
        return;
      }
      if (at > Date.now()) {
        error.textContent = '下班时间不能晚于现在';
        return;
      }
      const res = C.reviseRecord(state, r.key, at, Date.now());
      save();
      ui.editingRecord = null;
      afterWishChange(res.filled);
    };

    row.append(h('div', { class: 'rec-editor' },
      h('p', { class: 'rec-detail' }, detail.join(' · ')),
      leaveOnly
        ? h('p', { class: 'rec-detail' }, '这天是全天休假。要改的话，到排班页取消或更换标记。')
        : h('div', { class: 'field' }, h('span', { class: 'label' }, '实际下班时间'), input),
      error,
      h('div', { class: 'cal-tools' },
        !leaveOnly && h('button', { class: 'btn small primary', onclick: save_ }, r.voided ? '恢复并保存' : '保存'),
        !r.voided && h('button', {
          class: 'btn small danger',
          onclick: () => {
            C.voidRecord(state, r.key);
            save();
            ui.editingRecord = null;
            afterWishChange();
          },
        }, '这天不计薪'))));
    return row;
  }

  /* ----- 参数设置 ----- */
  function percentField(label, get, set) {
    return h('div', { class: 'field' },
      h('span', { class: 'label' }, label),
      h('input', {
        class: 'narrow',
        type: 'number',
        min: 0,
        max: 300,
        step: 5,
        value: get(),
        'aria-label': label,
        onchange: (e) => {
          set(Math.min(300, Math.max(0, Number(e.target.value) || 0)));
          e.target.value = get();
          save();
          ui.cardKey = null;
          frame();
        },
      }),
      h('span', { class: 'unit' }, '%'));
  }

  function renderShiftCards(box, onChange) {
    const shifts = state.schedule.shifts;
    const multi = shifts.length > 1;
    const hourlyText = (s) => {
      const wage = C.dailyWage(state, new Date());
      const hours = C.shiftSeconds(s) / 3600;
      return wage > 0 ? `工时 ${fmtNumber(hours)} 小时 · 时薪 ¥${C.fmtMoney(wage / hours)}` : `工时 ${fmtNumber(hours)} 小时`;
    };
    const changed = () => {
      onChange();
      renderShiftCards(box, onChange);
    };
    const timeInput = (label, value, patchKey, s) => h('input', {
      type: 'time',
      value: value || '',
      'aria-label': `${s.name}${label}`,
      onchange: (e) => {
        C.updateShift(state, s.id, { [patchKey]: e.target.value });
        changed();
      },
    });

    box.replaceChildren(
      ...shifts.map((s, i) => {
        const hasBreak = !!(s.breakStart && s.breakEnd);
        const invalidBreak = hasBreak && !C.breakOffsets(s);
        return h('div', { class: `shift-card s${i % 4}` },
          h('div', { class: 'shift-head' },
            h('i', { class: 'swatch' }),
            h('input', {
              class: 'shift-name',
              type: 'text',
              value: s.name,
              maxLength: 12,
              'aria-label': '班次名称',
              onchange: (e) => {
                C.updateShift(state, s.id, { name: e.target.value.trim() });
                changed();
              },
            }),
            h('span', { class: 'spacer' }),
            h('span', { class: 'hint' }, hourlyText(s)),
            multi && iconButton('trash', `删除${s.name}`, () => {
              C.removeShift(state, s.id);
              changed();
            })),
          h('div', { class: 'time-row' },
            h('span', { class: 'label' }, '上下班'),
            timeInput('上班时间', s.start, 'start', s),
            h('span', { class: 'dash' }, '–'),
            timeInput('下班时间', s.end, 'end', s)),
          h('div', { class: 'time-row' },
            h('span', { class: 'label' }, '午休'),
            hasBreak ? timeInput('午休开始', s.breakStart, 'breakStart', s) : h('span', { class: 'hint grow-text' }, '不设午休，上下午按中点分开'),
            hasBreak && h('span', { class: 'dash' }, '–'),
            hasBreak && timeInput('午休结束', s.breakEnd, 'breakEnd', s),
            h('input', {
              class: 'toggle',
              type: 'checkbox',
              role: 'switch',
              checked: hasBreak,
              'aria-label': `${s.name}午休`,
              onchange: (e) => {
                C.updateShift(state, s.id, e.target.checked ? C.suggestBreak(s) : { breakStart: null, breakEnd: null });
                changed();
              },
            })),
          invalidBreak && h('p', { class: 'hint warn' }, '午休不在上下班时间内，暂不生效。'));
      }),
      h('button', {
        class: 'link',
        onclick: () => {
          C.addShift(state);
          changed();
        },
      }, icon('plus'), '添加班次（早晚班、不同时长）'));
  }

  function renderSettingsTab(body) {
    const summary = h('div', { class: 'summary' });
    const shiftsBox = h('div');
    const refreshSummary = () => {
      const now = new Date();
      const y = now.getFullYear();
      const m = now.getMonth();
      const days = C.workDayCount(state.schedule, y, m);
      const wage = C.dailyWage(state, now);
      summary.replaceChildren(
        `${m + 1} 月排了 ${days} 天班`,
        wage > 0 ? ' · 日薪 ' : '',
        wage > 0 ? h('b', null, `¥${C.fmtMoney(wage)}`) : '',
        !(state.salary.monthly > 0) ? '，填好月薪后显示日薪' : days === 0 && state.salary.divisor === 'actual' ? '，到排班页选好上班日后显示日薪' : '');
    };
    const afterShiftChange = () => {
      save();
      refreshSummary();
      ui.cardKey = null;
      frame();
    };

    const otField = h('div');
    const renderOt = () => {
      otField.replaceChildren();
      const o = state.overtime;
      if (o.mode === 'multiplier') {
        otField.append(h('div', { class: 'field' },
          h('span', { class: 'label' }, '正常时薪的倍数'),
          h('input', {
            class: 'narrow',
            type: 'number',
            min: 0,
            step: 0.5,
            value: o.multiplier,
            'aria-label': '加班倍率',
            onchange: (e) => {
              o.multiplier = Math.max(0, Number(e.target.value) || 0);
              e.target.value = o.multiplier;
              save();
              frame();
            },
          })));
      } else if (o.mode === 'fixed') {
        otField.append(h('div', { class: 'field' },
          h('span', { class: 'label' }, '加班时薪（元/小时）'),
          h('input', {
            class: 'narrow',
            type: 'number',
            min: 0,
            step: 5,
            value: o.hourly,
            'aria-label': '加班时薪',
            onchange: (e) => {
              o.hourly = Math.max(0, Number(e.target.value) || 0);
              e.target.value = o.hourly;
              save();
              frame();
            },
          })));
      }
    };
    renderOt();

    const toggleRow = (label, checked, onChange) => h('div', { class: 'field' },
      h('span', { class: 'label' }, label),
      h('input', { class: 'toggle', type: 'checkbox', role: 'switch', checked, 'aria-label': label, onchange: (e) => onChange(e.target.checked, e.target) }));

    const autostartRow = toggleRow('开机自动启动', ui.autostart, (on) => post({ type: 'autostart', enabled: on }));
    ui.autostartEl = autostartRow.querySelector('input');

    body.append(
      h('section', null,
        h('h3', null, '薪资'),
        h('div', { class: 'field' },
          h('label', { htmlFor: 'salary' }, '月薪（元）'),
          h('input', {
            id: 'salary',
            class: 'narrow',
            type: 'number',
            min: 0,
            step: 100,
            placeholder: '必填',
            value: state.salary.monthly > 0 ? state.salary.monthly : '',
            oninput: (e) => {
              state.salary.monthly = Math.max(0, Number(e.target.value) || 0);
              refreshSummary();
              frame();
            },
            onchange: () => {
              save();
              ui.cardKey = null;
              frame();
              renderShiftCards(shiftsBox, afterShiftChange);
            },
          })),
        segmented([['actual', '除以当月排班天数'], ['legal', '除以固定 21.75 天']], state.salary.divisor, (v) => {
          state.salary.divisor = v;
          afterShiftChange();
          renderShiftCards(shiftsBox, afterShiftChange);
        }),
        summary),
      h('section', null,
        h('h3', null, '上下班时间和午休'),
        shiftsBox,
        h('p', { class: 'hint' }, '午休不计薪，时薪和每秒金额都按扣掉午休后的工时计算。半天假也按午休分上下午。')),
      h('section', null,
        h('h3', null, '假期工资比例（占正常工资）'),
        percentField('节假日', () => state.leave.holiday, (v) => { state.leave.holiday = v; }),
        percentField('调休', () => state.leave.comp, (v) => { state.leave.comp = v; }),
        percentField('事假', () => state.leave.personal, (v) => { state.leave.personal = v; }),
        percentField('病假', () => state.leave.sick, (v) => { state.leave.sick = v; })),
      h('section', null,
        h('h3', null, '加班费'),
        segmented([['none', '不计'], ['multiplier', '按倍率'], ['fixed', '固定时薪']], state.overtime.mode, (v) => {
          state.overtime.mode = v;
          save();
          renderOt();
          ui.cardKey = null;
          frame();
        }),
        otField),
      h('section', null,
        h('h3', null, '忘记点下班'),
        h('div', { class: 'field' },
          h('span', { class: 'label' }, '超过下班时间多少小时后自动结算'),
          h('input', {
            class: 'narrow',
            type: 'number',
            min: 1,
            max: 24,
            value: state.overtime.autoCloseHours,
            'aria-label': '自动结算时限（小时）',
            onchange: (e) => {
              state.overtime.autoCloseHours = Math.min(24, Math.max(1, Number(e.target.value) || 8));
              e.target.value = state.overtime.autoCloseHours;
              save();
              frame();
            },
          })),
        h('p', { class: 'hint' }, '自动结算只算正常工资，不算加班费。如果确实加班了，可以在记录里改实际下班时间。')),
      h('section', null,
        h('h3', null, '心愿'),
        percentField('收入的多少存入心愿', () => state.wishShare, (v) => { state.wishShare = Math.min(100, v); })),
      h('section', null,
        h('h3', null, '小窗'),
        toggleRow('全屏时自动让位（放 PPT、看视频时隐藏）', state.ui.yieldFullscreen, (on) => {
          state.ui.yieldFullscreen = on;
          save();
          syncWindow();
        }),
        toggleRow('小窗隐藏金额（防止被同事看到）', state.ui.hideMoney, (on) => {
          state.ui.hideMoney = on;
          save();
          ui.cardKey = null;
          frame();
        }),
        toggleRow('下班和心愿蓄满时响提示音', state.ui.sound, (on) => {
          state.ui.sound = on;
          save();
          if (on) chime();
        }),
        autostartRow),
      h('section', null,
        h('h3', null, '关于'),
        h('p', { class: 'hint' }, `版本 ${boot.version || '开发版'}。所有数据只保存在这台电脑上，不联网。`),
        boot.dataDir ? h('p', { class: 'hint' }, `数据位置：${boot.dataDir}`) : null,
        h('div', { class: 'cal-tools' }, h('button', { class: 'btn small', onclick: () => post({ type: 'quit' }) }, '退出程序'))));

    renderShiftCards(shiftsBox, afterShiftChange);
    refreshSummary();
  }

  /* ---------- 弹窗 ---------- */
  function closeDialog() {
    if (!ui.dialog) return;
    ui.dialog.observer.disconnect();
    ui.dialog.overlay.remove();
    ui.dialog = null;
    syncWindow();
  }

  function openDialog({ title, body, actions }) {
    closeDialog();
    const dialog = {};
    const box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', null, title),
      h('div', { class: 'dialog-body' }, body),
      h('div', { class: 'dialog-actions' }, actions.map((a) => h('button', {
        class: `btn ${a.kind || ''}`,
        onclick: () => {
          const result = a.onClick ? a.onClick() : undefined;
          if (result !== false && ui.dialog === dialog) closeDialog();
        },
      }, a.label))));
    const overlay = h('div', { class: 'overlay' }, box);
    Object.assign(dialog, { overlay, box, observer: new ResizeObserver(syncWindow) });
    ui.dialog = dialog;
    $('#dialog-root').append(overlay);
    dialog.observer.observe(box);
    syncWindow();
    const first = box.querySelector('input, .dialog-actions button');
    if (first) first.focus();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDialog();
    if (e.key === 'Tab') document.body.classList.add('keyboard');
  });
  document.addEventListener('mousedown', () => document.body.classList.remove('keyboard'));

  /* ---------- 下班结算 ---------- */
  function settleNow() {
    const st = C.getStatus(state, Date.now());
    if (st.kind === 'working' || st.kind === 'lunch') {
      openDialog({
        title: '现在就下班？',
        body: [h('p', null, `还没到 ${C.fmtHM(st.inst.workEnd)}，提前下班只计到此刻（约 ¥${C.fmtMoney(st.earn.total)}）。`)],
        actions: [
          { label: '提前下班', kind: 'primary', onClick: doClockOut },
          { label: '继续上班', kind: 'ghost' },
        ],
      });
      return;
    }
    doClockOut();
  }

  function doClockOut() {
    const res = C.clockOut(state, Date.now());
    if (!res) return;
    save();
    ui.cardKey = null;
    renderTabs();
    frame();
    showSettlement(res);
  }

  function showSettlement({ record, filled }) {
    const d = new Date(record.start);
    const month = C.monthStats(state, d.getFullYear(), d.getMonth());
    const allocRows = record.alloc.map((p) => {
      const wish = p.id ? C.findWish(state, p.id) : null;
      return h('div', null, h('span', null, wish ? `存入「${wish.name}」` : '存入未分配'), h('span', null, `+¥${C.fmtMoney(p.amount)}`));
    });
    if (filled.length) chime();
    openDialog({
      title: '今日结算',
      body: [
        h('div', { class: 'dialog-total' }, `¥${C.fmtMoney(record.total, 4)}`),
        h('div', { class: 'rows' },
          h('div', null, h('span', null, '班次'), h('span', null, `${record.shiftName} ${C.fmtHM(record.start)}–${C.fmtHM(record.end)}`)),
          h('div', null, h('span', null, '下班时间'), h('span', null, C.fmtHM(record.clockOut))),
          h('div', null, h('span', null, '正常工资'), h('span', null, `¥${C.fmtMoney(record.normal)}`)),
          record.leaveSeconds > 0 && h('div', null, h('span', null, `${C.markText(record.mark)} ${fmtNumber(record.leaveSeconds / 3600)} 小时`), h('span', null, `¥${C.fmtMoney(record.leavePay)}`)),
          record.otSeconds > 0 && h('div', null, h('span', null, `加班 ${C.fmtDuration(record.otSeconds)}`), h('span', null, `¥${C.fmtMoney(record.overtime)}`)),
          allocRows,
          h('div', null, h('span', null, '本月累计'), h('span', null, `¥${C.fmtMoney(month.earned)}`))),
        filled.length ? h('p', { class: 'celebrate' }, `${filled.map((w) => `「${w.name}」`).join('、')}蓄满了，可以去实现它了。`) : null,
      ],
      actions: [
        { label: '辛苦了，收工', kind: 'primary' },
        {
          label: '点错了，继续上班',
          kind: 'ghost',
          onClick: () => {
            C.reopenRecord(state, record.key);
            state.remindedKey = record.key;
            save();
            ui.cardKey = null;
            renderTabs();
            frame();
          },
        },
      ],
    });
  }

  /* ---------- 每秒刷新 ---------- */
  function announceAutoSettled(results) {
    const forgot = results.filter((r) => r.record.auto).map((r) => r.record);
    if (forgot.length === 1) {
      const last = forgot[0];
      post({ type: 'notify', title: '已自动结算', body: `${C.fmtDate(last.start)}没有点下班，已按 ${C.fmtHM(last.clockOut)} 结算。`, popup: false });
    } else if (forgot.length > 1) {
      post({ type: 'notify', title: '已自动结算', body: `有 ${forgot.length} 天没有点下班，已按正常下班时间结算。`, popup: false });
    }
    const filled = results.flatMap((r) => r.filled);
    if (filled.length) afterWishChange(filled);
    else if (state.ui.view === 'panel') renderTabs();
  }

  function remind(st) {
    // 没填月薪说明还没配置好，默认排班下的“到点”不算数。
    if (st.kind !== 'overtime' || state.remindedKey === st.inst.key || !(state.salary.monthly > 0)) return;
    state.remindedKey = st.inst.key;
    save();
    chime();
    const money = state.ui.hideMoney ? '' : `今日已赚 ¥${C.fmtMoney(st.earn.total)}，`;
    post({ type: 'notify', title: '到下班时间了', body: `${money}点「下班结算」收工。`, popup: true });
  }

  function updateTooltip(st, now) {
    if (now - ui.tooltipAt < 5000) return;
    ui.tooltipAt = now;
    let line = STATUS_TEXT[st.kind];
    if (st.kind === 'working') line = `距下班 ${C.fmtCountdown(st.inst.workEnd - now)}`;
    else if (st.kind === 'lunch') line = `午休中，距下午上班 ${C.fmtCountdown(st.target - now)}`;
    else if (st.target) line = `距上班 ${C.fmtCountdown(st.target - now)}`;
    const money = !state.ui.hideMoney && (st.earn || st.record) ? `\n今日 ¥${C.fmtMoney(C.todayEarned(st))}` : '';
    post({ type: 'tooltip', text: `上班鼓励器\n${line}${money}` });
  }

  function frame() {
    const now = Date.now();
    const auto = C.autoSettle(state, now);
    if (auto.length) {
      save();
      ui.cardKey = null;
      announceAutoSettled(auto);
    }

    const dayKey = C.dateKey(new Date(now));
    if (dayKey !== ui.day) {
      ui.day = dayKey;
      ui.cardKey = null;
      renderTabs();
    }

    const st = C.getStatus(state, now);
    const key = cardKeyFor(st, now);
    if (key !== ui.cardKey) {
      ui.cardKey = key;
      renderCard(st, now);
    }

    const showAll = state.ui.view === 'panel' && state.ui.tab === 'wishes';
    const fc = C.forecastWishes(state, now, st, showAll ? undefined : 1);
    updateCard(st, now, fc);
    if (showAll) updateWishLive(fc, now);
    if (ui.tabLive) ui.tabLive(st, now);
    remind(st);
    updateTooltip(st, now);
  }

  function loop() {
    try {
      frame();
    } finally {
      setTimeout(loop, 1000 - (Date.now() % 1000) + 5);
    }
  }

  function render() {
    const app = $('#app');
    app.className = `view-${state.ui.view}`;
    ui.cardKey = null;
    renderTabs();
    frame();
    syncWindow();
  }

  /* ---------- 启动 ---------- */
  $('#app').append(h('div', { id: 'top' }), h('div', { id: 'tabs' }));
  new ResizeObserver(syncWindow).observe($('#app'));

  if (webview) {
    webview.addEventListener('message', (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === 'autostart') {
        ui.autostart = m.enabled === true;
        if (ui.autostartEl) ui.autostartEl.checked = ui.autostart;
      } else if (m.type === 'command') {
        if (m.name === 'togglePin') togglePin();
        else if (m.name === 'toggleMini') setView(state.ui.view === 'mini' ? 'card' : 'mini');
        else if (m.name === 'openPanel') setView('panel');
      }
    });
  }

  render();
  if (!hasSavedData) save();
  post({ type: 'ready' });
  loop();
})();
