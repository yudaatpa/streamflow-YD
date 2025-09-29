// services/schedulerService.js
const Stream = require('../models/Stream');

const scheduledTerminations = new Map();
const SCHEDULE_LOOKAHEAD_SECONDS = 60;

let streamingService = null;

function init(streamingServiceInstance) {
  streamingService = streamingServiceInstance;
  console.log('[Scheduler] Stream scheduler initialized');

  // cek berkala
  setInterval(checkScheduledStreams, 60 * 1000);
  setInterval(checkStreamDurations, 60 * 1000);

  // cek awal saat boot
  checkScheduledStreams();
  checkStreamDurations();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function checkScheduledStreams() {
  try {
    if (!streamingService) {
      console.error('[Scheduler] StreamingService not initialized in scheduler');
      return;
    }

    const now = new Date();
    const lookAheadTime = new Date(now.getTime() + SCHEDULE_LOOKAHEAD_SECONDS * 1000);
    console.log(`[Scheduler] Checking for scheduled streams (${now.toISOString()} to ${lookAheadTime.toISOString()})`);

    const streams = await Stream.findScheduledInRange(now, lookAheadTime);
    if (!streams || streams.length === 0) return;

    console.log(`[Scheduler] Found ${streams.length} stream(s) to start`);
    for (const stream of streams) {
      try {
        console.log(`[Scheduler] Preparing to start stream: ${stream.id} - ${stream.title}`);

        // Berhenti dulu jika ada instance sebelumnya yang belum bersih
        await streamingService.stopStream(stream.id);

        // Pastikan benar-benar non-aktif sebelum start (anti duplikat koneksi ke primary)
        if (typeof streamingService.waitForInactive === 'function') {
          await streamingService.waitForInactive(stream.id, 15000);
        } else {
          await sleep(1500);
        }
        await sleep(500); // jeda ekstra aman

        const result = await streamingService.startStream(stream.id);
        if (result.success) {
          console.log(`[Scheduler] Successfully started scheduled stream: ${stream.id}`);
          if (stream.duration) {
            scheduleStreamTermination(stream.id, stream.duration);
          }
        } else {
          console.error(`[Scheduler] Failed to start scheduled stream ${stream.id}: ${result.error}`);
        }
      } catch (err) {
        console.error(`[Scheduler] Error handling scheduled start for ${stream.id}:`, err);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Error checking scheduled streams:', error);
  }
}

async function checkStreamDurations() {
  try {
    if (!streamingService) {
      console.error('[Scheduler] StreamingService not initialized in scheduler');
      return;
    }

    const liveStreams = await Stream.findAll(null, 'live');
    if (!liveStreams || liveStreams.length === 0) return;

    for (const stream of liveStreams) {
      try {
        if (stream.duration && stream.start_time && !scheduledTerminations.has(stream.id)) {
          const startTime = new Date(stream.start_time);
          const durationMs = stream.duration * 60 * 1000;
          const shouldEndAt = new Date(startTime.getTime() + durationMs);
          const now = new Date();

          if (shouldEndAt <= now) {
            console.log(`[Scheduler] Stream ${stream.id} exceeded duration, stopping now`);
            await streamingService.stopStream(stream.id);
            await sleep(1500); // jeda aman
          } else {
            const timeUntilEndMs = shouldEndAt.getTime() - now.getTime();
            scheduleStreamTermination(stream.id, timeUntilEndMs / 60000);
          }
        }
      } catch (err) {
        console.error(`[Scheduler] Error checking duration for ${stream.id}:`, err);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Error checking stream durations:', error);
  }
}

function scheduleStreamTermination(streamId, durationMinutes) {
  try {
    if (scheduledTerminations.has(streamId)) {
      clearTimeout(scheduledTerminations.get(streamId));
    }

    const durationMs = Math.max(0, Math.floor(durationMinutes * 60 * 1000));
    console.log(`[Scheduler] Scheduling termination for stream ${streamId} after ${durationMinutes.toFixed ? durationMinutes.toFixed(2) : durationMinutes} minutes`);

    const timeoutId = setTimeout(async () => {
      try {
        console.log(`[Scheduler] Terminating stream ${streamId} after scheduled duration`);
        await streamingService.stopStream(streamId);
      } catch (error) {
        console.error(`[Scheduler] Error terminating stream ${streamId}:`, error);
      } finally {
        scheduledTerminations.delete(streamId);
      }
    }, durationMs);

    scheduledTerminations.set(streamId, timeoutId);
  } catch (error) {
    console.error('[Scheduler] scheduleStreamTermination error:', error);
  }
}

function cancelStreamTermination(streamId) {
  if (scheduledTerminations.has(streamId)) {
    clearTimeout(scheduledTerminations.get(streamId));
    scheduledTerminations.delete(streamId);
    console.log(`[Scheduler] Cancelled scheduled termination for stream ${streamId}`);
    return true;
  }
  return false;
}

function handleStreamStopped(streamId) {
  return cancelStreamTermination(streamId);
}

module.exports = {
  init,
  scheduleStreamTermination,
  cancelStreamTermination,
  handleStreamStopped
};
