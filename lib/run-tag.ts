/**
 * Single, deterministic run classifier.
 *
 * Classification uses only metrics that are stable across the table view
 * (distance, duration, avg/max HR, name hint) so that every surface displays
 * the SAME tag for a given run. Heart-rate intensity is normalized against a
 * per-user reference max HR — if you've ever hit 195 bpm in another run, this
 * run's 162 bpm average will read as tempo (not threshold).
 *
 * If we don't have enough data to classify confidently, we return the
 * "unclassified" tag so the user can see at a glance which runs lack signal.
 */

/**
 * Minimum runs in a rolling window before we trust adaptive percentiles
 * (HR cutoffs, long-run distance, duration heuristics). Matches small windows
 * (e.g. last 10 runs) while staying above pure guesswork.
 */
export const MIN_SAMPLES_FOR_ROLLING_ADAPTIVE = 4;

export type RunTagId =
  | "race"
  | "long"
  | "intervals"
  | "tempo"
  | "threshold"
  | "easy"
  | "recovery"
  | "unclassified";

export type RunTag = {
  id: RunTagId;
  label: string;
  /** Short caption shown in the expanded panel. */
  description: string;
  /** Solid color used for the badge dot, sparkline, and accents. */
  color: string;
};

const TAGS: Record<RunTagId, Omit<RunTag, "id">> = {
  race: {
    label: "Race",
    description: "Race-day or all-out effort (≥92% of max HR).",
    color: "#a855f7",
  },
  long: {
    label: "Long run",
    description: "Long-distance aerobic run (≥10 mi).",
    color: "#3b82f6",
  },
  intervals: {
    label: "Intervals",
    description: "Short, hard workout above threshold (≥88% max HR, <45 min).",
    color: "#f97316",
  },
  threshold: {
    label: "Threshold",
    description: "Sustained effort near lactate threshold (85–88% max HR).",
    color: "#ef4444",
  },
  tempo: {
    label: "Tempo",
    description: "Comfortably hard aerobic effort (78–85% max HR).",
    color: "#f59e0b",
  },
  easy: {
    label: "Easy",
    description: "Conversational aerobic effort (65–78% max HR).",
    color: "#22c55e",
  },
  recovery: {
    label: "Recovery",
    description: "Short, low-HR shakeout (<65% max HR).",
    color: "#06b6d4",
  },
  unclassified: {
    label: "Unclassified",
    description: "Not enough data to classify (missing HR or distance).",
    color: "#94a3b8",
  },
};

/**
 * Strava-style Z1–Z5 bar colors, aligned with classification tag accents
 * (recovery → intervals) so expanded zone logs match the classification key.
 */
export const HEARTRATE_ZONE_BAR_COLORS = [
  TAGS.recovery.color,
  TAGS.easy.color,
  TAGS.tempo.color,
  TAGS.intervals.color,
  TAGS.threshold.color,
  TAGS.race.color,
] as const;

function tagOf(id: RunTagId): RunTag {
  return { id, ...TAGS[id] };
}

const NAME_RULES: Array<{ regex: RegExp; tag: RunTagId }> = [
  { regex: /\b(race|championship|relay|grand[\s-]*prix)\b/i, tag: "race" },
  {
    regex: /\b(5\s*k|10\s*k|half\s*marathon|\bhm\b|marathon|10\s*mile|10\s*mi)\b/i,
    tag: "race",
  },
  { regex: /\b(long\s*run|\blr\b)\b/i, tag: "long" },
  {
    regex: /\b(interval|intervals|workout|fartlek|repeats?|track|hill\s*repeats|x\s*\d+)\b/i,
    tag: "intervals",
  },
  { regex: /\b(threshold|\blt\b|\bcv\b|critical\s*velocity)\b/i, tag: "threshold" },
  { regex: /\b(tempo)\b/i, tag: "tempo" },
  {
    regex: /\b(recovery|shake[\s-]?out|cool[\s-]?down|warm[\s-]?up)\b/i,
    tag: "recovery",
  },
  { regex: /\b(easy|chill|jog)\b/i, tag: "easy" },
];

function classifyFromName(name: string | null | undefined): RunTagId | null {
  if (!name) return null;
  for (const r of NAME_RULES) {
    if (r.regex.test(name)) return r.tag;
  }
  return null;
}

export type ClassifyInput = {
  name?: string | null;
  distanceMeters?: number | null;
  movingTimeSec?: number | null;
  averageHrBpm?: number | null;
  maxHrBpm?: number | null;
  /**
   * Reference max HR to normalize this run's intensity against.
   * Typically the per-user observed max across all their runs.
   * If omitted or invalid, we fall back to this run's own maxHrBpm.
   */
  userReferenceMaxHr?: number | null;
  /**
   * Adaptive threshold for what counts as a long run for THIS user (miles).
   * - number: use this threshold
   * - null: explicitly disable auto-long-run labeling (only name-based \"long\" applies)
   * - undefined: fall back to generic 10 miles
   */
  userLongRunMiles?: number | null;
  /** Full adaptive profile (preferred when available). */
  trainingProfile?: RunTrainingProfile | null;
};

export type RunTrainingProfile = {
  /** Adaptive long-run threshold in miles. */
  longRunMiles: number | null;
  /** HR% cutoffs (avgHR/referenceMaxHR * 100). Null means insufficient HR data. */
  recoveryMaxHrPct: number | null;
  easyMaxHrPct: number | null;
  tempoMinHrPct: number | null;
  thresholdMinHrPct: number | null;
  intervalsMinHrPct: number | null;
  raceMinHrPct: number | null;
  /** Duration heuristics that scale with your training. */
  recoveryMaxDurationMin: number | null;
  intervalsMaxDurationMin: number | null;
  /** Number of runs used to compute the profile. */
  sampleCount: number;
  hrSampleCount: number;
};

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) return 0;
  const idx = clamp(Math.round((p / 100) * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx];
}

function roundToHalf(n: number) {
  return Math.round(n * 2) / 2;
}

/**
 * Computes an adaptive long-run threshold from recent run distances.
 *
 * \"Long run\" is treated as the top-end of your CURRENT training:
 *   max(P85, 0.85 * maxDistance), clamped to [2.5, 10], rounded to 0.5.
 *
 * If there isn't enough data, returns null so we don't guess.
 */
export function computeRunTrainingProfile(args: {
  distancesMi: number[];
  hrPcts?: number[];
  durationsMin?: number[];
}): RunTrainingProfile {
  const cleanDistances = args.distancesMi.filter((d) => Number.isFinite(d) && d > 0.5);
  const sampleCount = cleanDistances.length;
  const sortedDistances = [...cleanDistances].sort((a, b) => a - b);

  const longRunMiles =
    sampleCount < MIN_SAMPLES_FOR_ROLLING_ADAPTIVE
      ? null
      : roundToHalf(
          clamp(
            Math.max(
              percentile(sortedDistances, 85),
              sortedDistances[sortedDistances.length - 1] * 0.85,
            ),
            2.5,
            10,
          ),
        );

  const hrClean = (args.hrPcts ?? []).filter((p) => Number.isFinite(p) && p > 40 && p < 105);
  const hrSampleCount = hrClean.length;
  const hrSorted = [...hrClean].sort((a, b) => a - b);
  const hasHr = hrSampleCount >= MIN_SAMPLES_FOR_ROLLING_ADAPTIVE;

  const recoveryMaxHrPct = hasHr ? clamp(percentile(hrSorted, 20), 55, 72) : null;
  const easyMaxHrPct = hasHr
    ? clamp(percentile(hrSorted, 55), (recoveryMaxHrPct ?? 60) + 4, 82)
    : null;
  const tempoMinHrPct = hasHr
    ? clamp(percentile(hrSorted, 68), (easyMaxHrPct ?? 75) - 2, 88)
    : null;
  const thresholdMinHrPct = hasHr
    ? clamp(percentile(hrSorted, 84), (tempoMinHrPct ?? 80) + 2, 94)
    : null;
  const intervalsMinHrPct = hasHr
    ? clamp(percentile(hrSorted, 92), (thresholdMinHrPct ?? 86) + 2, 97)
    : null;
  const raceMinHrPct = hasHr
    ? clamp(percentile(hrSorted, 96), (intervalsMinHrPct ?? 90) + 1, 99)
    : null;

  const durClean = (args.durationsMin ?? []).filter((m) => Number.isFinite(m) && m > 3 && m < 400);
  const durSorted = [...durClean].sort((a, b) => a - b);
  const recoveryMaxDurationMin =
    durClean.length >= MIN_SAMPLES_FOR_ROLLING_ADAPTIVE
      ? clamp(roundToHalf(percentile(durSorted, 35)), 15, 45)
      : null;
  const intervalsMaxDurationMin =
    durClean.length >= MIN_SAMPLES_FOR_ROLLING_ADAPTIVE
      ? clamp(roundToHalf(percentile(durSorted, 35)), 20, 60)
      : null;

  return {
    longRunMiles,
    recoveryMaxHrPct,
    easyMaxHrPct,
    tempoMinHrPct,
    thresholdMinHrPct,
    intervalsMinHrPct,
    raceMinHrPct,
    recoveryMaxDurationMin,
    intervalsMaxDurationMin,
    sampleCount,
    hrSampleCount,
  };
}

export type ClassifyExplanation = {
  tag: RunTag;
  /** Short ordered bullet points describing how the tag was decided. */
  reasons: string[];
  /**
   * One-line summary of the thresholds in effect when the run was labeled
   * (e.g. "Adaptive thresholds from 9 of last 10 runs" or "Default thresholds").
   */
  thresholdsSummary: string;
};

function fmtPctRange(a: number | null, b: number | null) {
  if (a == null && b == null) return "n/a";
  if (a == null) return `<${(b as number).toFixed(0)}%`;
  if (b == null) return `≥${a.toFixed(0)}%`;
  return `${a.toFixed(0)}–${b.toFixed(0)}%`;
}

export function classifyRunWithReason(input: ClassifyInput): ClassifyExplanation {
  const distanceMi =
    input.distanceMeters != null && input.distanceMeters > 0
      ? input.distanceMeters / 1609.344
      : 0;
  const durationMin =
    input.movingTimeSec != null && input.movingTimeSec > 0
      ? input.movingTimeSec / 60
      : 0;

  const p = input.trainingProfile ?? null;
  const adaptive =
    !!p && (p.hrSampleCount >= MIN_SAMPLES_FOR_ROLLING_ADAPTIVE || (p.longRunMiles ?? 0) > 0);
  const thresholdsSummary = adaptive
    ? `Adaptive thresholds from ${p?.hrSampleCount ?? 0} HR-tagged of ${p?.sampleCount ?? 0} recent runs at the time.`
    : "Default thresholds (not enough recent runs to personalize).";

  // 1. Explicit name hint always wins — that's the user's stated intent.
  const fromName = classifyFromName(input.name);
  if (fromName) {
    return {
      tag: tagOf(fromName),
      reasons: [`Run name "${input.name ?? "Run"}" matched the ${fromName} pattern.`],
      thresholdsSummary,
    };
  }

  // 2. Distance-defined long run (adaptive). Works even without HR signal.
  const longFromProfile = input.trainingProfile?.longRunMiles;
  const longThreshold =
    longFromProfile === null
      ? null
      : typeof longFromProfile === "number" && longFromProfile > 0
        ? longFromProfile
        : input.userLongRunMiles === null
          ? null
          : typeof input.userLongRunMiles === "number" && input.userLongRunMiles > 0
            ? input.userLongRunMiles
            : 10;
  if (longThreshold != null && distanceMi >= longThreshold) {
    const longSrc =
      typeof longFromProfile === "number" && longFromProfile > 0
        ? `derived from your training at the time`
        : `fallback default (10 mi)`;
    return {
      tag: tagOf("long"),
      reasons: [
        `Distance ${distanceMi.toFixed(1)} mi ≥ long-run threshold ${longThreshold.toFixed(1)} mi (${longSrc}).`,
      ],
      thresholdsSummary,
    };
  }

  // 3. We need HR signal to classify intensity.
  const avg = input.averageHrBpm ?? null;
  const ownMax = input.maxHrBpm ?? null;
  const ref =
    typeof input.userReferenceMaxHr === "number" && input.userReferenceMaxHr > 100
      ? input.userReferenceMaxHr
      : ownMax;

  const hrSane = avg != null && avg > 60 && ref != null && ref > 100;
  if (!hrSane || distanceMi <= 0 || durationMin <= 0) {
    const missing: string[] = [];
    if (!(distanceMi > 0)) missing.push("distance");
    if (!(durationMin > 0)) missing.push("duration");
    if (avg == null || avg <= 60) missing.push("avg HR");
    if (ref == null || ref <= 100) missing.push("reference max HR");
    return {
      tag: tagOf("unclassified"),
      reasons: [
        missing.length > 0
          ? `Missing required signal: ${missing.join(", ")}.`
          : "Not enough signal to classify.",
      ],
      thresholdsSummary,
    };
  }

  const hrPct = ((avg as number) / (ref as number)) * 100;
  const refSrc =
    typeof input.userReferenceMaxHr === "number" && input.userReferenceMaxHr > 100
      ? "your observed max in the window"
      : "this run's max HR";
  const hrLine = `Avg HR ${avg} bpm = ${hrPct.toFixed(0)}% of ${ref} bpm (${refSrc}).`;

  // 4. Intensity buckets. Adaptive cutoffs when the profile has enough HR samples;
  // otherwise fixed defaults (same behavior for sparse windows).
  const raceMin = p?.raceMinHrPct ?? 92;
  const intervalsMin = p?.intervalsMinHrPct ?? 88;
  const thresholdMin = p?.thresholdMinHrPct ?? 85;
  const tempoMin = p?.tempoMinHrPct ?? 78;
  const recoveryMax = p?.recoveryMaxHrPct ?? 65;
  const intervalsMaxDur = p?.intervalsMaxDurationMin ?? 45;
  const recoveryMaxDur = p?.recoveryMaxDurationMin ?? 35;
  const adaptiveHr = !!p && p.hrSampleCount >= MIN_SAMPLES_FOR_ROLLING_ADAPTIVE;
  const cutoffSrc = adaptiveHr ? "adaptive" : "default";

  if (hrPct >= raceMin) {
    return {
      tag: tagOf("race"),
      reasons: [
        hrLine,
        `${hrPct.toFixed(0)}% ≥ race cutoff ${raceMin.toFixed(0)}% (${cutoffSrc}).`,
      ],
      thresholdsSummary,
    };
  }
  if (hrPct >= intervalsMin && durationMin <= intervalsMaxDur) {
    return {
      tag: tagOf("intervals"),
      reasons: [
        hrLine,
        `${hrPct.toFixed(0)}% ≥ intervals cutoff ${intervalsMin.toFixed(0)}% (${cutoffSrc}).`,
        `Duration ${durationMin.toFixed(0)} min ≤ intervals duration cap ${intervalsMaxDur.toFixed(0)} min.`,
      ],
      thresholdsSummary,
    };
  }
  if (hrPct >= thresholdMin) {
    return {
      tag: tagOf("threshold"),
      reasons: [
        hrLine,
        `${hrPct.toFixed(0)}% in threshold band ${fmtPctRange(thresholdMin, intervalsMin)} (${cutoffSrc}).`,
      ],
      thresholdsSummary,
    };
  }
  if (hrPct >= tempoMin) {
    return {
      tag: tagOf("tempo"),
      reasons: [
        hrLine,
        `${hrPct.toFixed(0)}% in tempo band ${fmtPctRange(tempoMin, thresholdMin)} (${cutoffSrc}).`,
      ],
      thresholdsSummary,
    };
  }
  if (hrPct <= recoveryMax && distanceMi < 4 && durationMin <= recoveryMaxDur) {
    return {
      tag: tagOf("recovery"),
      reasons: [
        hrLine,
        `${hrPct.toFixed(0)}% ≤ recovery cap ${recoveryMax.toFixed(0)}% (${cutoffSrc}).`,
        `Distance ${distanceMi.toFixed(1)} mi < 4 mi and duration ${durationMin.toFixed(0)} min ≤ ${recoveryMaxDur.toFixed(0)} min.`,
      ],
      thresholdsSummary,
    };
  }
  return {
    tag: tagOf("easy"),
    reasons: [
      hrLine,
      `${hrPct.toFixed(0)}% in easy band ${fmtPctRange(recoveryMax, tempoMin)} (${cutoffSrc}).`,
    ],
    thresholdsSummary,
  };
}

export function classifyRun(input: ClassifyInput): RunTag {
  return classifyRunWithReason(input).tag;
}


/** Returns the tag definition by id (useful for static color/label lookups). */
export function getTagDefinition(id: RunTagId): RunTag {
  return tagOf(id);
}
