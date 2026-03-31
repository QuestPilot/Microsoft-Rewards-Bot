import fs from "fs";
import path from "path";

/**
 * Try to load all points from sessions
 */
export function loadAllPointsFromSessions(): Map<string, number> {
  const pointsMap = new Map<string, number>();

  try {
    const sessionsDir = path.join(process.cwd(), "sessions");
    if (!fs.existsSync(sessionsDir)) {
      return pointsMap;
    }

    const files = fs.readdirSync(sessionsDir);

    for (const filename of files) {
      if (!filename.endsWith(".json")) continue;

      try {
        const filepath = path.join(sessionsDir, filename);
        const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));

        const email = data.email || data.account?.email;
        const points = data.points || data.availablePoints;

        if (email && points !== undefined) {
          pointsMap.set(email, points);
        }
      } catch (error) {
        // Skip invalid files
        continue;
      }
    }
  } catch {
    // Silently ignore: session loading is optional fallback
  }

  return pointsMap;
}

/**
 * Try to load points from job state
 */
export function loadPointsFromJobState(email: string): number | undefined {
  try {
    const jobStateDir = path.join(process.cwd(), "sessions", "job-state");
    if (!fs.existsSync(jobStateDir)) {
      return undefined;
    }

    const files = fs.readdirSync(jobStateDir);

    for (const filename of files) {
      if (!filename.endsWith(".json")) continue;

      try {
        const filepath = path.join(jobStateDir, filename);
        const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));

        if (data.email === email || data.account === email) {
          return data.points || data.availablePoints;
        }
      } catch (error) {
        continue;
      }
    }

    return undefined;
  } catch {
    // Silently ignore: job state loading is optional fallback
    return undefined;
  }
}
