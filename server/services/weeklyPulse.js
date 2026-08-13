/**
 * Spurti Weekly SP Pulse.
 *
 * These are DERIVED VIEWS over existing SP data — pure functions, no DB access,
 * no side effects. SP transactions and balances are never changed here.
 *
 * weeklySpBreakdown: a rolling 7-day breakdown of one student's SP by category,
 *   plus the single biggest debits (the "Autopsy" digest). Fed the `transactions`
 *   array already fetched by studentPayload — no extra query.
 *
 * weeklyTorchHolder: the student with the highest NET weekly SP, read from the
 *   top of the cached week-total leaderboard snapshot (week:total:all). The
 *   snapshot is built by the 6-hourly sp-refresh cron, so this never runs a
 *   transaction aggregation on a request — it just inspects already-computed
 *   rows. The weekly board excludes the +100 `initial` joining grant for the
 *   same reason the leaderboard does: the torch measures what you DID this
 *   week, not that you joined.
 */

export function weeklySpBreakdown(transactions = [], options = {}) {
  const referenceDate = options.referenceDate || new Date();
  const windowDays = options.windowDays || 7;

  const cutoffTime = referenceDate.getTime() - (windowDays * 24 * 60 * 60 * 1000);

  const windowTransactions = (transactions || []).filter(tx => {
    const txTime = new Date(tx.dateTime).getTime();
    return txTime >= cutoffTime && txTime <= referenceDate.getTime();
  });

  const categoryMap = {};
  let overallNet = 0;
  let overallGained = 0;
  let overallLost = 0;

  const debits = [];

  for (const tx of windowTransactions) {
    const delta = Number(tx.appliedDelta) || 0;
    const cat = tx.category || 'unknown';

    if (!categoryMap[cat]) {
      categoryMap[cat] = { netSp: 0, credits: 0, debits: 0 };
    }

    categoryMap[cat].netSp += delta;
    overallNet += delta;

    if (delta > 0) {
      categoryMap[cat].credits += delta;
      overallGained += delta;
    } else if (delta < 0) {
      categoryMap[cat].debits += Math.abs(delta);
      overallLost += Math.abs(delta);
      debits.push({
        reason: tx.reason,
        sessionLabel: tx.sessionLabel || '',
        amount: Math.abs(delta)
      });
    }
  }

  // topLossReasons: the 3 biggest single debits, most-negative first.
  debits.sort((a, b) => b.amount - a.amount);
  const topLossReasons = debits.slice(0, 3);

  return {
    windowDays,
    netSp: overallNet,
    gained: overallGained,
    lost: overallLost,
    byCategory: categoryMap,
    topLossReasons
  };
}

// Rows are a cached week-total leaderboard snapshot's rows (sorted desc by sp).
// Returns the torch holder — the top row when it actually gained SP — else null.
export function weeklyTorchHolder(rows = []) {
  const top = rows[0];
  if (!top || Number(top.sp) <= 0) return null;
  return { studentId: top.studentId, name: top.name || '', netSp: Number(top.sp) };
}
