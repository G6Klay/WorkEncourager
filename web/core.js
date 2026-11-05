/*
 * 上班鼓励器核心逻辑。
 * 不碰 DOM、窗口和文件，所有时间都由调用方传入，方便测试，也方便以后复用到手机版。
 * 金额和状态都从“时间 + 配置”推导，所以程序关闭或电脑休眠都不会丢失累计。
 */
(function (root) {
  'use strict';

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const EPS = 1e-6;
  const LEGAL_MONTH_DAYS = 21.75;
  const FORECAST_MAX_DAYS = 3660;
  const TASK_ENDING_NOTICE = 5 * MINUTE;
  const REMINDER_LATE_LIMIT = HOUR;
  const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const MARK_NAMES = { holiday: '节假日', comp: '调休', personal: '事假', sick: '病假' };
  const HALF_NAMES = { am: '上午', pm: '下午' };

  /* ---------- 日期工具 ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const monthKey = (y, m) => `${y}-${pad(m + 1)}`;
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseDateKey = (k) => {
    const [y, m, d] = k.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const startOfDay = (ms) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function parseHM(text) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text == null ? '' : text));
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    return h > 23 || mi > 59 ? null : h * 60 + mi;
  }

  /* ---------- 默认状态与读档校验 ---------- */
  function defaultState(now) {
    return {
      version: 1,
      createdAt: now,
      processedFrom: dateKey(startOfDay(now)),
      remindedKey: null,
      salary: { monthly: 0, divisor: 'actual' },
      overtime: { mode: 'multiplier', multiplier: 1.5, hourly: 50, autoCloseHours: 8 },
      /* 各类假期按正常工资的百分之几计薪。 */
      leave: { holiday: 100, comp: 100, personal: 0, sick: 60 },
      schedule: {
        mode: 'weekly',
        shifts: [{ id: 'day', name: '白班', start: '09:00', end: '18:00', breakStart: '12:00', breakEnd: '13:00' }],
        weekly: { 1: 'day', 2: 'day', 3: 'day', 4: 'day', 5: 'day' },
        monthly: {},
        exceptions: {},
        /* 日期 -> { type: 节假日/调休/事假/病假, half: null|'am'|'pm' }。排班本身不动，取消标记就恢复。 */
        marks: {},
      },
      records: {},
      wishes: [],
      wishSurplus: 0,
      wishShare: 100,
      tasks: [],
      ui: { pinned: true, view: 'card', tab: 'schedule', hideMoney: false, sound: true, trayHintShown: false, reckon: false, yieldFullscreen: true, strip: 'wish' },
    };
  }

  const num = (v, fallback, lo = -Infinity, hi = Infinity) => {
    const n = typeof v === 'number' ? v : Number(v);
    return v !== null && v !== '' && Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
  };
  const str = (v, fallback, maxLen = 40) => (typeof v === 'string' ? v.slice(0, maxLen) : fallback);
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const isDateKey = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k);
  const isMonthKey = (k) => /^\d{4}-\d{2}$/.test(k);

  /* 存档可能被手动改过或来自旧版本：只保留结构和类型都正确的字段，其余回落到默认值。 */
  function normalizeState(raw, now) {
    const s = defaultState(now);
    if (!isObj(raw)) return s;

    s.createdAt = num(raw.createdAt, s.createdAt, 0);
    if (typeof raw.processedFrom === 'string' && isDateKey(raw.processedFrom)) s.processedFrom = raw.processedFrom;
    s.remindedKey = typeof raw.remindedKey === 'string' ? raw.remindedKey : null;

    if (isObj(raw.salary)) {
      s.salary.monthly = num(raw.salary.monthly, 0, 0);
      s.salary.divisor = raw.salary.divisor === 'legal' ? 'legal' : 'actual';
    }
    if (isObj(raw.overtime)) {
      const o = raw.overtime;
      s.overtime.mode = ['none', 'multiplier', 'fixed'].includes(o.mode) ? o.mode : s.overtime.mode;
      s.overtime.multiplier = num(o.multiplier, s.overtime.multiplier, 0);
      s.overtime.hourly = num(o.hourly, s.overtime.hourly, 0);
      s.overtime.autoCloseHours = num(o.autoCloseHours, s.overtime.autoCloseHours, 1, 24);
    }
    if (isObj(raw.leave)) {
      for (const type of Object.keys(MARK_NAMES)) s.leave[type] = num(raw.leave[type], s.leave[type], 0, 300);
    }

    if (isObj(raw.schedule)) {
      const sc = raw.schedule;
      s.schedule.mode = sc.mode === 'monthly' ? 'monthly' : 'weekly';
      if (Array.isArray(sc.shifts)) {
        // 旧版存档的班次没有午休字段，读进来就是“不设午休”，金额算法和之前一致。
        const shifts = sc.shifts
          .filter((x) => isObj(x) && typeof x.id === 'string' && parseHM(x.start) !== null && parseHM(x.end) !== null)
          .map((x) => ({
            id: x.id,
            name: str(x.name, '班次', 12),
            start: x.start,
            end: x.end,
            breakStart: parseHM(x.breakStart) !== null ? x.breakStart : null,
            breakEnd: parseHM(x.breakEnd) !== null ? x.breakEnd : null,
          }));
        if (shifts.length) s.schedule.shifts = shifts;
      }
      const ids = new Set(s.schedule.shifts.map((x) => x.id));
      if (isObj(sc.weekly)) {
        s.schedule.weekly = {};
        for (let w = 0; w < 7; w++) if (ids.has(sc.weekly[w])) s.schedule.weekly[w] = sc.weekly[w];
      }
      if (isObj(sc.monthly)) {
        for (const [ym, plan] of Object.entries(sc.monthly)) {
          if (!isMonthKey(ym) || !isObj(plan)) continue;
          const clean = {};
          for (const [d, id] of Object.entries(plan)) if (Number(d) >= 1 && Number(d) <= 31 && ids.has(id)) clean[d] = id;
          s.schedule.monthly[ym] = clean;
        }
      }
      if (isObj(sc.exceptions)) {
        for (const [k, v] of Object.entries(sc.exceptions)) {
          if (isDateKey(k) && (v === 'off' || ids.has(v))) s.schedule.exceptions[k] = v;
        }
      }
      if (isObj(sc.marks)) {
        for (const [k, v] of Object.entries(sc.marks)) {
          const mark = cleanMark(v);
          if (isDateKey(k) && mark) s.schedule.marks[k] = mark;
        }
      }
    }

    if (isObj(raw.records)) {
      for (const [k, r] of Object.entries(raw.records)) {
        if (!isDateKey(k) || !isObj(r)) continue;
        const start = num(r.start, null, 0);
        const end = num(r.end, null, 0);
        if (start === null || end === null) continue;
        s.records[k] = {
          key: k,
          shiftName: str(r.shiftName, '班次', 12),
          start,
          end,
          clockOut: num(r.clockOut, end, 0),
          wage: num(r.wage, 0, 0),
          normal: num(r.normal, 0, 0),
          overtime: num(r.overtime, 0, 0),
          otSeconds: num(r.otSeconds, 0, 0),
          leavePay: num(r.leavePay, 0, 0),
          total: num(r.total, 0, 0),
          auto: r.auto === true,
          reviewed: r.reviewed !== false,
          voided: r.voided === true,
          alloc: Array.isArray(r.alloc)
            ? r.alloc
                .filter((p) => isObj(p) && (p.id === null || typeof p.id === 'string'))
                .map((p) => ({ id: p.id, amount: num(p.amount, 0, 0) }))
            : [],
          // 旧版记录没有分段信息：当时没有午休和请假，整段都是工作时间。
          workSegs: cleanSegments(r.workSegs) || [[start, end]],
          paidSeconds: num(r.paidSeconds, (end - start) / SECOND, 0),
          leaveSeconds: num(r.leaveSeconds, 0, 0),
          leaveRatio: num(r.leaveRatio, 0, 0),
          mark: cleanMark(r.mark),
        };
      }
    }

    if (Array.isArray(raw.wishes)) {
      s.wishes = raw.wishes
        .filter((w) => isObj(w) && typeof w.id === 'string' && num(w.budget, 0, 0) > 0)
        .map((w) => ({
          id: w.id,
          name: str(w.name, '心愿', 40),
          budget: num(w.budget, 0, 0),
          saved: num(w.saved, 0, 0),
          createdAt: num(w.createdAt, now, 0),
          filledAt: num(w.filledAt, null, 0),
          achievedAt: num(w.achievedAt, null, 0),
        }));
    }
    s.wishSurplus = num(raw.wishSurplus, 0, 0);
    s.wishShare = num(raw.wishShare, 100, 0, 100);

    if (Array.isArray(raw.tasks)) {
      s.tasks = raw.tasks.map((t) => cleanTask(t, now)).filter(Boolean);
      // 同一时间只能有一个任务在计时。
      let running = false;
      for (const t of s.tasks) {
        if (t.status !== 'running') continue;
        if (running) {
          const seg = t.segments[t.segments.length - 1];
          seg[1] = seg[0];
          t.status = 'paused';
        }
        running = true;
      }
    }

    if (isObj(raw.ui)) {
      const u = raw.ui;
      s.ui.pinned = u.pinned !== false;
      s.ui.view = ['mini', 'card', 'panel'].includes(u.view) ? u.view : 'card';
      s.ui.tab = ['schedule', 'wishes', 'tasks', 'records', 'settings'].includes(u.tab) ? u.tab : 'schedule';
      s.ui.hideMoney = u.hideMoney === true;
      s.ui.sound = u.sound !== false;
      s.ui.trayHintShown = u.trayHintShown === true;
      s.ui.reckon = u.reckon === true;
      s.ui.yieldFullscreen = u.yieldFullscreen !== false;
      s.ui.strip = u.strip === 'task' ? 'task' : 'wish';
    }
    return s;
  }

  function cleanTask(t, now) {
    if (!isObj(t) || typeof t.id !== 'string') return null;
    const segs = Array.isArray(t.segments)
      ? t.segments
          .filter((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && (p[1] === null || Number.isFinite(p[1])))
          .map((p) => [p[0], p[1]])
      : [];
    let status = ['planned', 'running', 'paused', 'done'].includes(t.status) ? t.status : 'planned';
    // 只有计时中的任务，最后一段才能没有结束时间。
    segs.forEach((p, i) => {
      if (p[1] === null && !(status === 'running' && i === segs.length - 1)) p[1] = p[0];
    });
    if (status === 'running' && (!segs.length || segs[segs.length - 1][1] !== null)) status = segs.length ? 'paused' : 'planned';
    if ((status === 'paused' || status === 'done') && !segs.length) status = 'planned';
    const n = isObj(t.notified) ? t.notified : {};
    return {
      id: t.id,
      name: str(t.name, '任务', 40),
      status,
      createdAt: num(t.createdAt, now, 0),
      scheduledStart: num(t.scheduledStart, null, 0),
      scheduledEnd: num(t.scheduledEnd, null, 0),
      segments: segs,
      doneAt: status === 'done' ? num(t.doneAt, now, 0) : null,
      seconds: num(t.seconds, 0, 0),
      paidSeconds: num(t.paidSeconds, 0, 0),
      earned: num(t.earned, 0, 0),
      notified: { start: n.start === true, ending: n.ending === true, end: n.end === true },
    };
  }

  /* 节假日只能标全天，调休和请假可以分上午、下午。 */
  function cleanMark(v) {
    if (!isObj(v) || !Object.prototype.hasOwnProperty.call(MARK_NAMES, v.type)) return null;
    const half = v.type !== 'holiday' && (v.half === 'am' || v.half === 'pm') ? v.half : null;
    return { type: v.type, half };
  }

  function cleanSegments(v) {
    if (!Array.isArray(v)) return null;
    const ok = v.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    return ok ? v.map((p) => [p[0], p[1]]) : null;
  }

  /* ---------- 排班 ---------- */
  const shiftById = (schedule, id) => schedule.shifts.find((x) => x.id === id) || null;

  /* project=true 时，没有排班的月份沿用最近一个已排班月份的日期，只用于估算心愿。 */
  function monthPlan(schedule, y, m, project) {
    const key = monthKey(y, m);
    const own = schedule.monthly[key];
    if (own && Object.keys(own).length) return { plan: own, projected: false };
    if (!project) return { plan: null, projected: false };
    const earlier = Object.keys(schedule.monthly)
      .filter((k) => k < key && Object.keys(schedule.monthly[k]).length)
      .sort();
    if (!earlier.length) return { plan: null, projected: false };
    return { plan: schedule.monthly[earlier[earlier.length - 1]], projected: true };
  }

  function shiftIdFor(schedule, date, project) {
    if (schedule.mode === 'monthly') {
      const { plan } = monthPlan(schedule, date.getFullYear(), date.getMonth(), project);
      return (plan && plan[date.getDate()]) || null;
    }
    const ex = schedule.exceptions[dateKey(date)];
    if (ex === 'off') return null;
    return ex || schedule.weekly[date.getDay()] || null;
  }

  const shiftFor = (schedule, date, project) => {
    const id = shiftIdFor(schedule, date, project);
    return id ? shiftById(schedule, id) : null;
  };

  /* 班次总时长（分钟），包含午休。下班时间不晚于上班时间时算跨零点。 */
  function shiftMinutes(shift) {
    const minutes = parseHM(shift.end) - parseHM(shift.start);
    return minutes > 0 ? minutes : minutes + 24 * 60;
  }

  /* 午休相对上班时间的分钟偏移。没设置，或者不在上下班时间之内，都按没有午休处理。 */
  function breakOffsets(shift) {
    const bs = parseHM(shift.breakStart);
    const be = parseHM(shift.breakEnd);
    if (bs === null || be === null) return null;
    const start = parseHM(shift.start);
    const from = (bs - start + 1440) % 1440;
    const to = (be - start + 1440) % 1440;
    return from > 0 && to > from && to < shiftMinutes(shift) ? { from, to } : null;
  }

  /* 计薪工时（秒）：班次总时长减去午休。时薪和每秒金额都按它来算。 */
  function shiftSeconds(shift) {
    const brk = breakOffsets(shift);
    return (shiftMinutes(shift) - (brk ? brk.to - brk.from : 0)) * 60;
  }

  /* 上午、下午各有几个工时，请假时用来显示。 */
  function shiftHalves(shift) {
    const total = shiftMinutes(shift);
    const brk = breakOffsets(shift);
    return brk ? { am: brk.from / 60, pm: (total - brk.to) / 60 } : { am: total / 120, pm: total / 120 };
  }

  /* 打开午休开关时的初始值：12 点能放下就用 12 点，否则放在班次中间，放不下就不设。 */
  function suggestBreak(shift) {
    const noon = { start: shift.start, end: shift.end, breakStart: '12:00', breakEnd: '13:00' };
    if (breakOffsets(noon)) return { breakStart: '12:00', breakEnd: '13:00' };
    const hm = (m) => `${pad(Math.floor(((m + 1440) % 1440) / 60))}:${pad((m + 1440) % 60)}`;
    const from = parseHM(shift.start) + Math.floor(shiftMinutes(shift) / 2) - 30;
    const mid = { start: shift.start, end: shift.end, breakStart: hm(from), breakEnd: hm(from + 60) };
    return breakOffsets(mid) ? { breakStart: mid.breakStart, breakEnd: mid.breakEnd } : { breakStart: null, breakEnd: null };
  }

  function workDayCount(schedule, y, m, project) {
    let n = 0;
    const total = daysInMonth(y, m);
    for (let d = 1; d <= total; d++) if (shiftFor(schedule, new Date(y, m, d), project)) n++;
    return n;
  }

  function dailyWage(state, date, opts) {
    const { monthly, divisor } = state.salary;
    if (!(monthly > 0)) return 0;
    if (divisor === 'legal') return monthly / LEGAL_MONTH_DAYS;
    const y = date.getFullYear();
    const m = date.getMonth();
    const project = !!(opts && opts.project);
    const cache = opts && opts.cache;
    const ck = monthKey(y, m);
    let n = cache ? cache.get(ck) : undefined;
    if (n === undefined) {
      n = workDayCount(state.schedule, y, m, project);
      if (cache) cache.set(ck, n);
    }
    return n > 0 ? monthly / n : 0;
  }

  const segmentsLength = (segs) => segs.reduce((sum, [a, b]) => sum + (b - a) / SECOND, 0);
  const secondsWithin = (segs, at) => segs.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(at, b) - a) / SECOND, 0);

  /*
   * 一个班次实例归属于它开始的那一天，跨零点的夜班也算在开始日。
   * 班次被拆成工作段和请假段，午休两边都不算：
   *   正常上班  工作 = 上午 + 下午
   *   上午请假  工作 = 下午，请假 = 上午
   *   下午请假  工作 = 上午，请假 = 下午
   *   全天请假  请假 = 上午 + 下午
   * 没有午休时，上午和下午按班次中点分开。
   */
  function instanceFor(state, date, project) {
    const shift = shiftFor(state.schedule, date, project);
    if (!shift) return null;
    const y = date.getFullYear();
    const m = date.getMonth();
    const d = date.getDate();
    const startMin = parseHM(shift.start);
    const total = shiftMinutes(shift);
    const at = (offset) => new Date(y, m, d, 0, startMin + offset).getTime();
    const start = at(0);
    const end = at(total);

    const brk = breakOffsets(shift);
    const am = [start, at(brk ? brk.from : Math.round(total / 2))];
    const pm = [at(brk ? brk.to : Math.round(total / 2)), end];
    const whole = brk ? [am, pm] : [[start, end]];

    const key = dateKey(date);
    const mark = state.schedule.marks[key] || null;
    let workSegs = whole;
    let leaveSegs = [];
    if (mark) {
      if (mark.half === 'am') {
        workSegs = [pm];
        leaveSegs = [am];
      } else if (mark.half === 'pm') {
        workSegs = [am];
        leaveSegs = [pm];
      } else {
        workSegs = [];
        leaveSegs = whole;
      }
    }

    return {
      key,
      date: new Date(y, m, d),
      shift,
      start,
      end,
      seconds: segmentsLength(whole),
      mark,
      workSegs,
      leaveSegs,
      workSeconds: segmentsLength(workSegs),
      leaveSeconds: segmentsLength(leaveSegs),
      ratio: mark ? state.leave[mark.type] / 100 : 0,
      fullLeave: workSegs.length === 0,
      workStart: workSegs.length ? workSegs[0][0] : null,
      workEnd: workSegs.length ? workSegs[workSegs.length - 1][1] : null,
      projected: !!project && state.schedule.mode === 'monthly' && monthPlan(state.schedule, y, m, true).projected,
    };
  }

  function nextWorkStartAfter(state, inst) {
    for (let i = 1; i <= 3; i++) {
      const next = instanceFor(state, addDays(inst.date, i));
      if (next && !next.fullLeave) return next.workStart;
    }
    return Infinity;
  }

  /*
   * 自动结算的时刻。全天休假到班次结束就结算，不需要点下班；
   * 上班的日子是忘记点下班的兜底：超过下班时间若干小时，或下一班开始，取较早者。
   */
  const closeAt = (state, inst) =>
    inst.fullLeave
      ? inst.end
      : Math.min(inst.workEnd + state.overtime.autoCloseHours * HOUR, nextWorkStartAfter(state, inst));

  function findNext(state, now) {
    const today = startOfDay(now);
    for (let i = 0; i <= 62; i++) {
      const inst = instanceFor(state, addDays(today, i));
      if (inst && !inst.fullLeave && inst.workStart > now && !state.records[inst.key]) return inst;
    }
    return null;
  }

  /* ---------- 计薪 ---------- */
  function overtimeRate(overtime, normalRate) {
    if (overtime.mode === 'fixed') return overtime.hourly / 3600;
    if (overtime.mode === 'multiplier') return normalRate * overtime.multiplier;
    return 0;
  }

  /*
   * at 时刻的累计金额。工作段按秒累计，午休不计。
   * 假期工资是这一天的固定金额（请假时长 × 时薪 × 比例），请假段一开始就整笔计入，不按秒跳动。
   */
  function earnFor(state, inst, at, wage) {
    const rate = inst.seconds > 0 ? wage / inst.seconds : 0;
    const normalSeconds = secondsWithin(inst.workSegs, at);
    const otSeconds = inst.workSegs.length ? Math.max(0, (at - inst.workEnd) / SECOND) : 0;
    const otRate = overtimeRate(state.overtime, rate);
    const normal = normalSeconds * rate;
    const overtime = otSeconds * otRate;
    const leaveFull = inst.leaveSeconds * rate * inst.ratio;
    const leavePay = inst.leaveSegs.length && at >= inst.leaveSegs[0][0] ? leaveFull : 0;
    return { wage, rate, otRate, normalSeconds, otSeconds, normal, overtime, leavePay, leaveFull, total: normal + overtime + leavePay };
  }

  /* ---------- 当前状态 ---------- */
  function getStatus(state, now) {
    const today = startOfDay(now);
    const yesterday = addDays(today, -1);
    const cache = new Map();

    let open = null;
    for (const d of [yesterday, today]) {
      const inst = instanceFor(state, d);
      if (!inst || inst.fullLeave || state.records[inst.key]) continue;
      if (now >= inst.workStart && now < closeAt(state, inst)) open = inst;
    }
    const next = findNext(state, now);
    const todayKey = dateKey(today);
    const mark = state.schedule.marks[todayKey] || null;

    if (open) {
      const wage = dailyWage(state, open.date, { cache });
      const earn = earnFor(state, open, now, wage);
      const onSegment = open.workSegs.some(([a, b]) => now >= a && now < b);
      let kind = 'overtime';
      let target = null;
      if (now < open.workEnd) {
        kind = onSegment ? 'working' : 'lunch';
        target = onSegment ? open.workEnd : open.workSegs.find(([a]) => a > now)[0];
      }
      return {
        kind,
        inst: open,
        earn,
        wage,
        next,
        target,
        progress: open.workSeconds > 0 ? clamp(earn.normalSeconds / open.workSeconds, 0, 1) : 0,
        record: null,
        mark: open.mark,
      };
    }

    const yRec = state.records[dateKey(yesterday)];
    const record = state.records[todayKey] || (yRec && yRec.clockOut >= today.getTime() ? yRec : null);
    const todayInst = instanceFor(state, today);

    if (todayInst && todayInst.fullLeave) {
      const wage = dailyWage(state, today, { cache });
      const own = state.records[todayKey] || null;
      return {
        kind: 'leave',
        inst: todayInst,
        earn: own ? null : earnFor(state, todayInst, now, wage),
        wage,
        next,
        target: next ? next.workStart : null,
        progress: 0,
        record: own,
        mark,
      };
    }

    if (todayInst && !state.records[todayKey] && now < todayInst.workStart) {
      const wage = dailyWage(state, today, { cache });
      return {
        kind: 'before',
        inst: todayInst,
        earn: earnFor(state, todayInst, now, wage),
        wage,
        next: todayInst,
        target: todayInst.workStart,
        progress: 0,
        record,
        mark,
      };
    }
    return {
      kind: record ? 'settled' : 'rest',
      inst: todayInst,
      earn: null,
      wage: next ? dailyWage(state, next.date, { cache }) : 0,
      next,
      target: next ? next.workStart : null,
      progress: 0,
      record,
      mark,
    };
  }

  const liveEarned = (st) => (st.earn ? st.earn.total : 0);

  /* 卡片大字显示的今日金额：进行中取实时值，已结算取结算值。 */
  const todayEarned = (st) => (st.earn && st.earn.total > 0 ? st.earn.total : st.record ? st.record.total : 0);

  /* ---------- 心愿 ---------- */
  const isFilled = (w) => w.saved >= w.budget - EPS;
  const activeWishes = (state) => state.wishes.filter((w) => !w.achievedAt && !isFilled(w));
  const filledWishes = (state) => state.wishes.filter((w) => !w.achievedAt && isFilled(w));
  const achievedWishes = (state) => state.wishes.filter((w) => !!w.achievedAt);
  const findWish = (state, id) => state.wishes.find((w) => w.id === id) || null;

  function give(wish, amount, now, filled) {
    const take = Math.min(amount, Math.max(0, wish.budget - wish.saved));
    if (take <= EPS) return 0;
    wish.saved += take;
    if (isFilled(wish)) {
      wish.saved = wish.budget;
      if (!wish.filledAt) {
        wish.filledAt = now;
        filled.push(wish);
      }
    }
    return take;
  }

  /* 按队列顺序把钱存进心愿，蓄满后溢出给下一个，全部蓄满后进未分配余额。 */
  function allocate(state, amount, now) {
    const parts = [];
    const filled = [];
    let left = amount;
    for (const w of activeWishes(state)) {
      if (left <= EPS) break;
      const taken = give(w, left, now, filled);
      if (taken > 0) {
        parts.push({ id: w.id, amount: taken });
        left -= taken;
      }
    }
    if (left > EPS) {
      state.wishSurplus += left;
      parts.push({ id: null, amount: left });
    }
    return { parts, filled };
  }

  function unallocate(state, parts) {
    for (const p of parts) {
      if (p.id === null) {
        state.wishSurplus = Math.max(0, state.wishSurplus - p.amount);
        continue;
      }
      const w = findWish(state, p.id);
      if (!w || w.achievedAt) continue; // 已实现的心愿，钱已经花掉了，不再回退
      w.saved = Math.max(0, w.saved - p.amount);
      if (!isFilled(w)) w.filledAt = null;
    }
  }

  function absorbSurplus(state, now) {
    const amount = state.wishSurplus;
    state.wishSurplus = 0;
    return amount > EPS ? allocate(state, amount, now).filled : [];
  }

  function addWish(state, { name, budget }, now) {
    const wish = {
      id: `w${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      name: str(name, '心愿', 40),
      budget: num(budget, 0, 0),
      saved: 0,
      createdAt: now,
      filledAt: null,
      achievedAt: null,
    };
    const active = activeWishes(state);
    state.wishes = [...active, wish, ...state.wishes.filter((w) => !active.includes(w))];
    return { wish, filled: absorbSurplus(state, now) };
  }

  function updateWish(state, id, patch, now) {
    const w = findWish(state, id);
    if (!w) return [];
    if (patch.name !== undefined) w.name = str(patch.name, w.name, 40);
    if (patch.budget !== undefined) w.budget = num(patch.budget, w.budget, 0.01);
    if (patch.saved !== undefined) w.saved = num(patch.saved, w.saved, 0);

    const filled = [];
    let overflow = 0;
    if (w.saved > w.budget) {
      overflow = w.saved - w.budget;
      w.saved = w.budget;
    }
    if (isFilled(w)) {
      if (!w.filledAt) {
        w.filledAt = now;
        filled.push(w);
      }
    } else {
      w.filledAt = null;
    }
    if (overflow > EPS) filled.push(...allocate(state, overflow, now).filled);
    filled.push(...absorbSurplus(state, now));
    return filled;
  }

  /* mode: 'transfer' 把已攒金额转给队列里的其他心愿，'drop' 一并清掉。 */
  function removeWish(state, id, mode, now) {
    const w = findWish(state, id);
    if (!w) return [];
    state.wishes = state.wishes.filter((x) => x !== w);
    return mode === 'transfer' && w.saved > EPS && !w.achievedAt ? allocate(state, w.saved, now).filled : [];
  }

  function achieveWish(state, id, now) {
    const w = findWish(state, id);
    if (w) w.achievedAt = now;
  }

  /*
   * 调整顺序前先算出影响：
   * - 首位变了：原首位是否已有进度，决定要不要询问；
   * - 首位没变但某个有进度的心愿被往后挪：询问是否把进度交给接替它位置的心愿。
   */
  function planWishMove(state, id, toIndex) {
    const active = activeWishes(state);
    const from = active.findIndex((w) => w.id === id);
    if (from < 0) return { changed: false, choice: null, order: active };
    const to = clamp(toIndex, 0, active.length - 1);
    if (to === from) return { changed: false, choice: null, order: active };

    const order = active.slice();
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);

    let subject = null;
    let target = null;
    if (order[0] !== active[0]) {
      subject = active[0];
      target = order[0];
    } else if (to > from) {
      subject = moved;
      target = order[from];
    }
    const choice =
      subject && subject.saved > EPS
        ? { subjectId: subject.id, subjectName: subject.name, targetId: target.id, targetName: target.name, amount: subject.saved }
        : null;
    return { changed: true, choice, order };
  }

  function applyWishMove(state, id, toIndex, mode, now) {
    const plan = planWishMove(state, id, toIndex);
    if (!plan.changed) return [];
    state.wishes = [...plan.order, ...state.wishes.filter((w) => !plan.order.includes(w))];
    if (mode !== 'transfer' || !plan.choice) return [];

    const subject = findWish(state, plan.choice.subjectId);
    const target = findWish(state, plan.choice.targetId);
    const amount = subject.saved;
    subject.saved = 0;
    subject.filledAt = null;
    const filled = [];
    const taken = give(target, amount, now, filled);
    if (amount - taken > EPS) filled.push(...allocate(state, amount - taken, now).filled);
    return filled;
  }

  /* 只预览不入账：今天还没结算的收入先算到队列上，用来实时显示进度。 */
  function previewWishes(state, pending) {
    let left = pending;
    const items = activeWishes(state).map((wish) => {
      const live = Math.min(Math.max(0, left), wish.budget - wish.saved);
      left -= live;
      return { wish, live, saved: wish.saved + live, remaining: Math.max(0, wish.budget - wish.saved - live) };
    });
    return { items, surplus: state.wishSurplus + Math.max(0, left) };
  }

  /*
   * 沿着排班往后走，算出每个心愿还需要工作多久。只按正常班次估算，不把加班算进去。
   * limit：只算前几个心愿，小窗只显示首位，不必走完整个队列。
   */
  function forecastWishes(state, now, status, limit) {
    const share = state.wishShare / 100;
    const preview = previewWishes(state, liveEarned(status) * share);
    const items = preview.items.map((it) => ({ ...it, workSeconds: 0, shifts: 0, eta: null, reachable: false, projected: false }));
    const result = { items, surplus: preview.surplus, blocked: null };

    if (!(state.salary.monthly > 0)) result.blocked = 'no-salary';
    else if (share <= 0) result.blocked = 'no-share';
    if (result.blocked) return result;

    const max = Math.min(items.length, limit === undefined ? items.length : limit);
    let i = 0;
    const skipDone = () => {
      while (i < max && items[i].remaining <= EPS) {
        items[i].reachable = true;
        items[i].eta = now;
        i++;
      }
    };
    skipDone();
    if (i >= max) return result;

    let need = items[i].remaining;
    let work = 0;
    let shifts = 0;
    let projected = false;
    const finish = (t) => {
      Object.assign(items[i], { workSeconds: work, shifts, eta: t, reachable: true, projected });
      i++;
      skipDone();
      if (i < max) need = items[i].remaining;
    };
    const cache = new Map();
    const inProgress = status.inst && (status.kind === 'working' || status.kind === 'lunch');
    let d = inProgress ? status.inst.date : startOfDay(now);

    for (let n = 0; n < FORECAST_MAX_DAYS && i < max; n++, d = addDays(d, 1)) {
      const inst = instanceFor(state, d, true);
      if (!inst || state.records[inst.key] || inst.end <= now) continue;
      const rate = (dailyWage(state, d, { project: true, cache }) / inst.seconds) * share;
      if (rate <= 0) continue;

      // 这一天的收入按时间排开：工作段按秒累计，假期工资整笔计入。已开始的假期工资已经算在预览里了。
      const events = [];
      if (inst.leaveSegs.length && inst.leaveSegs[0][0] > now) {
        events.push({ t: inst.leaveSegs[0][0], lump: inst.leaveSeconds * rate * inst.ratio });
      }
      for (const [a, b] of inst.workSegs) if (b > now) events.push({ t: Math.max(a, now), until: b });
      if (!events.length) continue;
      events.sort((x, y) => x.t - y.t);
      if (events.some((ev) => ev.until !== undefined)) shifts++;
      projected = projected || inst.projected;

      for (const ev of events) {
        if (ev.lump !== undefined) {
          let money = ev.lump;
          while (i < max && money > EPS) {
            if (money < need) {
              need -= money;
              break;
            }
            money -= need;
            finish(ev.t);
          }
          continue;
        }
        let t = ev.t;
        let left = (ev.until - t) / SECOND;
        while (i < max) {
          const sec = need / rate;
          if (sec > left) {
            work += left;
            need -= left * rate;
            break;
          }
          work += sec;
          left -= sec;
          t += sec * SECOND;
          finish(t);
        }
      }
    }
    return result;
  }

  /* ---------- 结算 ---------- */
  function settleInstance(state, inst, at, options) {
    const opts = options || {};
    const wage = opts.wage !== undefined ? opts.wage : dailyWage(state, inst.date);
    const earn = earnFor(state, inst, at, wage);
    // 结算时假期工资整笔入账，哪怕请假段还没开始（比如下午请假，中午就点了下班）。
    const total = earn.normal + earn.overtime + earn.leaveFull;
    const { parts, filled } = allocate(state, total * (state.wishShare / 100), opts.now);
    const record = {
      key: inst.key,
      shiftName: inst.shift.name,
      start: inst.start,
      end: inst.end,
      clockOut: at,
      wage,
      normal: earn.normal,
      overtime: earn.overtime,
      otSeconds: earn.otSeconds,
      leavePay: earn.leaveFull,
      total,
      auto: !!opts.auto,
      reviewed: opts.reviewed !== undefined ? opts.reviewed : !opts.auto,
      voided: false,
      alloc: parts,
      workSegs: inst.workSegs.map((p) => [p[0], p[1]]),
      paidSeconds: inst.seconds,
      leaveSeconds: inst.leaveSeconds,
      leaveRatio: inst.ratio,
      mark: inst.mark ? { type: inst.mark.type, half: inst.mark.half } : null,
    };
    state.records[inst.key] = record;
    return { record, filled };
  }

  /* 已结算的日子后来才标记请假或取消标记：按新的安排重算，保留原来的加班时长。 */
  function resettle(state, key, now) {
    const rec = state.records[key];
    if (!rec || rec.voided) return [];
    const inst = instanceFor(state, parseDateKey(key));
    if (!inst) return [];
    const oldWorkEnd = rec.workSegs.length ? rec.workSegs[rec.workSegs.length - 1][1] : rec.end;
    let at = inst.end;
    if (!inst.fullLeave) {
      at = rec.clockOut >= oldWorkEnd ? inst.workEnd + rec.otSeconds * SECOND : Math.min(rec.clockOut, inst.workEnd);
    }
    unallocate(state, rec.alloc);
    return settleInstance(state, inst, at, { wage: rec.wage, auto: rec.auto, reviewed: rec.reviewed, now }).filled;
  }

  function clockOut(state, now) {
    const st = getStatus(state, now);
    if (st.kind !== 'working' && st.kind !== 'overtime') return null;
    return settleInstance(state, st.inst, now, { now });
  }

  /* 撤销刚才的结算：删掉记录，回到上班状态。 */
  function reopenRecord(state, key) {
    const rec = state.records[key];
    if (!rec) return;
    unallocate(state, rec.alloc);
    delete state.records[key];
  }

  /*
   * 补结算：程序没开、或忘记点下班的班次。只算正常工资，不算加班，
   * 否则睡一觉也会多出一笔“加班费”。实际下班时间可以之后在记录里改。
   */
  function autoSettle(state, now) {
    const today = startOfDay(now);
    const results = [];
    // 没填月薪说明还没配置好，默认排班产生的日子不算真的上过班。
    const configured = state.salary.monthly > 0;
    for (let d = parseDateKey(state.processedFrom); configured && d <= today; d = addDays(d, 1)) {
      const inst = instanceFor(state, d);
      if (!inst || state.records[inst.key]) continue;
      const deadline = closeAt(state, inst);
      if (now >= deadline) {
        // 全天休假本来就不用点下班，正常入账，不算“忘记”。
        const at = inst.fullLeave ? inst.end : Math.min(inst.workEnd, deadline);
        results.push(settleInstance(state, inst, at, { auto: !inst.fullLeave, now }));
      }
    }
    const from = dateKey(addDays(today, -1));
    if (from > state.processedFrom) state.processedFrom = from;
    return results;
  }

  /* 修改某天的实际下班时间，金额按当时的日薪重算，心愿入账同步调整。 */
  function reviseRecord(state, key, newClockOut, now) {
    const rec = state.records[key];
    if (!rec) return null;
    unallocate(state, rec.alloc);
    const inst = {
      seconds: rec.paidSeconds,
      workSegs: rec.workSegs,
      workEnd: rec.workSegs.length ? rec.workSegs[rec.workSegs.length - 1][1] : null,
      leaveSegs: rec.leaveSeconds > 0 ? [[rec.start, rec.start]] : [],
      leaveSeconds: rec.leaveSeconds,
      ratio: rec.leaveRatio,
    };
    const at = Math.max(rec.start, newClockOut);
    const earn = earnFor(state, inst, at, rec.wage);
    const total = earn.normal + earn.overtime + earn.leaveFull;
    const { parts, filled } = allocate(state, total * (state.wishShare / 100), now);
    Object.assign(rec, {
      clockOut: at,
      normal: earn.normal,
      overtime: earn.overtime,
      otSeconds: earn.otSeconds,
      leavePay: earn.leaveFull,
      total,
      auto: false,
      reviewed: true,
      voided: false,
      alloc: parts,
    });
    return { record: rec, filled };
  }

  /* 这天不计薪（请假、其实没上班）。保留一条作废记录，防止又被自动补结算。 */
  function voidRecord(state, key) {
    const rec = state.records[key];
    if (!rec) return;
    unallocate(state, rec.alloc);
    Object.assign(rec, { normal: 0, overtime: 0, otSeconds: 0, leavePay: 0, total: 0, alloc: [], voided: true, auto: false, reviewed: true });
  }

  const unreviewedRecords = (state) =>
    Object.values(state.records)
      .filter((r) => r.auto && !r.reviewed)
      .sort((a, b) => a.key.localeCompare(b.key));

  function markReviewed(state) {
    for (const r of Object.values(state.records)) r.reviewed = true;
  }

  function monthStats(state, y, m) {
    const prefix = `${monthKey(y, m)}-`;
    const rows = Object.values(state.records)
      .filter((r) => r.key.startsWith(prefix))
      .sort((a, b) => b.key.localeCompare(a.key));
    const stats = { rows, earned: 0, otSeconds: 0, overtimePay: 0, attended: 0, scheduled: workDayCount(state.schedule, y, m) };
    for (const r of rows) {
      if (r.voided) continue;
      stats.earned += r.total;
      stats.otSeconds += r.otSeconds;
      stats.overtimePay += r.overtime;
      stats.attended++;
    }
    return stats;
  }

  /*
   * 一键核算：从 1 号累计到现在。已结算的日子用结算金额，今天用实时金额，
   * 其余有排班的日子（比如开始用这个程序之前）按排班和标记补算。
   * 只用于显示，不写记录，也不存入心愿。
   */
  function monthReckon(state, y, m, now, status) {
    const result = { settled: 0, live: 0, estimated: 0, estimatedDays: 0, total: 0 };
    const cache = new Map();
    const days = daysInMonth(y, m);
    for (let day = 1; day <= days; day++) {
      const date = new Date(y, m, day);
      if (date.getTime() > now) break;
      const key = dateKey(date);
      const rec = state.records[key];
      if (rec) {
        result.settled += rec.total;
        continue;
      }
      if (status && status.earn && status.inst && status.inst.key === key) {
        result.live += status.earn.total;
        continue;
      }
      const inst = instanceFor(state, date);
      if (!inst) continue;
      const wage = dailyWage(state, date, { cache });
      const earn = earnFor(state, inst, Math.min(now, inst.fullLeave ? inst.end : inst.workEnd), wage);
      const amount = inst.end <= now ? earn.normal + earn.leaveFull : earn.total;
      if (amount > 0) {
        result.estimated += amount;
        result.estimatedDays++;
      }
    }
    result.total = result.settled + result.live + result.estimated;
    return result;
  }

  /* 当月请假天数（半天算 0.5），只统计有排班的日子。 */
  function monthLeaveDays(state, y, m) {
    let n = 0;
    const days = daysInMonth(y, m);
    for (let day = 1; day <= days; day++) {
      const date = new Date(y, m, day);
      const mark = state.schedule.marks[dateKey(date)];
      if (mark && mark.type !== 'holiday' && shiftFor(state.schedule, date)) n += mark.half ? 0.5 : 1;
    }
    return n;
  }

  /* ---------- 任务 ---------- */
  /*
   * 一段时间值多少工资：上班时段按时薪，下班之后到点下班之间按加班费，
   * 午休、休息日、请假和已下班之后都不计。回报是工资的一部分，不会重复计入今日已赚。
   */
  function intervalPay(state, a, b) {
    const result = { paidSeconds: 0, earned: 0 };
    if (b <= a) return result;
    const cache = new Map();
    const overlap = (x, y) => Math.max(0, Math.min(b, y) - Math.max(a, x)) / SECOND;
    for (let d = addDays(startOfDay(a), -1); d.getTime() <= b; d = addDays(d, 1)) {
      const rec = state.records[dateKey(d)];
      let segs;
      let rate;
      let otFrom;
      let otTo;
      if (rec) {
        if (rec.voided || !rec.workSegs.length) continue;
        rate = rec.paidSeconds > 0 ? rec.wage / rec.paidSeconds : 0;
        segs = rec.workSegs.map(([x, y]) => [x, Math.min(y, rec.clockOut)]);
        otFrom = rec.workSegs[rec.workSegs.length - 1][1];
        otTo = rec.clockOut;
      } else {
        const inst = instanceFor(state, d);
        if (!inst || inst.fullLeave) continue;
        rate = inst.seconds > 0 ? dailyWage(state, d, { cache }) / inst.seconds : 0;
        segs = inst.workSegs;
        otFrom = inst.workEnd;
        otTo = closeAt(state, inst);
      }
      for (const [x, y] of segs) {
        const s = overlap(x, y);
        result.paidSeconds += s;
        result.earned += s * rate;
      }
      const otRate = overtimeRate(state.overtime, rate);
      if (otRate > 0) {
        const s = overlap(otFrom, otTo);
        result.paidSeconds += s;
        result.earned += s * otRate;
      }
    }
    return result;
  }

  const findTask = (state, id) => state.tasks.find((t) => t.id === id) || null;
  const runningTask = (state) => state.tasks.find((t) => t.status === 'running') || null;

  /* 小窗优先显示计时中的任务，其次是最近暂停的。 */
  function activeTask(state) {
    const running = runningTask(state);
    if (running) return running;
    const paused = state.tasks.filter((t) => t.status === 'paused');
    const lastEnd = (t) => t.segments[t.segments.length - 1][1];
    return paused.sort((x, y) => lastEnd(y) - lastEnd(x))[0] || null;
  }

  function startedTasks(state) {
    return state.tasks
      .filter((t) => t.status === 'running' || t.status === 'paused')
      .sort((x, y) => (x.status === 'running' ? -1 : y.status === 'running' ? 1 : y.createdAt - x.createdAt));
  }

  /* 还没开始的任务：有预约的按时间排在前面，其余按创建顺序。 */
  function plannedTasks(state) {
    const when = (t) => (t.scheduledStart === null ? Infinity : t.scheduledStart);
    return state.tasks.filter((t) => t.status === 'planned').sort((x, y) => when(x) - when(y) || x.createdAt - y.createdAt);
  }

  function doneTasks(state, y, m) {
    return state.tasks
      .filter((t) => {
        if (t.status !== 'done') return false;
        const d = new Date(t.doneAt);
        return d.getFullYear() === y && d.getMonth() === m;
      })
      .sort((x, z) => z.doneAt - x.doneAt);
  }

  function addTask(state, { name, scheduledStart, scheduledEnd }, now) {
    const clean = typeof name === 'string' ? name.trim() : '';
    const task = {
      id: `t${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      name: clean ? clean.slice(0, 40) : `任务 ${fmtDate(now).split(' ')[0]} ${fmtHM(now)}`,
      status: 'planned',
      createdAt: now,
      scheduledStart: scheduledStart === undefined ? null : scheduledStart,
      scheduledEnd: scheduledEnd === undefined ? null : scheduledEnd,
      segments: [],
      doneAt: null,
      seconds: 0,
      paidSeconds: 0,
      earned: 0,
      notified: { start: false, ending: false, end: false },
    };
    state.tasks.push(task);
    return task;
  }

  function pauseTask(state, id, now) {
    const t = findTask(state, id);
    if (!t || t.status !== 'running') return;
    t.segments[t.segments.length - 1][1] = Math.max(now, t.segments[t.segments.length - 1][0]);
    t.status = 'paused';
  }

  /* 下班时暂停正在计时的任务，返回被暂停的任务。 */
  function pauseRunningTask(state, now) {
    const t = runningTask(state);
    if (t) pauseTask(state, t.id, now);
    return t;
  }

  /* 开始或继续。一次只计一个任务，别的任务在计时就先暂停。 */
  function startTask(state, id, now) {
    const t = findTask(state, id);
    if (!t || t.status === 'running' || t.status === 'done') return;
    pauseRunningTask(state, now);
    t.segments.push([now, null]);
    t.status = 'running';
  }

  function taskStats(state, task, now) {
    if (task.status === 'done') return { seconds: task.seconds, paidSeconds: task.paidSeconds, earned: task.earned };
    const stats = { seconds: 0, paidSeconds: 0, earned: 0 };
    for (const [a, b] of task.segments) {
      const end = b === null ? now : b;
      stats.seconds += Math.max(0, end - a) / SECOND;
      const pay = intervalPay(state, a, end);
      stats.paidSeconds += pay.paidSeconds;
      stats.earned += pay.earned;
    }
    return stats;
  }

  /* 结算：把耗时和回报固定下来，之后改工资或排班都不影响这条记录。 */
  function finishTask(state, id, now) {
    const t = findTask(state, id);
    if (!t || (t.status !== 'running' && t.status !== 'paused')) return null;
    pauseTask(state, id, now);
    const stats = taskStats(state, t, now);
    Object.assign(t, stats, { status: 'done', doneAt: now });
    return t;
  }

  /* 撤销结算，回到暂停状态。 */
  function reopenTask(state, id) {
    const t = findTask(state, id);
    if (!t || t.status !== 'done') return;
    Object.assign(t, { status: 'paused', doneAt: null, seconds: 0, paidSeconds: 0, earned: 0 });
  }

  function updateTask(state, id, patch) {
    const t = findTask(state, id);
    if (!t) return;
    if (patch.name !== undefined) t.name = str(patch.name.trim(), t.name, 40) || t.name;
    if (patch.scheduledStart !== undefined && patch.scheduledStart !== t.scheduledStart) {
      t.scheduledStart = patch.scheduledStart;
      t.notified.start = false;
    }
    if (patch.scheduledEnd !== undefined && patch.scheduledEnd !== t.scheduledEnd) {
      t.scheduledEnd = patch.scheduledEnd;
      t.notified.ending = false;
      t.notified.end = false;
    }
  }

  function removeTask(state, id) {
    state.tasks = state.tasks.filter((t) => t.id !== id);
  }

  /*
   * 到点的预约提醒，每种只提醒一次。程序没开时错过太久的就不补了，只在任务页标出来。
   * “快结束”和“结束”只提醒已经开始的任务，没开始的任务提醒结束没有意义。
   */
  function dueTaskReminders(state, now) {
    const reminders = [];
    let changed = false;
    for (const t of state.tasks) {
      if (t.status === 'done') continue;
      const n = t.notified;
      if (t.scheduledStart !== null && !n.start && now >= t.scheduledStart) {
        n.start = true;
        changed = true;
        if (t.status === 'planned' && now - t.scheduledStart < REMINDER_LATE_LIMIT) reminders.push({ kind: 'start', task: t });
      }
      if (t.scheduledEnd === null || t.status === 'planned') continue;
      if (!n.end && now >= t.scheduledEnd) {
        n.end = true;
        n.ending = true;
        changed = true;
        if (now - t.scheduledEnd < REMINDER_LATE_LIMIT) reminders.push({ kind: 'end', task: t });
      } else if (!n.ending && now >= t.scheduledEnd - TASK_ENDING_NOTICE) {
        n.ending = true;
        changed = true;
        reminders.push({ kind: 'ending', task: t });
      }
    }
    return { reminders, changed };
  }

  /* ---------- 排班编辑 ---------- */
  /*
   * 在日历上点一下。brush: { kind: 'shift', id } | { kind: 'off' } | { kind: 'mark', type, half }。
   * 标记不会改变排班，所以请假不影响当月排班天数：事假扣的就是这一天该得的钱。
   */
  function applyBrush(state, date, brush, now) {
    const s = state.schedule;
    const key = dateKey(date);
    if (brush.kind === 'mark') {
      const mark = cleanMark({ type: brush.type, half: brush.half });
      const current = s.marks[key];
      if (current && current.type === mark.type && current.half === mark.half) delete s.marks[key];
      else s.marks[key] = mark;
      return { filled: resettle(state, key, now), noShift: !shiftFor(s, date) };
    }

    const hadMark = !!s.marks[key];
    delete s.marks[key];
    let filled = hadMark ? resettle(state, key, now) : [];
    if (brush.kind === 'off') {
      if (s.mode === 'monthly') {
        const plan = s.monthly[monthKey(date.getFullYear(), date.getMonth())];
        if (plan) delete plan[date.getDate()];
      } else if (!shiftIdFor(s, date) || !s.weekly[date.getDay()]) {
        delete s.exceptions[key];
      } else {
        s.exceptions[key] = 'off';
      }
    } else if (!(hadMark && shiftIdFor(s, date) === brush.id)) {
      // 这天本来就排了这个班、只是带着标记时，这一下只清掉标记，不把班也取消。
      toggleDay(state, date, brush.id);
    }
    return { filled, noShift: false };
  }

  function toggleDay(state, date, brushId) {
    const s = state.schedule;
    if (s.mode === 'monthly') {
      const ym = monthKey(date.getFullYear(), date.getMonth());
      const plan = s.monthly[ym] || (s.monthly[ym] = {});
      const d = date.getDate();
      if (plan[d] === brushId) delete plan[d];
      else plan[d] = brushId;
      return;
    }
    const key = dateKey(date);
    const base = s.weekly[date.getDay()] || null;
    const next = shiftIdFor(s, date) === brushId ? null : brushId;
    if (next === base) delete s.exceptions[key];
    else s.exceptions[key] = next === null ? 'off' : next;
  }

  function toggleWeekday(state, weekday, brushId) {
    const w = state.schedule.weekly;
    if (w[weekday] === brushId) delete w[weekday];
    else w[weekday] = brushId;
  }

  function fillMonthWeekdays(state, y, m, brushId) {
    const plan = {};
    const total = daysInMonth(y, m);
    for (let d = 1; d <= total; d++) {
      const wd = new Date(y, m, d).getDay();
      if (wd >= 1 && wd <= 5) plan[d] = brushId;
    }
    state.schedule.monthly[monthKey(y, m)] = plan;
  }

  function clearMonth(state, y, m) {
    state.schedule.monthly[monthKey(y, m)] = {};
  }

  function copyPreviousMonth(state, y, m) {
    const prev = new Date(y, m - 1, 1);
    const src = state.schedule.monthly[monthKey(prev.getFullYear(), prev.getMonth())];
    if (!src || !Object.keys(src).length) return false;
    const total = daysInMonth(y, m);
    const plan = {};
    for (const [d, id] of Object.entries(src)) if (Number(d) <= total) plan[d] = id;
    state.schedule.monthly[monthKey(y, m)] = plan;
    return true;
  }

  function addShift(state, patch) {
    const s = state.schedule;
    const base = s.shifts[s.shifts.length - 1];
    const shift = {
      id: `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
      name: str(patch && patch.name, `班次${s.shifts.length + 1}`, 12),
      start: (patch && patch.start) || base.start,
      end: (patch && patch.end) || base.end,
      breakStart: base.breakStart,
      breakEnd: base.breakEnd,
    };
    s.shifts.push(shift);
    return shift;
  }

  function updateShift(state, id, patch) {
    const shift = shiftById(state.schedule, id);
    if (!shift) return;
    if (patch.name !== undefined) shift.name = str(patch.name, shift.name, 12) || shift.name;
    if (parseHM(patch.start) !== null) shift.start = patch.start;
    if (parseHM(patch.end) !== null) shift.end = patch.end;
    if (patch.breakStart !== undefined) shift.breakStart = parseHM(patch.breakStart) !== null ? patch.breakStart : null;
    if (patch.breakEnd !== undefined) shift.breakEnd = parseHM(patch.breakEnd) !== null ? patch.breakEnd : null;
  }

  /* 删除班次时，已经用它排好的日子改用第一个剩余班次，不会悄悄变成休息日。 */
  function removeShift(state, id) {
    const s = state.schedule;
    if (s.shifts.length <= 1) return false;
    s.shifts = s.shifts.filter((x) => x.id !== id);
    const fallback = s.shifts[0].id;
    const remap = (obj) => {
      for (const k of Object.keys(obj)) if (obj[k] === id) obj[k] = fallback;
    };
    remap(s.weekly);
    remap(s.exceptions);
    Object.values(s.monthly).forEach(remap);
    return true;
  }

  /* ---------- 文本格式 ---------- */
  /* “病假”、“上午事假”。 */
  function markText(mark) {
    return mark ? `${mark.half ? HALF_NAMES[mark.half] : ''}${MARK_NAMES[mark.type]}` : '';
  }

  function fmtMoney(v, decimals) {
    const value = Number.isFinite(v) ? Math.max(0, v) : 0;
    const [i, f] = value.toFixed(decimals === undefined ? 2 : decimals).split('.');
    const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return f ? `${grouped}.${f}` : grouped;
  }
  function fmtDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }
  function fmtCountdown(ms) {
    const total = Math.max(0, Math.ceil(ms / SECOND));
    const days = Math.floor(total / 86400);
    const rest = fmtDuration(total % 86400);
    return days > 0 ? `${days}天 ${rest}` : rest;
  }
  function fmtWork(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}小时${pad(m)}分${pad(r)}秒`;
    if (m > 0) return `${m}分${pad(r)}秒`;
    return `${r}秒`;
  }
  function fmtClock(ms) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function fmtHM(ms) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtDate(ms) {
    const d = new Date(ms);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK_NAMES[d.getDay()]}`;
  }
  /* 跨年的预计日期要带上年份，否则“3月2日”分不清是哪一年。 */
  function fmtEta(ms, now) {
    const d = new Date(ms);
    const md = `${d.getMonth() + 1}月${d.getDate()}日`;
    return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}年${md}`;
  }

  root.Core = {
    HOUR,
    MINUTE,
    LEGAL_MONTH_DAYS,
    WEEK_NAMES,
    MARK_NAMES,
    pad,
    dateKey,
    monthKey,
    parseDateKey,
    startOfDay,
    addDays,
    daysInMonth,
    parseHM,
    defaultState,
    normalizeState,
    shiftById,
    shiftFor,
    shiftIdFor,
    shiftSeconds,
    shiftHalves,
    suggestBreak,
    breakOffsets,
    workDayCount,
    dailyWage,
    instanceFor,
    closeAt,
    earnFor,
    getStatus,
    liveEarned,
    todayEarned,
    isFilled,
    activeWishes,
    filledWishes,
    achievedWishes,
    findWish,
    allocate,
    addWish,
    updateWish,
    removeWish,
    achieveWish,
    planWishMove,
    applyWishMove,
    previewWishes,
    forecastWishes,
    clockOut,
    reopenRecord,
    autoSettle,
    reviseRecord,
    voidRecord,
    unreviewedRecords,
    markReviewed,
    intervalPay,
    findTask,
    runningTask,
    activeTask,
    startedTasks,
    plannedTasks,
    doneTasks,
    addTask,
    startTask,
    pauseTask,
    pauseRunningTask,
    finishTask,
    reopenTask,
    updateTask,
    removeTask,
    taskStats,
    dueTaskReminders,
    monthStats,
    monthReckon,
    monthLeaveDays,
    applyBrush,
    markText,
    toggleDay,
    toggleWeekday,
    fillMonthWeekdays,
    clearMonth,
    copyPreviousMonth,
    addShift,
    updateShift,
    removeShift,
    fmtMoney,
    fmtDuration,
    fmtCountdown,
    fmtWork,
    fmtClock,
    fmtHM,
    fmtDate,
    fmtEta,
  };
})(typeof window !== 'undefined' ? window : globalThis);
