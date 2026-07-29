import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { ALLOW_STUDENT_SEARCH, MONGO_URI, PORT, SAMAGAMA_AUTH_URL } from './config.js';
import Student from './models/Student.js';
import Session from './models/Session.js';
import AttendanceRecord from './models/AttendanceRecord.js';
import PollRecord from './models/PollRecord.js';
import SPTransaction from './models/SPTransaction.js';
import SessionEvent from './models/SessionEvent.js';
import { leagueBand, levelFor, legendBadge, leaderboardGroup, groupLabel } from './services/levels.js';
import Commitment from './models/Commitment.js';
import { isVibeEligible, buildVibeState, validateBet, settleBetDemo, applySpDelta, courseByKey } from './services/vibe.js';
import { buildStandupState, placeStandup, settleStandupDemo } from './services/standup.js';
import { buildJourneyState, saveJourneyPlan } from './services/journey.js';
import PeerReviewSubmission from './models/PeerReviewSubmission.js';
import PeerReview from './models/PeerReview.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const clientDist = path.join(rootDir, 'client', 'dist');
// Admin auth is env-only — NO hardcoded fallback. A committed default would be a
// public credential (anyone reading the repo could authenticate). If either is
// unset, admin endpoints fail closed (see isAdmin) rather than accept a known value.
const ADMIN_EMAIL = normalizeEmail(process.env.ADMIN_EMAIL || '');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
if (!ADMIN_EMAIL || !ADMIN_TOKEN) {
  console.warn('[security] ADMIN_EMAIL/ADMIN_TOKEN not set — admin endpoints are DISABLED until both are configured in .env');
}

// Survey triangulation pop-up(s). All driven by env so the form link / mode can
// change without a client rebuild (the client reads these via /api/config).
// One config per pop-up; `completedField` is the Student flag it drives, so each
// pop-up has an independent completion state. `SURVEY` is the original perception
// survey; `POLL2` is a second, identical pop-up on its own flag.
function makeSurvey(prefix, completedField) {
  return {
    key: completedField.replace(/Completed$/, ''),      // 'survey' | 'poll2'
    completedField,                                      // Student boolean flag
    completedAtField: completedField + 'At',             // Student timestamp field
    enabled: process.env[`${prefix}_ENABLED`] === '1',
    formUrl: process.env[`${prefix}_FORM_URL`] || '',          // .../viewform  (the published form)
    emailEntryId: process.env[`${prefix}_EMAIL_ENTRY`] || '',  // e.g. entry.1234567890  (pre-fills email)
    // Mandatory: 'hard' = blocking modal the student cannot dismiss until they
    // submit. No SP reward — participation is required, not incentivised.
    enforcement: process.env[`${prefix}_ENFORCEMENT`] || 'hard',
    // Auto-expiry. After this instant the modal stops showing (normal Spurti
    // resumes) with no redeploy. ISO 8601 incl. offset, e.g. 2026-06-30T23:59:59+05:30.
    deadline: process.env[`${prefix}_DEADLINE`] || '',
    webhookSecret: process.env[`${prefix}_WEBHOOK_SECRET`] || '', // shared secret for the Apps Script webhook
    // Apps Script web app that returns {emails:[...]} of actual submitters (private
    // sheet; secret-gated). Used to verify completion without trusting the client.
    responsesUrl: process.env[`${prefix}_RESPONSES_URL`] || '',
    responsesSecret: process.env[`${prefix}_RESPONSES_SECRET`] || '',
    _subs: { at: 0, set: null }                          // per-survey 60s cache
  };
}
const SURVEY = makeSurvey('SURVEY', 'surveyCompleted');
const POLL2 = makeSurvey('POLL2', 'poll2Completed');
const POLL3 = makeSurvey('POLL3', 'poll3Completed');
const SURVEYS = [SURVEY, POLL2, POLL3];

// Cached fetch of the submitted-email set from a survey's Apps Script endpoint.
async function getSubmittedEmails(cfg) {
  if (!cfg.responsesUrl) return null;
  if (cfg._subs.set && Date.now() - cfg._subs.at < 60000) return cfg._subs.set;   // 60s cache
  try {
    const u = cfg.responsesUrl + (cfg.responsesUrl.includes('?') ? '&' : '?') +
              'secret=' + encodeURIComponent(cfg.responsesSecret);
    const r = await fetch(u, { redirect: 'follow' });
    // Apps Script intermittently serves an HTML error/redirect page (esp. under
    // load) instead of JSON; parse defensively so it fails cleanly instead of
    // throwing an opaque "Unexpected token '<'".
    const body = await r.text();
    let j;
    try { j = JSON.parse(body); }
    catch { throw new Error(`non-JSON response (HTTP ${r.status}, ${body.length}B)`); }
    cfg._subs = { at: Date.now(), set: new Set((j.emails || []).map(e => normalizeEmail(e))) };
    return cfg._subs.set;
  } catch (err) {
    cfg._subs.at = Date.now(); // back off 60s on failure too — don't hammer Apps Script / spam logs
    console.error(`${cfg.key} responses fetch failed:`, err?.message);
    return cfg._subs.set; // serve last good cache on failure
  }
}

// A survey is active only while enabled AND before its deadline (if set).
function surveyActive(cfg) {
  if (!cfg.enabled) return false;
  if (cfg.deadline) {
    const cutoff = Date.parse(cfg.deadline);
    if (!Number.isNaN(cutoff) && Date.now() > cutoff) return false;
  }
  return true;
}

// The env-driven public view of a survey the client needs (form + mode + gate).
function surveyPublic(cfg) {
  return {
    enabled: surveyActive(cfg),
    formUrl: cfg.formUrl,
    emailEntryId: cfg.emailEntryId,
    enforcement: cfg.enforcement,
    deadline: cfg.deadline
  };
}

const app = express();
const api = express.Router();
const liveViewers = new Map();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!name || !domain) return 'hidden email';
  const start = name.slice(0, Math.min(2, name.length));
  const end = name.length > 4 ? name.slice(-2) : '';
  return `${start}${'*'.repeat(Math.max(3, name.length - start.length - end.length))}${end}@${domain}`;
}

function publicStudent(student) {
  return {
    _id: String(student._id),
    name: student.name,
    maskedEmail: maskEmail(student.email),
    maskedAlternateEmail: student.alternateEmail ? maskEmail(student.alternateEmail) : '',
    status: student.status || 'active',
    totalSp: student.totalSp
  };
}

function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map(part => {
    const index = part.indexOf('=');
    if (index < 0) return null;
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(Boolean));
}

// Validate the student's Samagama session by forwarding their chatengine_token
// cookie to Samagama's internal auth endpoint. Returns the email on success.
async function getSamagamaUser(chatengineToken) {
  if (!chatengineToken) return null;
  try {
    const res = await fetch(SAMAGAMA_AUTH_URL, {
      headers: { cookie: `chatengine_token=${chatengineToken}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function studentEmailFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const data = await getSamagamaUser(cookies.chatengine_token);
  // Samagama's /api/auth/me nests the user as { user: { email, ... } };
  // fall back to a top-level email in case the shape ever flattens.
  const email = data?.user?.email || data?.email;
  if (!email) return null;
  return normalizeEmail(email);
}

async function rankFor(email) {
  const student = await Student.findOne({ email }).lean();
  if (!student || student.status === 'excused') return null;
  const better = await Student.countDocuments({
    status: { $ne: 'excused' },
    $or: [
      { totalSp: { $gt: student.totalSp } },
      { totalSp: student.totalSp, name: { $lt: student.name } }
    ]
  });
  const cohortSize = await Student.countDocuments({ status: { $ne: 'excused' } });
  return { rank: better + 1, cohortSize };
}

function excusedPayload(student) {
  return {
    excused: true,
    student: publicStudent(student),
    message: 'Your current internship account has been excused. Your previous Spurti record is preserved, and you may come back in the next cohort.'
  };
}

async function studentPayload(student) {
  const email = student.email;
  const activeFilter = { status: { $ne: 'excused' } };
  const [transactions, polls, attendance, rankInfo, leaderboard, allStudents] = await Promise.all([
    SPTransaction.find({ email }).sort({ dateTime: 1, createdAt: 1 }).lean(),
    PollRecord.find({ email }).sort({ sessionLabel: 1 }).lean(),
    AttendanceRecord.find({ email }).sort({ sessionLabel: 1 }).lean(),
    rankFor(email),
    Student.find(activeFilter).sort({ totalSp: -1, name: 1 }).limit(50).lean(),
    Student.find(activeFilter).sort({ totalSp: -1, name: 1 }).lean()
  ]);
  const allSp = allStudents.map(s => Number(s.totalSp || 0));
  const averageSp = allSp.length ? Math.round(allSp.reduce((sum, value) => sum + value, 0) / allSp.length) : 0;
  const top10Cutoff = allStudents[9]?.totalSp || null;
  const top50Cutoff = allStudents[49]?.totalSp || null;
  const currentIndex = allStudents.findIndex(s => s.email === email);
  const nextStudent = currentIndex > 0 ? allStudents[currentIndex - 1] : null;
  // Spurti Levels & Trophy Leagues — derived from existing SP (lifetime highest + current).
  const highestSpEver = Math.max(Number(student.highestSpEver) || 0, Number(student.totalSp) || 0);
  const myGroup = leaderboardGroup(student.internshipStartDate);
  const groupStudents = allStudents.filter(s => leaderboardGroup(s.internshipStartDate) === myGroup);
  const mapRow = (row, index) => ({
    rank: index + 1,
    name: row.name,
    maskedEmail: maskEmail(row.email),
    totalSp: row.totalSp,
    level: levelFor(Math.max(Number(row.highestSpEver) || 0, Number(row.totalSp) || 0)),
    isCurrentStudent: row.email === email
  });
  return {
    student: {
      _id: String(student._id),
      name: student.name,
      email: student.email,
      alternateEmail: student.alternateEmail,
      internshipStartDate: student.internshipStartDate,
      internshipEndDate: student.internshipEndDate,
      status: student.status || 'active',
      excusedAt: student.excusedAt,
      excusedReason: student.excusedReason,
      totalSp: student.totalSp,
      rank: rankInfo?.rank || null,
      cohortSize: rankInfo?.cohortSize || null,
      highestSpEver,
      level: levelFor(highestSpEver),
      trophyLeague: leagueBand(student.totalSp),
      legendBadgeUnlocked: legendBadge(highestSpEver),
      leaderboardGroup: myGroup,
      leaderboardGroupLabel: groupLabel(myGroup),
      surveyCompleted: Boolean(student.surveyCompleted),
      poll2Completed: Boolean(student.poll2Completed),
      poll3Completed: Boolean(student.poll3Completed),
      eligibleForVibeGoals: isVibeEligible(student)
    },
    transactions,
    polls,
    attendance,
    cohort: {
      averageSp,
      top10Cutoff,
      top50Cutoff,
      pointsToTop50: top50Cutoff === null ? null : Math.max(0, top50Cutoff - student.totalSp + 1),
      pointsToNextRank: nextStudent ? Math.max(1, nextStudent.totalSp - student.totalSp + 1) : 0
    },
    leaderboard: leaderboard.map(mapRow),
    groupLeaderboard: groupStudents.slice(0, 50).map(mapRow)
  };
}

function isAdmin(req) {
  if (!ADMIN_EMAIL || !ADMIN_TOKEN) return false; // fail closed when admin creds aren't configured
  const emailOk = normalizeEmail(req.headers['x-admin-email']) === ADMIN_EMAIL;
  const tokenOk = String(req.headers['x-admin-token'] || '') === ADMIN_TOKEN;
  return emailOk && tokenOk;
}

function adminGuard(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  next();
}

api.get('/health', (_req, res) => res.json({ status: 'ok' }));

api.get('/config', (_req, res) => res.json({
  allowStudentSearch: ALLOW_STUDENT_SEARCH,
  survey: surveyPublic(SURVEY),
  poll2: surveyPublic(POLL2),
  poll3: surveyPublic(POLL3)
}));

api.get('/me', async (req, res) => {
  const email = await studentEmailFromRequest(req);
  if (!email) return res.status(401).json({ authenticated: false });
  const student = await Student.findOne({ $or: [{ email }, { alternateEmail: email }] }).lean();
  if (!student) return res.status(404).json({ authenticated: false, error: 'Student not found' });
  if (student.status === 'excused') return res.json({ authenticated: true, ...excusedPayload(student) });
  res.json({ authenticated: true, profile: await studentPayload(student) });
});

// ---- ViBe Goals (commitment-SP module; 16 July cohort onward) ----------------
async function vibeStudent(req) {
  const email = normalizeEmail(req.body?.email || req.query.email) || await studentEmailFromRequest(req);
  if (!email) return null;
  return Student.findOne({ $or: [{ email }, { alternateEmail: email }] }).lean();
}

api.get('/vibe/state', async (req, res) => {
  const student = await vibeStudent(req);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  if (!isVibeEligible(student)) return res.json({ eligible: false });
  res.json(await buildVibeState(student));
});

api.post('/vibe/bet', async (req, res) => {
  const student = await vibeStudent(req);
  if (!student || !isVibeEligible(student)) return res.status(403).json({ error: 'Not eligible for ViBe Goals.' });
  const { course, goalPct, stake, multiplier, deadline } = req.body || {};
  const state = await buildVibeState(student);
  const v = validateBet({ state, course, goalPct: +goalPct, stake: +stake, multiplier: +multiplier, deadline });
  if (v.errs.length) return res.status(400).json({ error: v.errs.join(' ') });
  const c = courseByKey(course);
  // debit the stake now (the "cost of the bet"), visible in the SP Bank
  await applySpDelta(student.email, -(+stake),
    `Staked ${stake} SP on ViBe goal: +${goalPct}% ${c ? c.name : course} (${multiplier}×)`);
  await Commitment.create({
    email: student.email, type: 'vibe', debited: true,
    course, goalPct: +goalPct, baselinePct: v.baselinePct,
    deadline: new Date(deadline), stake: +stake, multiplier: +multiplier,
    potentialWin: v.win, potentialLoss: v.loss, reserved: v.loss, status: 'active',
    label: `+${goalPct}% ${c ? c.name : course} (stake ${stake} @ ${multiplier}×)`
  });
  const fresh = await Student.findOne({ email: student.email }).lean();
  res.json(await buildVibeState(fresh));
});

api.put('/vibe/bet/:id', async (req, res) => {
  const student = await vibeStudent(req);
  if (!student || !isVibeEligible(student)) return res.status(403).json({ error: 'Not eligible.' });
  const bet = await Commitment.findOne({ _id: req.params.id, email: student.email, type: 'vibe', status: 'active' });
  if (!bet) return res.status(404).json({ error: 'No active bet to edit.' });
  const { goalPct, stake, multiplier } = req.body || {};   // deadline & course are NOT editable
  const state = await buildVibeState(student);
  const v = validateBet({ state, course: bet.course, goalPct: +goalPct, stake: +stake, multiplier: +multiplier, ignoreActive: true });
  if (v.errs.length) return res.status(400).json({ error: v.errs.join(' ') });
  // reconcile the already-debited stake: refund the difference (old − new)
  const stakeDiff = bet.stake - (+stake);
  if (stakeDiff !== 0) {
    const c = courseByKey(bet.course);
    await applySpDelta(student.email, stakeDiff,
      `ViBe goal edited — stake ${bet.stake}→${stake} on +${goalPct}% ${c ? c.name : bet.course}`);
  }
  Object.assign(bet, { goalPct: +goalPct, stake: +stake, multiplier: +multiplier,
    potentialWin: v.win, potentialLoss: v.loss, reserved: v.loss });
  await bet.save();
  const fresh = await Student.findOne({ email: student.email }).lean();
  res.json(await buildVibeState(fresh));
});

// DEMO: resolve a bet (no live settlement cron locally). result = 'won' | 'lost'.
api.post('/vibe/bet/:id/settle', async (req, res) => {
  const student = await vibeStudent(req);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const bet = await Commitment.findOne({ _id: req.params.id, email: student.email, type: 'vibe', status: 'active' });
  if (!bet) return res.status(404).json({ error: 'No active bet.' });
  const result = req.body?.result === 'lost' ? 'lost' : 'won';
  await settleBetDemo(bet, result);
  const fresh = await Student.findOne({ email: student.email }).lean();
  res.json(await buildVibeState(fresh));
});

// ---- Standup commitments (weekly, attendance-only; keep-the-stake) -----------
api.get('/standup/state', async (req, res) => {
  const student = await vibeStudent(req);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  if (!isVibeEligible(student)) return res.json({ eligible: false });
  res.json(await buildStandupState(student));
});

api.post('/standup/commit', async (req, res) => {
  const student = await vibeStudent(req);
  if (!student || !isVibeEligible(student)) return res.status(403).json({ error: 'Not eligible for standup commitments.' });
  const { tierKey, multiplier } = req.body || {};
  const r = await placeStandup(student, { tierKey, multiplier });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(await buildStandupState(student));
});

// DEMO: resolve a standup commitment (no live weekly settlement cron yet).
api.post('/standup/commit/:id/settle', async (req, res) => {
  const student = await vibeStudent(req);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const c = await Commitment.findOne({ _id: req.params.id, email: student.email, type: 'standup', status: 'active' });
  if (!c) return res.status(404).json({ error: 'No active standup commitment.' });
  await settleStandupDemo(c, req.body?.result === 'lost' ? 'lost' : 'won');
  const fresh = await Student.findOne({ email: student.email }).lean();
  res.json(await buildStandupState(fresh));
});

// ---- My Journey (phase-by-phase progress + SP; 16 July cohort onward) ---------
api.get('/journey/state', async (req, res) => {
  const student = await vibeStudent(req);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  if (!isVibeEligible(student)) return res.json({ eligible: false });
  res.json(await buildJourneyState(student));
});

api.put('/journey/plan', async (req, res) => {
  const student = await vibeStudent(req);
  if (!student || !isVibeEligible(student)) return res.status(403).json({ error: 'Not eligible for My Journey.' });
  await saveJourneyPlan(student.email, req.body || {});
  res.json(await buildJourneyState(student));
});

api.get('/search', async (req, res) => {
  if (!ALLOW_STUDENT_SEARCH) return res.status(403).json({ error: 'Student search is disabled. Please login from Samagama to view your Spurti Points.' });
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ exact: false, matches: [] });

  if (q.includes('@')) {
    const email = normalizeEmail(q);
    const student = await Student.findOne({ $or: [{ email }, { alternateEmail: email }] }).lean();
    if (student?.status === 'excused') return res.json(excusedPayload(student));
    if (student) return res.json({ exact: true, profile: await studentPayload(student) });
  }

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = await Student.find({
    $or: [
      { name: { $regex: escaped, $options: 'i' } },
      { email: { $regex: escaped, $options: 'i' } },
      { alternateEmail: { $regex: escaped, $options: 'i' } }
    ]
  }).sort({ name: 1 }).limit(12).lean();

  res.json({ exact: false, matches: matches.map(publicStudent) });
});

api.post('/confirm', async (req, res) => {
  if (!ALLOW_STUDENT_SEARCH) return res.status(403).json({ error: 'Student search is disabled. Please login from Samagama to view your Spurti Points.' });
  const { studentId, email } = req.body || {};
  const typed = normalizeEmail(email);
  const student = await Student.findById(studentId).lean();
  if (!student) return res.status(404).json({ error: 'Student not found' });
  if (typed !== normalizeEmail(student.email) && typed !== normalizeEmail(student.alternateEmail)) {
    return res.status(403).json({ error: 'Email did not match this record' });
  }
  if (student.status === 'excused') return res.json(excusedPayload(student));
  res.json(await studentPayload(student));
});

api.get('/leaderboard', async (req, res) => {
  const type = String(req.query.leaderboardType || 'overall');
  const filter = { status: { $ne: 'excused' } };
  if (type === 'my_onboarding_group' && req.query.group) filter.leaderboardGroup = String(req.query.group);
  const students = await Student.find(filter).sort({ totalSp: -1, name: 1 }).limit(50).lean();
  res.json(students.map((s, i) => ({
    rank: i + 1,
    name: s.name,
    maskedEmail: maskEmail(s.email),
    totalSp: s.totalSp,
    level: levelFor(Math.max(Number(s.highestSpEver) || 0, Number(s.totalSp) || 0)),
    trophyLeague: leagueBand(s.totalSp)
  })));
});

api.post('/ping', async (req, res) => {
  const { email, name, page } = req.body || {};
  const normalized = normalizeEmail(email);
  if (!normalized || !name || !page) return res.status(400).json({ error: 'email, name, page required' });
  // Telemetry is best-effort: an unknown page value (e.g. a new admin sub-page
  // not yet in the enum) must never crash the request or leak an unhandled
  // rejection. Drop the write and carry on.
  try {
    await SessionEvent.create({ email: normalized, name, event: 'page_view', page });
  } catch (err) {
    if (err?.name !== 'ValidationError') console.error('ping log failed:', err?.message);
  }
  if (page === 'record' || page.startsWith('admin')) {
    liveViewers.set(normalized, { name, page, lastSeen: new Date() });
  }
  res.json({ ok: true });
});

// --- Survey triangulation (mandatory perception follow-up) ---------------
// Mark a student's survey as completed for the given survey config. Idempotent;
// matches on primary or alternate email. No SP is awarded — mandatory, not rewarded.
async function markSurveyComplete(email, cfg) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const student = await Student.findOne({ $or: [{ email: normalized }, { alternateEmail: normalized }] });
  if (!student) return null;
  if (!student[cfg.completedField]) {
    student[cfg.completedField] = true;
    student[cfg.completedAtField] = new Date();
    await student.save();
  }
  return student;
}

// NOTE: there is deliberately NO client-callable "mark complete" endpoint. The
// flag is set ONLY by a real Google submission (the webhook below) or the
// server-side sheet sync, so the modal cannot be dismissed by trust. The client
// can only READ status via <base>/status and dismiss when it returns completed.
//
// Registers /<base>/status + /<base>/webhook for one survey config, so the
// original survey and poll2 share identical, independent route logic.
function registerSurveyRoutes(base, cfg) {
  // Completion check the modal polls and verifies on the "I've submitted" button.
  // Session-authenticated; reflects only server-set (webhook/sync) completion.
  api.get(`${base}/status`, async (req, res) => {
    const email = await studentEmailFromRequest(req);
    if (!email) return res.json({ completed: false });
    const student = await Student.findOne({ $or: [{ email }, { alternateEmail: email }] }).lean();
    if (student?.[cfg.completedField]) return res.json({ completed: true });
    // On-demand verification against the responses sheet (so the "I've submitted"
    // button confirms a genuine submission without waiting for the 10-min cron).
    const subs = await getSubmittedEmails(cfg);
    if (subs && student) {
      const e = normalizeEmail(student.email), a = normalizeEmail(student.alternateEmail);
      if (subs.has(e) || (a && subs.has(a))) {
        await markSurveyComplete(student.email, cfg);
        return res.json({ completed: true });
      }
    }
    res.json({ completed: false });
  });

  // Authoritative confirmation: the Google Form's Apps Script onFormSubmit
  // trigger POSTs { email, secret } here. Secret-authenticated, not session.
  api.post(`${base}/webhook`, async (req, res) => {
    if (!cfg.webhookSecret || String(req.body?.secret || '') !== cfg.webhookSecret) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    const student = await markSurveyComplete(req.body?.email, cfg);
    if (!student) return res.status(404).json({ ok: false, error: 'no match', email: normalizeEmail(req.body?.email) });
    res.json({ ok: true, email: student.email });
  });
}
registerSurveyRoutes('/survey', SURVEY);
registerSurveyRoutes('/poll2', POLL2);
registerSurveyRoutes('/poll3', POLL3);

api.get('/admin/stats', adminGuard, async (_req, res) => {
  const [yetToOnboard, excusedStudents, sessions, txns, activeStudents] = await Promise.all([
    Student.countDocuments({ status: 'yet to onboard' }),
    Student.countDocuments({ status: 'excused' }),
    Session.find().sort({ endDateTime: 1 }).lean(),
    SPTransaction.countDocuments(),
    Student.countDocuments({ status: 'active' })
  ]);
  res.json({ yetToOnboard, excusedStudents, activeStudents, sessions, transactions: txns });
});
api.get('/admin/students-by-status', adminGuard, async (req, res) => {
  const status = String(req.query.status || 'yet to onboard');
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 200)));
  const students = await Student.find({ status }).sort({ name: 1 }).limit(limit).lean();
  res.json(students.map(s => ({
    _id: String(s._id),
    name: s.name,
    email: s.email,
    totalSp: s.totalSp,
    internshipStartDate: s.internshipStartDate
  })));
});


api.get('/admin/leaderboard', adminGuard, async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 50)));
  const students = await Student.find({ status: 'active' }).sort({ totalSp: -1, name: 1 }).limit(limit).lean();
  res.json(students.map((s, i) => ({
    rank: i + 1,
    _id: String(s._id),
    name: s.name,
    email: s.email,
    totalSp: s.totalSp
  })));
});

api.get('/admin/attendance', adminGuard, async (_req, res) => {
  const [sessions, students, records] = await Promise.all([
    Session.find().sort({ endDateTime: 1 }).lean(),
    Student.find({ status: 'active' }).sort({ name: 1 }).lean(),
    AttendanceRecord.find().lean()
  ]);
  const byStudent = new Map();
  for (const record of records) byStudent.set(`${record.email}|${record.sessionLabel}`, record);
  res.json({
    sessions: sessions.map(s => ({ label: s.label, totalMinutes: s.totalMinutes })),
    students: students.map(student => ({
      _id: String(student._id),
      name: student.name,
      email: student.email,
      totalSp: student.totalSp,
      cells: Object.fromEntries(sessions.map(session => {
        const record = byStudent.get(`${student.email}|${session.label}`);
        return [session.label, record ? {
          minutes: record.attendedMinutes,
          totalMinutes: record.totalSessionMinutes,
          qualified: record.qualified,
          percentage: record.attendancePercentage
        } : null];
      }))
    }))
  });
});

api.get('/admin/student/:id', adminGuard, async (req, res) => {
  const student = await Student.findById(req.params.id).lean();
  if (!student) return res.status(404).json({ error: 'Student not found' });
  res.json(await studentPayload(student));
});

api.get('/admin/active', adminGuard, (_req, res) => {
  const now = new Date();
  const cutoff = now.getTime() - 60_000;
  const viewers = [];
  for (const [email, data] of liveViewers.entries()) {
    if (data.lastSeen.getTime() >= cutoff) {
      viewers.push({
        email,
        name: data.name,
        page: data.page,
        recordViewed: data.recordViewed,
        secondsAgo: Math.round((now.getTime() - data.lastSeen.getTime()) / 1000)
      });
    }
  }
  res.json(viewers);
});

api.get('/admin/analytics', adminGuard, async (_req, res) => {
  const now = new Date();
  const lastHour = new Date(now.getTime() - 60 * 60 * 1000);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [allStudents, sessions, attendance, transactions, events] = await Promise.all([
    Student.find().lean(),
    Session.find().sort({ endDateTime: 1 }).lean(),
    AttendanceRecord.find().lean(),
    SPTransaction.find().lean(),
    SessionEvent.find({ timestamp: { $gte: last30Days } }).lean()
  ]);
  const statusCounts = { active: 0, 'yet to onboard': 0, excused: 0 };
  for (const s of allStudents) { if (s.status in statusCounts) statusCounts[s.status]++; }
  const activeStudents = allStudents.filter(s => s.status === 'active');
  const activeEmails = new Set(activeStudents.map(student => student.email));
  const activeAttendance = attendance.filter(row => activeEmails.has(row.email));
  const activeTransactions = transactions.filter(row => activeEmails.has(row.email));
  const activeEvents = events.filter(row => activeEmails.has(row.email));

  const uniqueSince = (date) => new Set(activeEvents.filter(e => e.timestamp >= date).map(e => e.email)).size;
  const bucket = (date, mode) => {
    const d = new Date(date);
    if (mode === 'hour') return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:00`;
    if (mode === 'week') {
      const first = new Date(d.getFullYear(), 0, 1);
      const week = Math.ceil((((d - first) / 86400000) + first.getDay() + 1) / 7);
      return `${d.getFullYear()}-W${String(week).padStart(2,'0')}`;
    }
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  };
  const series = (mode, from) => {
    const map = new Map();
    for (const ev of activeEvents.filter(e => e.timestamp >= from)) {
      const key = bucket(ev.timestamp, mode);
      if (!map.has(key)) map.set(key, { label: key, events: 0, emails: new Set() });
      const row = map.get(key);
      row.events += 1;
      row.emails.add(ev.email);
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label)).map(r => ({ label: r.label, events: r.events, uniqueUsers: r.emails.size }));
  };

  const activeNow = [...liveViewers.values()].filter(v => now.getTime() - v.lastSeen.getTime() <= 60_000).length;
  const spValues = activeStudents.map(s => Number(s.totalSp || 0)).sort((a, b) => a - b);
  const avgSp = spValues.length ? Math.round(spValues.reduce((a, b) => a + b, 0) / spValues.length) : 0;
  const medianSp = spValues.length ? spValues[Math.floor(spValues.length / 2)] : 0;
  const spBands = {
    below100: spValues.filter(v => v < 100).length,
    from100to149: spValues.filter(v => v >= 100 && v < 150).length,
    from150to199: spValues.filter(v => v >= 150 && v < 200).length,
    from200plus: spValues.filter(v => v >= 200).length
  };

  const attendanceBySession = sessions.map(session => {
    const rows = activeAttendance.filter(a => a.sessionLabel === session.label);
    const qualified = rows.filter(r => r.qualified).length;
    const totalMinutes = rows.reduce((sum, r) => sum + Number(r.attendedMinutes || 0), 0);
    return {
      label: session.label,
      totalStudents: rows.length,
      qualified,
      notQualified: rows.length - qualified,
      qualifiedPct: rows.length ? Math.round((qualified / rows.length) * 100) : 0,
      avgMinutes: rows.length ? Math.round(totalMinutes / rows.length) : 0,
      sessionMinutes: session.totalMinutes
    };
  });

  const categoryTotals = ['initial', 'attendance', 'poll', 'manual'].map(category => {
    const rows = activeTransactions.filter(t => t.category === category);
    return {
      category,
      count: rows.length,
      netSp: rows.reduce((sum, t) => sum + Number(t.appliedDelta || 0), 0),
      credits: rows.filter(t => t.appliedDelta > 0).length,
      debits: rows.filter(t => t.appliedDelta < 0).length
    };
  });
  const attendanceDebits = activeTransactions.filter(t => t.category === 'attendance' && t.appliedDelta < 0);
  const pollDebits = activeTransactions.filter(t => t.category === 'poll' && t.appliedDelta < 0);
  const inactiveToday = activeStudents.length - new Set(activeEvents.filter(e => e.timestamp >= todayStart).map(e => e.email)).size;
  const lowSp = activeStudents.filter(s => Number(s.totalSp || 0) < 100).length;
  const topDrops = Object.values(attendanceDebits.concat(pollDebits).reduce((acc, txn) => {
    if (!acc[txn.email]) acc[txn.email] = { email: txn.email, debitCount: 0, debitSp: 0 };
    acc[txn.email].debitCount += 1;
    acc[txn.email].debitSp += Math.abs(Number(txn.appliedDelta || 0));
    return acc;
  }, {})).sort((a, b) => b.debitSp - a.debitSp).slice(0, 10);

  res.json({
    live: { activeNow },
    users: {
      activeLastHour: uniqueSince(lastHour),
      activeToday: uniqueSince(todayStart),
      activeLast7Days: uniqueSince(last7Days),
      activeLast30Days: uniqueSince(last30Days),
      hourly: series('hour', last24Hours(now)),
      weekly: series('week', last30Days),
      monthly: series('month', last30Days)
    },
    attendance: {
      sessions: attendanceBySession,
      overallQualifiedPct: activeAttendance.length ? Math.round((activeAttendance.filter(a => a.qualified).length / activeAttendance.length) * 100) : 0
    },
    sp: {
      students: activeStudents.length,
      statusCounts,
      average: avgSp,
      median: medianSp,
      min: spValues[0] || 0,
      max: spValues[spValues.length - 1] || 0,
      bands: spBands,
      categoryTotals
    },
    alerts: {
      lowSp,
      inactiveToday,
      attendanceDebits: attendanceDebits.length,
      pollDebits: pollDebits.length,
      topDrops
    }
  });
});

function last24Hours(now) {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000);
}

// ═══════════════════════════════════════════════════════════════════════════
// PEER REVIEW RUBRIC — 10 Yes/No questions for Phase 1 project evaluation
// Each question is worth 3 points (max 30 total)
// ═══════════════════════════════════════════════════════════════════════════
const PEER_REVIEW_RUBRIC = [
  { id: 1, question: "Is the claimed feature/fix verified with proof — does the report, README.md, or product.md include screenshots, links, or evidence that it actually works?", description: "Evaluates whether the student provided verifiable proof (screenshots, demo links, output samples) in their submission documents that the change works as claimed.", points: 3 },
  { id: 2, question: "Is the code change well-scoped — does it avoid unrelated modifications or unnecessary refactoring?", description: "Assesses whether the student kept the PR focused and avoided scope creep.", points: 3 },
  { id: 3, question: "Does the code follow the existing project conventions and patterns (naming, file structure, framework usage)?", description: "Checks if the change is consistent with how the rest of the codebase is written.", points: 3 },
  { id: 4, question: "Does the PR include a clear description explaining what was changed and why?", description: "Evaluates documentation quality — commit messages, PR description, and inline comments where needed.", points: 3 },
  { id: 5, question: "Does the project report follow the given format — correct sections, headings, structure, and length as specified?", description: "Evaluates whether the student adhered to the prescribed project report template and formatting guidelines.", points: 3 },
  { id: 6, question: "Is the product.md well-written with a clear problem statement, proposed solution, architecture overview, and future roadmap?", description: "Evaluates documentation quality — product.md should clearly explain what the feature/fix does, why it matters, and how it fits into the project.", points: 3 },
  { id: 7, question: "Is the code readable and easy to understand — are variable names clear, functions well-sized, and logic straightforward?", description: "Evaluates code clarity — another developer should be able to understand the change without difficulty.", points: 3 },
  { id: 8, question: "Does the implementation correctly use the project's tech stack (React, Express, Mongoose, TypeScript) without unnecessary dependencies?", description: "Checks if the student used the right tools from the existing stack rather than introducing new libraries.", points: 3 },
  { id: 9, question: "Is the project report well-structured with clear sections covering the problem, approach, implementation details, and results?", description: "Evaluates the project report PDF — should document the journey from understanding the problem to delivering the solution.", points: 3 },
  { id: 10, question: "Does the submission demonstrate problem-solving — does the student explain trade-offs, challenges faced, or alternative approaches considered?", description: "Evaluates critical thinking — the student should reflect on why they chose their approach and what difficulties they encountered.", points: 3 }
];
const PEER_REVIEW_MAX_POINTS = 30;

// ═══════════════════════════════════════════════════════════════════════════
// PEER REVIEW — Phase 1 project submission and peer evaluation
// ═══════════════════════════════════════════════════════════════════════════

api.get('/peer-review/rubric', async (req, res) => {
  const email = await studentEmailFromRequest(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ rubric: PEER_REVIEW_RUBRIC, maxPoints: PEER_REVIEW_MAX_POINTS });
});

api.post('/peer-review/submit', async (req, res) => {
  try {
    const email = await studentEmailFromRequest(req);
    if (!email) return res.status(401).json({ error: 'Not authenticated' });

    const student = await Student.findOne({ $or: [{ email }, { alternateEmail: email }] });
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const { prLink, projectReport, productMd } = req.body;
    if (!prLink || !projectReport || !productMd) {
      return res.status(400).json({ error: 'prLink, projectReport, and productMd are required' });
    }

    const existing = await PeerReviewSubmission.findOne({ studentEmail: email });
    if (existing) {
      return res.status(409).json({ error: 'Already submitted', submission: existing });
    }

    const submission = await PeerReviewSubmission.create({
      studentEmail: email,
      studentId: student._id,
      studentName: student.name,
      prLink,
      projectReport,
      productMd,
      status: 'submitted'
    });

    res.json({ success: true, submission });
  } catch (err) {
    console.error('peer-review submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

api.get('/peer-review/my-submission', async (req, res) => {
  try {
    const email = await studentEmailFromRequest(req);
    if (!email) return res.status(401).json({ error: 'Not authenticated' });

    const submission = await PeerReviewSubmission.findOne({ studentEmail: email }).lean();
    if (!submission) {
      return res.json({ submitted: false });
    }

    const reviews = await PeerReview.find({
      revieweeEmail: email,
      status: 'completed'
    }).select('reviewerNumber totalYesCount totalPoints percentageScore completedAt').lean();

    res.json({
      submitted: true,
      submission,
      reviews: reviews.map(r => ({
        reviewerNumber: r.reviewerNumber,
        score: r.totalYesCount,
        totalPoints: r.totalPoints,
        percentageScore: r.percentageScore,
        completedAt: r.completedAt
      })),
      averageScore: submission.averageScore,
      spAwarded: submission.spAwarded
    });
  } catch (err) {
    console.error('peer-review my-submission error:', err);
    res.status(500).json({ error: err.message });
  }
});

api.get('/peer-review/to-review', async (req, res) => {
  try {
    const email = await studentEmailFromRequest(req);
    if (!email) return res.status(401).json({ error: 'Not authenticated' });

    const mySubmission = await PeerReviewSubmission.findOne({ studentEmail: email });
    if (!mySubmission) {
      return res.status(400).json({ error: 'Must submit your project first', mustSubmit: true });
    }

    const completedReviews = await PeerReview.countDocuments({
      reviewerEmail: email,
      status: 'completed'
    });

    if (completedReviews >= 5) {
      return res.json({ canReview: false, message: 'You have completed all 5 reviews', completedReviews });
    }

    const reviewedEmails = await PeerReview.find({ reviewerEmail: email }).distinct('revieweeEmail');

    const availableSubmissions = await PeerReviewSubmission.find({
      studentEmail: { $ne: email, $nin: reviewedEmails },
      status: { $in: ['submitted', 'under_review'] }
    }).select('studentName studentEmail prLink submittedAt reviewCount').lean();

    res.json({
      canReview: true,
      completedReviews,
      mandatoryReviews: Math.min(completedReviews, 3),
      remainingReviews: 5 - completedReviews,
      remainingForSp: Math.max(0, 3 - completedReviews),
      submissions: availableSubmissions.map(s => ({
        _id: s._id,
        studentName: s.studentName,
        maskedEmail: maskEmail(s.studentEmail),
        prLink: s.prLink,
        submittedAt: s.submittedAt,
        reviewCount: s.reviewCount
      }))
    });
  } catch (err) {
    console.error('peer-review to-review error:', err);
    res.status(500).json({ error: err.message });
  }
});

api.post('/peer-review/start/:submissionId', async (req, res) => {
  try {
    const email = await studentEmailFromRequest(req);
    if (!email) return res.status(401).json({ error: 'Not authenticated' });

    const { submissionId } = req.params;
    const submission = await PeerReviewSubmission.findById(submissionId);
    if (!submission) return res.status(404).json({ error: 'Submission not found' });
    if (submission.studentEmail === email) {
      return res.status(400).json({ error: 'Cannot review your own submission' });
    }

    const existingReview = await PeerReview.findOne({
      reviewerEmail: email, revieweeEmail: submission.studentEmail
    });
    if (existingReview) {
      return res.status(409).json({ error: 'Already reviewing or reviewed this submission' });
    }

    const completedReviews = await PeerReview.countDocuments({ reviewerEmail: email, status: 'completed' });
    if (completedReviews >= 5) return res.status(400).json({ error: 'Already completed 5 reviews' });

    const existingReviewCount = await PeerReview.countDocuments({ revieweeEmail: submission.studentEmail, status: 'completed' });
    if (existingReviewCount >= 5) return res.status(400).json({ error: 'This submission already has 5 reviews' });

    const reviewerNumber = existingReviewCount + 1;
    const reviewer = await Student.findOne({ email });

    const review = await PeerReview.create({
      reviewerEmail: email, reviewerId: reviewer._id, reviewerName: reviewer.name,
      revieweeEmail: submission.studentEmail, revieweeId: submission.studentId, revieweeName: submission.studentName,
      reviewerNumber, submissionId: submission._id, status: 'pending', startedAt: new Date()
    });

    submission.status = 'under_review';
    await submission.save();

    res.json({
      success: true,
      review: {
        _id: review._id, reviewerNumber: review.reviewerNumber,
        submission: { prLink: submission.prLink, projectReport: submission.projectReport, productMd: submission.productMd, studentName: submission.studentName },
        rubric: PEER_REVIEW_RUBRIC, maxPoints: PEER_REVIEW_MAX_POINTS
      }
    });
  } catch (err) {
    console.error('peer-review start error:', err);
    res.status(500).json({ error: err.message });
  }
});

api.post('/peer-review/submit-review/:reviewId', async (req, res) => {
  try {
    const email = await studentEmailFromRequest(req);
    if (!email) return res.status(401).json({ error: 'Not authenticated' });

    const { reviewId } = req.params;
    const { responses } = req.body;

    if (!responses || !Array.isArray(responses) || responses.length !== 10) {
      return res.status(400).json({ error: 'Must provide exactly 10 responses' });
    }

    const review = await PeerReview.findById(reviewId);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (review.reviewerEmail !== email) return res.status(403).json({ error: 'Not authorized' });
    if (review.status !== 'pending') return res.status(400).json({ error: 'Review already submitted' });

    let totalYesCount = 0, totalPoints = 0;

    const processedResponses = responses.map((r, index) => {
      const rubricQuestion = PEER_REVIEW_RUBRIC[index];
      if (!rubricQuestion) throw new Error(`Invalid question index ${index}`);
      if (r.questionId !== rubricQuestion.id) throw new Error(`Question ID mismatch at index ${index}`);
      if (typeof r.answer !== 'boolean') throw new Error(`Answer must be boolean at question ${rubricQuestion.id}`);
      if (!r.explanation || r.explanation.trim().length < 10) {
        throw new Error(`Explanation must be at least 10 characters at question ${rubricQuestion.id}`);
      }
      const points = r.answer ? rubricQuestion.points : 0;
      if (r.answer) totalYesCount++;
      totalPoints += points;
      return { questionId: rubricQuestion.id, questionText: rubricQuestion.question, answer: r.answer, explanation: r.explanation.trim(), points };
    });

    const percentageScore = Math.round((totalPoints / PEER_REVIEW_MAX_POINTS) * 100);
    review.responses = processedResponses;
    review.totalYesCount = totalYesCount;
    review.totalPoints = totalPoints;
    review.percentageScore = percentageScore;
    review.status = 'completed';
    review.completedAt = new Date();
    await review.save();

    const submission = await PeerReviewSubmission.findById(review.submissionId);
    submission.reviewCount += 1;
    const allReviews = await PeerReview.find({ revieweeEmail: submission.studentEmail, status: 'completed' });
    const avgScore = allReviews.reduce((sum, r) => sum + r.percentageScore, 0) / allReviews.length;
    submission.averageScore = Math.round(avgScore);
    submission.totalPoints = allReviews.reduce((sum, r) => sum + r.totalPoints, 0);

    let revieweeSpAwarded = 0;
    if (allReviews.length === 3) {
      const finalAvg = allReviews.reduce((sum, r) => sum + r.percentageScore, 0) / 3;
      revieweeSpAwarded = finalAvg === 100 ? 30 : Math.round((finalAvg / 100) * 30);
      submission.spAwarded = revieweeSpAwarded;
      submission.spAwardedAt = new Date();
      submission.status = 'reviewed';

      const reviewee = await Student.findOne({ email: submission.studentEmail });
      if (reviewee) {
        const currentBalance = Number(reviewee.totalSp) || 0;
        await SPTransaction.create({
          email: reviewee.email, studentId: reviewee._id, category: 'peer_review',
          sessionLabel: 'Phase 1 Peer Review', deltaMode: 'absolute', deltaValue: revieweeSpAwarded,
          appliedDelta: revieweeSpAwarded, balanceAfter: currentBalance + revieweeSpAwarded,
          reason: `Peer Review: Received 3 peer reviews with ${Math.round(finalAvg)}% average score`,
          dateTime: new Date()
        });
        await Student.updateOne({ _id: reviewee._id }, { $inc: { totalSp: revieweeSpAwarded } });
      }
    }

    await submission.save();

    let reviewerSpAwarded = 0;
    const reviewerCompletedCount = await PeerReview.countDocuments({ reviewerEmail: email, status: 'completed' });

    if (reviewerCompletedCount === 3) {
      reviewerSpAwarded = 50;
      const reviewer = await Student.findOne({ email });
      if (reviewer) {
        const currentBalance = Number(reviewer.totalSp) || 0;
        await SPTransaction.create({
          email: reviewer.email, studentId: reviewer._id, category: 'peer_review',
          sessionLabel: 'Phase 1 Peer Review', deltaMode: 'absolute', deltaValue: reviewerSpAwarded,
          appliedDelta: reviewerSpAwarded, balanceAfter: currentBalance + reviewerSpAwarded,
          reason: 'Peer Review: Completed 3 peer reviews', dateTime: new Date()
        });
        await Student.updateOne({ _id: reviewer._id }, { $inc: { totalSp: reviewerSpAwarded } });
        review.reviewerSpAwarded = reviewerSpAwarded;
        review.reviewerSpAwardedAt = new Date();
        await review.save();
      }
    }

    res.json({
      success: true,
      review: { _id: review._id, totalYesCount: review.totalYesCount, totalPoints: review.totalPoints, percentageScore: review.percentageScore },
      submission: { reviewCount: submission.reviewCount, averageScore: submission.averageScore, spAwarded: submission.spAwarded },
      revieweeSpAwarded, reviewerSpAwarded, reviewerCompletedCount,
      message: reviewerSpAwarded > 0
        ? `Congratulations! You've completed 3 mandatory reviews and earned ${reviewerSpAwarded} SP!`
        : revieweeSpAwarded > 0
          ? `Review submitted. The reviewee earned ${revieweeSpAwarded} SP from 3 peer reviews!`
          : `Review submitted. ${Math.max(0, 3 - reviewerCompletedCount)} more mandatory reviews for SP reward.`
    });
  } catch (err) {
    console.error('peer-review submit-review error:', err);
    res.status(500).json({ error: err.message });
  }
});

api.get('/peer-review/my-reviews-given', async (req, res) => {
  try {
    const email = await studentEmailFromRequest(req);
    if (!email) return res.status(401).json({ error: 'Not authenticated' });

    const reviews = await PeerReview.find({ reviewerEmail: email })
      .select('revieweeName reviewerNumber totalYesCount totalPoints percentageScore status completedAt reviewerSpAwarded')
      .lean();

    const completedCount = reviews.filter(r => r.status === 'completed').length;
    res.json({
      reviews, completedCount,
      mandatoryCompleted: Math.min(completedCount, 3),
      remainingCount: 5 - completedCount,
      remainingForSp: Math.max(0, 3 - completedCount),
      spAwarded: completedCount >= 3 ? (reviews[0]?.reviewerSpAwarded || 50) : 0
    });
  } catch (err) {
    console.error('peer-review my-reviews-given error:', err);
    res.status(500).json({ error: err.message });
  }
});

api.get('/admin/peer-review/submissions', adminGuard, async (req, res) => {
  try {
    const submissions = await PeerReviewSubmission.find().sort({ submittedAt: -1 }).lean();
    res.json(submissions.map(s => ({
      _id: s._id, studentName: s.studentName, studentEmail: s.studentEmail, prLink: s.prLink,
      submittedAt: s.submittedAt, status: s.status, reviewCount: s.reviewCount,
      averageScore: s.averageScore, totalPoints: s.totalPoints, spAwarded: s.spAwarded
    })));
  } catch (err) {
    console.error('admin peer-review submissions error:', err);
    res.status(500).json({ error: err.message });
  }
});

api.get('/admin/peer-review/reviews', adminGuard, async (req, res) => {
  try {
    const { status, revieweeEmail, reviewerEmail } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (revieweeEmail) filter.revieweeEmail = revieweeEmail;
    if (reviewerEmail) filter.reviewerEmail = reviewerEmail;
    const reviews = await PeerReview.find(filter).sort({ createdAt: -1 }).lean();
    res.json(reviews);
  } catch (err) {
    console.error('admin peer-review reviews error:', err);
    res.status(500).json({ error: err.message });
  }
});

api.get('/admin/peer-review/stats', adminGuard, async (req, res) => {
  try {
    const [totalSubmissions, completedReviews, pendingSubmissions] = await Promise.all([
      PeerReviewSubmission.countDocuments(),
      PeerReview.countDocuments({ status: 'completed' }),
      PeerReviewSubmission.countDocuments({ status: 'submitted' })
    ]);
    const spStats = await PeerReviewSubmission.aggregate([
      { $match: { spAwarded: { $gt: 0 } } },
      { $group: { _id: null, totalSpAwardedToReviewees: { $sum: '$spAwarded' }, avgScore: { $avg: '$averageScore' } } }
    ]);
    const reviewerSpStats = await PeerReview.aggregate([
      { $match: { reviewerSpAwarded: { $gt: 0 } } },
      { $group: { _id: null, totalSpAwardedToReviewers: { $sum: '$reviewerSpAwarded' }, totalReviewersRewarded: { $sum: 1 } } }
    ]);
    res.json({
      totalSubmissions, completedReviews, pendingSubmissions,
      totalSpAwardedToReviewees: spStats[0]?.totalSpAwardedToReviewees || 0,
      totalSpAwardedToReviewers: reviewerSpStats[0]?.totalSpAwardedToReviewers || 0,
      totalReviewersRewarded: reviewerSpStats[0]?.totalReviewersRewarded || 0,
      averageScore: Math.round(spStats[0]?.avgScore || 0)
    });
  } catch (err) {
    console.error('admin peer-review stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use('/api', api);
app.use('/spurti/api', api);

if (fs.existsSync(clientDist)) {
  app.use('/spurti', express.static(clientDist));
  app.use(express.static(clientDist));
  app.get('/spurti/*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
} else {
  app.get('*', (_req, res) => res.status(404).send('Build the client first with npm run build.'));
}

mongoose.connect(MONGO_URI).then(() => {
  app.listen(PORT, () => console.log(`Spurti app running at http://localhost:${PORT}/`));
}).catch((error) => {
  console.error(error);
  process.exit(1);
});


