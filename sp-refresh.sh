#!/bin/bash
# sp-refresh.sh — sakshi-side Spurti SP refresh.
#
# Re-scores SP from the sakshi_spurti mirrors and then refreshes the derived
# Levels / Trophy-League / Legend fields, so any new SP change is picked up and
# shown to students. Owned by sakshi (see memory: spurti-scoring-ownership).
#
# Steps (step 2 only runs if step 1 succeeds):
#   1. pipeline/sp-rubric-build-mirror.cjs  APPLY=1  (auto-backs-up sptransactions
#      + students into sp-runs/ before writing)
#   2. sync-levels.cjs                       (idempotent, derived-only)
#
# The /spurti app reads sakshi_spurti live, so students see the new numbers
# immediately; the samagama-side `updatespurti` cron carries them into chatengine
# on its next even-hour run. No app restart needed.
#
# Self-flocking (single instance) so manual runs and cron can't overlap.
# Scheduled from the sakshi crontab at 06:00/12:00/18:00/00:00 UTC
# = 11:30 / 17:30 / 23:30 / 05:30 IST (every 6h, anchored on 11:30 IST).
set -euo pipefail

REPO=/home/sakshi/spurti
OUT_DIR="$REPO/sp-runs"
LOG="$REPO/logs/sp-refresh.log"
NODE=/usr/bin/node

cd "$REPO"
mkdir -p "$OUT_DIR" "$REPO/logs"

# Single-instance guard: re-exec under an exclusive lock on our own fd.
exec 9>"/tmp/sp-refresh.lock"
if ! flock -n 9; then
  echo "[$(date -u +%FT%TZ)] another sp-refresh is running; skipping" >> "$LOG"
  exit 0
fi

log() { echo "[$(date -u +%FT%TZ)] $*" >> "$LOG"; }

log "=== sp-refresh start ==="

# Load guard: the APPLY rewrites ~90k sptransactions; doing that under heavy load
# has OOM-crashed mongod (2026-08-04). Wait for the 1-min load to drop below
# MAX_LOAD; if it stays high for ~30 min, skip this cycle (the next cron retries).
# Override with FORCE=1 for an urgent manual run.
MAX_LOAD="${MAX_LOAD:-12}"
if [ "${FORCE:-0}" != "1" ]; then
  waited=0
  while :; do
    load1=$(awk '{print int($1)}' /proc/loadavg)
    if [ "$load1" -lt "$MAX_LOAD" ]; then break; fi
    if [ "$waited" -ge 1800 ]; then
      log "load ${load1} >= ${MAX_LOAD} for 30 min; SKIPPING this cycle (next cron retries)"
      exit 0
    fi
    log "load ${load1} >= ${MAX_LOAD}; waiting 60s (waited ${waited}s)"
    sleep 60; waited=$((waited+60))
  done
fi

# Step 0: pull the latest Spandan evening-poll sessions (incremental). Non-fatal:
# if the API is down we still re-score with whatever is already mirrored.
if "$NODE" pipeline/spandan-poll-fetch.cjs >> "$LOG" 2>&1; then
  log "spandan fetch ok"
else
  log "spandan fetch FAILED (non-fatal) — scoring with existing spandan_polls"
fi

# Step 1: re-score (APPLY). Backs up before writing.
if APPLY=1 OUT_DIR="$OUT_DIR" "$NODE" --max-old-space-size=2048 \
     pipeline/sp-rubric-build-mirror.cjs >> "$LOG" 2>&1; then
  log "rubric APPLY ok"
else
  log "rubric APPLY FAILED — skipping sync-levels (SP ledger untouched on failure)"
  exit 1
fi

# Step 2: refresh derived Levels / Trophy League / Legend fields.
if "$NODE" sync-levels.cjs >> "$LOG" 2>&1; then
  log "sync-levels ok"
else
  log "sync-levels FAILED — SP applied but derived level fields may be stale"
  exit 1
fi

# Step 2b: fold attendance minutes into attendancerecords (drives the My-Journey
# 3600-minute standup goal). Parses "present X of Y min (Z%)" from the attendance
# transactions the rubric just wrote. Non-fatal — SP is unaffected if this fails.
if "$NODE" pipeline/sync-attendance-records.cjs >> "$LOG" 2>&1; then
  log "sync-attendance-records ok"
else
  log "sync-attendance-records FAILED (non-fatal) — attendance minutes/3600 goal may be stale"
fi

# Step 3: rebuild the SP-trajectory snapshot (cohort/group reference lines for the
# student trajectory modal). Non-fatal — the student's own line is always live.
if "$NODE" server/scripts/buildTrajectories.js >> "$LOG" 2>&1; then
  log "trajectory snapshot ok"
else
  log "trajectory snapshot FAILED (non-fatal) — cohort lines may be stale"
fi

# Step 3b: rebuild cached leaderboard boards (weekly/all-time/category/cohort).
if "$NODE" server/scripts/buildLeaderboards.js >> "$LOG" 2>&1; then log "leaderboards ok"; else log "leaderboards FAILED (non-fatal)"; fi

# Housekeeping: weekly retention — keep last 2 days of dailies + 1 snapshot/week for 12 weeks.
OUT_DIR="$OUT_DIR" WEEKS=12 DAILY_DAYS=2 "$REPO/sp-runs-retention.sh" >> "$LOG" 2>&1 || true

log "=== sp-refresh done ==="
