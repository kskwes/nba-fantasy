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
const BOX_KEYS  = [...STAT_KEYS, 'MIN'];  // ボックススコアのキャッシュに残す項目（MIN は直近成績の表示用）
const STARTER_IX = BOX_KEYS.length;       // キャッシュの各行の最後に、先発なら 1 を付ける
const RECENT_DAYS = 7;                    // 直近成績の集計期間（今日を含む日数）

const API = {
    SCOREBOARD: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
    SUMMARY:    'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary',
    TEAMS:      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams',
    BY_ATHLETE: 'https://site.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete',
    STANDINGS:  'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings',
};
// 選手ページ・試合ページは nba/ のサイトのものを開く（このアプリからデータは読まない）
const NBA_SITE = {
    player: id => `../players/player.html?id=${encodeURIComponent(id)}`,
    game:   id => `../games/game.html?id=${encodeURIComponent(id)}`,
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
    days:  'nbaf.days.v2',   // v2: ホームのチームと試合の進み具合を追加
    boxes: 'nbaf.boxes.v3',  // v2: 出場時間(MIN)と試合開始時刻を追加 / v3: 先発かどうかを追加
    season: 'nbaf.season.v1', // 今季の成績と、相手チームの失点（編成の参考）
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
// 試合開始時刻（ISO）→ 日本時間の「月/日」
function fmtJstMd(iso) {
    return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).format(new Date(iso));
}
function jstYmd(date) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(date).replace(/-/g, '');
}
function fmtJstTime(iso) {
    return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
// ロックまでの残り時間: 「3日 21時間」「5時間 12分」
function fmtLeft(iso) {
    const m = Math.max(0, Math.floor((new Date(iso) - Date.now()) / 60e3));
    const d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60);
    return d ? `${d}日 ${h}時間` : `${h}時間 ${m % 60}分`;
}
function fmtJst(iso) {
    return new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));
}

/* ─── statistics/byathlete の読み取り ─── */
function athleteGetter(d) {
    const idx = {};
    for (const cat of d.categories || []) {
        idx[cat.name] = {};
        (cat.names || []).forEach((n, i) => { idx[cat.name][n] = i; });
    }
    return (a, catName, statName) => {
        const cat = (a.categories || []).find(x => x.name === catName);
        const i = idx[catName]?.[statName];
        return cat && i != null ? (cat.values?.[i] ?? 0) : 0;
    };
}
// 1試合平均の [PTS, REB, AST, STL, BLK, TO]
function avgLine(get, a) {
    return [
        get(a, 'offensive', 'avgPoints'),
        get(a, 'general',   'avgRebounds'),
        get(a, 'offensive', 'avgAssists'),
        get(a, 'defensive', 'avgSteals'),
        get(a, 'defensive', 'avgBlocks'),
        get(a, 'offensive', 'avgTurnovers'),
    ];
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

    const get = athleteGetter(stats.value);
    const prev = {};
    for (const a of stats.value.athletes || []) {
        const line = avgLine(get, a);
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
                    home:  String((comp.competitors || []).find(x => x.homeAway === 'home')?.team?.id || ''),
                    detail: comp.status?.type?.shortDetail || '',  // 試合中の「6:12 - 3rd」など
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
                const ix = BOX_KEYS.map(k => labels.indexOf(k));
                for (const a of st.athletes || []) {
                    if (a.didNotPlay || !a.stats?.length) continue;
                    p[String(a.athlete?.id)] = [...ix.map(i => (i >= 0 ? parseFloat(a.stats[i]) || 0 : 0)), a.starter ? 1 : 0];
                }
            }
        }
        boxCache[ev.id] = { ts: Date.now(), start: ev.start, final: ev.state === 'post', p };
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
        days: perDay,   // 月〜日の曜日ごとの試合
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
            // 保存する line は従来どおり STAT_KEYS の6項目だけ（state の形式を変えない）
            (games[id] ||= []).push({ f: round1(fpts(line)), line: line.slice(0, STAT_KEYS.length), start: e.start, live: e.state === 'in', name: e.name });
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
        // ボックススコアは直近成績でも使うので、ここでは消さない（古いものは pruneBoxes で消す）
    }
    return res;
}

// 直近成績の期間より古いボックススコアをキャッシュから消す
function pruneBoxes() {
    const limit = Date.now() - (RECENT_DAYS + 2) * 86400e3;
    let changed = false;
    for (const [id, b] of Object.entries(boxCache)) {
        if (!b.start || new Date(b.start).getTime() < limit) {
            delete boxCache[id];
            changed = true;
        }
    }
    if (changed) save(KEYS.boxes, boxCache);
}

/* ─── 直近成績（直近7日の終了した試合のボックススコアから集計） ─── */
let recent        = null;    // { days, byTeam, boxes, failed, ts }（メモリ上のみ）
let recentStats   = {};      // athleteId → { gp, teamG, fpg, min, avg, value }
let recentStatus  = 'idle';  // idle / loading / ok / error
let recentPromise = null;

// 同時に投げるリクエスト数を抑えて順に処理する
async function mapLimit(items, limit, fn) {
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function loadRecent() {
    const today = etYmd(new Date());
    const days = Array.from({ length: RECENT_DAYS }, (_, i) => addDays(today, i - RECENT_DAYS + 1));
    let failed = 0;
    const perDay = await Promise.all(days.map(d =>
        fetchDay(d)
            .then(evs => evs.map(e => ({ ...e, ymd: d })))
            .catch(() => { failed++; return []; })));
    if (failed === days.length) throw new Error('日程の取得に失敗しました');

    const events = perDay.flat().filter(e => e.state === 'post');  // 試合中の途中経過は含めない
    const boxes = {};
    await mapLimit(events, 6, async e => {
        const b = await fetchBox(e);
        if (b) boxes[e.id] = b;
        else failed++;
    });
    const byTeam = {};  // teamId → 取得できた試合（古い順）
    events
        .filter(e => boxes[e.id])
        .sort((a, b) => new Date(a.start) - new Date(b.start))
        .forEach(e => e.teams.forEach(t => (byTeam[t] ||= []).push(e)));
    pruneBoxes();
    return { days, byTeam, boxes, failed, ts: Date.now() };
}

// 直近成績を用意する（10分以内に集計済みならそのまま使う）
function ensureRecent() {
    if (recent && Date.now() - recent.ts < 10 * 60e3) return Promise.resolve(recent);
    if (!recentPromise) {
        if (!recent) recentStatus = 'loading';
        recentPromise = loadRecent()
            .then(r => {
                recent = r;
                recentStats = calcRecentStats();
                recentStatus = 'ok';
            })
            .catch(e => {
                console.error(e);
                if (!recent) recentStatus = 'error';
            })
            .finally(() => { recentPromise = null; });
    }
    return recentPromise;
}

// 選手のチームの直近の試合と、各試合の成績（出場していなければ dnp）
function recentGames(p) {
    if (!recent) return [];
    return (recent.byTeam[p.teamId] || []).map(e => {
        const line = recent.boxes[e.id][p.id];
        return line ? { e, line, f: fpts(line), min: line[6] || 0 } : { e, dnp: true };
    });
}

function calcRecentStats() {
    const out = {};
    for (const p of pool) {
        const games = recentGames(p);
        const played = games.filter(g => !g.dnp);
        const n = played.length;
        const avg = k => sum(played.map(g => g.line[k] || 0)) / n;
        const fpg = n ? sum(played.map(g => g.f)) / n : null;
        out[p.id] = {
            gp:    n,
            teamG: games.length,
            fpg,
            min:   n ? avg(6) : 0,
            avg:   n ? STAT_KEYS.map((_, k) => avg(k)) : null,
            value: fpg == null ? null : fpg - p.price,  // 割安度
        };
    }
    return out;
}

/* ─── 今季の成績と相手チームの失点（編成・見込みの参考。値段には使わない） ─── */
let season = load(KEYS.season, null);  // { ts, year, stats: { athleteId: { fpg, gp, min } }, opp: { teamId: 'hard' | 'easy' } }
let seasonPromise = null;
const OPP_EDGE = 8;  // 失点の少ない8チームを「守備が強い」、多い8チームを「弱い」とする

function ensureSeason() {
    if (season?.year === SEASON_YEAR && Date.now() - season.ts < 3 * 3600e3) return Promise.resolve(season);
    if (!seasonPromise) {
        seasonPromise = (async () => {
            const [st, sd] = await Promise.allSettled([
                fetchJson(`${API.BY_ATHLETE}?season=${SEASON_YEAR}&seasontype=2&limit=1000&qualified=false&sort=offensive.avgPoints:desc`),
                fetchJson(API.STANDINGS),
            ]);
            if (st.status !== 'fulfilled') throw st.reason;
            const get = athleteGetter(st.value);
            const stats = {};
            for (const a of st.value.athletes || []) {
                const gp = get(a, 'general', 'gamesPlayed');
                if (gp) stats[String(a.athlete?.id)] = { fpg: round1(fpts(avgLine(get, a))), gp, min: round1(get(a, 'general', 'avgMinutes')) };
            }
            // 1試合平均の失点の順位（取れなければ前回の値を使う）
            let opp = season?.opp || {};
            if (sd.status === 'fulfilled') {
                const rows = (sd.value.children || []).flatMap(c => c.standings?.entries || [])
                    .map(e => ({ id: String(e.team?.id), v: e.stats?.find(x => x.name === 'avgPointsAgainst')?.value }))
                    .filter(r => r.v != null)
                    .sort((a, b) => a.v - b.v);
                if (rows.length === 30) {
                    opp = {};
                    rows.forEach((r, i) => { if (i < OPP_EDGE) opp[r.id] = 'hard'; else if (i >= 30 - OPP_EDGE) opp[r.id] = 'easy'; });
                }
            }
            season = { ts: Date.now(), year: SEASON_YEAR, stats, opp };
            save(KEYS.season, season);
            return season;
        })()
            .catch(e => { console.warn('season stats:', e); return season; })
            .finally(() => { seasonPromise = null; });
    }
    return seasonPromise;
}

const seasonOf = id => (season?.year === SEASON_YEAR ? season.stats[id] : null) || null;

// 1試合あたりの見込み: 今季3試合以上 → 今季平均、なければ直近7日、なければ前季（値段の元）
function expectFpg(id) {
    const s = seasonOf(id);
    if (s?.gp >= 3) return s.fpg;
    if (recentStats[id]?.fpg != null) return recentStats[id].fpg;
    const p = poolById[id];
    return p?.fpg ?? p?.price ?? 0;
}

/* ─── 試合の相手 ─── */
let teamAbbrById = {};  // teamId → 略称（選手プールから作る）
// 「BOS」（ホーム）/「@BOS」（アウェー）
function oppLabel(e, teamId) {
    const o = e.teams.find(t => t !== teamId);
    const a = teamAbbrById[o] || '?';
    return e.home && e.home !== teamId ? `@${a}` : a;
}
// 「vs BOS」/「@ BOS」
function vsLabel(e, teamId) {
    const o = e.teams.find(t => t !== teamId);
    return `${e.home && e.home !== teamId ? '@' : 'vs'} ${teamAbbrById[o] || '?'}`;
}
const oppStrength = (e, teamId) => season?.opp?.[e.teams.find(t => t !== teamId)] || '';

// 週の曜日ごとに、そのチームの試合（なければ null）
function teamDays(info, teamId) {
    return (info?.days || []).map(evs => evs.find(e => e.teams.includes(teamId)) || null);
}
const hasB2B = days => days.some((e, i) => e && days[i + 1]);

// 起動時・復帰時に呼ぶ: 未処理の週をロックし、終わった週を確定させる
async function sync(forcePool = false) {
    pool = await loadPool(forcePool);
    poolById = Object.fromEntries(pool.map(p => [p.id, p]));
    teamAbbrById = Object.fromEntries(pool.map(p => [p.teamId, p.team]));
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
    pruneBoxes();
    if (recent) recentStats = calcRecentStats();  // 選手データを取り直したときの移籍に追従
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

function swapsUsed(list = state.pending) {
    const base = swapBase();
    if (!base) return 0;
    const baseIds = new Set(base.map(p => p.id));
    return list.filter(p => !baseIds.has(p.id)).length;
}

function pendingCost(list = state.pending) { return sum(list.map(p => p.price)); }

// list: 判定するロスター（入れ替え候補では、外す選手を除いたロスター）
function canAdd(p, list = state.pending) {
    if (list.some(x => x.id === p.id)) return '登録済み';
    if (list.length >= CONFIG.ROSTER_SIZE) return '枠がいっぱい';
    if (pendingCost(list) + p.price > CONFIG.BUDGET) return '予算オーバー';
    const base = swapBase();
    if (base && !base.some(x => x.id === p.id) && swapsUsed(list) >= CONFIG.MAX_SWAPS) return '入れ替え上限';
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

// ロスターの1人を別の選手に入れ替える（同じ位置に入れる）
function swapPlayer(outId, inId) {
    ensureLockBeforeEdit();
    const out = state.pending.find(x => x.id === outId);
    const p = poolById[inId];
    if (!out || !p) return;
    const rest = state.pending.filter(x => x.id !== outId);
    const reason = canAdd(p, rest);
    if (reason) { toast(reason); return; }
    state.pending = state.pending.map(x => (x.id === outId ? toMeta(p) : x));
    saveState();
    toast(`${out.name} → ${p.name}`);
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

// 割安度などの差分: +5.2 / −3.1 / ±0.0
function signed(x) {
    const v = Math.round(x * 10) / 10;
    return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}`;
}

// 割安度の色分け（差が3点未満は「ほぼ値段どおり」）
function valClass(v) {
    if (v == null) return 'flat';
    return v >= 3 ? 'up' : v <= -3 ? 'down' : 'flat';
}

// 編成を適用する週の試合数（2試合以下は外す候補として赤字）
function wkGamesTag(n, label) {
    return `${label} <span class="wk ${n <= 2 ? 'low' : ''}">${n}試合</span>`;
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
const DOW = ['月', '火', '水', '木', '金', '土', '日'];

// 自分の選手の今週の様子: 曜日ごとのマス・状態・週末までの見込みの上乗せ
function weekView(p, info) {
    const teamId = poolById[p.id]?.teamId || p.teamId;
    const inj = poolById[p.id]?.inj || '';
    const out = inj === 'Out';
    const todayJst = jstYmd(new Date());
    const avg = expectFpg(p.id);
    let extra = 0;
    const cells = teamDays(info, teamId).map(e => {
        if (!e) return '<div class="c none">·</div>';
        if (e.state === 'pre') {
            if (!out) extra += avg;
            const today = jstYmd(new Date(e.start)) === todayJst;
            return `<div class="c todo ${today ? 'today' : ''}">${esc(oppLabel(e, teamId))}</div>`;
        }
        const box = boxCache[e.id];
        const line = box?.p?.[p.id];
        if (e.state === 'in') {
            const f = line ? fpts(line) : 0;
            extra += Math.max(0, avg - f);   // 試合中は、平均に届くまでを見込む
            return `<div class="c live">${line ? fmt1(f) : '−'}</div>`;
        }
        if (!box) return '<div class="c">?</div>';
        if (!line) return '<div class="c dnp">欠</div>';
        const f = fpts(line);
        return `<div class="c ${valClass(f - p.price)}">${Math.round(f)}</div>`;
    });

    // 状態の1行
    const days = teamDays(info, teamId);
    const live = days.find(e => e?.state === 'in');
    const next = days.find(e => e?.state === 'pre');
    let status;
    if (live) status = { kind: 'live', text: `<span class="dot"></span>試合中 ${esc(live.detail)} ${esc(vsLabel(live, teamId))}`, game: live };
    else if (out) status = { kind: 'out', text: '欠場中（OUT）' };
    else if (!next) status = { kind: 'done', text: '今週の試合は終了' };
    else if (jstYmd(new Date(next.start)) === todayJst) status = { kind: 'today', text: `今日 ${fmtJstTime(next.start)} ${esc(vsLabel(next, teamId))}`, game: next };
    else status = { kind: 'idle', text: `次 ${fmtJst(next.start)} ${esc(vsLabel(next, teamId))}` };
    return { cells, status, extra };
}

const WEEK_GROUPS = [['live', '試合中'], ['today', '今日の試合'], ['idle', 'このあと'], ['out', '欠場中'], ['done', '今週の試合は終了']];

function myWeekRows(players, info) {
    const todayIx = weekDays(info.wk).indexOf(etYmd(new Date()));
    const head = DOW.map((d, i) => `<div class="d ${i === todayIx ? 'today' : ''}">${d}</div>`).join('');
    const rows = players.map(p => ({ p, v: weekView(p, info) }));
    const html = WEEK_GROUPS.map(([kind, label]) => {
        const list = rows.filter(r => r.v.status.kind === kind).sort((a, b) => b.p.total - a.p.total);
        if (!list.length) return '';
        return `<div class="grp">${label}<span class="n">${list.length}</span></div>` + list.map(({ p, v }) => {
            const played = p.games.length;
            return `
                <div class="prow top trow" data-player="${esc(p.id)}">
                    ${photoImg(p.id)}
                    <div class="pbody">
                        <div class="pname">${esc(p.name)}${injTag(poolById[p.id]?.inj)}</div>
                        <div class="pmeta">${esc(abbr(poolById[p.id]?.team || p.team))} · $${p.price} · ${played}/${p.sched || played}試合</div>
                        <div class="status ${v.status.kind}">${v.status.text}</div>
                    </div>
                    <div class="pright"><div class="ptotal">${fmt1(p.total)}</div><div class="ptotal-sub">平均 ${played ? fmt1(p.total / played) : '−'}</div></div>
                    <div class="wk7">${head}${v.cells.join('')}</div>
                </div>`;
        }).join('');
    }).join('');
    const extra = sum(rows.map(r => r.v.extra));
    return { html, extra };
}

async function renderWeek() {
    const el = document.getElementById('view-week');
    const info = weekInfo[curWk];
    const w = state.weeks[curWk];

    if (!w) {
        let html = `<div class="card"><div class="card-title">今週 ${fmtWeek(curWk)}（現地）</div>`;
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

    const [res] = await Promise.all([scoreWeek(curWk, info), ensureSeason()]);
    const mine = myWeekRows(res.my.players, info);
    const projected = res.my.total + mine.extra;
    const projTier = [...res.targets].reverse().find(t => projected >= t.score);
    const nextTier = res.targets.find(t => res.my.total < t.score);
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
            ${res.final ? '' : `<div class="proj"><span>週末の見込み<b>${fmt1(projected)}</b></span><span class="${projTier ? 'up' : ''}">${projTier ? `${projTier.label} に届くペース` : '目標に届かないペース'}</span></div>`}
        </div>
        <div class="card">
            <div class="card-title">目標スコア ${tierBadge(res.tier)}${nextTier && !res.final ? ` <span class="card-aside">${nextTier.label} まであと ${fmt1(nextTier.score - res.my.total)}</span>` : ''}</div>
            ${targetBar(res.my.total, res.targets)}
        </div>
        <div class="card">
            <div class="card-title">自分のチーム</div>
            <div class="plist">${mine.html}</div>
            <div class="legend7"><span class="l-up">値段より +3 以上</span><span class="l-down">値段より −3 以下</span><span class="l-dnp">欠場</span><span class="l-todo">これからの試合（相手）</span></div>
            <p class="note" style="margin-top:6px">見込みは、残りの試合 × 1試合の見込み（今季平均。今季3試合未満は直近7日か前季）。欠場中（OUT）の選手は数えません。</p>
        </div>
        <div class="card">
            <details class="cpu">
                <summary>CPUチームを見る（$${sum(w.cpu.map(p => p.price))}）</summary>
                <div class="plist">${scoredRows(res.cpu.players)}</div>
            </details>
        </div>`;
}

/* ─── 編成タブ ─── */
const search = { q: '', team: '', pos: '', sort: 'proj' };
const POSITIONS = [['G', 'ガード'], ['F', 'フォワード'], ['C', 'センター']];
const SORTS = [
    ['proj', '見込み'], ['season', '今季FPTS'], ['value', '今季の割安度'], ['recent', '直近7日'],
    ['games', '試合数'], ['price-desc', '価格 高い順'], ['price-asc', '価格 安い順'],
];
let teamCtx = null;  // 編成タブの描画に使う { gamesOf, wkLabel, info }

// 編成を適用する週の見込み（1試合の見込み × 試合数）
const projOf = p => expectFpg(p.id) * teamCtx.gamesOf(poolById[p.id]?.teamId || p.teamId);

// 直近の試合で先発したか（直近の成績がまだなければ空）
function startTag(p) {
    const g = recentGames(p).filter(x => !x.dnp).pop();
    if (!g || g.line[STARTER_IX] == null) return '';
    return g.line[STARTER_IX] ? '<span class="tag start">先発</span>' : '<span class="tag">控え</span>';
}

// 今季・直近・出場時間の1行
function statsLine(p) {
    const s = seasonOf(p.id);
    const r = recentStats[p.id];
    const v = s ? s.fpg - p.price : null;
    let recentHtml = '<span>直近 <b>…</b></span>';
    if (recentStatus === 'error') recentHtml = '<span>直近 取得できませんでした</span>';
    else if (recentStatus === 'ok') {
        const gp = r?.teamG && r.gp < r.teamG ? ` <span class="gp low">出場${r.gp}/${r.teamG}</span>` : '';
        recentHtml = `<span>直近 <b>${r?.fpg != null ? fmt1(r.fpg) : '−'}</b>${gp}</span>`;
    }
    // 出場時間: 直近7日の平均が今季平均より2.5分以上多い/少ないときに矢印
    let trend = '';
    if (s?.gp >= 3 && r?.gp) trend = r.min - s.min >= 2.5 ? ' <span class="up">↑</span>' : r.min - s.min <= -2.5 ? ' <span class="down">↓</span>' : '';
    return `
        <div class="kv">
            <span>今季 <b>${s ? fmt1(s.fpg) : '−'}</b>${v != null ? ` <span class="val ${valClass(v)}">${signed(v)}</span>` : ''}</span>
            ${recentHtml}
            <span>MIN <b>${s ? fmt1(s.min) : '−'}</b>${trend}</span>
        </div>`;
}

// 編成を適用する週の、曜日ごとの相手（下線は相手の失点の少なさ）
function schedStrip(teamId) {
    return `<div class="sched">${teamDays(teamCtx.info, teamId).map((e, i) => e
        ? `<div class="s g ${oppStrength(e, teamId)}"><span class="w">${DOW[i]}</span>${esc(oppLabel(e, teamId))}</div>`
        : `<div class="s"><span class="w">${DOW[i]}</span>·</div>`).join('')}</div>`;
}

// 編成タブの選手の行（ロスター・検索結果・入れ替え候補で共通）
function teamRow(p, { badge = '', right = '', action = '' } = {}) {
    const pp = poolById[p.id] || p;
    const n = teamCtx.gamesOf(pp.teamId);
    const b2b = hasB2B(teamDays(teamCtx.info, pp.teamId));
    return `
        <div class="prow top trow" data-player="${esc(p.id)}">
            ${photoImg(p.id)}
            <div class="pbody">
                <div class="pname">${esc(p.name)}${badge}${injTag(pp.inj)}</div>
                <div class="pmeta">${esc(abbr(pp.team))}${pp.pos ? ` ${esc(pp.pos)}` : ''} · ${wkGamesTag(n, teamCtx.wkLabel)} ${startTag(pp)}${b2b ? '<span class="tag b2b">連戦</span>' : ''}</div>
                ${statsLine(p)}
            </div>
            <div class="pright">
                <div class="ptotal">$${p.price}</div>
                <div class="proj-chip">見込 ${fmt1(projOf(p))}</div>
                <div class="pbtns">${right}${action}</div>
            </div>
            ${schedStrip(pp.teamId)}
        </div>`;
}

function rosterRows() {
    const base = swapBase();
    const baseIds = new Set((base || []).map(p => p.id));
    const slots = state.pending.map(p => teamRow(p, {
        badge: base && !baseIds.has(p.id) ? ' <span class="badge accent">NEW</span>' : '',
        right: `<button class="swap-btn" data-swap="${esc(p.id)}">入替</button>`,
        action: `<button class="icon-btn" data-remove="${esc(p.id)}" aria-label="外す">×</button>`,
    }));
    for (let i = state.pending.length; i < CONFIG.ROSTER_SIZE; i++) slots.push('<div class="empty-slot">空き枠</div>');
    return slots.join('');
}

const rosterProjHtml = () => `見込み <b>${fmt1(sum(state.pending.map(projOf)))}</b>`;

async function renderTeam() {
    const el = document.getElementById('view-team');
    const tInfo = await pendingTargetWeek().catch(() => null);
    const targetWk = tInfo?.wk || curWk;
    const gamesOf = teamId => tInfo?.teamGames[teamId] ?? 0;
    const wkLabel = targetWk === curWk ? '今週' : targetWk === addDays(curWk, 7) ? '来週' : `${fmtMd(targetWk)}〜の週`;
    teamCtx = { gamesOf, wkLabel, info: tInfo };

    const cost = pendingCost();
    const base = swapBase();
    const swapsLeft = base ? CONFIG.MAX_SWAPS - swapsUsed() : null;
    const lockLeft = tInfo?.lockAt && !isLocked(tInfo) ? fmtLeft(tInfo.lockAt) : '';

    const teams = [...new Set(pool.map(p => p.team))].sort();
    el.innerHTML = `
        <div class="card budget-sticky">
            <div class="stats-row">
                <div class="stat-box"><div class="v ${cost > CONFIG.BUDGET ? 'over' : ''}">$${CONFIG.BUDGET - cost}</div><div class="l">残り予算</div></div>
                <div class="stat-box"><div class="v">${state.pending.length}/${CONFIG.ROSTER_SIZE}</div><div class="l">人数</div></div>
                <div class="stat-box"><div class="v">${swapsLeft == null ? '自由' : swapsLeft}</div><div class="l">入れ替え残り</div></div>
            </div>
            <div class="budget-line">
                <span>${fmtWeek(targetWk)} の週${lockLeft ? ` · ロックまで <b class="left">${lockLeft}</b>` : ''}</span>
                <span id="roster-proj">${rosterProjHtml()}</span>
            </div>
            ${state.pending.length < CONFIG.ROSTER_SIZE ? `<p class="warn">${CONFIG.ROSTER_SIZE}人そろっていないと、その分の得点が入りません</p>` : ''}
        </div>
        <div class="card">
            <div class="card-title">ロスター</div>
            <div class="plist" id="roster-list">${rosterRows()}</div>
        </div>
        <div class="card">
            <div class="card-title">選手を探す <span class="card-aside">試合数は ${fmtWeek(targetWk)}</span></div>
            <div class="search-controls">
                <input type="search" id="s-q" placeholder="選手名で検索" value="${esc(search.q)}" autocomplete="off">
                <div class="seg" id="s-pos">
                    ${[['', '全て'], ...POSITIONS].map(([v, l]) => `<button class="${v === search.pos ? 'active' : ''}" data-pos="${v}">${v ? `${v}<small>${l}</small>` : l}</button>`).join('')}
                </div>
                <select id="s-team">
                    <option value="">全チーム</option>
                    ${teams.map(t => `<option value="${esc(t)}" ${t === search.team ? 'selected' : ''}>${esc(t)}</option>`).join('')}
                </select>
            </div>
            <div class="chips" id="s-sort">
                ${SORTS.map(([k, l]) => `<button class="${k === search.sort ? 'active' : ''}" data-sort="${k}">${l}</button>`).join('')}
            </div>
            <div class="plist" id="s-results"></div>
            <p class="note" style="margin-top:8px">見込み = 1試合の見込み（今季平均。今季3試合未満は直近7日か前季）× 試合数。日程の下線は相手の1試合平均の失点で、赤は失点の少ない8チーム、緑は多い8チーム。</p>
        </div>`;

    renderSearchResults();
    document.getElementById('s-q').addEventListener('input', e => { search.q = e.target.value; renderSearchResults(); });
    document.getElementById('s-team').addEventListener('change', e => { search.team = e.target.value; renderSearchResults(); });
    document.getElementById('s-pos').addEventListener('click', e => {
        const b = e.target.closest('[data-pos]');
        if (!b) return;
        search.pos = b.dataset.pos;
        document.querySelectorAll('#s-pos button').forEach(x => x.classList.toggle('active', x === b));
        renderSearchResults();
    });
    document.getElementById('s-sort').addEventListener('click', e => {
        const b = e.target.closest('[data-sort]');
        if (!b) return;
        search.sort = b.dataset.sort;
        document.querySelectorAll('#s-sort button').forEach(x => x.classList.toggle('active', x === b));
        renderSearchResults();
    });

    // 直近・今季の成績は後から読み込み、行の中身だけ差し替える（入力中の検索欄を消さないため）
    const ctx = teamCtx;
    Promise.all([ensureRecent(), ensureSeason()]).then(() => {
        if (activeView !== 'team' || teamCtx !== ctx) return;
        document.getElementById('roster-list').innerHTML = rosterRows();
        document.getElementById('roster-proj').innerHTML = rosterProjHtml();
        renderSearchResults();
    });
}

// 値がない選手は、並び替えで最後に回す
const desc = f => (a, b) => (f(b) ?? -Infinity) - (f(a) ?? -Infinity) || b.price - a.price;

function renderSearchResults() {
    const q = search.q.trim().toLowerCase();
    let list = pool.filter(p =>
        (!q || p.name.toLowerCase().includes(q)) && (!search.team || p.team === search.team) && (!search.pos || p.pos === search.pos));
    const cmp = {
        'proj':       desc(projOf),
        'season':     desc(p => seasonOf(p.id)?.fpg),
        'value':      desc(p => (seasonOf(p.id) ? seasonOf(p.id).fpg - p.price : null)),
        'recent':     desc(p => recentStats[p.id]?.fpg),
        'games':      desc(p => teamCtx.gamesOf(p.teamId) + projOf(p) / 1e4),
        'price-desc': (a, b) => b.price - a.price,
        'price-asc':  (a, b) => a.price - b.price,
    }[search.sort];
    list.sort(cmp);
    const shown = list.slice(0, 60);
    const el = document.getElementById('s-results');
    if (!el) return;
    if (!shown.length) { el.innerHTML = '<div class="msg">該当なし</div>'; return; }
    el.innerHTML = shown.map(p => {
        const reason = canAdd(p);
        return teamRow(p, {
            action: `<button class="icon-btn add" data-add="${esc(p.id)}" ${reason ? 'disabled' : ''} aria-label="追加">＋</button>`,
        }).replace('<div class="pbtns">', reason ? `<div class="reason">${esc(reason)}</div><div class="pbtns">` : '<div class="pbtns">');
    }).join('') + (list.length > shown.length ? `<div class="note more">ほか ${list.length - shown.length} 人（検索で絞り込んでください）</div>` : '');
}

// 入れ替え候補: その選手を外したときに入れられる選手を、見込みの高い順に
function openSwap(outId) {
    const out = state.pending.find(x => x.id === outId);
    if (!out || !teamCtx) return;
    const rest = state.pending.filter(x => x.id !== outId);
    const outProj = projOf(out);
    const cands = pool.filter(p => !canAdd(p, rest)).sort(desc(projOf)).slice(0, 30);
    openSheet(`
        <div class="sh-title">${esc(out.name)} と入れ替え</div>
        <div class="sh-sub">外すと予算 $${CONFIG.BUDGET - pendingCost(rest)} まで · ${esc(out.name)} の見込み ${fmt1(outProj)}</div>
        <div class="plist">${cands.map(p => {
            const d = projOf(p) - outProj;
            return teamRow(p, {
                right: `<div class="diff ${d >= 0 ? 'up' : 'down'}"><small>差 </small>${d >= 0 ? '+' : ''}${fmt1(d)}</div>`,
                action: `<button class="icon-btn add" data-swapin="${esc(p.id)}" data-swapout="${esc(outId)}" aria-label="入れ替える">⇄</button>`,
            });
        }).join('') || '<div class="msg">入れられる選手がいません</div>'}</div>`);
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
                <button class="btn" id="btn-update">アプリを更新</button>
                <button class="btn" id="btn-reload">選手データを再取得</button>
                <button class="btn danger" id="btn-reset">すべてリセット</button>
            </div>
        </div>
        <p class="note center">v${esc(APP_VERSION)}${latestVersion && latestVersion !== APP_VERSION ? `（最新 v${esc(latestVersion)}）` : ''} · データ: ESPN</p>`;

    document.getElementById('btn-export').onclick = exportData;
    document.getElementById('btn-import').onclick = () => document.getElementById('file-import').click();
    document.getElementById('file-import').onchange = importData;
    document.getElementById('btn-update').onclick = hardReload;
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

/* ─── 選手モーダル（直近成績・前季スタッツ） ─── */
let modalPlayerId = null;

// 直近7日の平均と試合ごとの一覧
function recentSectionHtml(p) {
    const range = recent ? ` · 現地 ${fmtMd(recent.days[0])}〜${fmtMd(recent.days[recent.days.length - 1])}` : '';
    const head = aside => `<div class="msection"><span>直近${RECENT_DAYS}日${range}</span>${aside ? `<b>${aside}</b>` : ''}</div>`;
    if (recentStatus === 'error') return `${head()}<div class="note">直近の成績を取得できませんでした。時間をおいて更新してください。</div>`;
    if (!recent) return `${head()}<div class="note">読み込み中…</div>`;

    const r = recentStats[p.id];
    const games = recentGames(p);
    const failedNote = recent.failed ? `<div class="note">一部の試合を取得できなかったため、取得できた試合だけで計算しています。</div>` : '';
    if (!games.length) return `${head()}<div class="note">この期間にチームの試合がありません。</div>${failedNote}`;

    const cell = (label, v, cls = '') => `<div class="mstat"><div class="v ${cls}">${v}</div><div class="l">${label}</div></div>`;
    const summary = r?.fpg != null
        ? `
            <div class="mgrid mgrid-3">
                ${cell('平均MIN', fmt1(r.min))}
                ${cell('FPTS', fmt1(r.fpg))}
                ${cell('割安度', signed(r.value), valClass(r.value) === 'flat' ? '' : valClass(r.value))}
            </div>
            <div class="mgrid mgrid-6">
                ${STAT_KEYS.map((k, i) => cell(k, fmt1(r.avg[i]))).join('')}
            </div>`
        : '<div class="note">この期間は出場していません。</div>';

    // 棒の長さは FPTS、黄色い線は値段の位置
    const max = Math.max(p.price * 1.6, ...games.map(g => g.f || 0), 10);
    const pct = v => `${Math.min(100, Math.max(0, v) / max * 100).toFixed(1)}%`;
    const labels = ['点', 'リバ', 'アシ', 'スティ', 'ブロ', 'TO'];
    const rows = [...games].reverse().map(g => {
        if (g.dnp) {
            return `
                <div class="grow dnp">
                    <span class="d">${fmtJstMd(g.e.start)}</span>
                    <span class="m"><div class="opp">${esc(g.e.name)}<small>出場なし</small></div></span>
                    <span class="f">−</span>
                </div>`;
        }
        const parts = STAT_KEYS.map((_, k) => (g.line[k] ? `${g.line[k]}${labels[k]}` : '')).filter(Boolean).join(' ');
        const cls = valClass(g.f - p.price);
        return `
            <div class="grow">
                <span class="d">${fmtJstMd(g.e.start)}</span>
                <span class="m"><div class="opp">${esc(g.e.name)}<small>${Math.round(g.min)}分</small></div><div class="line">${parts}</div></span>
                <span class="f">${fmt1(g.f)}</span>
                <span class="bar"><i class="${cls}" style="width:${pct(g.f)}"></i><b style="left:${pct(p.price)}"></b></span>
            </div>`;
    }).join('');

    return `
        ${head(`出場 ${r?.gp || 0}/${games.length}試合`)}
        ${summary}
        <div class="glog">
            <div class="ghead"><span>日付</span><span>対戦・出場時間</span><span>FPTS</span></div>
            ${rows}
        </div>
        <div class="barkey"><b></b>値段（$${p.price}）の位置。棒が線を超えた試合は値段以上に稼いでいます</div>
        ${failedNote}`;
}

function openPlayer(id) {
    modalPlayerId = id;
    const p = poolById[id];
    const meta = p || Object.values(state.weeks).flatMap(w => [...w.roster, ...w.cpu]).find(x => x.id === id);
    if (!meta) return;
    const prevSeason = `${PRICE_SEASON - 1}-${String(PRICE_SEASON).slice(2)}`;
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
        : `<div class="msg">${prevSeason} シーズンの出場記録がありません</div>`;

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

    // 今季の成績と、nba/ のページへのリンク（試合は今日・試合中のものだけ）
    const ss = seasonOf(id);
    const seasonHtml = ss
        ? `<div class="mgrid mgrid-3">${cell('試合', ss.gp)}${cell('出場時間', fmt1(ss.min))}${cell('FPTS', fmt1(ss.fpg))}</div>`
        : '<div class="note">今季の出場記録はまだありません。</div>';
    const teamId = p?.teamId || meta.teamId;
    const todayJst = jstYmd(new Date());
    const game = (weekInfo[curWk]?.events || []).find(e => e.teams.includes(teamId)
        && (e.state === 'in' || jstYmd(new Date(e.start)) === todayJst));
    const links = `
        <div class="mlinks">
            <a href="${NBA_SITE.player(id)}" target="_blank" rel="noopener">選手ページ<small>今季の全試合・経歴</small></a>
            ${game ? `<a href="${NBA_SITE.game(game.id)}" target="_blank" rel="noopener">${game.state === 'in' ? '試合中' : '今日の試合'}<small>${esc(vsLabel(game, teamId))} のボックススコア</small></a>` : ''}
        </div>`;

    openSheet(`
        <div class="mhead">
            <img class="mphoto" src="${headshot(esc(id))}" alt="" onerror="this.style.visibility='hidden'">
            <div class="mhead-body">
                <div class="mname">${esc(meta.name)}</div>
                <div class="mmeta">${esc(abbr(meta.team))}${p?.pos ? ` · ${esc(p.pos)}` : ''}${injTag(p?.inj)}</div>
            </div>
            <div class="mprice">$${meta.price}</div>
        </div>
        ${p ? `<div id="m-recent">${recentSectionHtml(p)}</div>` : ''}
        <div class="msection">${SEASON_YEAR - 1}-${String(SEASON_YEAR).slice(2)} シーズン平均（今季）</div>
        ${seasonHtml}
        <div class="msection">${prevSeason} シーズン平均（値段の元）</div>
        ${statsHtml}
        ${links}
        <div class="maction">${action}</div>`);
    const m = document.getElementById('modal');

    // 直近成績がまだなければ読み込み、同じ選手を表示中なら差し替える
    if (p && !recent) {
        ensureRecent().then(() => {
            const box = document.getElementById('m-recent');
            if (box && modalPlayerId === id && !m.hidden) box.innerHTML = recentSectionHtml(p);
        });
    }
}

// 下から出るシートに中身を入れて開く（選手画面・入れ替え候補で共通）
function openSheet(html) {
    document.getElementById('modal-body').innerHTML = html;
    const m = document.getElementById('modal');
    m.querySelector('.sheet').scrollTop = 0;
    m.hidden = false;
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => m.classList.add('open'));
}

function closePlayer() {
    modalPlayerId = null;
    const m = document.getElementById('modal');
    m.classList.remove('open');
    document.body.classList.remove('modal-open');
    setTimeout(() => { m.hidden = true; }, 200);
}

/* ─── アプリの更新（ホーム画面アプリには再読み込みボタンがないため） ─── */
// 一時的な余白調整機能（v1.8）で保存した値と、古い形式の日程・ボックススコアのキャッシュを掃除する
try {
    localStorage.removeItem('nbaf.headerExtra');
    localStorage.removeItem('nbaf.boxes.v1');
    localStorage.removeItem('nbaf.boxes.v2');
    localStorage.removeItem('nbaf.days.v1');
} catch (e) { /* noop */ }

const APP_VERSION = document.querySelector('meta[name="app-version"]')?.content || '';
let latestVersion = null;

// サーバー上の index.html をキャッシュなしで取得し、バージョンを比べる
async function checkUpdate() {
    try {
        const res = await fetch(`${location.pathname}?_=${Date.now()}`, { cache: 'no-store' });
        const m = (await res.text()).match(/name="app-version" content="([^"]+)"/);
        if (!m) return;
        latestVersion = m[1];
        const bar = document.getElementById('update-bar');
        if (latestVersion !== APP_VERSION) {
            document.getElementById('update-text').textContent = `新しいバージョン v${latestVersion} があります`;
            bar.hidden = false;
        } else {
            bar.hidden = true;
        }
    } catch (e) {
        // オフラインなどは無視
    }
}

// キャッシュを無視して最新版を読み込み直す（localStorage のデータには影響しない）
async function hardReload() {
    const ver = latestVersion || APP_VERSION;
    document.querySelectorAll('#update-btn, #btn-update').forEach(b => { b.disabled = true; b.textContent = '更新中…'; });
    try {
        await fetch(location.pathname, { cache: 'reload' });  // 次回起動時の index.html も新しくしておく
    } catch (e) { /* noop */ }
    location.replace(`${location.pathname}?v=${encodeURIComponent(ver)}&t=${Date.now()}`);
}

/* ─── 遊び方ページ（ヘッダーの「?」から開く） ─── */
function renderHelp() {
    const el = document.getElementById('view-help');
    const s = CONFIG.SCORING;
    const par = CONFIG.BUDGET / CONFIG.ROSTER_SIZE;  // 値段どおりに活躍したときの1人1試合の点数
    const tier = key => CONFIG.TIERS.find(t => t.key === key);
    const ex = [20, 5, 5, 1, 1, 2];
    const marks = [
        ...CONFIG.TIERS.map(t => ({ v: t.base, label: t.label, cls: t.key })),
        { v: par, label: '値段どおり', cls: 'par' },
    ];
    const lo = Math.min(...marks.map(m => m.v)) - 3;
    const hi = Math.max(...marks.map(m => m.v)) + 3;
    const pos = v => `${((v - lo) / (hi - lo) * 100).toFixed(1)}%`;
    const coef = v => (v < 0 ? `−${Math.abs(v)}` : `×${v}`);
    const num = v => fmt1(v).replace(/\.0$/, '');
    const exTerms = STAT_KEYS.map((k, i) => ex[i] * s[k])
        .map((t, i) => (i === 0 ? num(t) : `${t < 0 ? ' − ' : ' + '}${num(Math.abs(t))}`)).join('');

    el.innerHTML = `
        <button class="back-btn" data-view="${esc(prevView)}">‹ 戻る</button>
        <div class="card guide">
            <div class="card-title">このゲームの目的</div>
            <p>予算 $${CONFIG.BUDGET} で${CONFIG.ROSTER_SIZE}人を選び、1週間（月〜日）に${CONFIG.ROSTER_SIZE}人が稼いだファンタジーポイント（FPTS）の合計で勝負します。</p>
            <p>毎週ランダムに組まれる CPU チームとの勝ち負けに加えて、${CONFIG.TIERS.map(t => t.label).reverse().join(' / ')} の目標スコアを目指します。</p>
        </div>

        <div class="card guide">
            <div class="card-title">得点の計算</div>
            <div class="score-grid">
                <div><b>${coef(s.PTS)}</b><span>得点 PTS</span></div>
                <div><b>${coef(s.REB)}</b><span>リバウンド REB</span></div>
                <div><b>${coef(s.AST)}</b><span>アシスト AST</span></div>
                <div><b>${coef(s.STL)}</b><span>スティール STL</span></div>
                <div><b>${coef(s.BLK)}</b><span>ブロック BLK</span></div>
                <div><b class="neg">${coef(s.TO)}</b><span>ターンオーバー TO</span></div>
            </div>
            <p class="ex">例：${ex[0]}点 ${ex[1]}リバ ${ex[2]}アシ ${ex[3]}スティール ${ex[4]}ブロック ${ex[5]}TO<br>
                = ${exTerms} = <b>${fmt1(fpts(ex))}</b></p>
        </div>

        <div class="card guide">
            <div class="card-title">値段の意味</div>
            <p>値段は<b>前シーズンの1試合平均FPTS</b>です。$30 の選手は、前季に1試合30点稼いだ選手です。</p>
            <p>$${CONFIG.BUDGET} を${CONFIG.ROSTER_SIZE}人で割ると1人 $${num(par)}。全員が値段どおりに活躍すると、1人1試合${num(par)}点になり、${tier('silver').label} に届きません。</p>
            <div class="tier-scale" aria-hidden="true">
                <div class="ts-track" style="--par:${pos(par)}"></div>
                ${marks.map(m => `<span class="ts-mark ${m.cls}" style="left:${pos(m.v)}"><i></i>${m.cls === 'par' ? `${m.label} ${num(m.v)}` : `${num(m.v)}<br>${m.label}`}</span>`).join('')}
            </div>
            <p class="note">1人1試合あたりの点数。目標スコアは「${CONFIG.ROSTER_SIZE}人 × その週の平均試合数 × この数字」です。</p>
            <p>上を目指すには、<b>値段（前季の実績）より今季たくさん稼ぐ選手</b>を見つけることが必要です。</p>
        </div>

        <div class="card guide">
            <div class="card-title">選手選びのコツ</div>
            <ol class="tips">
                <li><b>割安度を見る</b>今季の平均FPTS − 値段。プラスが大きいほど、値段以上に稼いでいます。並び替え「今季の割安度」が便利です。</li>
                <li><b>出場時間が増えた選手を狙う</b>スタメン昇格、移籍、主力のケガなど。MIN の ↑ や「先発」が目印です。安い選手ほど伸びたときの効果が大きくなります。</li>
                <li><b>スティールとブロックは1つ${s.STL}点</b>得点が少なくても、守備の強い選手は見た目以上に稼ぎます。</li>
                <li><b>FG%・3P%・FT% は関係なし</b>選手画面に出ていますが、得点の計算には使いません。</li>
                <li><b>新人は一律 $${CONFIG.NO_DATA_PRICE}</b>前季のデータがないためです。活躍している新人は掘り出し物です。</li>
            </ol>
        </div>

        <div class="card guide">
            <div class="card-title">毎週の入れ替え（週${CONFIG.MAX_SWAPS}人まで）</div>
            <ol class="tips">
                <li><b>試合数を見る</b>週の合計で競うので、4試合ある選手は2試合の選手の約2倍稼ぎます。「来週 2試合」のように赤字の選手が外す候補です。「見込み」は試合数まで含めた目安です。</li>
                <li><b>「入替」から候補を見る</b>ロスターの選手の「入替」を押すと、その選手を外したときの予算で入れられる選手が、見込みの高い順に出ます。⇄ で入れ替えます。</li>
                <li><b>調子より試合数を優先</b>少し調子が悪い選手より、試合が少ない選手を外すほうが効くことが多いです。</li>
                <li><b>ケガを確認</b><span class="inj">Out</span> の選手はその週0点です。<span class="inj">DTD</span> は出るかどうか直前まで分かりません。</li>
                <li><b>締め切りに注意</b>その週の最初の試合開始でロスターが確定します。時刻はヘッダーの「ロック」に出ます。確定後の変更は翌週分になります。</li>
            </ol>
        </div>

        <div class="card guide">
            <div class="card-title">編成画面の見方</div>
            <div class="anatomy">
                <div class="prow top trow">
                    <div class="photo"></div>
                    <div class="pbody">
                        <div class="pname">選手名</div>
                        <div class="pmeta">MIA C · ${wkGamesTag(4, '来週')} <span class="tag start">先発</span><span class="tag b2b">連戦</span></div>
                        <div class="kv"><span>今季 <b>26.4</b> <span class="val up">+8.0</span></span><span>直近 <b>29.1</b></span><span>MIN <b>31.2</b> <span class="up">↑</span></span></div>
                    </div>
                    <div class="pright"><div class="ptotal">$18</div><div class="proj-chip">見込 105.6</div></div>
                    <div class="sched">${DOW.map((d, i) => [0, 2, 4, 5].includes(i)
                        ? `<div class="s g ${i === 2 ? 'easy' : i === 5 ? 'hard' : ''}"><span class="w">${d}</span>${['BOS', '', '@NYK', '', 'CHA', '@ORL'][i]}</div>`
                        : `<div class="s"><span class="w">${d}</span>·</div>`).join('')}</div>
                </div>
            </div>
            <dl class="defs">
                <dt>$18</dt><dd>値段（前季の1試合平均FPTS）</dd>
                <dt>来週 4試合</dt><dd>編成を適用する週の試合数。ロック前は「今週」と表示。2試合以下は赤</dd>
                <dt>先発 / 控え</dt><dd>直近の試合で先発したかどうか</dd>
                <dt>連戦</dt><dd>その週に2日続けて試合がある（主力が休むことがある）</dd>
                <dt>今季 26.4 +8.0</dt><dd>今季の1試合平均FPTSと、値段との差（割安度）。緑はプラス、赤はマイナス</dd>
                <dt>直近 29.1</dt><dd>直近${RECENT_DAYS}日の1試合平均FPTS。休んだ試合があると「出場 2/3」のように赤字で出る</dd>
                <dt>MIN 31.2 ↑</dt><dd>今季の平均出場時間。直近${RECENT_DAYS}日が今季より2.5分以上多いと ↑、少ないと ↓</dd>
                <dt>見込 105.6</dt><dd>1試合の見込み（今季平均。今季3試合未満は直近か前季）× その週の試合数</dd>
                <dt>曜日の段</dt><dd>その週の相手（@ はアウェー）。下線の赤は失点の少ない相手、緑は失点の多い相手</dd>
            </dl>
        </div>`;
}

/* ─── 画面制御 ─── */
let activeView = 'week';
let prevView   = 'week';  // 遊び方ページから戻る先

function showView(name) {
    if (name === 'help' && activeView !== 'help') prevView = activeView;
    activeView = name;
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
    document.querySelector('main').scrollTop = 0;
    renderActive();
}

async function renderActive() {
    if (activeView === 'help') { renderHelp(); return; }  // データがなくても読める
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
    let sub = `${SEASON_YEAR - 1}-${String(SEASON_YEAR).slice(2)} · 今週 ${fmtWeek(curWk)}（現地）`;
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
    const t = e.target.closest('[data-view],[data-goto],[data-add],[data-remove],[data-swap],[data-swapin],[data-player]');
    if (!t) return;
    const inModal = !!t.closest('#modal');
    if (t.dataset.view)   showView(t.dataset.view);
    if (t.dataset.goto)   showView(t.dataset.goto);
    if (t.dataset.add)    addPlayer(t.dataset.add);
    if (t.dataset.remove) removePlayer(t.dataset.remove);
    if (t.dataset.swap)   { modalPlayerId = null; openSwap(t.dataset.swap); }
    if (t.dataset.swapin) swapPlayer(t.dataset.swapout, t.dataset.swapin);
    if (t.dataset.player) openPlayer(t.dataset.player);
    if (inModal && (t.dataset.add || t.dataset.remove || t.dataset.swapin)) closePlayer();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePlayer(); });
document.getElementById('refresh-btn').addEventListener('click', () => refresh());
document.getElementById('update-btn').addEventListener('click', hardReload);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastSync > 60e3) {
        refresh();
        checkUpdate();
    }
});

refresh();
checkUpdate();
