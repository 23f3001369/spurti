import mongoose from 'mongoose';

// A permanent, once-earned achievement for a student. Rank-based achievements
// (#1 on a board, Top 10/50) are awarded by the leaderboard build and persisted
// here so they survive later rank drops ("if you were EVER #1"). Monotonic ones
// (Legend, level milestones, 3600-min club) are derived at request time from the
// student's own always-increasing fields and are NOT stored here.
const achievementSchema = new mongoose.Schema({
  studentId: { type: String, required: true, index: true },
  achId: { type: String, required: true },   // stable id, e.g. fp:week:poll:all:2026-08-03
  icon: { type: String, default: '🏆' },
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
  earnedAt: { type: Date, default: Date.now }
}, { timestamps: true });

achievementSchema.index({ studentId: 1, achId: 1 }, { unique: true });

export default mongoose.model('Achievement', achievementSchema);
