import type { Job } from "./job.js";

/**
 * Jobs that a human has marked `READY_TO_APPLY` but that do not have an
 * application record yet. Highest score first; unscored jobs last. Ties keep
 * the lower job id first so the order is stable.
 *
 * Pure: the caller supplies the set of job ids that already have an
 * application, so this module performs no I/O.
 */
export function selectApplyQueue(
  jobs: readonly Job[],
  appliedJobIds: ReadonlySet<number>,
): Job[] {
  return jobs
    .filter((job) => job.reviewStatus === "READY_TO_APPLY" && !appliedJobIds.has(job.id))
    .sort((left, right) => {
      const leftScore = left.scoreTotal;
      const rightScore = right.scoreTotal;
      if (leftScore === null && rightScore === null) {
        return left.id - right.id;
      }
      if (leftScore === null) {
        return 1;
      }
      if (rightScore === null) {
        return -1;
      }
      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }
      return left.id - right.id;
    });
}
