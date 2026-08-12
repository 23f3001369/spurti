// Mints podium cards for weeks that finished BEFORE achievements went live.
//
// The live build only ever awards the last completed week, so every earlier week
// of the internship has winners that were never recognised. This walks those
// weeks and awards them retrospectively, using the same ranking and podium rules
// as the live build (`rankRows` / `weeklyPodiumSpecs` in services/leaderboards.js)
// so the two cannot disagree about who placed.
//
//   node server/scripts/backfillWeeklyAchievements.mjs                  # report only
//   node server/scripts/backfillWeeklyAchievements.mjs --from 2026-06-01
//   node server/scripts/backfillWeeklyAchievements.mjs --apply
//
//   --from YYYY-MM-DD   first week to consider (default: the programme start —
//                       NOT the earliest transaction, which can be junk data).
//                       Snapped back to that week's Monday.
//   --to   YYYY-MM-DD   last week to consider (default: the last COMPLETED week —
//                       the week in progress is never awarded)
//   --board total|poll|…  restrict to one board
//   --apply             actually write. Without it, nothing is written.
//
// Run from the repo root so .env is picked up. Safe to re-run: a placing that
// already has a holder is skipped, so this can never hand the same week's title
// to a second student.
//
// `earnedAt` is set to the END of the week in question, not now, so the cards
// sit in the student's timeline where they actually belong.

import 'dotenv/config';
import mongoose from 'mongoose';
import Student from '../models/Student.js';
import SPTransaction from '../models/SPTransaction.js';
import Achievement, { awardAchievements } from '../models/Achievement.js';
import {
  rankRows, weeklyPodiumSpecs, sumByStudentCat, weeklyTotal,
  weekStartIST, weekKey, weekLabel, CATS, WEEKLY_EXCLUDED_CATEGORIES
} from '../services/leaderboards.js';

const WEEK = 7 * 86400000;
const IST_MS = 5.5 * 3600 * 1000;

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const APPLY = process.argv.includes('--apply');
const ONLY_BOARD = arg('--board');
const BOARDS = ONLY_BOARD ? [ONLY_BOARD] : ['total', ...CATS];

const URI = process.env.MONGO_URI;
if (!URI) {
  console.error('MONGO_URI is not set. Run this from the repo root so .env is picked up.');
  process.exit(1);
}
await mongoose.connect(URI);

// The week in progress is never awarded — its standings can still move.
const lastCompleted = new Date(weekStartIST(new Date()).getTime() - WEEK);

const firstTx = await SPTransaction.find({}, { dateTime: 1 }).sort({ dateTime: 1 }).limit(1).lean();
if (!firstTx.length) { console.error('no SP transactions — nothing to backfill'); process.exit(1); }

// The floor is the internship, NOT the earliest transaction. The ledger contains
// rows dated well outside the programme — there is one in 2006 — and taking the
// earliest of those as the start walked twenty years of empty weeks and minted a
// card for a phantom "Week of Jul 31 – Aug 6, 2006". A card is a permanent public
// credential; it should never be issued for a week the programme did not run.
const firstStart = await Student.find(
  { status: { $ne: 'excused' }, internshipStartDate: { $ne: null } },
  { internshipStartDate: 1 }
).sort({ internshipStartDate: 1 }).limit(1).lean();
const programmeStart = firstStart.length ? new Date(firstStart[0].internshipStartDate) : null;

const stray = await SPTransaction.countDocuments(
  programmeStart ? { dateTime: { $lt: programmeStart } } : { _id: null }
);
if (stray) {
  console.log(`note: ${stray} SP transaction(s) are dated before the programme started ` +
              `(${programmeStart.toISOString().slice(0, 10)}). They are excluded from the default range; ` +
              `pass --from explicitly to include them. Worth investigating separately — it is a ledger issue, not an achievements one.`);
}

const fromArg = arg('--from');
const toArg = arg('--to');
let from = weekStartIST(
  fromArg ? new Date(`${fromArg}T00:00:00+05:30`)
          : new Date(Math.max(new Date(firstTx[0].dateTime).getTime(), programmeStart?.getTime() ?? 0))
);
let to = toArg ? weekStartIST(new Date(`${toArg}T00:00:00+05:30`)) : lastCompleted;
if (to > lastCompleted) {
  console.log(`--to is in the current week; clamped to the last completed week (${weekKey(lastCompleted)})`);
  to = lastCompleted;
}
if (from > to) { console.error('nothing to do: --from is after the last completed week'); process.exit(1); }

const students = await Student.find(
  { status: { $ne: 'excused' } },
  { name: 1, totalSp: 1, highestSpEver: 1 }
).lean();
const nameOf = new Map(students.map((s) => [String(s._id), s.name || String(s._id)]));

// Every placing already held, so a re-run — or a week the live build has since
// awarded — is skipped rather than duplicated.
const held = new Set(
  (await Achievement.find({ achId: { $regex: '^rank:[^:]+:week:' } }, { achId: 1 }).lean())
    .map((a) => a.achId)
);

console.log(`backfill ${weekKey(from)} … ${weekKey(to)}   boards: ${BOARDS.join(', ')}`);
console.log(`${students.length} non-excused students, ${held.size} weekly placings already held`);
console.log(`weekly Overall SP excludes: ${WEEKLY_EXCLUDED_CATEGORIES.join(', ')}`);
console.log(APPLY ? '\nMODE: APPLY — cards will be written\n' : '\nMODE: dry run — nothing will be written\n');

const all = [];
const perStudent = new Map();
let weeks = 0, emptyWeeks = 0;

for (let ws = new Date(from); ws <= to; ws = new Date(ws.getTime() + WEEK)) {
  const we = new Date(ws.getTime() + WEEK);
  const map = await sumByStudentCat({ dateTime: { $gte: ws, $lt: we } });
  const wk = weekKey(ws);
  const period = `Week of ${weekLabel(ws)}`;
  // End of the week in IST, which is when these were really earned.
  const earnedAt = new Date(we.getTime() - 1000);

  const specs = [];
  for (const category of BOARDS) {
    const valueOf = category === 'total'
      ? (sid) => weeklyTotal(map.get(sid))
      : (sid) => (map.get(sid)?.cat[category]) || 0;
    specs.push(...weeklyPodiumSpecs({
      rows: rankRows(students, valueOf, true),
      category, weekKey: wk, period, earnedAt, settled: held
    }));
  }

  weeks += 1;
  if (!specs.length) { emptyWeeks += 1; continue; }

  console.log(`${period}  (${wk})  → ${specs.length} card${specs.length === 1 ? '' : 's'}`);
  for (const s of specs) {
    const [, cat, , , place] = s.doc.achId.split(':');
    console.log(`    ${place}. ${cat.padEnd(11)} ${nameOf.get(s.doc.studentId)}  ${s.doc.detail}`);
    perStudent.set(s.doc.studentId, (perStudent.get(s.doc.studentId) || 0) + 1);
    held.add(s.doc.achId);          // so a later week in this same run can't re-add it
  }
  all.push(...specs);
}

console.log(`\n${weeks} week(s) examined, ${emptyWeeks} with no qualifying placing`);
console.log(`${all.length} card(s) to mint across ${perStudent.size} student(s)`);

const top = [...perStudent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
if (top.length) {
  console.log('\nmost cards landing at once:');
  for (const [sid, n] of top) console.log(`    ${String(n).padStart(3)}  ${nameOf.get(sid)}`);
}

if (!all.length) {
  console.log('\nnothing to do.');
} else if (!APPLY) {
  console.log('\nre-run with --apply to write these.');
} else {
  await awardAchievements(all);
  console.log(`\nwrote ${all.length} card(s).`);
  const now = await Achievement.countDocuments({ achId: { $regex: '^rank:[^:]+:week:' } });
  console.log(`weekly rank cards in the collection: ${now}`);
}

await mongoose.disconnect();
