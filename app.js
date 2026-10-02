'use strict';

/* ─── ルール設定（ここを変えればルールが変わる） ─── */
const CONFIG = {
    ROSTER_SIZE:   8,
    BUDGET:        200,
    MAX_SWAPS:     2,    // 1週あたりの入れ替え上限
    MIN_PRICE:     5,
    NO_DATA_PRICE: 10,   // 前季データなし（新人など）の値段
    CPU_MIN_PRICE: 10,   // CPUが選ぶ選手の下限価格（ローテーション外の選手を除外）
    CPU_MIN_GP:    40,   // CPUが選ぶ選手の前季出場試合数の下限（新人・長期離脱明けを除外）
    SCORING: { PTS: 1, REB: 1.2, AST: 1.5, STL: 3, BLK: 3, TO: -1 },  // Yahoo標準
    TIERS: [
        { key: 'gold',   label: 'Gold',   base: 32 },
        { key: 'silver', label: 'Silver', base: 27 },
        { key: 'bronze', label: 'Bronze', base: 22 },
    ],
};
const STAT_KEYS = ['PTS', 'REB', 'AST', 'STL', 'BLK', 'TO'];

const API = {
    SCOREBOARD: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
    SUMMARY:    'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary',
    TEAMS:      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams',
    BY_ATHLETE: 'https://site.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete',
};
const TEAM_IDS = [1,2,17,30,4,5,6,7,8,9,10,11,12,13,29,14,15,16,3,18,25,19,20,21,22,23,24,28,26,27];
// ESPNの略称をNBA公式の3文字表記にそろえる
const TEAM_ABBR = { GS: 'GSW', NO: 'NOP', NY: 'NYK', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS' };
const abbr = a => TEAM_ABBR[a] || a || '';

// 7月以降は次シーズン扱い（2026年7月〜 → 2026-27シーズン = 2027）
const _now = new Date();
const SEASON_YEAR  = _now.getMonth() >= 6 ? _now.getFullYear() + 1 : _now.getFullYear();
const PRICE_SEASON = SEASON_YEAR - 1;  // 値段は前シーズンの平均FPTSで固定

/* ─── localStorage ─── */
const KEYS = {
    state: 'nbaf.state.v1',
    pool:  'nbaf.pool.v2',
    days:  'nbaf.days.v1',
    boxes: 'nbaf.boxes.v1',
};

function load(key, fallback) {
    try {
        const s = localStorage.getItem(key);
        return s ? JSON.parse(s) : fallback;
    } catch (e) {
        return fallback;
    }
}

function save(key, val) {
    try {
        localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
        console.warn('save failed:', key, e);
    }
}

function defaultState() {
    return { v: 1, pending: [], weeks: {}, lastWeek: null };
}

let state    = Object.assign(defaultState(), load(KEYS.state, {}));
let dayCache = load(KEYS.days, {});
let boxCache = load(KEYS.boxes, {});
let pool     = [];
let poolById = {};
let curWk    = null;
let weekInfo = {};   // wk → loadWeek() の結果（メモリ上のみ）
let lastSync = 0;

function saveState() { save(KEYS.state, state); }

/* ─── Utils ─── */
const pad = n => String(n).padStart(2, '0');
const round1 = x => Math.round(x * 10) / 10;
const sum = arr => arr.reduce((s, x) => s + x, 0);
const fmt1 = x => (Math.round(x * 10) / 10).toFixed(1);

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
}

function fpts(line) {
    return STAT_KEYS.reduce((s, k, i) => s + (line[i] || 0) * CONFIG.SCORING[k], 0);
}

function headshot(id) {
    return `https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/${id}.png&w=96&h=70`;
}

let toastTimer = null;
function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ─── 日付（週は米国東部時間の月曜〜日曜） ─── */
function etYmd(date) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date).replace(/-/g, '');
}
function ymdToMs(ymd) {
    return Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
}
function msToYmd(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}
function addDays(ymd, n) { return msToYmd(ymdToMs(ymd) + n * 86400000); }
function mondayOf(ymd) {
    const dow = new Date(ymdToMs(ymd)).getUTCDay();
    return addDays(ymd, -((dow + 6) % 7));
}
function weekDays(wk) { return [0, 1, 2, 3, 4, 5, 6].map(i => addDays(wk, i)); }
function fmtMd(ymd) { return `${+ymd.slice(4, 6)}/${+ymd.slice(6, 8)}`; }
function fmtWeek(wk) { return `${fmtMd(wk)}〜${fmtMd(addDays(wk, 6))}`; }
function fmtJst(iso) {
    return new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));
}

/* ─── 選手プール（現ロスター + 前季成績から値段を算出） ─── */
async function loadPool(force = false) {
    const c = load(KEYS.pool, null);
    if (!force && c && c.priceSeason === PRICE_SEASON && Date.now() - c.ts < 12 * 3600e3) return c.players;

    const statsUrl = `${API.BY_ATHLETE}?season=${PRICE_SEASON}&seasontype=2&limit=1000&qualified=false&sort=offensive.avgPoints:desc`;
    const [stats, ...rosters] = await Promise.allSettled([
        fetchJson(statsUrl),
        ...TEAM_IDS.map(id => fetchJson(`${API.TEAMS}/${id}/roster`)),
    ]);
    if (stats.status !== 'fulfilled') {
        if (c) return c.players;
        throw new Error('前シーズン成績の取得に失敗しました');
    }

    const idx = {};
    for (const cat of stats.value.categories || []) {
        idx[cat.name] = {};
        (cat.names || []).forEach((n, i) => { idx[cat.name][n] = i; });
    }
    const get = (a, catName, statName) => {
        const cat = (a.categories || []).find(x => x.name === catName);
        const i = idx[catName]?.[statName];
        return cat && i != null ? (cat.values?.[i] ?? 0) : 0;
    };
    const prev = {};
    for (const a of stats.value.athletes || []) {
        const line = [
            get(a, 'offensive', 'avgPoints'),
            get(a, 'general',   'avgRebounds'),
            get(a, 'offensive', 'avgAssists'),
            get(a, 'defensive', 'avgSteals'),
            get(a, 'defensive', 'avgBlocks'),
            get(a, 'offensive', 'avgTurnovers'),
        ];
        prev[String(a.athlete?.id)] = {
            fpg: fpts(line),
            gp:  get(a, 'general', 'gamesPlayed'),
            // モーダル表示用: [MIN, PTS, REB, AST, STL, BLK, TO, FG%, 3PM, 3P%, FT%]
            st: [
                get(a, 'general',   'avgMinutes'),
                ...line,
                get(a, 'offensive', 'fieldGoalPct'),
                get(a, 'offensive', 'avgThreePointFieldGoalsMade'),
                get(a, 'offensive', 'threePointFieldGoalPct'),
                get(a, 'offensive', 'freeThrowPct'),
            ].map(round1),
        };
    }

    const players = [];
    let failed = 0;
    for (const r of rosters) {
        if (r.status !== 'fulfilled') { failed++; continue; }
        const t = r.value.team || {};
        for (const a of r.value.athletes || []) {
            const id = String(a.id);
            const pv = prev[id];
            players.push({
                id,
                name:   a.displayName || '?',
                team:   abbr(t.abbreviation),
                teamId: String(t.id || ''),
                pos:    a.position?.abbreviation || '',
                fpg:    pv ? round1(pv.fpg) : null,
                gp:     pv ? pv.gp : 0,
                st:     pv ? pv.st : null,
                price:  pv ? Math.max(CONFIG.MIN_PRICE, Math.round(pv.fpg)) : CONFIG.NO_DATA_PRICE,
                inj:    a.injuries?.[0]?.status || '',
            });
        }
    }
    if (failed && c) return c.players;  // 一部失敗時は前回キャッシュを優先
    if (!failed) save(KEYS.pool, { ts: Date.now(), priceSeason: PRICE_SEASON, players });
    return players;
}

function toMeta(p) {
    return { id: p.id, name: p.name, team: p.team, teamId: p.teamId, price: p.price };
}

/* ─── スケジュール / ボックススコア ─── */
async function fetchDay(ymd) {
    const today = etYmd(new Date());
    const c = dayCache[ymd];
    if (c) {
        const age = Date.now() - c.ts;
        if (ymd < today && c.events.every(e => e.state === 'post')) return c.events;
        if (ymd > today && age < 6 * 3600e3) return c.events;
        if (age < 60e3) return c.events;
    }
    try {
        const d = await fetchJson(`${API.SCOREBOARD}?dates=${ymd}&limit=50`);
        const events = (d.events || [])
            .filter(e => e.season?.type === 2)   // レギュラーシーズンのみ
            .map(e => {
                const comp = e.competitions?.[0] || {};
                return {
                    id:    String(e.id),
                    start: e.date,
                    state: comp.status?.type?.state || 'pre',
                    teams: (comp.competitors || []).map(x => String(x.team?.id)),
                    name:  e.shortName || '',
                };
            });
        dayCache[ymd] = { ts: Date.now(), events };
        save(KEYS.days, dayCache);
        return events;
    } catch (e) {
        if (c) return c.events;
        throw e;
    }
}

async function fetchBox(ev) {
    if (ev.state === 'pre') return null;
    const c = boxCache[ev.id];
    if (c && (c.final || Date.now() - c.ts < 60e3)) return c.p;
    try {
        const d = await fetchJson(`${API.SUMMARY}?event=${ev.id}`);
        const p = {};
        for (const team of d.boxscore?.players || []) {
            for (const st of team.statistics || []) {
                const labels = st.labels || st.names || [];
                const ix = STAT_KEYS.map(k => labels.indexOf(k));
                for (const a of st.athletes || []) {
                    if (a.didNotPlay || !a.stats?.length) continue;
                    p[String(a.athlete?.id)] = ix.map(i => (i >= 0 ? parseFloat(a.stats[i]) || 0 : 0));
                }
            }
        }
        boxCache[ev.id] = { ts: Date.now(), final: ev.state === 'post', p };
        save(KEYS.boxes, boxCache);
        return p;
    } catch (e) {
        return c ? c.p : null;
    }
}

async function loadWeek(wk) {
    const perDay = await Promise.all(weekDays(wk).map(fetchDay));
    const events = perDay.flat();
    const teamGames = {};
    events.forEach(e => e.teams.forEach(t => { teamGames[t] = (teamGames[t] || 0) + 1; }));
    const lockAt = events.length
        ? events.map(e => e.start).sort((a, b) => new Date(a) - new Date(b))[0]
        : null;
    const info = {
        wk,
        events,
        teamGames,
        lockAt,
        avgGames: events.length * 2 / 30,
        done: events.length > 0 && events.every(e => e.state === 'post'),
    };
    weekInfo[wk] = info;
    return info;
}

function targetsFor(avgGames) {
    return CONFIG.TIERS.map(t => ({ key: t.key, label: t.label, score: Math.round(CONFIG.ROSTER_SIZE * avgGames * t.base) }));
}

function isLocked(info) {
    return !!info?.lockAt && Date.now() >= new Date(info.lockAt).getTime();
}

/* ─── CPUチーム（週ごとにシード固定のランダム編成） ─── */
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function buildCpu(wk) {
    const rand = mulberry32(parseInt(wk, 10));
    const cands = pool.filter(p => p.price >= CONFIG.CPU_MIN_PRICE && p.gp >= CONFIG.CPU_MIN_GP && p.inj !== 'Out');
    if (cands.length < CONFIG.ROSTER_SIZE) return [];
    let best = null;
    for (let t = 0; t < 5000; t++) {
        const picked = new Set();
        while (picked.size < CONFIG.ROSTER_SIZE) picked.add(cands[Math.floor(rand() * cands.length)]);
        const team = [...picked];
        const cost = sum(team.map(p => p.price));
        if (cost > CONFIG.BUDGET) continue;
        if (!best || cost > best.cost) best = { team, cost };
        if (cost >= CONFIG.BUDGET - 5) break;   // 予算をほぼ使い切ったら採用
    }
    return best ? best.team.map(toMeta) : [];
}

/* ─── 週のロック・集計 ─── */
function latestLockedWeek() {
    const keys = Object.keys(state.weeks).sort();
    return keys.length ? keys[keys.length - 1] : null;
}

function snapshotWeek(wk, info) {
    if (state.weeks[wk] || !state.pending.length) return;
    state.weeks[wk] = {
        lockAt: info.lockAt,
        roster: state.pending.map(p => ({ ...p })),
        cpu:    buildCpu(wk),
        result: null,
    };
    saveState();
}

async function scoreWeek(wk, info) {
    const w = state.weeks[wk];
    if (!w) return null;
    if (w.result) return w.result;

    const started = info.events.filter(e => e.state !== 'pre');
    const boxes = await Promise.all(started.map(fetchBox));
    const games = {};  // athleteId → [{f, line, start, live, name}]
    started.forEach((e, i) => {
        const b = boxes[i];
        if (!b) return;
        for (const [id, line] of Object.entries(b)) {
            (games[id] ||= []).push({ f: round1(fpts(line)), line, start: e.start, live: e.state === 'in', name: e.name });
        }
    });
    const side = list => {
        const players = list.map(p => {
            const g = (games[p.id] || []).sort((a, b) => new Date(a.start) - new Date(b.start));
            return { ...p, games: g, total: round1(sum(g.map(x => x.f))), sched: info.teamGames[p.teamId] || 0 };
        });
        return { players, total: round1(sum(players.map(p => p.total))) };
    };
    const my  = side(w.roster);
    const cpu = side(w.cpu);
    const targets = targetsFor(info.avgGames);
    const tier = targets.find(t => my.total >= t.score)?.key || null;
    const final = info.done && boxes.every(Boolean);
    const res = {
        my, cpu, targets, tier, final,
        outcome: my.total > cpu.total ? 'win' : my.total < cpu.total ? 'lose' : 'draw',
    };

    if (final && wk < curWk) {
        w.result = res;
        saveState();
        info.events.forEach(e => { delete boxCache[e.id]; });
        save(KEYS.boxes, boxCache);
    }
    return res;
}

// 起動時・復帰時に呼ぶ: 未処理の週をロックし、終わった週を確定させる
async function sync(forcePool = false) {
    pool = await loadPool(forcePool);
    poolById = Object.fromEntries(pool.map(p => [p.id, p]));
    // 移籍に追従（値段は前季成績で固定なので変わらない）
    state.pending = state.pending.map(p => (poolById[p.id] ? { ...p, team: poolById[p.id].team, teamId: poolById[p.id].teamId } : p));

    curWk = mondayOf(etYmd(new Date()));
    const toCheck = new Set([curWk]);
    Object.keys(state.weeks).forEach(k => { if (!state.weeks[k].result && k < curWk) toCheck.add(k); });
    if (state.pending.length) {
        // 前回起動から空いた週を埋める（最大30週）
        let wk = state.lastWeek ? addDays(state.lastWeek, 7) : curWk;
        for (let i = 0; wk < curWk && i < 30; i++, wk = addDays(wk, 7)) toCheck.add(wk);
    }

    for (const wk of [...toCheck].sort()) {
        const info = await loadWeek(wk);
        if (isLocked(info)) snapshotWeek(wk, info);
        if (state.weeks[wk] && wk < curWk) await scoreWeek(wk, info);
    }
    // ここまでで処理済みの週を記録（ロスターが空だった週を後から埋めないため）
    const done = isLocked(weekInfo[curWk]) ? curWk : addDays(curWk, -7);
    if (!state.lastWeek || done > state.lastWeek) state.lastWeek = done;
    saveState();
    lastSync = Date.now();
}

// 編成を変える直前に、今週のロック時刻を過ぎていないか確認する
function ensureLockBeforeEdit() {
    const info = weekInfo[curWk];
    if (info && isLocked(info) && !state.weeks[curWk]) {
        snapshotWeek(curWk, info);
        saveState();
        toast('今週のロスターが確定しました。変更は来週分になります');
    }
}

/* ─── 編成ルール ─── */
function swapBase() {
    const wk = latestLockedWeek();
    return wk ? state.weeks[wk].roster : null;
}

function swapsUsed() {
    const base = swapBase();
    if (!base) return 0;
    const baseIds = new Set(base.map(p => p.id));
    return state.pending.filter(p => !baseIds.has(p.id)).length;
}

function pendingCost() { return sum(state.pending.map(p => p.price)); }

function canAdd(p) {
    if (state.pending.some(x => x.id === p.id)) return '登録済み';
    if (state.pending.length >= CONFIG.ROSTER_SIZE) return '枠がいっぱい';
    if (pendingCost() + p.price > CONFIG.BUDGET) return '予算オーバー';
    const base = swapBase();
    if (base && !base.some(x => x.id === p.id) && swapsUsed() >= CONFIG.MAX_SWAPS) return '入れ替え上限';
    return null;
}

function addPlayer(id) {
    ensureLockBeforeEdit();
    const p = poolById[id];
    if (!p) return;
    const reason = canAdd(p);
    if (reason) { toast(reason); return; }
    state.pending.push(toMeta(p));
    saveState();
    toast(`${p.name} を追加しました`);
    renderActive();
}

function removePlayer(id) {
    ensureLockBeforeEdit();
    const p = state.pending.find(x => x.id === id);
    state.pending = state.pending.filter(x => x.id !== id);
    saveState();
    if (p) toast(`${p.name} を外しました`);
    renderActive();
}

// 編成が適用される週（今週がロック済みなら来週。オフ期間は試合がある最初の週）
async function pendingTargetWeek() {
    let wk = state.weeks[curWk] ? addDays(curWk, 7) : curWk;
    for (let i = 0; i < 8; i++, wk = addDays(wk, 7)) {
        const info = weekInfo[wk] || await loadWeek(wk);
        if (info.events.length) return info;
    }
    return weekInfo[curWk];
}

/* ─── 描画パーツ ─── */
function photoImg(id) {
    return `<img class="photo" src="${headshot(esc(id))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
}

function injTag(status) {
    if (!status) return '';
    const short = status === 'Day-To-Day' ? 'DTD' : status;
    return ` <span class="inj">${esc(short)}</span>`;
}

function gameChips(p) {
    const chips = p.games.map(g => `<span class="gchip${g.live ? ' live' : ''}">${fmt1(g.f)}</span>`);
    const remain = Math.max(0, (p.sched || 0) - p.games.length);
    for (let i = 0; i < remain; i++) chips.push('<span class="gchip todo">−</span>');
    return `<div class="games">${chips.join('')}</div>`;
}

function scoredRows(players) {
    return [...players]
        .sort((a, b) => b.total - a.total)
        .map(p => `
            <div class="prow" data-player="${esc(p.id)}">
                ${photoImg(p.id)}
                <div class="pbody">
                    <div class="pname">${esc(p.name)}</div>
                    <div class="pmeta">${esc(abbr(p.team))} · $${p.price} · ${p.games.length}/${p.sched || p.games.length}試合</div>
                    ${gameChips(p)}
                </div>
                <div class="pright"><div class="ptotal">${fmt1(p.total)}</div></div>
            </div>`).join('');
}

function targetBar(total, targets) {
    const gold = targets.find(t => t.key === 'gold')?.score || 1;
    const max = Math.max(gold * 1.15, total);
    const pct = v => `${Math.min(100, (v / max) * 100).toFixed(1)}%`;
    const marks = targets.map(t => `<div class="target-mark ${t.key}" style="left:${pct(t.score)}"></div>`).join('');
    const legend = [...targets].reverse().map(t => `<span class="${t.key}">${t.label} ${t.score}</span>`).join('');
    return `
        <div class="target-bar">
            <div class="target-fill" style="width:${pct(total)}"></div>
            ${marks}
        </div>
        <div class="target-legend">${legend}</div>`;
}

function tierBadge(tier) {
    if (!tier) return '<span class="badge">未達</span>';
    const t = CONFIG.TIERS.find(x => x.key === tier);
    return `<span class="badge ${tier}">${t.label}</span>`;
}

function outcomeBadge(res) {
    if (!res.final) return '<span class="badge live">進行中</span>';
    if (res.outcome === 'win')  return '<span class="badge win">WIN</span>';
    if (res.outcome === 'lose') return '<span class="badge lose">LOSE</span>';
    return '<span class="badge">DRAW</span>';
}

function weekNumber(wk) {
    return Object.keys(state.weeks).sort().indexOf(wk) + 1;
}

/* ─── 今週タブ ─── */
async function renderWeek() {
    const el = document.getElementById('view-week');
    const info = weekInfo[curWk];
    const w = state.weeks[curWk];

    if (!w) {
        let html = `<div class="card"><div class="card-title">今週 ${fmtWeek(curWk)}</div>`;
        if (!info?.events.length) {
            const next = await pendingTargetWeek().catch(() => null);
            html += `<div class="msg">今週は公式戦がありません。`;
            if (next?.lockAt) html += `<br>次のロックは <strong>${fmtJst(next.lockAt)}</strong>（${fmtWeek(next.wk)} の週）です。`;
            html += `<br>「編成」タブでチームを作りましょう。</div>`;
        } else {
            html += `<div class="msg">ロック前です。<br><strong>${fmtJst(info.lockAt)}</strong> にロスターが確定します。</div>`;
        }
        if (!state.pending.length) {
            html += `<button class="btn primary block" data-goto="team">チームを編成する</button>`;
        }
        html += '</div>';
        if (info?.events.length) html += `<div class="card"><div class="card-title">今週の目標</div>${targetBar(0, targetsFor(info.avgGames))}<div class="note">今週の平均試合数: ${info.avgGames.toFixed(2)}試合/チーム</div></div>`;
        el.innerHTML = html;
        return;
    }

    const res = await scoreWeek(curWk, info);
    const myLead = res.my.total >= res.cpu.total;
    const share = res.my.total + res.cpu.total > 0 ? (res.my.total / (res.my.total + res.cpu.total)) * 100 : 50;
    el.innerHTML = `
        <div class="card">
            <div class="card-title">第${weekNumber(curWk)}週 · ${fmtWeek(curWk)} ${outcomeBadge(res)}</div>
            <div class="vs">
                <div class="vs-side ${myLead ? 'lead' : ''}"><div class="vs-label">自分</div><div class="vs-score">${fmt1(res.my.total)}</div></div>
                <div class="vs-side right ${myLead ? '' : 'lead'}"><div class="vs-label">CPU</div><div class="vs-score">${fmt1(res.cpu.total)}</div></div>
            </div>
            <div class="vs-bar"><div style="width:${share.toFixed(1)}%"></div></div>
        </div>
        <div class="card">
            <div class="card-title">目標スコア ${tierBadge(res.tier)}</div>
            ${targetBar(res.my.total, res.targets)}
        </div>
        <div class="card">
            <div class="card-title">自分のチーム</div>
            <div class="plist">${scoredRows(res.my.players)}</div>
        </div>
        <div class="card">
            <details class="cpu">
                <summary>CPUチームを見る（$${sum(w.cpu.map(p => p.price))}）</summary>
                <div class="plist">${scoredRows(res.cpu.players)}</div>
            </details>
        </div>`;
}

/* ─── 編成タブ ─── */
const search = { q: '', team: '', sort: 'price-desc' };

async function renderTeam() {
    const el = document.getElementById('view-team');
    const tInfo = await pendingTargetWeek().catch(() => null);
    const targetWk = tInfo?.wk || curWk;
    const gamesOf = teamId => tInfo?.teamGames[teamId] ?? 0;

    const cost = pendingCost();
    const base = swapBase();
    const swapsLeft = base ? CONFIG.MAX_SWAPS - swapsUsed() : null;
    const baseIds = new Set((base || []).map(p => p.id));

    const slots = state.pending.map(p => {
        const pp = poolById[p.id];
        const isNew = base && !baseIds.has(p.id);
        return `
            <div class="prow" data-player="${esc(p.id)}">
                ${photoImg(p.id)}
                <div class="pbody">
                    <div class="pname">${esc(p.name)}${isNew ? ' <span class="badge accent">NEW</span>' : ''}</div>
                    <div class="pmeta">${esc(abbr(p.team))} · 前季 ${pp?.fpg != null ? fmt1(pp.fpg) : '−'} · ${gamesOf(p.teamId)}試合${injTag(pp?.inj)}</div>
                </div>
                <div class="pright"><div class="ptotal">$${p.price}</div></div>
                <button class="icon-btn" data-remove="${esc(p.id)}" aria-label="外す">×</button>
            </div>`;
    });
    for (let i = state.pending.length; i < CONFIG.ROSTER_SIZE; i++) slots.push('<div class="empty-slot">空き枠</div>');

    const teams = [...new Set(pool.map(p => p.team))].sort();
    el.innerHTML = `
        <div class="card">
            <div class="card-title">${fmtWeek(targetWk)} の週に適用</div>
            <div class="stats-row">
                <div class="stat-box"><div class="v ${cost > CONFIG.BUDGET ? 'over' : ''}">$${CONFIG.BUDGET - cost}</div><div class="l">残り予算</div></div>
                <div class="stat-box"><div class="v">${state.pending.length}/${CONFIG.ROSTER_SIZE}</div><div class="l">人数</div></div>
                <div class="stat-box"><div class="v">${swapsLeft == null ? '自由' : swapsLeft}</div><div class="l">入れ替え残り</div></div>
            </div>
            ${state.pending.length < CONFIG.ROSTER_SIZE ? `<p class="warn">${CONFIG.ROSTER_SIZE}人そろっていないと、その分の得点が入りません</p>` : ''}
        </div>
        <div class="card">
            <div class="card-title">ロスター</div>
            <div class="plist">${slots.join('')}</div>
        </div>
        <div class="card">
            <div class="card-title">選手を探す <span class="card-aside">試合数は ${fmtWeek(targetWk)}</span></div>
            <div class="search-controls">
                <input type="search" id="s-q" placeholder="選手名で検索" value="${esc(search.q)}" autocomplete="off">
                <select id="s-team">
                    <option value="">全チーム</option>
                    ${teams.map(t => `<option value="${esc(t)}" ${t === search.team ? 'selected' : ''}>${esc(t)}</option>`).join('')}
                </select>
                <select id="s-sort">
                    <option value="price-desc" ${search.sort === 'price-desc' ? 'selected' : ''}>価格 高い順</option>
                    <option value="price-asc"  ${search.sort === 'price-asc'  ? 'selected' : ''}>価格 安い順</option>
                    <option value="games"      ${search.sort === 'games'      ? 'selected' : ''}>試合数 多い順</option>
                </select>
            </div>
            <div class="plist" id="s-results"></div>
        </div>`;

    renderSearchResults(gamesOf);
    document.getElementById('s-q').addEventListener('input', e => { search.q = e.target.value; renderSearchResults(gamesOf); });
    document.getElementById('s-team').addEventListener('change', e => { search.team = e.target.value; renderSearchResults(gamesOf); });
    document.getElementById('s-sort').addEventListener('change', e => { search.sort = e.target.value; renderSearchResults(gamesOf); });
}

function renderSearchResults(gamesOf) {
    const q = search.q.trim().toLowerCase();
    let list = pool.filter(p =>
        (!q || p.name.toLowerCase().includes(q)) && (!search.team || p.team === search.team));
    const cmp = {
        'price-desc': (a, b) => b.price - a.price,
        'price-asc':  (a, b) => a.price - b.price,
        'games':      (a, b) => gamesOf(b.teamId) - gamesOf(a.teamId) || b.price - a.price,
    }[search.sort];
    list.sort(cmp);
    const shown = list.slice(0, 60);
    const el = document.getElementById('s-results');
    if (!shown.length) { el.innerHTML = '<div class="msg">該当なし</div>'; return; }
    el.innerHTML = shown.map(p => {
        const reason = canAdd(p);
        return `
            <div class="prow" data-player="${esc(p.id)}">
                ${photoImg(p.id)}
                <div class="pbody">
                    <div class="pname">${esc(p.name)}</div>
                    <div class="pmeta">${esc(abbr(p.team))} ${esc(p.pos)} · 前季 ${p.fpg != null ? fmt1(p.fpg) : '−'} · ${gamesOf(p.teamId)}試合${injTag(p.inj)}</div>
                </div>
                <div class="pright">
                    <div class="ptotal">$${p.price}</div>
                    ${reason ? `<div class="reason">${esc(reason)}</div>` : ''}
                </div>
                <button class="icon-btn add" data-add="${esc(p.id)}" ${reason ? 'disabled' : ''} aria-label="追加">＋</button>
            </div>`;
    }).join('') + (list.length > shown.length ? `<div class="note more">ほか ${list.length - shown.length} 人（検索で絞り込んでください）</div>` : '');
}

/* ─── 履歴タブ ─── */
function renderHistory() {
    const el = document.getElementById('view-history');
    const done = Object.keys(state.weeks).sort().reverse().filter(k => state.weeks[k].result);
    const results = done.map(k => state.weeks[k].result);
    const count = o => results.filter(r => r.outcome === o).length;
    const tierCount = t => results.filter(r => r.tier === t).length;

    const rows = done.map(k => {
        const r = state.weeks[k].result;
        return `
            <details class="week">
                <summary>
                    <span class="wk-label">第${weekNumber(k)}週 ${fmtWeek(k)}</span>
                    <span class="wk-score">${fmt1(r.my.total)} - ${fmt1(r.cpu.total)}</span>
                    ${outcomeBadge(r)} ${tierBadge(r.tier)}
                </summary>
                <div class="note">目標: ${r.targets.map(t => `${t.label} ${t.score}`).join(' / ')}</div>
                <div class="plist">${scoredRows(r.my.players)}</div>
            </details>`;
    }).join('');

    el.innerHTML = `
        <div class="card">
            <div class="card-title">シーズン成績</div>
            <div class="stats-row">
                <div class="stat-box"><div class="v">${count('win')}-${count('lose')}${count('draw') ? `-${count('draw')}` : ''}</div><div class="l">CPU戦</div></div>
                <div class="stat-box"><div class="v">${results.length ? fmt1(sum(results.map(r => r.my.total)) / results.length) : '−'}</div><div class="l">平均スコア</div></div>
                <div class="stat-box"><div class="v tiers">
                    <span class="gold">${tierCount('gold')}</span><span class="silver">${tierCount('silver')}</span><span class="bronze">${tierCount('bronze')}</span></div><div class="l">Gold · Silver · Bronze</div></div>
            </div>
        </div>
        <div class="card">
            <div class="card-title">週ごとの結果</div>
            ${rows || '<div class="msg">まだ確定した週はありません</div>'}
        </div>`;
}

/* ─── 設定タブ ─── */
function renderSettings() {
    const el = document.getElementById('view-settings');
    const s = CONFIG.SCORING;
    el.innerHTML = `
        <div class="card">
            <div class="card-title">ルール</div>
            <dl class="rules">
                <dt>チーム</dt>
                <dd>${CONFIG.ROSTER_SIZE}人・予算 $${CONFIG.BUDGET}。全員の得点を合計します。</dd>
                <dt>値段</dt>
                <dd>${PRICE_SEASON - 1}-${String(PRICE_SEASON).slice(2)} シーズンの1試合平均FPTS（最低 $${CONFIG.MIN_PRICE}、データなしは $${CONFIG.NO_DATA_PRICE}）。シーズン中は固定。</dd>
                <dt>得点（Yahoo標準）</dt>
                <dd>PTS ×${s.PTS} / REB ×${s.REB} / AST ×${s.AST} / STL ×${s.STL} / BLK ×${s.BLK} / TO ×${s.TO}</dd>
                <dt>週とロック</dt>
                <dd>月〜日（米国東部時間）。その週の最初の試合開始でロスター確定。確定後の変更は翌週分になります。</dd>
                <dt>入れ替え</dt>
                <dd>前週のロスターから週${CONFIG.MAX_SWAPS}人まで。最初の編成は自由。</dd>
                <dt>目標スコア</dt>
                <dd>${CONFIG.ROSTER_SIZE}人 × その週の平均試合数 × 基準値（${CONFIG.TIERS.map(t => `${t.label} ${t.base}`).join(' / ')}）</dd>
                <dt>CPUチーム</dt>
                <dd>毎週、同じ予算内でランダムに編成（$${CONFIG.CPU_MIN_PRICE}以上・前季${CONFIG.CPU_MIN_GP}試合以上・欠場中の選手から選ぶ）。</dd>
            </dl>
        </div>
        <div class="card">
            <div class="card-title">データ</div>
            <p class="note gap">データはこの端末のブラウザに保存されます。iPhoneは「ホーム画面に追加」して使うと消えにくくなります。念のため定期的にバックアップしてください。</p>
            <div class="btn-row">
                <button class="btn" id="btn-export">バックアップを書き出す</button>
                <button class="btn" id="btn-import">バックアップを読み込む</button>
                <input type="file" id="file-import" accept="application/json,.json" hidden>
                <button class="btn" id="btn-reload">選手データを再取得</button>
                <button class="btn danger" id="btn-reset">すべてリセット</button>
            </div>
        </div>
        <p class="note center">データ: ESPN</p>`;

    document.getElementById('btn-export').onclick = exportData;
    document.getElementById('btn-import').onclick = () => document.getElementById('file-import').click();
    document.getElementById('file-import').onchange = importData;
    document.getElementById('btn-reload').onclick = () => refresh(true);
    document.getElementById('btn-reset').onclick = () => {
        if (!confirm('ロスターと履歴をすべて削除します。よろしいですか？')) return;
        state = defaultState();
        saveState();
        refresh();
    };
}

function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nba-fantasy-backup-${etYmd(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importData(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const data = JSON.parse(reader.result);
            if (!Array.isArray(data.pending) || typeof data.weeks !== 'object') throw new Error('invalid');
            if (!confirm('現在のデータを上書きします。よろしいですか？')) return;
            state = Object.assign(defaultState(), data);
            saveState();
            toast('読み込みました');
            refresh();
        } catch (err) {
            toast('ファイルの形式が正しくありません');
        }
    };
    reader.readAsText(file);
    e.target.value = '';
}

/* ─── 選手モーダル（前季スタッツ） ─── */
function openPlayer(id) {
    const p = poolById[id];
    const meta = p || Object.values(state.weeks).flatMap(w => [...w.roster, ...w.cpu]).find(x => x.id === id);
    if (!meta) return;
    const season = `${PRICE_SEASON - 1}-${String(PRICE_SEASON).slice(2)}`;
    const st = p?.st;
    const cell = (label, v, unit = '') => `<div class="mstat"><div class="v">${v}${unit}</div><div class="l">${label}</div></div>`;
    const statsHtml = st
        ? `
            <div class="mgrid mgrid-3">
                ${cell('試合', p.gp)}
                ${cell('出場時間', fmt1(st[0]))}
                ${cell('FPTS', fmt1(p.fpg))}
            </div>
            <div class="mgrid mgrid-6">
                ${cell('PTS', fmt1(st[1]))}${cell('REB', fmt1(st[2]))}${cell('AST', fmt1(st[3]))}
                ${cell('STL', fmt1(st[4]))}${cell('BLK', fmt1(st[5]))}${cell('TO', fmt1(st[6]))}
            </div>
            <div class="mgrid mgrid-4">
                ${cell('FG%', fmt1(st[7]))}${cell('3PM', fmt1(st[8]))}${cell('3P%', fmt1(st[9]))}${cell('FT%', fmt1(st[10]))}
            </div>`
        : `<div class="msg">${season} シーズンの出場記録がありません</div>`;

    const inRoster = state.pending.some(x => x.id === id);
    let action = '';
    if (inRoster) {
        action = `<button class="btn danger block" data-remove="${esc(id)}">ロスターから外す</button>`;
    } else if (p) {
        const reason = canAdd(p);
        action = reason
            ? `<button class="btn block" disabled>${esc(reason)}</button>`
            : `<button class="btn primary block" data-add="${esc(id)}">ロスターに追加（$${p.price}）</button>`;
    }

    document.getElementById('modal-body').innerHTML = `
        <div class="mhead">
            <img class="mphoto" src="${headshot(esc(id))}" alt="" onerror="this.style.visibility='hidden'">
            <div class="mhead-body">
                <div class="mname">${esc(meta.name)}</div>
                <div class="mmeta">${esc(abbr(meta.team))}${p?.pos ? ` · ${esc(p.pos)}` : ''}${injTag(p?.inj)}</div>
            </div>
            <div class="mprice">$${meta.price}</div>
        </div>
        <div class="msection">${season} シーズン平均</div>
        ${statsHtml}
        <div class="maction">${action}</div>`;
    const m = document.getElementById('modal');
    m.hidden = false;
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => m.classList.add('open'));
}

function closePlayer() {
    const m = document.getElementById('modal');
    m.classList.remove('open');
    document.body.classList.remove('modal-open');
    setTimeout(() => { m.hidden = true; }, 200);
}

/* ─── 画面制御 ─── */
let activeView = 'week';

function showView(name) {
    activeView = name;
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
    window.scrollTo(0, 0);
    renderActive();
}

async function renderActive() {
    if (!curWk) return;  // 初回の同期に失敗している
    try {
        if (activeView === 'week')     await renderWeek();
        if (activeView === 'team')     await renderTeam();
        if (activeView === 'history')  renderHistory();
        if (activeView === 'settings') renderSettings();
    } catch (e) {
        console.error(e);
        document.getElementById(`view-${activeView}`).innerHTML = `<div class="msg error">表示に失敗しました<br>${esc(e.message)}</div>`;
    }
}

function renderHeader() {
    const locked = !!state.weeks[curWk];
    const info = weekInfo[curWk];
    let sub = `${SEASON_YEAR - 1}-${String(SEASON_YEAR).slice(2)} · 今週 ${fmtWeek(curWk)}`;
    if (!locked && info?.lockAt) sub += ` · ロック ${fmtJst(info.lockAt)}`;
    document.getElementById('header-sub').textContent = sub;
}

let refreshing = false;
async function refresh(forcePool = false) {
    if (refreshing) return;
    refreshing = true;
    const btn = document.getElementById('refresh-btn');
    btn.classList.add('spinning');
    try {
        await sync(forcePool);
        renderHeader();
        await renderActive();
    } catch (e) {
        console.error(e);
        document.getElementById(`view-${activeView}`).innerHTML =
            `<div class="msg error">データの取得に失敗しました<br>${esc(e.message)}</div>`;
    } finally {
        btn.classList.remove('spinning');
        refreshing = false;
    }
}

document.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) { closePlayer(); return; }
    const t = e.target.closest('[data-view],[data-goto],[data-add],[data-remove],[data-player]');
    if (!t) return;
    const inModal = !!t.closest('#modal');
    if (t.dataset.view)   showView(t.dataset.view);
    if (t.dataset.goto)   showView(t.dataset.goto);
    if (t.dataset.add)    addPlayer(t.dataset.add);
    if (t.dataset.remove) removePlayer(t.dataset.remove);
    if (t.dataset.player) openPlayer(t.dataset.player);
    if (inModal && (t.dataset.add || t.dataset.remove)) closePlayer();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePlayer(); });
document.getElementById('refresh-btn').addEventListener('click', () => refresh());
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastSync > 60e3) refresh();
});

refresh();
