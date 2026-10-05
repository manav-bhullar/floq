const cron = require('node-cron');
const { runMatchingCycle } = require('../integrations/matchingIntegration');
const { acquireLock, releaseLock } = require('../../utils/lock');

// Distributed lock key — shared across all instances/processes
const MATCHING_LOCK_KEY = 'matching:cron:lock';

// Lock TTL must be comfortably longer than the worst-case cycle time.
// If a process crashes mid-cycle, Redis auto-releases the lock after this.
const MATCHING_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

let schedulerStarted = false;

function startMatchingScheduler() {
  if (schedulerStarted) {
    console.warn('⚠️ Scheduler already started. Ignoring duplicate start.');
    return;
  }
  schedulerStarted = true;

  cron.schedule('*/45 * * * * *', async () => {
    let lock = null;
    try {
      // Attempt to acquire the distributed lock — fails instantly if held
      lock = await acquireLock(MATCHING_LOCK_KEY, MATCHING_LOCK_TTL_MS);

      if (!lock) {
        console.log('⏭️  Skipping overlapping batch — another instance holds the lock');
        return;
      }

      console.log('🚀 Running matching batch...');
      const metrics = await runMatchingCycle('CRON');

      console.log(
        `✅ Matching batch completed | tripsCreated=${metrics.tripsCreated} ` +
        `usersMatched=${metrics.usersMatched} pendingRemaining=${metrics.usersStillPending} ` +
        `autoCancelled=${metrics.autoCancelledCount} durationMs=${metrics.durationMs}`
      );
    } catch (err) {
      console.error('❌ Matching batch failed:', err);
    } finally {
      // Always release the lock, even if the batch threw
      if (lock) {
        const released = await releaseLock(lock);
        if (!released) {
          console.warn('⚠️ Lock already expired before release — cycle took longer than TTL');
        }
      }
    }
  });

  console.log(`✅ Matching scheduler started (distributed lock: ${MATCHING_LOCK_KEY})`);
}

module.exports = {
  startMatchingScheduler,
};
