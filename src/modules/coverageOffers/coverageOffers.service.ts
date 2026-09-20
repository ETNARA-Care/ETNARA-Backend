import { sql } from "kysely";
import { z } from "zod";
import { withTenantContext } from "../../context/tenantContext.js";
import { recommendCoverage } from "../coverage/coverage.service.js";

export class CoverageOfferForbiddenError extends Error {}
export class CoverageOfferShiftNotFoundError extends Error {}
export class CoverageOfferNoCandidatesError extends Error {}
export class CoverageCampaignAlreadyOpenError extends Error {}
export class CoverageOfferNotFoundError extends Error {}
export class CoverageOfferAlreadyRespondedError extends Error {}

export const openCoverageCampaignSchema = z.object({
  waveSize: z.number().int().min(1).max(10).default(3),
  responseWindowMinutes: z.number().int().min(5).max(240).default(30),
  expiresAt: z.string().datetime().optional(),
});
export const respondCoverageOfferSchema = z.object({
  decision: z.enum(["interested", "declined"]),
  reason: z.string().trim().max(240).optional(),
});

interface ShiftForOffer { id: string; care_recipient_id: string | null; scheduled_start: string; scheduled_end: string; status: string }

async function requireManagerShift(userId: string, organizationId: string, shiftId: string): Promise<ShiftForOffer> {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const manager = await sql<{ ok: boolean }>`SELECT app_is_org_manager() AS ok`.execute(trx);
    if (!manager.rows[0]?.ok) throw new CoverageOfferForbiddenError();
    const result = await sql<ShiftForOffer>`
      SELECT id, care_recipient_id, scheduled_start, scheduled_end, status
      FROM shifts WHERE id = ${shiftId} AND organization_id = ${organizationId} LIMIT 1
    `.execute(trx);
    const shift = result.rows[0];
    if (!shift || !shift.care_recipient_id || shift.status !== "unassigned") throw new CoverageOfferShiftNotFoundError();
    return shift;
  });
}

export async function openCoverageCampaign(userId: string, organizationId: string, shiftId: string, input: z.infer<typeof openCoverageCampaignSchema>) {
  const shift = await requireManagerShift(userId, organizationId, shiftId);
  const candidates = (await recommendCoverage(userId, organizationId, {
    careRecipientId: shift.care_recipient_id!, scheduledStart: shift.scheduled_start, scheduledEnd: shift.scheduled_end,
  })).filter((candidate) => candidate.recommended);
  if (!candidates.length) throw new CoverageOfferNoCandidatesError();
  const expiresAt = input.expiresAt ?? new Date(Math.min(new Date(shift.scheduled_start).getTime(), Date.now() + 24 * 60 * 60_000)).toISOString();
  if (new Date(expiresAt).getTime() <= Date.now()) throw new CoverageOfferNoCandidatesError();
  const firstResponseDueAt = new Date(Math.min(
    new Date(expiresAt).getTime(),
    Date.now() + input.responseWindowMinutes * 60_000,
  )).toISOString();
  if (new Date(firstResponseDueAt).getTime() <= Date.now()) throw new CoverageOfferNoCandidatesError();

  return withTenantContext({ userId, organizationId }, async (trx) => {
    const currentShift = await sql<{ status: string }>`
      SELECT status FROM shifts
      WHERE id = ${shiftId} AND organization_id = ${organizationId}
      FOR UPDATE
    `.execute(trx);
    if (currentShift.rows[0]?.status !== "unassigned") throw new CoverageOfferShiftNotFoundError();
    const existing = await sql`SELECT id FROM coverage_campaigns WHERE shift_id = ${shiftId} AND status = 'open' LIMIT 1`.execute(trx);
    if (existing.rows[0]) throw new CoverageCampaignAlreadyOpenError();
    const campaign = await sql<{ id: string }>`
      INSERT INTO coverage_campaigns (
        organization_id, shift_id, scheduled_start, scheduled_end, expires_at,
        created_by_user_id, wave_size, response_window_minutes, current_wave, next_wave_at
      ) VALUES (
        ${organizationId}, ${shiftId}, ${shift.scheduled_start}, ${shift.scheduled_end}, ${expiresAt},
        ${userId}, ${input.waveSize}, ${input.responseWindowMinutes}, 1, ${firstResponseDueAt}
      ) RETURNING id
    `.execute(trx);
    for (const [index, candidate] of candidates.entries()) {
      const candidateRank = candidate.rank ?? index + 1;
      const waveNumber = Math.floor(index / input.waveSize) + 1;
      const active = waveNumber === 1;
      const offer = await sql<{ id: string; user_id: string | null }>`
        WITH inserted AS (
          INSERT INTO coverage_offers (
            organization_id, coverage_campaign_id, organization_worker_membership_id,
            candidate_rank, response_status, wave_number, activated_at, response_due_at
          ) VALUES (
            ${organizationId}, ${campaign.rows[0].id}, ${candidate.membershipId},
            ${candidateRank}, ${active ? "pending" : "queued"}, ${waveNumber},
            ${active ? new Date().toISOString() : null}, ${active ? firstResponseDueAt : null}
          ) RETURNING id, organization_worker_membership_id
        )
        SELECT inserted.id, w.user_id FROM inserted
        JOIN organization_worker_memberships owm ON owm.id = inserted.organization_worker_membership_id
        JOIN workers w ON w.id = owm.worker_id
      `.execute(trx);
      if (active && offer.rows[0]?.user_id) {
        await sql`
          INSERT INTO notifications (user_id, organization_id, notification_type, related_entity_type, related_entity_id, channel, status, sent_at)
          VALUES (${offer.rows[0].user_id}, ${organizationId}, 'OPEN_SHIFT_OFFER', 'coverage_offer', ${offer.rows[0].id}, 'in_app', 'sent', now())
        `.execute(trx);
      }
    }
    return {
      id: campaign.rows[0].id,
      offerCount: Math.min(input.waveSize, candidates.length),
      totalCandidates: candidates.length,
      currentWave: 1,
      nextWaveAt: firstResponseDueAt,
      expiresAt,
    };
  });
}

export async function listMyCoverageOffers(userId: string, organizationId: string) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const result = await sql<{
      id: string; campaign_id: string; scheduled_start: string; scheduled_end: string; role_label: string;
      response_status: string; expires_at: string; candidate_rank: number; wave_number: number;
      response_due_at: string | null;
    }>`
      SELECT offer.id, offer.coverage_campaign_id AS campaign_id, campaign.scheduled_start, campaign.scheduled_end,
             campaign.role_label, offer.response_status, campaign.expires_at, offer.candidate_rank,
             offer.wave_number, offer.response_due_at
      FROM coverage_offers offer
      JOIN coverage_campaigns campaign ON campaign.id = offer.coverage_campaign_id
      JOIN organization_worker_memberships owm ON owm.id = offer.organization_worker_membership_id
      JOIN workers w ON w.id = owm.worker_id
      WHERE offer.organization_id = ${organizationId} AND w.user_id = ${userId}
        AND campaign.status = 'open' AND campaign.expires_at > now()
        AND offer.response_status IN ('pending', 'interested', 'declined')
        AND (offer.response_status <> 'pending' OR offer.response_due_at > now())
      ORDER BY campaign.scheduled_start, offer.candidate_rank
    `.execute(trx);
    return result.rows.map((row) => ({
      id: row.id, campaignId: row.campaign_id, scheduledStart: row.scheduled_start, scheduledEnd: row.scheduled_end,
      roleLabel: row.role_label, responseStatus: row.response_status, expiresAt: row.expires_at, candidateRank: row.candidate_rank,
      waveNumber: row.wave_number, responseDueAt: row.response_due_at,
    }));
  });
}

export async function listShiftCoverageOffers(userId: string, organizationId: string, shiftId: string) {
  await requireManagerShift(userId, organizationId, shiftId);
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const result = await sql<{
      id: string; display_name: string | null; response_status: string; responded_at: string | null; candidate_rank: number;
      wave_number: number; response_due_at: string | null; campaign_status: string; current_wave: number;
      next_wave_at: string | null; wave_size: number; total_candidates: number;
    }>`
      SELECT offer.id, w.display_name, offer.response_status, offer.responded_at, offer.candidate_rank,
             offer.wave_number, offer.response_due_at, campaign.status AS campaign_status,
             campaign.current_wave, campaign.next_wave_at, campaign.wave_size,
             (count(*) OVER ())::int AS total_candidates
      FROM coverage_offers offer
      JOIN coverage_campaigns campaign ON campaign.id = offer.coverage_campaign_id
      JOIN organization_worker_memberships owm ON owm.id = offer.organization_worker_membership_id
      JOIN workers w ON w.id = owm.worker_id
      WHERE campaign.id = (
        SELECT latest.id FROM coverage_campaigns latest
        WHERE latest.shift_id = ${shiftId} AND latest.organization_id = ${organizationId}
        ORDER BY latest.created_at DESC LIMIT 1
      )
      ORDER BY offer.candidate_rank
    `.execute(trx);
    return result.rows.map((row) => ({
      id: row.id, displayName: row.display_name, responseStatus: row.response_status,
      respondedAt: row.responded_at, candidateRank: row.candidate_rank,
      waveNumber: row.wave_number, responseDueAt: row.response_due_at,
      campaignStatus: row.campaign_status, currentWave: row.current_wave,
      nextWaveAt: row.next_wave_at, waveSize: row.wave_size,
      totalCandidates: row.total_candidates,
    }));
  });
}

export async function respondCoverageOffer(userId: string, organizationId: string, offerId: string, input: z.infer<typeof respondCoverageOfferSchema>) {
  return withTenantContext({ userId, organizationId }, async (trx) => {
    const result = await sql<{ id: string; response_status: string }>`
      SELECT offer.id, offer.response_status FROM coverage_offers offer
      JOIN organization_worker_memberships owm ON owm.id = offer.organization_worker_membership_id
      JOIN workers w ON w.id = owm.worker_id
      JOIN coverage_campaigns campaign ON campaign.id = offer.coverage_campaign_id
      WHERE offer.id = ${offerId} AND offer.organization_id = ${organizationId} AND w.user_id = ${userId}
        AND campaign.status = 'open' AND campaign.expires_at > now()
        AND offer.response_due_at > now()
      LIMIT 1
      FOR UPDATE OF offer
    `.execute(trx);
    if (!result.rows[0]) throw new CoverageOfferNotFoundError();
    if (result.rows[0].response_status !== "pending") throw new CoverageOfferAlreadyRespondedError();
    const updated = await sql<{ id: string; response_status: string; responded_at: string }>`
      UPDATE coverage_offers SET response_status = ${input.decision}, responded_at = now(), response_reason = ${input.reason ?? null}
      WHERE id = ${offerId} AND response_status = 'pending' RETURNING id, response_status, responded_at
    `.execute(trx);
    const notificationType = input.decision === "interested" ? "OPEN_SHIFT_INTERESTED" : "OPEN_SHIFT_DECLINED";
    await sql`SELECT app_notify_coverage_offer_managers(${offerId}, ${notificationType})`.execute(trx);
    await sql`SELECT app_progress_coverage_campaign_after_response(${offerId})`.execute(trx);
    return updated.rows[0];
  });
}
