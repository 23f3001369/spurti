import Student from '../models/Student.js';
import SPTransaction from '../models/SPTransaction.js';
import LeaderboardSnapshot from '../models/LeaderboardSnapshot.js';
import Achievement, { awardAchievements } from '../models/Achievement.js';
import { levelFor } from './levels.js';

const CAT_LABEL = { total: 'Overall', attendance: 'Best Attendance', poll: 'Poll Champions', spa: 'Top SPA', query: 'Top Query Answerers' };

// Achievement titles, one per board. The SAME title is used for all three podium
// places — the medal in the card's gold disc is what says which place it was.
const ACH_TITLE = {
  total: 'Cohort Champion',
  attendance: 'Attendance Ace',
  poll: 'Poll Champion',
  spa: 'Peer-Learning Champion',
  query: "Cohort's Go-To"
};
const PLACE_ICON = { 1: '🥇', 2: '🥈', 3: '🥉' };

// Category boards beyond the "total" board. Combined SPA (learn + teach) is one
// category. `total` = sum of all categories in the window.
const CATS = ['attendance', 'poll', 'spa', 'query'];
const IST_MS = 5.5 * 3600 * 1000;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Most recent Monday 00:00 IST, returned as the real UTC instant.
function weekStartIST(now) {
  const ist = new Date(now.getTime() + IST_MS);
  const daysSinceMon = (ist.getUTCDay() + 6) % 7; // Mon->0 ... Sun->6
  const monMidnightIst = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - daysSinceMon);
  return new Date(monMidnightIst - IST_MS);
}
// The week's Monday as an IST calendar date. A week starts at 00:00 IST, which
// is 18:30 UTC the evening BEFORE, so slicing the UTC instant would name every
// week after the preceding Sunday — "2026-08-02" for the week of Aug 3–9.
function weekKey(weekStartUtc) {
  return new Date(weekStartUtc.getTime() + IST_MS).toISOString().slice(0, 10);
}
function weekLabel(weekStartUtc) {
  const s = new Date(weekStartUtc.getTime() + IST_MS);
  const e = new Date(s.getTime() + 6 * 86400000);
  return s.getUTCMonth() === e.getUTCMonth()
    ? `${MON[s.getUTCMonth()]} ${s.getUTCDate()}–${e.getUTCDate()}`
    : `${MON[s.getUTCMonth()]} ${s.getUTCDate()} – ${MON[e.getUTCMonth()]} ${e.getUTCDate()}`;
}

// Sum appliedDelta per (student, category) over a match window.
async function sumByStudentCat(match) {
  const rows = await SPTransaction.aggregate([
    { $match: match },
    { $group: { _id: { sid: '$studentId', cat: '$category' }, sp: { $sum: '$appliedDelta' } } }
  ]);
  const m = new Map(); // sid -> { total, cat:{} }
  for (const r of rows) {
    const sid = r._id.sid ? String(r._id.sid) : null;
    if (!sid) continue;
    let o = m.get(sid); if (!o) { o = { total: 0, cat: {} }; m.set(sid, o); }
    o.cat[r._id.cat] = (o.cat[r._id.cat] || 0) + r.sp;
    o.total += r.sp;
  }
  return m;
}

export async function computeAndStoreLeaderboards() {
  const now = new Date();
  // Both changes this feature makes to the build — tie-aware ranks and minted
  // podium cards — become visible to the cohort the moment the sp-refresh cron
  // runs, so they wait on the same go-live switch as the tab (ACHIEVEMENTS_ENABLED).
  // With it off the build behaves exactly as it did before achievements existed:
  // unique 1,2,3… ranks and no cards. Read here, not at import, so the flag is
  // whatever the .env said when the process started, however it was started.
  const awardsOn = process.env.ACHIEVEMENTS_ENABLED === '1';
  // All-time podiums are a SEPARATE switch, default off, because unlike a week
  // an all-time board never settles while the programme is running. Awarding it
  // live handed every successive leader their own permanent "1st place,
  // All-time" card — three leaders, three cards, all verifying as genuine, none
  // of them exclusive. There is no completed period to award from, so the only
  // honest moment is one the operator picks: flip this at programme end and a
  // single settled set is minted.
  const allTimeOn = awardsOn && process.env.ACHIEVEMENTS_ALLTIME === '1';
  const weekStart = weekStartIST(now);
  const label = weekLabel(weekStart);
  // The week the cards are for. The boards on screen still show the week in
  // progress; only the awarding waits for it to finish.
  const prevWeekStart = new Date(weekStart.getTime() - 7 * 86400000);
  const prevLabel = weekLabel(prevWeekStart);

  const students = await Student.find(
    { status: { $ne: 'excused' } },
    { name: 1, totalSp: 1, highestSpEver: 1, leaderboardGroup: 1 }
  ).lean();

  const weekMap = await sumByStudentCat({ dateTime: { $gte: weekStart } });
  const allMap = await sumByStudentCat({});

  const levelOf = (s) => levelFor(Math.max(Number(s.highestSpEver) || 0, Number(s.totalSp) || 0));
  // Standard competition ("1224") ranking: equal SP shares a rank, and the next
  // distinct SP jumps past the tie (1,2,2,4 … 1,2,2,2,2,6).
  const build = (subset, valueOf) => {
    const sorted = subset
      .map((s) => ({ studentId: String(s._id), name: s.name || '', level: levelOf(s), sp: Math.round(valueOf(String(s._id))) }))
      .sort((a, b) => b.sp - a.sp || a.name.localeCompare(b.name));
    if (!awardsOn) return sorted.map((r, i) => ({ ...r, rank: i + 1 }));
    let rank = 0, prevSp = null;
    return sorted.map((r, i) => {
      if (r.sp !== prevSp) { rank = i + 1; prevSp = r.sp; }
      return { ...r, rank };
    });
  };

  const wTotal = (sid) => (weekMap.get(sid)?.total) || 0;
  const wCat = (cat) => (sid) => (weekMap.get(sid)?.cat[cat]) || 0;
  const aCat = (cat) => (sid) => (allMap.get(sid)?.cat[cat]) || 0;
  const byId = new Map(students.map((s) => [String(s._id), s]));
  const aTotal = (sid) => Number(byId.get(sid)?.totalSp) || 0;

  const boards = [];
  const push = (window, category, scope, group, rows) => boards.push({
    boardKey: scope === 'group' ? `${window}:${category}:group:${group}` : `${window}:${category}:${scope}`,
    window, category, scope, group: group || null, weekStart, weekLabel: label, builtAt: now, rows
  });

  // Total boards (global)
  push('week', 'total', 'all', null, build(students, wTotal));
  push('all', 'total', 'all', null, build(students, aTotal));
  // Category boards (global), weekly + all-time
  for (const cat of CATS) {
    push('week', cat, 'all', null, build(students, wCat(cat)));
    push('all', cat, 'all', null, build(students, aCat(cat)));
  }
  // Total boards per onboarding group (weekly + all-time)
  const groups = [...new Set(students.map((s) => s.leaderboardGroup).filter(Boolean))];
  for (const g of groups) {
    const subset = students.filter((s) => s.leaderboardGroup === g);
    push('week', 'total', 'group', g, build(subset, wTotal));
    push('all', 'total', 'group', g, build(subset, aTotal));
  }

  // Persist: upsert each board; drop any stale group boards no longer present.
  const keys = new Set(boards.map((b) => b.boardKey));
  await Promise.all(boards.map((b) => LeaderboardSnapshot.updateOne({ boardKey: b.boardKey }, { $set: b }, { upsert: true })));
  await LeaderboardSnapshot.deleteMany({ boardKey: { $nin: [...keys] } });

  // Award permanent podium achievements — 1st, 2nd and 3rd on each GLOBAL board.
  //
  // WEEKLY CARDS COME FROM THE LAST COMPLETED WEEK, NEVER THE ONE IN PROGRESS.
  // Awarding live looked idempotent but was not: the upsert is keyed on
  // (studentId, achId) and achId carries no student, so a different leader at
  // the next six-hourly run did not replace the previous one — they were handed
  // their own row. Monday's leader, Wednesday's and Sunday's would each end up
  // holding a permanent, independently verifiable "1st place, week of X" card
  // for the same board. Four runs a day meant up to 28 holders of one placing.
  // A finished week's standings cannot move, so awarding from them gives one
  // set of winners and makes re-running genuinely a no-op.
  //
  // Not awarded here (deliberate, v1 scope):
  //  · onboarding-group boards — they overlap the cohort-wide win and would more
  //    than double the weekly card volume for the least meaningful placing.
  //  · placings below 3rd — "7th on the Polls board this week" can be 7th out of
  //    a field of thirty, which isn't the same achievement as a podium.
  const TIE_MAX = 3;      // a place shared by more than 3 people isn't a placing
  const ops = [];
  let awardBoards = [];
  let settled = new Set();

  if (awardsOn) {
    const prevWeekMap = await sumByStudentCat({ dateTime: { $gte: prevWeekStart, $lt: weekStart } });
    const pTotal = (sid) => (prevWeekMap.get(sid)?.total) || 0;
    const pCat = (cat) => (sid) => (prevWeekMap.get(sid)?.cat[cat]) || 0;

    awardBoards = [
      { window: 'week', category: 'total', rows: build(students, pTotal) },
      ...CATS.map((cat) => ({ window: 'week', category: cat, rows: build(students, pCat(cat)) })),
      ...(allTimeOn
        ? boards.filter((b) => b.window === 'all' && b.scope === 'all')
            .map((b) => ({ window: 'all', category: b.category, rows: b.rows }))
        : [])
    ];

    // Belt and braces against a placing being awarded twice with different
    // winners — a late backdated transaction could shift even a settled week's
    // standings, and an all-time board moves whenever anyone earns. Once a
    // placing has any holder it is closed, so ties (awarded together in one
    // batch) still work while a later challenger cannot claim the same title.
    const wk = weekKey(prevWeekStart);
    const already = await Achievement.find(
      { $or: [{ achId: { $regex: `^rank:[^:]+:week:${wk}:` } }, { achId: { $regex: '^rank:[^:]+:all:all:' } }] },
      { achId: 1 }
    ).lean();
    settled = new Set(already.map((a) => a.achId));
  }

  const add = (r, b, place) => {
    const wk = b.window === 'week' ? weekKey(prevWeekStart) : 'all';
    const achId = `rank:${b.category}:${b.window}:${wk}:${place}`;
    if (settled.has(achId)) return;                  // this placing is already awarded
    ops.push({
      filter: { studentId: r.studentId, achId },
      doc: {
        studentId: r.studentId, achId, kind: 'rank', board: b.category, place,
        icon: PLACE_ICON[place], title: ACH_TITLE[b.category],
        period: b.window === 'week' ? `Week of ${prevLabel}` : 'All-time',
        periodKey: wk,
        detail: `${r.sp} SP`, earnedAt: now
      }
    });
  };
  for (const b of awardBoards) {
    for (const place of [1, 2, 3]) {
      const tied = b.rows.filter((r) => r.rank === place);
      // A placing needs a real score: the top of a table of zeroes is not a win.
      if (!tied.length || tied.length > TIE_MAX || tied[0].sp <= 0) continue;
      for (const r of tied) add(r, b, place);
    }
  }
  if (ops.length) await awardAchievements(ops);

  return {
    boards: boards.length, groups: groups.length, achievementOps: ops.length,
    weekStart, weekLabel: label, awardedWeek: awardsOn ? prevLabel : null,
    students: students.length
  };
}
