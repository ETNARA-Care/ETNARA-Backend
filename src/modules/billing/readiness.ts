import { sql } from "kysely";
import type { Trx } from "./billing.service.js";
import { isBillingStorageConfigured } from "./billingStorage.js";

/** What blocks issuing for the agency as a whole (shown on every draft). */
export async function agencyIssueBlockers(trx: Trx, organizationId: string): Promise<string[]> {
  const s = (await sql<{ legal_name: string | null; tax_config_validated_at: string | null }>`
    SELECT legal_name, tax_config_validated_at FROM billing_settings WHERE organization_id = ${organizationId}`.execute(trx)).rows[0];
  return [
    ...(!s?.legal_name ? ["SETTINGS_INCOMPLETE"] : []),
    ...(!s?.tax_config_validated_at ? ["TAX_CONFIG_NOT_VALIDATED"] : []),
    ...(!isBillingStorageConfigured() ? ["STORAGE_NOT_CONFIGURED"] : []),
  ];
}

