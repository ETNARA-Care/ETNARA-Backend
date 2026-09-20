import { sql } from "kysely";
import { db } from "../../config/db.js";

const ESCALATION_INTERVAL_MS = 30_000;

export async function advanceDueCoverageCampaigns(): Promise<number> {
  const result = await sql<{ activated: number }>`
    SELECT app_advance_due_coverage_campaigns() AS activated
  `.execute(db);
  return Number(result.rows[0]?.activated ?? 0);
}

export function startCoverageEscalationWorker(): () => void {
  const tick = async () => {
    try {
      await advanceDueCoverageCampaigns();
    } catch (error) {
      const failure = error as { name?: string; code?: string };
      // Bounded operational diagnostics only: never log tenant, campaign,
      // caregiver, SQL text or response data from this cross-tenant worker.
      // eslint-disable-next-line no-console
      console.error("Coverage escalation worker failed", {
        name: failure.name ?? "Error",
        code: failure.code ?? "UNKNOWN",
      });
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), ESCALATION_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
