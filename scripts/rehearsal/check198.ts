/**
 * Post-deploy check of the SmartMatch / En Camino backend (#198) on a PITR COPY
 * of production: migrations 090-109 recorded, every pilot feature OFF, no
 * SmartMatch / journey / arrival rows, platform deny on every new table.
 * Read-only; prints counts and verdicts only. Refuses unmarked hosts unless
 * CHECK088_ALLOW_UNMARKED_COPY names this host, and refuses production's host.
 */
import { Client } from "pg";

(async () => {
  const url = process.env.CHECK088_URL!;
  const host = new URL(url).hostname;
  if (host === "etnara-care-staging-db.railway.internal") throw new Error("refused: production host");
  if (process.env.CHECK088_ALLOW_UNMARKED_COPY !== host) throw new Error("refused: not an allowed copy");
  const c = new Client({ connectionString: url, options: "-c default_transaction_read_only=on" });
  await c.connect();
  const q = async <T extends Record<string, unknown>>(s: string) => (await c.query<T>(s)).rows;
  const r: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: boolean, detail = "") => r.push({ name, pass, detail });
  const want = Array.from({ length: 20 }, (_, i) => String(90 + i).padStart(3, "0"));
  const got = new Set((await q<{ p: string }>(`SELECT left(filename,3) p FROM schema_migrations WHERE filename >= '090'`)).map((x) => x.p));
  check("P1 migrations 090-109 all recorded", want.every((p) => got.has(p)), `missing=${want.filter((p) => !got.has(p)).join(",")}`);
  const on = (await q<{ n: number }>(`SELECT count(*)::int n FROM organization_features WHERE enabled`))[0].n;
  check("P2 no agency has SMARTMATCH or EN_CAMINO enabled", on === 0, `enabled=${on}`);
  const ev = (await q<{ n: number }>(`SELECT count(*)::int n FROM organization_feature_events`))[0].n;
  check("P3 no feature switch was ever changed", ev === 0, `events=${ev}`);
  const tables = ["smartmatch_opportunities", "smartmatch_applications", "shift_journey_events", "shift_arrivals", "worker_location_consents", "shift_private_instructions"];
  const counts = await Promise.all(tables.map(async (t) => (await q<{ n: number }>(`SELECT count(*)::int n FROM ${t}`))[0].n));
  check("P4 SmartMatch / journey / arrival tables are empty", counts.every((n) => n === 0), tables.map((t, i) => `${t}=${counts[i]}`).join(" "));
  const nulls = (await q<{ a: number; b: number }>(`SELECT (SELECT count(*) FROM shifts WHERE service_location_id IS NOT NULL)::int a, (SELECT count(*) FROM family_relationships WHERE can_view_service_location)::int b`))[0];
  check("P5 existing shifts/relatives untouched (no service address, family address permission off)", nulls.a === 0 && nulls.b === 0, `shifts_with_address=${nulls.a} relatives_with_permission=${nulls.b}`);
  const missingDeny = (await q<{ t: string }>(`
    SELECT tablename t FROM pg_tables p WHERE schemaname='public'
      AND (tablename LIKE 'smartmatch%' OR tablename LIKE 'shift\\_%' OR tablename LIKE 'care_recipient_location%' OR tablename = 'worker_location_consents')
      AND NOT EXISTS (SELECT 1 FROM pg_policies x WHERE x.schemaname='public' AND x.tablename=p.tablename AND x.permissive='RESTRICTIVE' AND (x.qual ILIKE '%superadmin%' OR x.qual ILIKE '%platform%'))`)).map((x) => x.t);
  check("P6 ETNARA central / Tower denied on every new SmartMatch / location / journey table", missingDeny.length === 0, missingDeny.join(","));
  for (const x of r) console.log(`${x.pass ? "PASS" : "FAIL"}  ${x.name}  ${x.detail}`);
  console.log(`CHECK198 ${r.filter((x) => x.pass).length}/${r.length} PASS`);
  await c.end();
  if (r.some((x) => !x.pass)) process.exitCode = 1;
})().catch((e) => { console.error((e as Error).message); process.exit(1); });
