import crypto from 'crypto';
import mongoose from 'mongoose';

// A permanent, once-earned achievement. Rank achievements (podium places on a
// leaderboard) are awarded by the leaderboard build; milestone ones (Legend,
// level, 3600-min club) are awarded on read off the student's own record.
//
// Each is stored ONCE PER BOARD PER PERIOD: a weekly win carries its week, so
// winning Polls in two different weeks is two achievements and two shareable
// cards, while the same week rebuilt six-hourly stays one. Every row gets a
// `verifyId` so the card's QR can resolve to it.
const achievementSchema = new mongoose.Schema({
  studentId: { type: String, required: true, index: true },
  achId: { type: String, required: true },   // e.g. rank:poll:week:2026-08-03:1 | ms:legend
  kind: { type: String, enum: ['rank', 'milestone'], default: 'rank' },
  board: { type: String, default: '' },      // poll | attendance | spa | query | total (rank only)
  place: { type: Number, default: 0 },       // 1 | 2 | 3 (rank only)
  icon: { type: String, default: '🏆' },
  title: { type: String, required: true },   // e.g. "Poll Champion"
  period: { type: String, default: '' },     // "Week of Aug 3–9" | "All-time"
  detail: { type: String, default: '' },     // stat line, e.g. "240 SP"
  verifyId: { type: String, index: true },   // public code, e.g. SPRT-4F2A-9C1D
  earnedAt: { type: Date, default: Date.now }
}, { timestamps: true });

achievementSchema.index({ studentId: 1, achId: 1 }, { unique: true });

// Crockford-ish alphabet: no I/L/O/U/0/1, so a code read off a printed card is
// unambiguous. 8 chars from 30 symbols ≈ 6.6e11 combinations.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newVerifyId() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `SPRT-${s.slice(0, 4)}-${s.slice(4, 8)}`;
}

export default mongoose.model('Achievement', achievementSchema);
