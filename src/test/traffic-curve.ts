export type Waypoint = {
  timeMs: number;
  target: number; // 0.0–1.0
};

export type TrafficCurve = {
  waypoints: Waypoint[];
  currentTarget: number;
  tick(elapsedMs: number): void;
  describe(): string;
};

/**
 * Generate a random traffic curve spanning durationMs.
 * Produces waypoints with linear interpolation between them.
 */
export function generateCurve(durationMs: number): TrafficCurve {
  const waypoints: Waypoint[] = [];

  // Start at time 0 with a random target between 10–50%
  waypoints.push({ timeMs: 0, target: randBetween(0.1, 0.5) });

  let currentTime = 0;
  while (currentTime < durationMs) {
    // Random segment duration: 0.5–5 minutes
    const segmentMs = randBetween(30_000, 300_000);
    currentTime += segmentMs;

    if (currentTime >= durationMs) {
      // Final waypoint at exactly the end
      waypoints.push({ timeMs: durationMs, target: randBetween(0.1, 0.95) });
      break;
    }

    waypoints.push({ timeMs: currentTime, target: randBetween(0.1, 0.95) });
  }

  const curve: TrafficCurve = {
    waypoints,
    currentTarget: waypoints[0].target,

    tick(elapsedMs: number) {
      // Find bracketing waypoints and linearly interpolate
      if (elapsedMs <= 0) {
        curve.currentTarget = waypoints[0].target;
        return;
      }
      if (elapsedMs >= waypoints[waypoints.length - 1].timeMs) {
        curve.currentTarget = waypoints[waypoints.length - 1].target;
        return;
      }

      for (let i = 0; i < waypoints.length - 1; i++) {
        const a = waypoints[i];
        const b = waypoints[i + 1];
        if (elapsedMs >= a.timeMs && elapsedMs < b.timeMs) {
          const t = (elapsedMs - a.timeMs) / (b.timeMs - a.timeMs);
          curve.currentTarget = a.target + t * (b.target - a.target);
          return;
        }
      }
    },

    describe(): string {
      const lines: string[] = ["Traffic curve waypoints:"];
      for (const wp of waypoints) {
        const pct = (wp.target * 100).toFixed(0);
        lines.push(`  ${formatTime(wp.timeMs)} → ${pct}%`);
      }
      return lines.join("\n");
    },
  };

  return curve;
}

function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m${sec > 0 ? sec + "s" : ""}`;
}
