'use strict';

/* ---------- small helpers ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';
const DAY_MS = 86400000;
const MAX_CONCURRENT = 4;
// Garmin rejects longer ranges on these endpoints (HTTP 400), so requests are split.
const SHORT_RANGE_DAYS = 28;
const LONG_RANGE_DAYS = 365;
const ACTIVITY_PAGE = 100;
const ACTIVITY_MAX_PAGES = 30;

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'disabled' || k === 'open') e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(kid);
  }
  return e;
}

function s(tag, attrs, ...kids) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v !== null && v !== undefined) e.setAttribute(k, v);
  }
  for (const kid of kids) e.append(kid);
  return e;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const sum = (a) => a.filter(isNum).reduce((t, v) => t + v, 0);
const avg = (a) => { const n = a.filter(isNum); return n.length ? sum(n) / n.length : null; };
const nonNegative = (v) => (isNum(v) && v >= 0 ? v : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pad2 = (v) => String(v).padStart(2, '0');

function isoLocal(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function toUtc(iso) { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function fromUtc(ms) { return new Date(ms).toISOString().slice(0, 10); }
function addDays(iso, n) { return fromUtc(toUtc(iso) + n * DAY_MS); }
function daysBetween(a, b) { return Math.round((toUtc(b) - toUtc(a)) / DAY_MS); }
function dateRange(a, b) { const out = []; for (let t = toUtc(a); t <= toUtc(b); t += DAY_MS) out.push(fromUtc(t)); return out; }
function parseTs(v) { return Date.parse(/Z$/.test(v) ? v : `${v}Z`); }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDay(ms) { const d = new Date(ms); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; }
function fmtDayLong(ms) { return `${fmtDay(ms)}, ${new Date(ms).getUTCFullYear()}`; }
function fmtClock(ms) { const d = new Date(ms); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; }
function fmtIsoDay(iso) { return fmtDayLong(toUtc(iso)); }

function fmtNum(v, digits = 0) {
  if (!isNum(v)) return '–';
  return v.toLocaleString('en-US', { maximumFractionDigits: digits });
}
function fmtCompact(v) {
  if (!isNum(v)) return '–';
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${fmtNum(v / 1e6, 1)}M`;
  if (abs >= 1e4) return `${fmtNum(v / 1e3, 1)}K`;
  return fmtNum(v, abs < 10 && v % 1 ? 1 : 0);
}
function fmtDuration(seconds) {
  if (!isNum(seconds)) return '–';
  const total = Math.round(seconds / 60);
  const hours = Math.floor(total / 60);
  return hours ? `${hours}h ${pad2(total % 60)}m` : `${total}m`;
}
function humanize(v) {
  if (v === null || v === undefined) return '–';
  const text = String(v).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const imperial = () => Boolean(S.profile && S.profile.measurementSystem && S.profile.measurementSystem !== 'metric');
const distValue = (meters) => (isNum(meters) ? meters / (imperial() ? 1609.344 : 1000) : null);
const distUnit = () => (imperial() ? 'mi' : 'km');
const fmtDist = (meters) => (isNum(meters) ? `${fmtNum(distValue(meters), 2)} ${distUnit()}` : '–');
const fmtSpeed = (mps) => (isNum(mps) ? `${fmtNum(mps * (imperial() ? 2.23694 : 3.6), 1)} ${imperial() ? 'mph' : 'km/h'}` : '–');
const weightValue = (grams) => (isNum(grams) ? grams / (imperial() ? 453.592 : 1000) : null);
const weightUnit = () => (imperial() ? 'lb' : 'kg');

/* ---------- state ---------- */

const today = () => isoLocal(new Date());
const S = {
  tab: 'overview',
  preset: 30,
  start: addDays(today(), -29),
  end: today(),
  day: today(),
  profile: null,
  memo: new Map(),
  renderId: 0,
  workoutId: null,
  workoutType: '',
  workoutQuery: '',
  explorerId: 'daily',
};

/* ---------- data access ---------- */

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let active = 0;
const waiting = [];
function slot() {
  if (active < MAX_CONCURRENT) { active += 1; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else active -= 1;
}

async function api(path) {
  await slot();
  try {
    const res = await fetch(`/api/garmin${path}`);
    if (res.status === 204) return null;
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new ApiError(res.status, (body && body.error) || `Request failed (HTTP ${res.status}).`);
    }
    return body;
  } finally {
    release();
  }
}

function memo(key, fn) {
  if (!S.memo.has(key)) {
    const promise = fn();
    S.memo.set(key, promise);
    promise.catch(() => S.memo.delete(key));
  }
  return S.memo.get(key);
}

function chunks(start, end, size) {
  const out = [];
  let from = start;
  while (toUtc(from) <= toUtc(end)) {
    const to = fromUtc(Math.min(toUtc(from) + (size - 1) * DAY_MS, toUtc(end)));
    out.push([from, to]);
    from = addDays(to, 1);
  }
  return out;
}

async function fetchChunked(makePath, start, end, size, pick) {
  const parts = await Promise.all(chunks(start, end, size).map(([a, b]) => api(makePath(a, b))));
  return parts.flatMap((part) => {
    const list = pick ? pick(part) : part;
    return Array.isArray(list) ? list : [];
  });
}

const qs = (a, b) => `startDate=${a}&endDate=${b}`;
const data = {
  daily: () => memo(`daily:${S.start}:${S.end}`, () => fetchChunked(
    (a, b) => `/usersummary-service/v2/dailysummaries?${qs(a, b)}`, S.start, S.end, LONG_RANGE_DAYS, (r) => r && r.data)),
  sleep: () => memo(`sleep:${S.start}:${S.end}`, () => fetchChunked(
    (a, b) => `/sleep-service/sleep/dailySleepSummariesByDate?${qs(a, b)}`, S.start, S.end, SHORT_RANGE_DAYS)),
  hrv: () => memo(`hrv:${S.start}:${S.end}`, () => fetchChunked(
    (a, b) => `/hrv-service/hrv/daily/${a}/${b}`, S.start, S.end, LONG_RANGE_DAYS, (r) => r && r.hrvSummaries)),
  weight: () => memo(`weight:${S.start}:${S.end}`, () => fetchChunked(
    (a, b) => `/weight-service/weight/range/${a}/${b}?includeAll=true`, S.start, S.end, LONG_RANGE_DAYS, (r) => r && r.dailyWeightSummaries)),
  weightGoals: () => memo(`goals:${S.start}:${S.end}`, () => fetchChunked(
    (a, b) => `/goal-service/goal/user/effective/weightgoal/${a}/${b}`, S.start, S.end, LONG_RANGE_DAYS, (r) => r && r.userGoals)),
  wellnessActivities: () => memo(`wact:${S.start}:${S.end}`, () => fetchChunked(
    (a, b) => `/wellnessactivity-service/activity/summary/range/${a}/${b}`, S.start, S.end, LONG_RANGE_DAYS)),
  activities: () => memo(`act:${S.start}:${S.end}`, async () => {
    const all = [];
    for (let page = 0; page < ACTIVITY_MAX_PAGES; page += 1) {
      const rows = await api(`/activitylist-service/activities/search/activities?start=${page * ACTIVITY_PAGE}&limit=${ACTIVITY_PAGE}&${qs(S.start, S.end)}`);
      if (!Array.isArray(rows) || !rows.length) break;
      all.push(...rows);
      if (rows.length < ACTIVITY_PAGE) break;
    }
    return all;
  }),
  dayDaily: (day) => memo(`dd:${day}`, async () => {
    const r = await api(`/usersummary-service/v2/dailysummaries?${qs(day, day)}`);
    return (r && r.data && r.data[0]) || null;
  }),
  daySleep: (day) => memo(`ds:${day}`, () => api(`/sleep-service/sleep/dailySleep?date=${day}`)),
  dayHr: (day) => memo(`dh:${day}`, () => api(`/wellness-service/wellness/dailyHeartRate?date=${day}`)),
  dayHrv: (day) => memo(`dv:${day}`, () => api(`/hrv-service/hrv/${day}`)),
  dayBb: (day) => memo(`db:${day}`, () => api(`/wellness-service/wellness/bodyBattery/reports/daily?${qs(day, day)}`)),
  daySpo2: (day) => memo(`do:${day}`, () => api(`/wellness-service/wellness/daily/spo2acclimation/${day}`)),
  dayFood: (day) => memo(`df:${day}`, () => api(`/nutrition-service/food/logs/${day}`)),
  dayFit: (day) => memo(`dfa:${day}`, () => api(`/fitnessage-service/fitnessage/v2/${day}`)),
  zones: () => memo('zones', () => api('/biometric-service/heartRateZones/v2')),
  profile: () => memo('profile', () => api('/userprofile-service/userprofile/settings')),
  cycleSummary: (day) => memo(`cs:${day}`, () => api(`/periodichealth-service/menstrualcycle/summary/${day}`)),
  cycleDay: (day) => memo(`cd:${day}`, () => api(`/periodichealth-service/menstrualcycle/dayview/${day}?todayDate=${today()}`)),
  activity: (id) => memo(`a:${id}`, () => api(`/activity-service/activity/${id}`)),
  activityWorkouts: (id) => memo(`aw:${id}`, () => api(`/activity-service/activity/${id}/workouts`)),
};

/* Each loader settles to {ok, value} or {ok:false, error}, so one failed section can't blank a page. */
async function settle(promise) {
  try { return { ok: true, value: await promise }; } catch (error) { return { ok: false, error }; }
}

/* Align rows to the selected date range so every chart shares the same X positions. */
function aligned(rows, dateOf) {
  const byDate = new Map((rows || []).map((r) => [dateOf(r), r]));
  const dates = dateRange(S.start, S.end);
  return { dates, xs: dates.map(toUtc), rows: dates.map((d) => byDate.get(d) || null) };
}

function pickDay(ms) {
  S.day = fromUtc(ms);
  renderFilters();
  render();
}

/* ---------- tooltip ---------- */

const tip = () => document.getElementById('tip');
function hideTip() { tip().hidden = true; }
function showTip(title, rows, x, y) {
  const el = tip();
  el.replaceChildren(
    h('div', { class: 't-title', text: title }),
    ...rows.map((r) => h('div', { class: 't-row' },
      r.color ? h('span', { class: 'key-line', style: `background:${r.color}` }) : null,
      h('b', { text: r.value }),
      h('span', { class: 'name', text: r.name }))),
  );
  el.hidden = false;
  const box = el.getBoundingClientRect();
  el.style.left = `${clamp(x + 14, 8, window.innerWidth - box.width - 8)}px`;
  el.style.top = `${clamp(y - box.height - 10, 8, window.innerHeight - box.height - 8)}px`;
}

/* ---------- charts ---------- */

function niceTicks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

function barPath(x, y, w, height, radius) {
  const r = Math.min(radius, w / 2, height);
  return `M${x} ${y + height}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + height}Z`;
}

/*
 * One chart for lines and bars. All series share `xs`.
 * o: {type, xs, series:[{name,color,values,fmt}], stacked, yFmt, xFmt, xTick, time, yMin, yMax,
 *     height, area, markers, gapMs, endLabels, onPick, label}
 */
function chart(o) {
  const hidden = new Set();
  const plot = h('div', { class: `plot${o.onPick ? ' pick' : ''}`, tabindex: '0', role: 'img', 'aria-label': o.label || 'Chart. Use left and right arrow keys to read values.' });
  const root = h('div', { class: 'chart' });
  const isBar = o.type === 'bar';
  const yFmt = o.yFmt || fmtCompact;
  const xFmt = o.xFmt || fmtDayLong;
  const xTick = o.xTick || fmtDay;
  let current = -1;
  let geometry = null;

  if (o.series.length >= 2) {
    root.append(h('div', { class: 'legend' }, o.series.map((series) => {
      const button = h('button', {
        type: 'button',
        'aria-pressed': 'true',
        title: 'Show or hide this series',
        onclick: () => {
          if (hidden.has(series.name)) hidden.delete(series.name);
          else if (hidden.size < o.series.length - 1) hidden.add(series.name);
          button.setAttribute('aria-pressed', String(!hidden.has(series.name)));
          draw();
        },
      }, h('span', { class: isBar ? 'key-rect' : 'key-line', style: `background:${series.color}` }), series.name);
      return button;
    })));
  }
  root.append(plot);

  function draw() {
    const W = plot.clientWidth;
    if (!W) return;
    const H = o.height || 220;
    const visible = o.series.filter((series) => !hidden.has(series.name));
    const n = o.xs.length;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i += 1) {
      if (isBar && o.stacked) {
        const total = sum(visible.map((series) => series.values[i]));
        hi = Math.max(hi, total);
        lo = 0;
      } else {
        for (const series of visible) {
          const v = series.values[i];
          if (isNum(v)) { hi = Math.max(hi, v); lo = Math.min(lo, v); }
        }
      }
    }
    if (hi === -Infinity) { lo = 0; hi = 1; }
    if (isBar) lo = 0;
    if (o.yMin !== undefined) lo = o.yMin;
    if (o.yMax !== undefined) hi = Math.max(o.yMax, hi);
    if (hi <= lo) hi = lo + 1;
    const ticks = niceTicks(lo, hi);
    const y0 = ticks[0];
    const y1 = ticks[ticks.length - 1];
    const labelWidth = Math.max(...ticks.map((t) => yFmt(t).length)) * 7 + 12;
    const endTexts = o.endLabels && !isBar ? visible.map((series) => {
      let i = n - 1;
      while (i >= 0 && !isNum(series.values[i])) i -= 1;
      return i < 0 ? '' : (series.fmt || yFmt)(series.values[i]);
    }) : [];
    const endWidth = endTexts.length ? Math.max(...endTexts.map((t) => t.length)) * 7 + 12 : 14;
    const m = { t: 10, r: endWidth, b: 24, l: Math.max(26, labelWidth) };
    const innerW = Math.max(10, W - m.l - m.r);
    const innerH = H - m.t - m.b;
    const yScale = (v) => m.t + innerH - ((v - y0) / (y1 - y0)) * innerH;
    const slotW = innerW / Math.max(1, n);
    const xMin = o.xs[0];
    const xMax = o.xs[n - 1];
    const xScale = isBar
      ? (i) => m.l + slotW * (i + 0.5)
      : (i) => m.l + (xMax === xMin ? innerW / 2 : ((o.xs[i] - xMin) / (xMax - xMin)) * innerW);

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    for (const tick of ticks) {
      const y = yScale(tick);
      svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, stroke: tick === y0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }));
      const label = s('text', { x: m.l - 7, y: y + 4, 'text-anchor': 'end' });
      label.textContent = yFmt(tick);
      svg.append(label);
    }

    // X ticks: whole hours for intraday charts, evenly spaced otherwise.
    const maxTicks = Math.max(2, Math.floor(innerW / 76));
    const placeXTick = (x, text) => {
      const nearEdge = x + text.length * 3.5 > W;
      const label = s('text', { x: nearEdge ? W - 1 : x, y: H - 7, 'text-anchor': nearEdge ? 'end' : 'middle' });
      label.textContent = text;
      svg.append(label);
    };
    if (o.time && xMax > xMin) {
      const span = (xMax - xMin) / 3600000;
      const step = [1, 2, 3, 4, 6, 8, 12, 24].find((c) => span / c <= maxTicks) || 24;
      const stepMs = step * 3600000;
      for (let t = Math.ceil(xMin / stepMs) * stepMs; t <= xMax; t += stepMs) {
        placeXTick(m.l + ((t - xMin) / (xMax - xMin)) * innerW, fmtClock(t));
      }
    } else if (n) {
      const step = Math.max(1, Math.ceil(n / maxTicks));
      for (let i = (n - 1) % step; i < n; i += step) {
        placeXTick(xScale(i), xTick(o.xs[i], i));
      }
    }

    const groups = [];
    if (isBar) {
      const barW = clamp(slotW - 2, 1, 24);
      const gap = slotW >= 6 ? 2 : 0;
      for (let i = 0; i < n; i += 1) {
        const group = s('g', { class: 'bar' });
        groups.push(group);
        const present = visible.filter((series) => isNum(series.values[i]) && series.values[i] > 0);
        let base = yScale(y0);
        const stackList = o.stacked ? present : present.slice(0, 1);
        stackList.forEach((series, index) => {
          const top = yScale(y0 + (o.stacked
            ? stackList.slice(0, index + 1).reduce((t, x) => t + x.values[i], 0)
            : series.values[i]));
          const isTop = index === stackList.length - 1;
          const segment = Math.max(1, base - top - (isTop ? 0 : gap));
          const y = base - segment;
          svg.append(group);
          group.append(s('path', {
            d: isTop ? barPath(xScale(i) - barW / 2, y, barW, segment, 4) : `M${xScale(i) - barW / 2} ${y}h${barW}v${segment}h${-barW}Z`,
            style: `fill:${series.color}`,
          }));
          base = top;
        });
      }
    } else {
      for (const series of visible) {
        let pathData = '';
        let segmentStart = -1;
        let prev = -1;
        const isolated = [];
        let last = -1;
        for (let i = 0; i < n; i += 1) {
          const v = series.values[i];
          if (!isNum(v)) continue;
          const gapped = prev >= 0 && o.gapMs && o.xs[i] - o.xs[prev] > o.gapMs;
          const breaks = prev < 0 || gapped || (!o.gapMs && i - prev > 1 && !o.connect);
          if (breaks) {
            if (segmentStart >= 0 && segmentStart === prev) isolated.push(prev);
            pathData += `M${xScale(i)} ${yScale(v)}`;
            segmentStart = i;
          } else {
            pathData += `L${xScale(i)} ${yScale(v)}`;
          }
          prev = i;
          last = i;
        }
        if (segmentStart >= 0 && segmentStart === prev) isolated.push(prev);
        if (o.area && visible.length === 1 && pathData) {
          const floor = yScale(y0);
          const areaPath = pathData.replace(/M([\d.]+) ([\d.]+)((?:L[\d.]+ [\d.]+)*)/g, (full, x, y, rest) => {
            const points = rest.match(/L[\d.]+/g);
            const lastX = points ? points[points.length - 1].slice(1) : x;
            return `M${x} ${floor}L${x} ${y}${rest}L${lastX} ${floor}Z`;
          });
          svg.append(s('path', { d: areaPath, style: `fill:${series.color};opacity:.1` }));
        }
        svg.append(s('path', { d: pathData, fill: 'none', style: `stroke:${series.color}`, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
        const dots = new Set(isolated);
        if (o.markers) series.values.forEach((v, i) => { if (isNum(v)) dots.add(i); });
        if (last >= 0) dots.add(last);
        for (const i of dots) {
          svg.append(s('circle', { cx: xScale(i), cy: yScale(series.values[i]), r: 4, style: `fill:${series.color};stroke:var(--surface-1)`, 'stroke-width': 2 }));
        }
      }
      if (o.endLabels) {
        const ends = visible.map((series) => {
          let i = n - 1;
          while (i >= 0 && !isNum(series.values[i])) i -= 1;
          return i < 0 ? null : { series, i, y: yScale(series.values[i]) };
        }).filter(Boolean).sort((a, b) => a.y - b.y);
        let lastY = -Infinity;
        for (const end of ends) {
          if (end.y - lastY < 14) continue;
          const label = s('text', { class: 'end', x: W - m.r + 8, y: end.y + 4 });
          label.textContent = (end.series.fmt || yFmt)(end.series.values[end.i]);
          svg.append(label);
          lastY = end.y;
        }
      }
    }

    const crosshair = s('line', { y1: m.t, y2: m.t + innerH, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' });
    const hoverDots = s('g');
    svg.append(crosshair, hoverDots);
    plot.replaceChildren(svg);
    geometry = { svg, m, innerW, slotW, xScale, yScale, groups, crosshair, hoverDots, visible, n, H };
  }

  function nearestIndex(px) {
    const { m, slotW, xScale, n } = geometry;
    if (isBar) return clamp(Math.floor((px - m.l) / slotW), 0, n - 1);
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < n; i += 1) {
      if (!geometry.visible.some((series) => isNum(series.values[i]))) continue;
      const distance = Math.abs(xScale(i) - px);
      if (distance < bestDistance) { best = i; bestDistance = distance; }
    }
    return best;
  }

  function reveal(i, clientX, clientY) {
    if (!geometry || !geometry.n) return;
    current = i;
    const { svg, xScale, yScale, groups, crosshair, hoverDots, visible } = geometry;
    const rect = svg.getBoundingClientRect();
    const x = xScale(i);
    if (isBar) {
      svg.classList.add('hovering');
      groups.forEach((group, index) => group.classList.toggle('active', index === i));
    } else {
      crosshair.setAttribute('x1', x);
      crosshair.setAttribute('x2', x);
      crosshair.setAttribute('visibility', 'visible');
      hoverDots.replaceChildren(...visible.filter((series) => isNum(series.values[i])).map((series) => s('circle', {
        cx: x, cy: yScale(series.values[i]), r: 4, style: `fill:${series.color};stroke:var(--surface-1)`, 'stroke-width': 2,
      })));
    }
    const rows = visible.map((series) => ({
      color: series.color,
      name: series.name,
      value: isNum(series.values[i]) ? (series.fmt || yFmt)(series.values[i]) : 'No data',
    }));
    showTip(xFmt(o.xs[i], i), rows, clientX === undefined ? rect.left + x : clientX, clientY === undefined ? rect.top + 30 : clientY);
  }

  function conceal() {
    current = -1;
    hideTip();
    if (!geometry) return;
    geometry.svg.classList.remove('hovering');
    geometry.groups.forEach((group) => group.classList.remove('active'));
    geometry.crosshair.setAttribute('visibility', 'hidden');
    geometry.hoverDots.replaceChildren();
  }

  plot.addEventListener('pointermove', (event) => {
    if (!geometry) return;
    const rect = plot.getBoundingClientRect();
    reveal(nearestIndex(event.clientX - rect.left), event.clientX, event.clientY);
  });
  plot.addEventListener('pointerleave', conceal);
  plot.addEventListener('blur', conceal);
  if (o.onPick) {
    plot.addEventListener('click', (event) => {
      const rect = plot.getBoundingClientRect();
      o.onPick(o.xs[nearestIndex(event.clientX - rect.left)]);
    });
  }
  plot.addEventListener('keydown', (event) => {
    if (!geometry || !geometry.n) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const dir = event.key === 'ArrowLeft' ? -1 : 1;
      reveal(current < 0 ? geometry.n - 1 : clamp(current + dir, 0, geometry.n - 1));
    } else if (event.key === 'Enter' && o.onPick && current >= 0) {
      o.onPick(o.xs[current]);
    } else if (event.key === 'Escape') {
      conceal();
    }
  });

  let width = 0;
  new ResizeObserver(() => {
    const next = plot.clientWidth;
    if (next && next !== width) { width = next; draw(); }
  }).observe(plot);
  return root;
}

function sparkline(values, currentIndex) {
  const W = 160;
  const H = 28;
  const points = values.map((v, i) => (isNum(v) ? [i, v] : null)).filter(Boolean);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' });
  if (points.length < 2) return svg;
  const lo = Math.min(...points.map((p) => p[1]));
  const hi = Math.max(...points.map((p) => p[1]));
  const x = (i) => 3 + (i / Math.max(1, values.length - 1)) * (W - 6);
  const y = (v) => (hi === lo ? H / 2 : H - 4 - ((v - lo) / (hi - lo)) * (H - 8));
  svg.append(s('path', {
    d: points.map((p, index) => `${index ? 'L' : 'M'}${x(p[0])} ${y(p[1])}`).join(''),
    fill: 'none', style: 'stroke:var(--axis)', 'stroke-width': 1.5, 'stroke-linejoin': 'round',
  }));
  if (currentIndex >= 0 && isNum(values[currentIndex])) {
    svg.append(s('circle', { cx: x(currentIndex), cy: y(values[currentIndex]), r: 3, style: 'fill:var(--series-1)' }));
  }
  return svg;
}

/* ---------- page pieces ---------- */

function dataTable(columns, rows, opts = {}) {
  let sortIndex = -1;
  let ascending = true;
  const body = h('tbody');
  const paint = () => {
    const ordered = [...rows];
    if (sortIndex >= 0) {
      const get = columns[sortIndex].get;
      ordered.sort((a, b) => {
        const x = get(a);
        const y = get(b);
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return (x > y ? 1 : -1) * (ascending ? 1 : -1);
      });
    }
    body.replaceChildren(...ordered.map((row) => h('tr', { class: opts.selected && opts.selected(row) ? 'selected' : null },
      columns.map((col) => {
        const shown = col.cell ? col.cell(row) : (col.fmt ? col.fmt(col.get(row)) : col.get(row));
        return h('td', { class: col.num ? 'num' : null }, shown === null || shown === undefined ? '–' : shown);
      }))));
  };
  const head = h('thead', {}, h('tr', {}, columns.map((col, index) => h('th', { class: col.num ? 'num' : null, scope: 'col' },
    h('button', {
      type: 'button',
      text: col.label,
      onclick: () => {
        if (sortIndex === index) ascending = !ascending;
        else { sortIndex = index; ascending = !col.num; }
        paint();
      },
    })))));
  paint();
  return h('div', { class: 'table-wrap' }, h('table', {}, head, body));
}

function chartTable(o) {
  const xFmt = o.xFmt || fmtDayLong;
  const rows = o.xs.map((x, i) => ({ x, i })).reverse();
  const columns = [
    { label: 'Time', get: (r) => r.x, fmt: (v) => null, cell: (r) => xFmt(r.x, r.i) },
    ...o.series.map((series) => ({
      label: series.name,
      num: true,
      get: (r) => series.values[r.i],
      fmt: (v) => (isNum(v) ? (series.fmt || o.yFmt || fmtCompact)(v) : '–'),
    })),
  ];
  return dataTable(columns, rows);
}

function card(title, subtitle, body, opts = {}) {
  const content = h('div', {}, body);
  const actions = h('div', { class: 'card-actions' }, opts.actions || []);
  if (opts.table) {
    let table = null;
    const toggle = h('button', {
      type: 'button',
      text: 'Table',
      'aria-pressed': 'false',
      onclick: () => {
        const showing = toggle.getAttribute('aria-pressed') === 'true';
        toggle.setAttribute('aria-pressed', String(!showing));
        table = table || opts.table();
        content.replaceChildren(showing ? body : table);
      },
    });
    actions.append(toggle);
  }
  return h('section', { class: `card${opts.wide ? ' wide' : ''}`, id: opts.id },
    h('div', { class: 'card-head' },
      h('div', {}, h('h3', { text: title }), subtitle ? h('p', { text: subtitle }) : null),
      actions),
    content);
}

function chartCard(title, subtitle, o, opts = {}) {
  return card(title, subtitle, chart(o), { ...opts, table: () => chartTable(o) });
}

function empty(text) { return h('div', { class: 'empty', text }); }
function errorBlock(error) { return h('div', { class: 'error', text: (error && error.message) || 'Something went wrong.' }); }
function failedCard(title, error, opts) { return card(title, null, errorBlock(error), opts); }

function tile(label, value, opts = {}) {
  const isText = typeof value === 'string' && value.length > 9;
  return h('div', { class: 'tile' },
    h('div', { class: 't-label', text: label }),
    h('div', { class: `t-value${isText ? ' small' : ''}` }, value === null || value === undefined ? '–' : String(value),
      opts.unit ? h('span', { class: 't-unit', text: opts.unit }) : null),
    h('div', { class: 't-delta', text: opts.delta || '' }),
    opts.spark ? sparkline(opts.spark, opts.sparkIndex === undefined ? opts.spark.length - 1 : opts.sparkIndex) : null);
}

function deltaVs(value, reference, fmt = (v) => fmtNum(v)) {
  if (!isNum(value) || !isNum(reference)) return '';
  const diff = value - reference;
  return `${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff))} vs range avg`;
}

function hbars(items) {
  const max = Math.max(1, ...items.map((i) => (isNum(i.value) ? i.value : 0)));
  return h('div', { class: 'hbars' }, items.flatMap((item) => [
    h('div', { class: 'h-label', text: item.label }),
    h('div', { class: 'h-track' },
      h('div', { class: 'h-bar', style: `width:calc(${((isNum(item.value) ? item.value : 0) / max) * 100}% - 70px * ${(isNum(item.value) ? item.value : 0) / max})` }),
      h('div', { class: 'h-val', text: item.text })),
  ]));
}

function kvList(pairs, columns) {
  return h('dl', { class: `kv${columns ? ' cols' : ''}` }, pairs.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v === null || v === undefined || v === '' ? '–' : String(v) })]));
}

function flatPairs(obj) {
  return Object.entries(obj || {})
    .filter(([, v]) => v !== null && typeof v !== 'object')
    .map(([k, v]) => [humanize(k), typeof v === 'number' && !/(id|pk|timestamp)$/i.test(k) ? fmtNum(v, 2) : String(v)]);
}

function jsonTree(value, name, open = true) {
  const preview = (v) => (Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).length}}`);
  const build = (v, key, startOpen) => {
    if (v === null || typeof v !== 'object') {
      return h('div', { class: 'leaf' }, key !== undefined ? h('span', { class: 'k', text: `${key}: ` }) : null,
        JSON.stringify(v));
    }
    const details = h('details', { open: startOpen },
      h('summary', {}, key !== undefined ? `${key} ` : '', h('span', { class: 'hint', text: preview(v) })));
    let filled = false;
    const fill = () => {
      if (filled) return;
      filled = true;
      const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
      details.append(...entries.map(([k, x]) => build(x, k, false)));
    };
    details.addEventListener('toggle', fill);
    if (startOpen) fill();
    return details;
  };
  return h('div', { class: 'tree' }, build(value, name, open));
}

function grid(...items) { return h('div', { class: 'grid' }, items.filter(Boolean)); }
function kpis(...items) { return h('div', { class: 'kpis' }, items.filter(Boolean)); }

const rangeText = () => `${fmtIsoDay(S.start)} – ${fmtIsoDay(S.end)}`;
const dayText = () => fmtIsoDay(S.day);

/* ---------- field getters ---------- */

const G = {
  steps: (d) => (d && d.movement && d.movement.steps ? d.movement.steps.value : null),
  stepGoal: (d) => (d && d.movement && d.movement.steps ? d.movement.steps.goal : null),
  distance: (d) => (d && d.movement && d.movement.steps ? d.movement.steps.distanceInMeters : null),
  floorsUp: (d) => (d && d.movement && d.movement.floorsAscended ? d.movement.floorsAscended.value : null),
  floorsDown: (d) => (d && d.movement && d.movement.floorsDescended ? d.movement.floorsDescended.value : null),
  active: (d) => (d && d.calories ? d.calories.burnedActive : null),
  resting: (d) => (d && d.calories ? d.calories.burnedResting : null),
  total: (d) => (d && d.calories ? d.calories.burnedTotal : null),
  moderate: (d) => (d && d.intensityMinutes ? d.intensityMinutes.moderate : null),
  vigorous: (d) => (d && d.intensityMinutes ? d.intensityMinutes.vigorous : null),
  rhr: (d) => (d && d.heartRate ? d.heartRate.restingValue : null),
  hrMin: (d) => (d && d.heartRate ? d.heartRate.minValue : null),
  hrMax: (d) => (d && d.heartRate ? d.heartRate.maxValue : null),
  stress: (d) => nonNegative(d && d.stress ? d.stress.avgLevel : null),
  stressMax: (d) => nonNegative(d && d.stress ? d.stress.maxLevel : null),
  stressPart: (d, key) => (d && d.stress && isNum(d.stress[key]) ? d.stress[key] / 3600000 : null),
  bbMax: (d) => (d && d.bodyBattery ? d.bodyBattery.maxValue : null),
  bbMin: (d) => (d && d.bodyBattery ? d.bodyBattery.minValue : null),
  bbLatest: (d) => (d && d.bodyBattery ? d.bodyBattery.latestValue : null),
  charged: (d) => (d && d.bodyBattery ? d.bodyBattery.chargedValue : null),
  drained: (d) => (d && d.bodyBattery ? d.bodyBattery.drainedValue : null),
  hydration: (d) => (d && d.hydration ? d.hydration.consumedInMl : null),
  hydrationGoal: (d) => (d && d.hydration ? d.hydration.goalInMl : null),
  respAvg: (d) => (d && d.respiration ? nonNegative(d.respiration.avgValue) : null),
  respMin: (d) => (d && d.respiration ? nonNegative(d.respiration.minValue) : null),
  respMax: (d) => (d && d.respiration ? nonNegative(d.respiration.maxValue) : null),
  sleepScore: (r) => (r && r.sleepScores && r.sleepScores.overall ? r.sleepScores.overall.value : null),
  stage: (r, key) => (r && isNum(r[key]) ? r[key] / 3600 : null),
};
const hoursFmt = (v) => fmtDuration(v * 3600);

/* ---------- tabs ---------- */

async function renderOverview() {
  const [daily, sleep, hrv, activities, dayDaily, daySleep, dayHrv] = await Promise.all([
    settle(data.daily()), settle(data.sleep()), settle(data.hrv()), settle(data.activities()),
    settle(data.dayDaily(S.day)), settle(data.daySleep(S.day)), settle(data.dayHrv(S.day)),
  ]);
  const a = aligned(daily.ok ? daily.value : [], (r) => r.calendarDate);
  const sl = aligned(sleep.ok ? sleep.value : [], (r) => r.calendarDate);
  const hv = aligned(hrv.ok ? hrv.value : [], (r) => r.calendarDate);
  const index = a.dates.indexOf(S.day);
  const d = dayDaily.ok ? dayDaily.value : null;
  const series = (fn, set) => set.rows.map(fn);
  const stepsAll = series(G.steps, a);
  const rhrAll = series(G.rhr, a);
  const stressAll = series(G.stress, a);
  const bbAll = series(G.bbLatest, a);
  const scoreAll = series(G.sleepScore, sl);
  const hrvAll = hv.rows.map((r) => (r ? r.lastNightAvg : null));
  const dayScore = G.sleepScore(daySleep.ok ? daySleep.value : null);
  const dayHrvValue = dayHrv.ok && dayHrv.value && dayHrv.value.hrvSummary ? dayHrv.value.hrvSummary.lastNightAvg : null;

  const tiles = kpis(
    tile('Steps', fmtNum(G.steps(d)), { delta: deltaVs(G.steps(d), avg(stepsAll)), spark: stepsAll, sparkIndex: index }),
    tile('Sleep score', dayScore === null ? null : fmtNum(dayScore), { delta: deltaVs(dayScore, avg(scoreAll)), spark: scoreAll, sparkIndex: index }),
    tile('Resting heart rate', G.rhr(d) === null ? null : fmtNum(G.rhr(d)), { unit: 'bpm', delta: deltaVs(G.rhr(d), avg(rhrAll)), spark: rhrAll, sparkIndex: index }),
    tile('Overnight HRV', dayHrvValue === null ? null : fmtNum(dayHrvValue), { unit: 'ms', delta: deltaVs(dayHrvValue, avg(hrvAll)), spark: hrvAll, sparkIndex: index }),
    tile('Avg stress', G.stress(d) === null ? null : fmtNum(G.stress(d)), { delta: deltaVs(G.stress(d), avg(stressAll)), spark: stressAll, sparkIndex: index }),
    tile('Body Battery', G.bbLatest(d) === null ? null : fmtNum(G.bbLatest(d)), { delta: deltaVs(G.bbLatest(d), avg(bbAll)), spark: bbAll, sparkIndex: index }),
  );

  const goal = [...a.rows].reverse().map(G.stepGoal).find(isNum);
  const charts = grid(
    daily.ok ? chartCard('Steps', goal ? `Latest daily goal: ${fmtNum(goal)}` : null, {
      type: 'bar', xs: a.xs, onPick: pickDay, yFmt: fmtCompact,
      series: [{ name: 'Steps', color: 'var(--series-1)', values: stepsAll, fmt: (v) => fmtNum(v) }],
    }) : failedCard('Steps', daily.error),
    sleep.ok ? chartCard('Sleep score', 'Out of 100', {
      type: 'line', xs: sl.xs, onPick: pickDay, endLabels: true, area: true, yMax: 100,
      series: [{ name: 'Score', color: 'var(--series-1)', values: scoreAll, fmt: (v) => fmtNum(v) }],
    }) : failedCard('Sleep score', sleep.error),
    daily.ok ? chartCard('Resting heart rate', 'Beats per minute', {
      type: 'line', xs: a.xs, onPick: pickDay, endLabels: true,
      series: [{ name: 'Resting HR', color: 'var(--series-1)', values: rhrAll, fmt: (v) => `${fmtNum(v)} bpm` }],
    }) : failedCard('Resting heart rate', daily.error),
    activities.ok ? workoutsMiniCard(activities.value) : failedCard('Recent workouts', activities.error),
  );
  return [h('div', { class: 'section-title', text: dayText() }), tiles, charts];
}

function workoutsMiniCard(rows) {
  const latest = [...rows].sort((a, b) => (a.startTimeLocal < b.startTimeLocal ? 1 : -1)).slice(0, 6);
  const body = latest.length ? dataTable([
    { label: 'Date', get: (r) => r.startTimeLocal, cell: (r) => r.startTimeLocal.slice(0, 16).replace('T', ' ') },
    { label: 'Workout', get: (r) => r.activityName, cell: (r) => h('button', { class: 'link', type: 'button', text: r.activityName || 'Workout', onclick: () => { S.workoutId = r.activityId; setTab('workouts'); } }) },
    { label: 'Distance', num: true, get: (r) => r.distance, fmt: fmtDist },
    { label: 'Time', num: true, get: (r) => r.duration, fmt: fmtDuration },
  ], latest) : empty('No workouts in this date range.');
  return card('Recent workouts', `${rows.length} in this date range`, body, { wide: true });
}

async function renderActivity() {
  const [daily, wellness] = await Promise.all([settle(data.daily()), settle(data.wellnessActivities())]);
  if (!daily.ok) return [grid(failedCard('Daily activity', daily.error, { wide: true }))];
  const a = aligned(daily.value, (r) => r.calendarDate);
  const steps = a.rows.map(G.steps);
  const distance = a.rows.map((r) => distValue(G.distance(r)));
  const up = a.rows.map(G.floorsUp);
  const down = a.rows.map(G.floorsDown);
  const active = a.rows.map(G.active);
  const resting = a.rows.map(G.resting);
  const moderate = a.rows.map(G.moderate);
  const vigorous = a.rows.map(G.vigorous);
  const goalDays = a.rows.filter((r) => isNum(G.steps(r)) && isNum(G.stepGoal(r)) && G.steps(r) >= G.stepGoal(r)).length;
  const measured = steps.filter(isNum).length;
  return [
    kpis(
      tile('Total steps', fmtCompact(sum(steps))),
      tile('Daily average', fmtNum(avg(steps)), { unit: 'steps' }),
      tile('Step goal met', `${goalDays} of ${measured}`, { unit: 'days' }),
      tile('Distance', fmtNum(sum(distance), 1), { unit: distUnit() }),
      tile('Active calories', fmtCompact(sum(active)), { unit: 'kcal' }),
      tile('Intensity minutes', fmtCompact(sum(moderate) + sum(vigorous)), { unit: 'min' }),
    ),
    grid(
      chartCard('Steps', 'Click a day to inspect it', {
        type: 'bar', xs: a.xs, onPick: pickDay,
        series: [{ name: 'Steps', color: 'var(--series-1)', values: steps, fmt: (v) => fmtNum(v) }],
      }),
      chartCard('Distance', `From steps, in ${distUnit()}`, {
        type: 'bar', xs: a.xs, onPick: pickDay,
        series: [{ name: 'Distance', color: 'var(--series-1)', values: distance, fmt: (v) => `${fmtNum(v, 2)} ${distUnit()}` }],
      }),
      chartCard('Calories burned', 'Resting plus active', {
        type: 'bar', stacked: true, xs: a.xs, onPick: pickDay,
        series: [
          { name: 'Resting', color: 'var(--series-1)', values: resting, fmt: (v) => `${fmtNum(v)} kcal` },
          { name: 'Active', color: 'var(--series-2)', values: active, fmt: (v) => `${fmtNum(v)} kcal` },
        ],
      }),
      chartCard('Intensity minutes', 'Raw minutes, without Garmin’s doubling of vigorous time', {
        type: 'bar', stacked: true, xs: a.xs, onPick: pickDay,
        series: [
          { name: 'Moderate', color: 'var(--series-1)', values: moderate, fmt: (v) => `${fmtNum(v)} min` },
          { name: 'Vigorous', color: 'var(--series-2)', values: vigorous, fmt: (v) => `${fmtNum(v)} min` },
        ],
      }),
      chartCard('Floors', 'Up and down', {
        type: 'line', xs: a.xs, onPick: pickDay, endLabels: true, yMin: 0,
        series: [
          { name: 'Up', color: 'var(--series-1)', values: up, fmt: (v) => fmtNum(v) },
          { name: 'Down', color: 'var(--series-2)', values: down, fmt: (v) => fmtNum(v) },
        ],
      }),
      wellness.ok
        ? card('Wellness activities', 'Activities Garmin detected automatically', wellness.value.length ? jsonTree(wellness.value, 'activities') : empty('None recorded in this date range.'))
        : failedCard('Wellness activities', wellness.error),
    ),
  ];
}

function hrZoneItems(a) {
  return [1, 2, 3, 4, 5].map((z) => ({ label: `Zone ${z}`, value: a[`hrTimeInZone_${z}`], text: fmtDuration(a[`hrTimeInZone_${z}`]) }));
}

async function workoutDetail(row) {
  const [detail, workouts] = await Promise.all([settle(data.activity(row.activityId)), settle(data.activityWorkouts(row.activityId))]);
  const summary = detail.ok && detail.value ? detail.value.summaryDTO || {} : {};
  const powerSpans = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600].filter((t) => isNum(row[`maxAvgPower_${t}`]));
  const spanText = (t) => (t < 60 ? `${t}s` : t < 3600 ? `${t / 60} min` : `${t / 3600} h`);
  const powerZones = [1, 2, 3, 4, 5, 6, 7].filter((z) => isNum(row[`powerTimeInZone_${z}`]));
  const hasHrZones = hrZoneItems(row).some((i) => i.value > 0);
  const load = row.activityTrainingLoad;
  const download = h('a', { class: 'button', href: `/api/garmin/download-service/files/activity/${row.activityId}`, text: 'Download original file' });
  return [
    h('div', { class: 'section-title', text: `${row.activityName || 'Workout'} · ${row.startTimeLocal.slice(0, 16).replace('T', ' ')}`, id: 'workout-detail' }),
    kpis(
      tile('Distance', fmtDist(row.distance)),
      tile('Time', fmtDuration(row.duration)),
      tile('Avg speed', fmtSpeed(row.averageSpeed)),
      tile('Avg heart rate', isNum(row.averageHR) ? fmtNum(row.averageHR) : null, { unit: 'bpm', delta: isNum(row.maxHR) ? `Max ${fmtNum(row.maxHR)}` : '' }),
      isNum(row.avgPower) ? tile('Avg power', fmtNum(row.avgPower), { unit: 'W', delta: isNum(row.normPower) ? `Normalized ${fmtNum(row.normPower)} W` : '' }) : null,
      tile('Calories', fmtNum(row.calories), { unit: 'kcal' }),
      isNum(row.aerobicTrainingEffect) ? tile('Training effect', fmtNum(row.aerobicTrainingEffect, 1), { delta: `Anaerobic ${fmtNum(row.anaerobicTrainingEffect, 1)}` }) : null,
      isNum(load) ? tile('Training load', fmtNum(load)) : null,
    ),
    grid(
      hasHrZones ? card('Time in heart rate zones', null, hbars(hrZoneItems(row))) : null,
      powerZones.length ? card('Time in power zones', null, hbars(powerZones.map((z) => ({ label: `Zone ${z}`, value: row[`powerTimeInZone_${z}`], text: fmtDuration(row[`powerTimeInZone_${z}`]) })))) : null,
      powerSpans.length ? chartCard('Power curve', 'Best average power for each duration', {
        type: 'line', xs: powerSpans.map((_, i) => i), markers: true, yMin: 0,
        xFmt: (x) => `Best ${spanText(powerSpans[x])}`, xTick: (x) => spanText(powerSpans[x]),
        series: [{ name: 'Power', color: 'var(--series-1)', values: powerSpans.map((t) => row[`maxAvgPower_${t}`]), fmt: (v) => `${fmtNum(v)} W` }],
      }) : null,
      card('All recorded fields', 'Raw values in Garmin’s units: meters, seconds and m/s', kvList([
        ...new Map([
          ...flatPairs(row).filter(([k]) => !/^(Owner|Max avg power|Hr time in zone|Power time in zone)/.test(k)),
          ...flatPairs(summary),
        ]),
      ], true), { actions: [download], wide: true }),
      card('Full workout data', 'Every field Garmin returned', detail.ok ? jsonTree(detail.value, 'activity') : errorBlock(detail.error), { wide: true }),
      card('Linked training plans', null, workouts.ok
        ? (workouts.value && workouts.value.length ? jsonTree(workouts.value, 'workouts') : empty('No planned workout is linked to this activity.'))
        : errorBlock(workouts.error), { wide: true }),
    ),
  ];
}

async function renderWorkouts() {
  const activities = await settle(data.activities());
  if (!activities.ok) return [grid(failedCard('Workouts', activities.error, { wide: true }))];
  const all = [...activities.value].sort((a, b) => (a.startTimeLocal < b.startTimeLocal ? 1 : -1));
  const typeOf = (r) => (r.activityType ? r.activityType.typeKey : 'other');
  const types = [...new Set(all.map(typeOf))].sort();
  if (S.workoutType && !types.includes(S.workoutType)) S.workoutType = '';
  if (S.workoutId && !all.some((r) => r.activityId === S.workoutId)) S.workoutId = null;

  const summaryArea = h('div', { class: 'stack' });
  const listArea = h('div', { class: 'stack' });
  const detailArea = h('div', { class: 'stack' });

  const matches = () => all.filter((r) => (!S.workoutType || typeOf(r) === S.workoutType)
    && (!S.workoutQuery || (r.activityName || '').toLowerCase().includes(S.workoutQuery.toLowerCase())));

  const paintDetail = async (scroll) => {
    const row = all.find((r) => r.activityId === S.workoutId);
    if (!row) { detailArea.replaceChildren(); return; }
    detailArea.style.opacity = '0.5';
    const nodes = await workoutDetail(row);
    if (S.workoutId !== row.activityId) return;
    detailArea.replaceChildren(...nodes);
    detailArea.style.opacity = '';
    if (scroll) detailArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const paint = () => {
    const rows = matches();
    const dates = aligned([], () => null);
    const minutes = new Map();
    for (const r of rows) {
      const day = r.startTimeLocal.slice(0, 10);
      minutes.set(day, (minutes.get(day) || 0) + (r.duration || 0) / 60);
    }
    const chartConfig = {
      type: 'bar', xs: dates.xs, onPick: pickDay,
      series: [{ name: 'Training time', color: 'var(--series-1)', values: dates.dates.map((d) => minutes.get(d) || null), fmt: (v) => fmtDuration(v * 60) }],
      yFmt: (v) => `${fmtNum(v)}m`,
    };
    summaryArea.replaceChildren(
      kpis(
        tile('Workouts', fmtNum(rows.length)),
        tile('Total time', fmtDuration(sum(rows.map((r) => r.duration)))),
        tile('Total distance', fmtNum(distValue(sum(rows.map((r) => r.distance))), 1), { unit: distUnit() }),
        tile('Calories', fmtCompact(sum(rows.map((r) => r.calories))), { unit: 'kcal' }),
        tile('Training load', fmtCompact(sum(rows.map((r) => r.activityTrainingLoad)))),
      ),
      grid(chartCard('Training time per day', 'Minutes, summed across workouts', chartConfig, { wide: true })),
    );
    listArea.replaceChildren(grid(card('Workouts', 'Sort by any column. Select a name to see its details.', rows.length ? dataTable([
      { label: 'Date', get: (r) => r.startTimeLocal, cell: (r) => r.startTimeLocal.slice(0, 16).replace('T', ' ') },
      {
        label: 'Name',
        get: (r) => r.activityName,
        cell: (r) => h('button', {
          class: 'link', type: 'button', text: r.activityName || 'Workout',
          onclick: () => { S.workoutId = r.activityId; paint(); paintDetail(true); },
        }),
      },
      { label: 'Type', get: typeOf, fmt: humanize },
      { label: 'Distance', num: true, get: (r) => r.distance, fmt: fmtDist },
      { label: 'Time', num: true, get: (r) => r.duration, fmt: fmtDuration },
      { label: 'Avg HR', num: true, get: (r) => r.averageHR, fmt: (v) => fmtNum(v) },
      { label: 'Avg power', num: true, get: (r) => r.avgPower, fmt: (v) => fmtNum(v) },
      { label: 'Calories', num: true, get: (r) => r.calories, fmt: (v) => fmtNum(v) },
      { label: 'Training effect', num: true, get: (r) => r.aerobicTrainingEffect, fmt: (v) => fmtNum(v, 1) },
      { label: 'Stress score', num: true, get: (r) => r.trainingStressScore, fmt: (v) => fmtNum(v) },
    ], rows, { selected: (r) => r.activityId === S.workoutId }) : empty('No workouts match.'), { wide: true })));
  };

  const toolbar = h('div', { class: 'toolbar' },
    h('select', {
      'aria-label': 'Workout type',
      onchange: (e) => { S.workoutType = e.target.value; paint(); },
    }, h('option', { value: '', text: 'All types' }), types.map((t) => {
      const option = h('option', { value: t, text: humanize(t) });
      option.selected = t === S.workoutType;
      return option;
    })),
    h('input', {
      type: 'search', placeholder: 'Search by name', 'aria-label': 'Search workouts by name', value: S.workoutQuery,
      oninput: (e) => { S.workoutQuery = e.target.value; paint(); },
    }),
  );

  paint();
  paintDetail(Boolean(S.workoutId));
  return [toolbar, h('div', { class: 'stack' }, summaryArea, listArea, detailArea)];
}

async function renderSleep() {
  const [sleep, night] = await Promise.all([settle(data.sleep()), settle(data.daySleep(S.day))]);
  const out = [];
  const n = night.ok ? night.value : null;
  if (night.ok && n && isNum(n.sleepTimeSeconds)) {
    const scores = n.sleepScores || {};
    out.push(
      h('div', { class: 'section-title', text: `Night ending ${dayText()}` }),
      kpis(
        tile('Sleep score', G.sleepScore(n) === null ? null : fmtNum(G.sleepScore(n)), { delta: scores.overall ? humanize(scores.overall.qualifierKey) : '' }),
        tile('Time asleep', fmtDuration(n.sleepTimeSeconds), { delta: n.napTimeSeconds ? `Nap ${fmtDuration(n.napTimeSeconds)}` : '' }),
        tile('Bedtime', isNum(n.sleepStartTimestampLocal) ? fmtClock(n.sleepStartTimestampLocal) : null, { delta: isNum(n.sleepEndTimestampLocal) ? `Woke ${fmtClock(n.sleepEndTimestampLocal)}` : '' }),
        tile('Awake', fmtDuration(n.awakeSleepSeconds), { delta: isNum(n.awakeCount) ? `${n.awakeCount} times` : '' }),
        tile('Respiration', fmtNum(n.averageRespirationValue, 1), { unit: 'brpm', delta: isNum(n.lowestRespirationValue) ? `${fmtNum(n.lowestRespirationValue)}–${fmtNum(n.highestRespirationValue)}` : '' }),
        tile('Sleep stress', fmtNum(n.avgSleepStress, 1)),
      ),
    );
  } else if (!night.ok) {
    out.push(grid(failedCard('Selected night', night.error, { wide: true })));
  } else {
    out.push(grid(card(`Night ending ${dayText()}`, null, empty('No sleep recorded for this night.'), { wide: true })));
  }
  if (!sleep.ok) return [...out, grid(failedCard('Sleep trends', sleep.error, { wide: true }))];
  const a = aligned(sleep.value, (r) => r.calendarDate);
  const stageSeries = [
    { name: 'Deep', key: 'deepSleepSeconds', color: 'var(--series-1)' },
    { name: 'REM', key: 'remSleepSeconds', color: 'var(--series-2)' },
    { name: 'Light', key: 'lightSleepSeconds', color: 'var(--series-3)' },
    { name: 'Awake', key: 'awakeSleepSeconds', color: 'var(--series-4)' },
  ].map((stage) => ({ ...stage, values: a.rows.map((r) => G.stage(r, stage.key)), fmt: hoursFmt }));

  const legendText = stageSeries.map((stage) => `${stage.name} ${hoursFmt(avg(stage.values) || 0)}`).join(' · ');
  const nightsWithData = a.rows.filter(Boolean);
  out.push(grid(
    chartCard('Sleep stages', `Nightly averages: ${legendText}`, {
      type: 'bar', stacked: true, xs: a.xs, onPick: pickDay, series: stageSeries,
      yFmt: (v) => `${fmtNum(v, 1)}h`,
    }, { wide: true }),
    chartCard('Sleep score', 'Out of 100', {
      type: 'line', xs: a.xs, onPick: pickDay, endLabels: true, area: true, yMax: 100,
      series: [{ name: 'Score', color: 'var(--series-1)', values: a.rows.map(G.sleepScore), fmt: (v) => fmtNum(v) }],
    }),
    chartCard('Respiration during sleep', 'Breaths per minute', {
      type: 'line', xs: a.xs, onPick: pickDay, endLabels: true,
      series: [{ name: 'Average', color: 'var(--series-1)', values: a.rows.map((r) => (r ? r.averageRespirationValue : null)), fmt: (v) => `${fmtNum(v, 1)} brpm` }],
    }),
    n && n.sleepScores ? card('Score breakdown', dayText(), dataTable([
      { label: 'Component', get: (r) => r.name, fmt: humanize },
      { label: 'Rating', get: (r) => r.qualifierKey, fmt: humanize },
      { label: 'Value', num: true, get: (r) => r.value, fmt: (v) => fmtNum(v) },
    ], Object.entries(n.sleepScores).map(([name, v]) => ({ name, qualifierKey: v.qualifierKey, value: v.value })))) : null,
    n && (n.sleepScoreFeedback || n.sleepScoreInsight) ? card('Garmin feedback', dayText(), kvList([
      ['Feedback', humanize(n.sleepScoreFeedback)],
      ['Insight', humanize(n.sleepScoreInsight)],
      ['Personal insight', humanize(n.sleepScorePersonalizedInsight)],
    ])) : null,
    card('Every night', 'Sort by any column', dataTable([
      { label: 'Date', get: (r) => r.calendarDate, cell: (r) => h('button', { class: 'link', type: 'button', text: fmtIsoDay(r.calendarDate), onclick: () => pickDay(toUtc(r.calendarDate)) }) },
      { label: 'Bedtime', get: (r) => r.sleepStartTimestampLocal, fmt: (v) => (isNum(v) ? fmtClock(v) : '–') },
      { label: 'Woke', get: (r) => r.sleepEndTimestampLocal, fmt: (v) => (isNum(v) ? fmtClock(v) : '–') },
      { label: 'Asleep', num: true, get: (r) => r.sleepTimeSeconds, fmt: fmtDuration },
      { label: 'Score', num: true, get: G.sleepScore, fmt: (v) => fmtNum(v) },
      { label: 'Deep', num: true, get: (r) => r.deepSleepSeconds, fmt: fmtDuration },
      { label: 'REM', num: true, get: (r) => r.remSleepSeconds, fmt: fmtDuration },
      { label: 'Light', num: true, get: (r) => r.lightSleepSeconds, fmt: fmtDuration },
      { label: 'Awake', num: true, get: (r) => r.awakeSleepSeconds, fmt: fmtDuration },
      { label: 'Stress', num: true, get: (r) => r.avgSleepStress, fmt: (v) => fmtNum(v, 1) },
    ], [...nightsWithData].reverse()), { wide: true }),
  ));
  return out;
}

function offsetFrom(record) {
  if (!record || !record.startTimestampLocal || !record.startTimestampGMT) return 0;
  return parseTs(record.startTimestampLocal) - parseTs(record.startTimestampGMT);
}

async function renderHeart() {
  const [daily, hrv, dayHr, dayHrv, zones] = await Promise.all([
    settle(data.daily()), settle(data.hrv()), settle(data.dayHr(S.day)), settle(data.dayHrv(S.day)), settle(data.zones()),
  ]);
  const cards = [];
  if (dayHr.ok && dayHr.value && Array.isArray(dayHr.value.heartRateValues) && dayHr.value.heartRateValues.length) {
    const rec = dayHr.value;
    const offset = offsetFrom(rec);
    const samples = rec.heartRateValues.filter((p) => isNum(p[1]));
    cards.push(chartCard(`Heart rate on ${dayText()}`, `Low ${fmtNum(rec.minHeartRate)} · High ${fmtNum(rec.maxHeartRate)} · Resting ${fmtNum(rec.restingHeartRate)} bpm`, {
      type: 'line', time: true, xs: samples.map((p) => p[0] + offset), gapMs: 30 * 60000, area: true, height: 240,
      xFmt: fmtClock,
      series: [{ name: 'Heart rate', color: 'var(--series-1)', values: samples.map((p) => p[1]), fmt: (v) => `${fmtNum(v)} bpm` }],
    }, { wide: true }));
  } else if (!dayHr.ok) {
    cards.push(failedCard('Heart rate', dayHr.error, { wide: true }));
  } else {
    cards.push(card(`Heart rate on ${dayText()}`, null, empty('No heart rate recorded for this day.'), { wide: true }));
  }
  if (daily.ok) {
    const a = aligned(daily.value, (r) => r.calendarDate);
    cards.push(chartCard('Daily heart rate range', 'Highest, resting and lowest, in bpm. Click a day to inspect it.', {
      type: 'line', xs: a.xs, onPick: pickDay, endLabels: true,
      series: [
        { name: 'Highest', color: 'var(--series-1)', values: a.rows.map(G.hrMax), fmt: (v) => `${fmtNum(v)} bpm` },
        { name: 'Resting', color: 'var(--series-2)', values: a.rows.map(G.rhr), fmt: (v) => `${fmtNum(v)} bpm` },
        { name: 'Lowest', color: 'var(--series-3)', values: a.rows.map(G.hrMin), fmt: (v) => `${fmtNum(v)} bpm` },
      ],
    }));
  } else cards.push(failedCard('Daily heart rate range', daily.error));
  if (hrv.ok) {
    const a = aligned(hrv.value, (r) => r.calendarDate);
    const latest = [...a.rows].reverse().find((r) => r && r.status);
    const baseline = latest && latest.baseline ? `Balanced range ${fmtNum(latest.baseline.balancedLow)}–${fmtNum(latest.baseline.balancedUpper)} ms` : '';
    cards.push(chartCard('Heart rate variability (HRV)', [latest ? `Latest status: ${humanize(latest.status)}` : '', baseline].filter(Boolean).join(' · '), {
      type: 'line', xs: a.xs, onPick: pickDay, endLabels: true,
      series: [
        { name: 'Overnight', color: 'var(--series-1)', values: a.rows.map((r) => (r ? r.lastNightAvg : null)), fmt: (v) => `${fmtNum(v)} ms` },
        { name: '7-day average', color: 'var(--series-2)', values: a.rows.map((r) => (r ? r.weeklyAvg : null)), fmt: (v) => `${fmtNum(v)} ms` },
      ],
    }));
  } else cards.push(failedCard('HRV', hrv.error));
  if (dayHrv.ok && dayHrv.value && Array.isArray(dayHrv.value.hrvReadings) && dayHrv.value.hrvReadings.length) {
    const readings = dayHrv.value.hrvReadings;
    cards.push(chartCard('Overnight HRV readings', dayHrv.value.hrvSummary ? `${dayText()} · ${humanize(dayHrv.value.hrvSummary.status)}` : dayText(), {
      type: 'line', time: true, gapMs: 60 * 60000, xs: readings.map((r) => parseTs(r.readingTimeLocal)), xFmt: fmtClock,
      series: [{ name: 'HRV', color: 'var(--series-1)', values: readings.map((r) => r.hrvValue), fmt: (v) => `${fmtNum(v)} ms` }],
    }));
  } else if (!dayHrv.ok) cards.push(failedCard('Overnight HRV readings', dayHrv.error));
  if (zones.ok && Array.isArray(zones.value)) {
    cards.push(card('Heart rate zones', 'Lower limit of each zone, in bpm', dataTable([
      { label: 'Sport', get: (r) => r.sport, fmt: humanize },
      { label: 'Method', get: (r) => r.trainingMethod, fmt: humanize },
      ...[1, 2, 3, 4, 5].map((z) => ({ label: `Zone ${z}`, num: true, get: (r) => r[`zone${z}Floor`], fmt: (v) => fmtNum(v) })),
      { label: 'Max', num: true, get: (r) => r.maxHeartRateUsed, fmt: (v) => fmtNum(v) },
    ], zones.value), { wide: true }));
  } else if (!zones.ok) cards.push(failedCard('Heart rate zones', zones.error));
  return [grid(...cards)];
}

async function renderStress() {
  const [daily, dayBb] = await Promise.all([settle(data.daily()), settle(data.dayBb(S.day))]);
  if (!daily.ok) return [grid(failedCard('Stress and energy', daily.error, { wide: true }))];
  const a = aligned(daily.value, (r) => r.calendarDate);
  const hours = (key) => a.rows.map((r) => G.stressPart(r, key));
  const otherHours = a.rows.map((r) => {
    const activity = G.stressPart(r, 'activityDurationInMillis');
    const unmeasured = G.stressPart(r, 'uncategorizedDurationInMillis');
    return isNum(activity) || isNum(unmeasured) ? (activity || 0) + (unmeasured || 0) : null;
  });
  const cards = [
    chartCard('Average stress', 'Garmin’s 0–100 scale. Click a day to inspect it.', {
      type: 'line', xs: a.xs, onPick: pickDay, endLabels: true, yMin: 0,
      series: [
        { name: 'Average', color: 'var(--series-1)', values: a.rows.map(G.stress), fmt: (v) => fmtNum(v) },
        { name: 'Peak', color: 'var(--series-2)', values: a.rows.map(G.stressMax), fmt: (v) => fmtNum(v) },
      ],
    }),
    chartCard('Time by stress level', 'Hours per day. Darker means more stress in light mode, brighter in dark mode.', {
      type: 'bar', stacked: true, xs: a.xs, onPick: pickDay, yFmt: (v) => `${fmtNum(v)}h`,
      series: [
        { name: 'Rest', color: 'var(--ord-1)', values: hours('restDurationInMillis'), fmt: hoursFmt },
        { name: 'Low', color: 'var(--ord-2)', values: hours('lowStressDurationInMillis'), fmt: hoursFmt },
        { name: 'Medium', color: 'var(--ord-3)', values: hours('mediumStressDurationInMillis'), fmt: hoursFmt },
        { name: 'High', color: 'var(--ord-4)', values: hours('highStressDurationInMillis'), fmt: hoursFmt },
        { name: 'Active or unmeasured', color: 'var(--other)', values: otherHours, fmt: hoursFmt },
      ],
    }),
    chartCard('Body Battery range', 'Daily high and low, out of 100', {
      type: 'line', xs: a.xs, onPick: pickDay, endLabels: true, yMin: 0, yMax: 100,
      series: [
        { name: 'High', color: 'var(--series-1)', values: a.rows.map(G.bbMax), fmt: (v) => fmtNum(v) },
        { name: 'Low', color: 'var(--series-2)', values: a.rows.map(G.bbMin), fmt: (v) => fmtNum(v) },
      ],
    }),
  ];
  const bb = dayBb.ok && Array.isArray(dayBb.value) ? dayBb.value[0] : null;
  if (bb && Array.isArray(bb.bodyBatteryValuesArray) && bb.bodyBatteryValuesArray.length) {
    const offset = offsetFrom(bb);
    const points = bb.bodyBatteryValuesArray.filter((p) => isNum(p[1]));
    cards.push(chartCard(`Body Battery on ${dayText()}`, `Charged ${fmtNum(bb.charged)} · Drained ${fmtNum(bb.drained)}`, {
      type: 'line', time: true, gapMs: 12 * 3600000, markers: true, xs: points.map((p) => p[0] + offset), xFmt: fmtClock, yMin: 0, yMax: 100,
      series: [{ name: 'Body Battery', color: 'var(--series-1)', values: points.map((p) => p[1]), fmt: (v) => fmtNum(v) }],
    }));
  } else if (!dayBb.ok) {
    cards.push(failedCard('Body Battery', dayBb.error));
  } else {
    cards.push(card(`Body Battery on ${dayText()}`, null, empty('No Body Battery readings for this day.')));
  }
  cards.push(
    chartCard('Body Battery charged', 'Points gained per day', {
      type: 'bar', xs: a.xs, onPick: pickDay,
      series: [{ name: 'Charged', color: 'var(--series-1)', values: a.rows.map(G.charged), fmt: (v) => fmtNum(v) }],
    }),
    chartCard('Body Battery drained', 'Points used per day', {
      type: 'bar', xs: a.xs, onPick: pickDay,
      series: [{ name: 'Drained', color: 'var(--series-1)', values: a.rows.map(G.drained), fmt: (v) => fmtNum(v) }],
    }),
  );
  return [grid(...cards)];
}

async function renderBreathing() {
  const [daily, spo2] = await Promise.all([settle(data.daily()), settle(data.daySpo2(S.day))]);
  const cards = [];
  if (spo2.ok && spo2.value && Array.isArray(spo2.value.spO2HourlyAverages) && spo2.value.spO2HourlyAverages.length) {
    const rec = spo2.value;
    const offset = offsetFrom(rec);
    const points = rec.spO2HourlyAverages.filter((p) => isNum(p[1]));
    cards.push(chartCard(`Blood oxygen on ${dayText()}`, `Hourly averages, ${points.length} readings. Average ${fmtNum(avg(points.map((p) => p[1])), 1)}%.`, {
      type: 'line', time: true, gapMs: 3 * 3600000, markers: true, xs: points.map((p) => p[0] + offset), xFmt: fmtClock, yMin: 80, yMax: 100,
      yFmt: (v) => `${fmtNum(v)}%`,
      series: [{ name: 'SpO2', color: 'var(--series-1)', values: points.map((p) => p[1]), fmt: (v) => `${fmtNum(v)}%` }],
    }, { wide: true }));
  } else if (!spo2.ok) {
    cards.push(failedCard('Blood oxygen', spo2.error, { wide: true }));
  } else {
    cards.push(card(`Blood oxygen on ${dayText()}`, null, empty('No blood oxygen readings for this day.'), { wide: true }));
  }
  if (daily.ok) {
    const a = aligned(daily.value, (r) => r.calendarDate);
    cards.push(chartCard('Respiration', 'Breaths per minute across the whole day. Click a day to inspect it.', {
      type: 'line', xs: a.xs, onPick: pickDay, endLabels: true,
      series: [
        { name: 'Highest', color: 'var(--series-1)', values: a.rows.map(G.respMax), fmt: (v) => `${fmtNum(v)} brpm` },
        { name: 'Average', color: 'var(--series-2)', values: a.rows.map(G.respAvg), fmt: (v) => `${fmtNum(v)} brpm` },
        { name: 'Lowest', color: 'var(--series-3)', values: a.rows.map(G.respMin), fmt: (v) => `${fmtNum(v)} brpm` },
      ],
    }, { wide: true }));
  } else cards.push(failedCard('Respiration', daily.error, { wide: true }));
  return [grid(...cards)];
}

async function renderBody() {
  const [weight, goals, daily, food, fit] = await Promise.all([
    settle(data.weight()), settle(data.weightGoals()), settle(data.daily()), settle(data.dayFood(S.day)), settle(data.dayFit(S.day)),
  ]);
  const cards = [];
  if (weight.ok) {
    const entries = weight.value.flatMap((d) => (d.allWeightMetrics && d.allWeightMetrics.length ? d.allWeightMetrics : d.latestWeight ? [d.latestWeight] : []));
    const summaries = weight.value.filter((d) => d.latestWeight && isNum(d.latestWeight.weight));
    if (summaries.length) {
      const a = aligned(summaries, (r) => r.summaryDate);
      cards.push(chartCard('Weight', `In ${weightUnit()}`, {
        type: 'line', xs: a.xs, connect: true, endLabels: true, markers: true, onPick: pickDay,
        series: [{ name: 'Weight', color: 'var(--series-1)', values: a.rows.map((r) => (r ? weightValue(r.latestWeight.weight) : null)), fmt: (v) => `${fmtNum(v, 1)} ${weightUnit()}` }],
      }));
    }
    cards.push(card('Weight entries', `${entries.length} in this date range`, entries.length ? dataTable([
      { label: 'Date', get: (r) => r.calendarDate, fmt: (v) => (v ? fmtIsoDay(v) : '–') },
      { label: `Weight (${weightUnit()})`, num: true, get: (r) => r.weight, fmt: (v) => fmtNum(weightValue(v), 1) },
      { label: 'BMI', num: true, get: (r) => r.bmi, fmt: (v) => fmtNum(v, 1) },
      { label: 'Body fat %', num: true, get: (r) => r.bodyFat, fmt: (v) => fmtNum(v, 1) },
      { label: 'Body water %', num: true, get: (r) => r.bodyWater, fmt: (v) => fmtNum(v, 1) },
      { label: `Muscle (${weightUnit()})`, num: true, get: (r) => r.muscleMass, fmt: (v) => fmtNum(weightValue(v), 1) },
      { label: `Bone (${weightUnit()})`, num: true, get: (r) => r.boneMass, fmt: (v) => fmtNum(weightValue(v), 1) },
      { label: 'Source', get: (r) => r.sourceType, fmt: humanize },
    ], entries) : empty('No weight entries in this date range.')));
  } else cards.push(failedCard('Weight', weight.error));

  cards.push(goals.ok
    ? card('Weight goals', null, goals.value.length ? jsonTree(goals.value, 'goals') : empty('No weight goal is set for this date range.'))
    : failedCard('Weight goals', goals.error));

  if (daily.ok) {
    const a = aligned(daily.value, (r) => r.calendarDate);
    const drinks = a.rows.map(G.hydration);
    const goal = [...a.rows].reverse().map(G.hydrationGoal).find(isNum);
    cards.push(sum(drinks) > 0
      ? chartCard('Water intake', goal ? `Latest daily goal: ${fmtNum(goal)} ml` : 'Millilitres per day', {
        type: 'bar', xs: a.xs, onPick: pickDay,
        series: [{ name: 'Water', color: 'var(--series-1)', values: drinks, fmt: (v) => `${fmtNum(v)} ml` }],
      })
      : card('Water intake', null, empty('No water logged in this date range.')));
  } else cards.push(failedCard('Water intake', daily.error));

  if (food.ok) {
    const foods = food.value && Array.isArray(food.value.loggedFoodsWithServingSizes) ? food.value.loggedFoodsWithServingSizes : [];
    const meals = food.value && Array.isArray(food.value.mealDetails) ? food.value.mealDetails : [];
    cards.push(card(`Food log on ${dayText()}`, null, foods.length || meals.length ? jsonTree(food.value, 'log') : empty('No food logged on this day.')));
  } else cards.push(failedCard('Food log', food.error));

  if (fit.ok) {
    const value = fit.value || {};
    const reasons = { USER_UNDER_AGE: 'Garmin doesn’t calculate fitness age for this profile because it is below the minimum age.' };
    cards.push(card('Fitness age', dayText(), value.invalidReason
      ? empty(reasons[value.invalidReason] || `Not available: ${humanize(value.invalidReason)}.`)
      : (Object.keys(value).length ? h('div', {}, kvList(flatPairs(value)), jsonTree(value, 'details', false)) : empty('No fitness age for this day.'))));
  } else cards.push(failedCard('Fitness age', fit.error));
  return [grid(...cards)];
}

async function renderCycle() {
  const [summary, dayView] = await Promise.all([settle(data.cycleSummary(S.day)), settle(data.cycleDay(S.day))]);
  const section = (title, result) => {
    if (!result.ok) return failedCard(title, result.error);
    return card(title, dayText(), result.value ? jsonTree(result.value, 'data') : empty('Nothing recorded for this day. This fills in if you use cycle tracking in Garmin Connect.'));
  };
  return [grid(section('Cycle summary', summary), section('Cycle day view', dayView))];
}

async function renderProfile() {
  const [profile, zones, status] = await Promise.all([
    settle(data.profile()), settle(data.zones()), settle(fetch('/api/status').then((r) => r.json())),
  ]);
  const message = h('div', { class: 'notice', role: 'status' });
  const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Paste a new Personal API key', 'aria-label': 'New API key' });
  const button = h('button', { type: 'submit', text: 'Replace key' });
  const form = h('form', {
    class: 'keyform',
    onsubmit: async (event) => {
      event.preventDefault();
      button.disabled = true;
      const outcome = await saveKey(input.value);
      button.disabled = false;
      message.textContent = outcome.ok ? 'New key checked with Garmin and saved.' : outcome.error;
      if (outcome.ok) input.value = '';
    },
  }, input, button);
  const st = status.ok ? status.value : {};
  return [grid(
    profile.ok ? card('Settings', null, h('div', {}, kvList([
      ['Display name', profile.value.displayName],
      ['Language', profile.value.preferredLocale],
      ['Units', humanize(profile.value.measurementSystem)],
      ['Time zone', profile.value.timeZone],
      ['Week starts', profile.value.firstDayOfWeek && humanize(profile.value.firstDayOfWeek.dayName)],
      ['Number format', humanize(profile.value.numberFormat)],
      ['Time format', profile.value.timeFormat && humanize(profile.value.timeFormat.formatKey)],
      ['Date format', profile.value.dateFormat && humanize(profile.value.dateFormat.formatKey)],
      ['Water unit', humanize(profile.value.hydrationMeasurementUnit)],
      ['Golf distance', humanize(profile.value.golfDistanceUnit)],
    ]))) : failedCard('Settings', profile.error),
    card('API key', null, h('div', {},
      kvList([
        ['Saved in', st.keyPath],
        ['Status', st.ok ? 'Working' : (st.error || 'Unknown')],
        ['Access token renews', st.tokenExpiresAt ? new Date(st.tokenExpiresAt * 1000).toLocaleString() : '–'],
      ]),
      form, message)),
    zones.ok && zones.value ? card('Heart rate zones', null, jsonTree(zones.value, 'zones', false)) : null,
    profile.ok ? card('All profile fields', null, jsonTree(profile.value, 'profile')) : null,
  )];
}

/* ---------- data explorer ---------- */

const ENDPOINTS = [
  { id: 'daily', name: 'Daily summaries', kind: 'long', make: (a, b) => `/usersummary-service/v2/dailysummaries?${qs(a, b)}`, pick: (r) => r && r.data },
  { id: 'steps', name: 'Daily steps', kind: 'short', make: (a, b) => `/usersummary-service/stats/steps/daily/${a}/${b}` },
  { id: 'stress', name: 'Daily stress', kind: 'short', make: (a, b) => `/usersummary-service/stats/stress/daily/${a}/${b}` },
  { id: 'hydration', name: 'Daily hydration', kind: 'short', make: (a, b) => `/usersummary-service/stats/hydration/daily/${a}/${b}` },
  { id: 'sleepSummaries', name: 'Sleep summaries', kind: 'short', make: (a, b) => `/sleep-service/sleep/dailySleepSummariesByDate?${qs(a, b)}` },
  { id: 'bodyBattery', name: 'Body Battery', kind: 'short', make: (a, b) => `/wellness-service/wellness/bodyBattery/reports/daily?${qs(a, b)}` },
  { id: 'hrvDaily', name: 'HRV summaries', kind: 'long', make: (a, b) => `/hrv-service/hrv/daily/${a}/${b}`, pick: (r) => r && r.hrvSummaries },
  { id: 'weight', name: 'Weight', kind: 'long', make: (a, b) => `/weight-service/weight/range/${a}/${b}?includeAll=true`, pick: (r) => r && r.dailyWeightSummaries },
  { id: 'weightGoals', name: 'Weight goals', kind: 'long', make: (a, b) => `/goal-service/goal/user/effective/weightgoal/${a}/${b}`, pick: (r) => r && r.userGoals },
  { id: 'wellnessActivity', name: 'Wellness activities', kind: 'long', make: (a, b) => `/wellnessactivity-service/activity/summary/range/${a}/${b}` },
  { id: 'activities', name: 'Workout search', kind: 'one', make: () => `/activitylist-service/activities/search/activities?start=0&limit=100&${qs(S.start, S.end)}` },
  { id: 'sleepDay', name: 'Sleep (selected day)', kind: 'one', make: () => `/sleep-service/sleep/dailySleep?date=${S.day}` },
  { id: 'heartRate', name: 'Heart rate (selected day)', kind: 'one', make: () => `/wellness-service/wellness/dailyHeartRate?date=${S.day}` },
  { id: 'hrvDay', name: 'HRV (selected day)', kind: 'one', make: () => `/hrv-service/hrv/${S.day}` },
  { id: 'spo2', name: 'Blood oxygen (selected day)', kind: 'one', make: () => `/wellness-service/wellness/daily/spo2acclimation/${S.day}` },
  { id: 'food', name: 'Food log (selected day)', kind: 'one', make: () => `/nutrition-service/food/logs/${S.day}` },
  { id: 'fitnessAge', name: 'Fitness age (selected day)', kind: 'one', make: () => `/fitnessage-service/fitnessage/v2/${S.day}` },
  { id: 'cycleSummary', name: 'Cycle summary (selected day)', kind: 'one', make: () => `/periodichealth-service/menstrualcycle/summary/${S.day}` },
  { id: 'cycleDay', name: 'Cycle day view (selected day)', kind: 'one', make: () => `/periodichealth-service/menstrualcycle/dayview/${S.day}?todayDate=${today()}` },
  { id: 'profile', name: 'Profile settings', kind: 'one', make: () => '/userprofile-service/userprofile/settings' },
  { id: 'zones', name: 'Heart rate zones', kind: 'one', make: () => '/biometric-service/heartRateZones/v2' },
  { id: 'activity', name: 'Workout detail (by ID)', kind: 'id', make: (id) => `/activity-service/activity/${id}` },
  { id: 'activityWorkouts', name: 'Linked workouts (by ID)', kind: 'id', make: (id) => `/activity-service/activity/${id}/workouts` },
];

function renderExplorer() {
  const pathLine = h('div', { class: 'path' });
  const result = h('div', {}, empty('Choose a data source to see everything Garmin returns for it.'));
  const idInput = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Workout ID', 'aria-label': 'Workout ID', hidden: 'hidden' });
  const customInput = h('input', { type: 'text', placeholder: '/service/path?param=value', 'aria-label': 'Custom Garmin path', hidden: 'hidden' });
  let lastJson = null;

  const copy = h('button', {
    type: 'button', text: 'Copy JSON', disabled: true,
    onclick: async () => {
      await navigator.clipboard.writeText(JSON.stringify(lastJson, null, 2));
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy JSON'; }, 1200);
    },
  });
  const save = h('button', {
    type: 'button', text: 'Save JSON', disabled: true,
    onclick: () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(lastJson, null, 2)], { type: 'application/json' }));
      const link = h('a', { href: url, download: `garmin-${S.explorerId}.json` });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });

  const syncInputs = () => {
    const ep = ENDPOINTS.find((e) => e.id === S.explorerId);
    idInput.hidden = !ep || ep.kind !== 'id';
    customInput.hidden = S.explorerId !== 'custom';
  };

  const run = async () => {
    const ep = ENDPOINTS.find((e) => e.id === S.explorerId);
    result.style.opacity = '0.5';
    copy.disabled = true;
    save.disabled = true;
    try {
      let value;
      if (S.explorerId === 'custom') {
        const path = customInput.value.trim();
        pathLine.textContent = `GET ${path}`;
        value = await api(path);
      } else if (ep.kind === 'id') {
        const id = idInput.value.trim();
        if (!/^\d+$/.test(id)) throw new Error('Enter a workout ID. The Workouts tab data includes an activityId for each one.');
        pathLine.textContent = `GET ${ep.make(id)}`;
        value = await api(ep.make(id));
      } else if (ep.kind === 'one') {
        pathLine.textContent = `GET ${ep.make()}`;
        value = await api(ep.make());
      } else {
        const size = ep.kind === 'short' ? SHORT_RANGE_DAYS : LONG_RANGE_DAYS;
        const parts = chunks(S.start, S.end, size);
        pathLine.textContent = `GET ${ep.make(parts[0][0], parts[0][1])}${parts.length > 1 ? `  (and ${parts.length - 1} more, merged)` : ''}`;
        value = await fetchChunked(ep.make, S.start, S.end, size, ep.pick);
      }
      lastJson = value;
      copy.disabled = false;
      save.disabled = false;
      result.replaceChildren(value === null ? empty('Garmin returned no data for this request.') : jsonTree(value, 'response'));
    } catch (error) {
      result.replaceChildren(errorBlock(error));
    } finally {
      result.style.opacity = '';
    }
  };

  const select = h('select', {
    'aria-label': 'Data source',
    onchange: (event) => { S.explorerId = event.target.value; syncInputs(); },
  }, ENDPOINTS.map((ep) => {
    const option = h('option', { value: ep.id, text: ep.name });
    option.selected = ep.id === S.explorerId;
    return option;
  }), (() => { const o = h('option', { value: 'custom', text: 'Custom path' }); o.selected = S.explorerId === 'custom'; return o; })());

  syncInputs();
  return [grid(card('Data explorer', 'Read the raw response from any Garmin data source. Uses the dates selected above.', h('div', {},
    h('form', { class: 'toolbar', onsubmit: (event) => { event.preventDefault(); run(); } },
      select, idInput, customInput, h('button', { type: 'submit', text: 'Fetch' }), copy, save),
    pathLine, result), { wide: true }))];
}

/* ---------- shell ---------- */

const TABS = [
  ['overview', 'Overview', renderOverview],
  ['activity', 'Activity', renderActivity],
  ['workouts', 'Workouts', renderWorkouts],
  ['sleep', 'Sleep', renderSleep],
  ['heart', 'Heart', renderHeart],
  ['stress', 'Stress & energy', renderStress],
  ['breathing', 'Breathing', renderBreathing],
  ['body', 'Body & food', renderBody],
  ['cycle', 'Cycle', renderCycle],
  ['profile', 'Profile', renderProfile],
  ['explorer', 'Data explorer', renderExplorer],
];

function renderTabs() {
  document.getElementById('tabs').replaceChildren(...TABS.map(([id, label]) => h('button', {
    type: 'button', text: label, 'aria-current': id === S.tab ? 'page' : null, onclick: () => setTab(id),
  })));
}

function setTab(id) {
  S.tab = id;
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  renderTabs();
  window.scrollTo(0, 0);
  render();
}

function setPreset(days) {
  S.preset = days;
  S.end = today();
  S.start = addDays(S.end, -(days - 1));
  renderFilters();
  render();
}

function currentTheme() {
  const stored = document.documentElement.dataset.theme;
  if (stored) return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function renderFilters() {
  const presets = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '1 year']];
  const startInput = h('input', {
    type: 'date', value: S.start, max: S.end, 'aria-label': 'Range start',
    onchange: (event) => {
      if (!event.target.value) return;
      S.start = event.target.value;
      S.preset = null;
      renderFilters();
      render();
    },
  });
  const endInput = h('input', {
    type: 'date', value: S.end, min: S.start, max: today(), 'aria-label': 'Range end',
    onchange: (event) => {
      if (!event.target.value) return;
      S.end = event.target.value;
      S.preset = null;
      renderFilters();
      render();
    },
  });
  const moveDay = (n) => {
    const next = addDays(S.day, n);
    if (toUtc(next) > toUtc(today())) return;
    S.day = next;
    renderFilters();
    render();
  };
  document.getElementById('filters').replaceChildren(
    h('span', { class: 'label', text: 'Range' }),
    h('div', { class: 'group' }, presets.map(([days, label]) => h('button', {
      type: 'button', text: label, 'aria-pressed': String(S.preset === days), onclick: () => setPreset(days),
    }))),
    h('div', { class: 'group' }, startInput, '–', endInput),
    h('span', { class: 'sep' }),
    h('span', { class: 'label', text: 'Day' }),
    h('div', { class: 'group' },
      h('button', { type: 'button', text: '‹', 'aria-label': 'Previous day', onclick: () => moveDay(-1) }),
      h('input', {
        type: 'date', value: S.day, max: today(), 'aria-label': 'Selected day',
        onchange: (event) => {
          if (!event.target.value) return;
          S.day = event.target.value;
          render();
        },
      }),
      h('button', { type: 'button', text: '›', 'aria-label': 'Next day', disabled: S.day === today(), onclick: () => moveDay(1) })),
    h('span', { class: 'hint', text: 'Click a day in a chart to select it' }),
    h('span', { class: 'spacer' }),
    h('button', {
      type: 'button', text: 'Refresh',
      onclick: async () => {
        S.memo.clear();
        await postJson('/api/cache/clear', {});
        render();
      },
    }),
    h('button', {
      type: 'button',
      text: currentTheme() === 'dark' ? 'Light mode' : 'Dark mode',
      onclick: () => {
        const next = currentTheme() === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        localStorage.setItem('theme', next);
        renderFilters();
      },
    }),
  );
}

async function render() {
  const id = ++S.renderId;
  const main = document.getElementById('main');
  hideTip();
  main.classList.add('loading');
  const entry = TABS.find(([key]) => key === S.tab);
  let nodes;
  try {
    nodes = await entry[2]();
  } catch (error) {
    nodes = [grid(failedCard(entry[1], error, { wide: true }))];
  }
  if (id !== S.renderId) return;
  main.replaceChildren(...nodes);
  main.classList.remove('loading');
}

async function postJson(url, value) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const body = await res.json().catch(() => ({}));
  return res.ok ? { ok: true } : { ok: false, error: body.error || `Request failed (HTTP ${res.status}).` };
}

async function saveKey(key) {
  const outcome = await postJson('/api/key', { key: key.trim() });
  if (outcome.ok) S.memo.clear();
  return outcome;
}

function renderSetup(reason) {
  const message = h('div', { class: 'notice', role: 'status', text: reason || '' });
  const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Personal API key', 'aria-label': 'Personal API key', required: 'required' });
  const button = h('button', { type: 'submit', text: 'Save and continue' });
  document.getElementById('filters').replaceChildren();
  document.getElementById('tabs').replaceChildren();
  document.getElementById('main').replaceChildren(h('div', { class: 'setup' }, card('Connect your Garmin account', 'Create a Personal API key on Garmin Connect Web, then paste it here. It is checked with Garmin and stored only on this Mac.', h('div', {},
    h('form', {
      onsubmit: async (event) => {
        event.preventDefault();
        button.disabled = true;
        const outcome = await saveKey(input.value);
        button.disabled = false;
        if (outcome.ok) boot();
        else message.textContent = outcome.error;
      },
    }, input, button),
    message))));
}

async function boot() {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.dataset.theme = saved;
  const status = await fetch('/api/status').then((r) => r.json());
  if (!status.ok) { renderSetup(status.error); return; }
  const profile = await settle(data.profile());
  if (profile.ok) S.profile = profile.value;
  const hash = location.hash.slice(1);
  if (TABS.some(([id]) => id === hash)) S.tab = hash;
  renderTabs();
  renderFilters();
  render();
}

window.addEventListener('hashchange', () => {
  const hash = location.hash.slice(1);
  if (hash !== S.tab && TABS.some(([id]) => id === hash)) setTab(hash);
});

boot();
