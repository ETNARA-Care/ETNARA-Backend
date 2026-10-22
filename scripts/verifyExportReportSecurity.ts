import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src");
const ALLOWED_PLATFORM_EXPORT_FILES = new Set<string>([
  // Future aggregate-only platform exporters must be explicitly allowlisted
  // here after security review. Keep empty by default.
]);

const exportPattern = /(?:text\/csv|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|Content-Disposition|attachment;|\/export(?:s)?\b|\/reports?\b|csv-stringify|exceljs|xlsx|papaparse)/i;
const platformRoutePattern = /\/platform\//;
const tenantContextPattern = /withTenantContext\s*\(/;
const platformContextPattern = /withPlatformContext\s*\(/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const findings: string[] = [];

for (const file of walk(ROOT).filter((p) => /\.(ts|tsx)$/.test(p))) {
  const source = readFileSync(file, "utf8");
  if (!exportPattern.test(source)) continue;

  const rel = relative(process.cwd(), file).replace(/\\/g, "/");
  const isPlatform = platformRoutePattern.test(source) || /platform/i.test(rel);
  const hasTenantContext = tenantContextPattern.test(source);
  const hasPlatformContext = platformContextPattern.test(source);

  if (isPlatform) {
    if (!ALLOWED_PLATFORM_EXPORT_FILES.has(rel)) {
      findings.push(`${rel}: platform export/report surface requires explicit security allowlist review`);
    } else if (!hasPlatformContext) {
      findings.push(`${rel}: allowlisted platform export/report must use withPlatformContext()`);
    }
    continue;
  }

  if (!hasTenantContext) {
    findings.push(`${rel}: tenant export/report surface must use withTenantContext()`);
  }
}

if (findings.length) {
  console.error("EXPORT_REPORT_SECURITY_GUARD_FAILED");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("Export/report security guard passed: no unreviewed export/report surfaces detected.");
