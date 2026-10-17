/** Version guard for future repair patches. No repository reads or writes. */
export interface RepairFileVersion {
  path: string;
  expectedBlobSha: string;
}
export function validateRepairFileVersions(input: unknown): readonly RepairFileVersion[] | null {
  if (!Array.isArray(input) || input.length < 1 || input.length > 3) return null;
  const seen = new Set<string>();
  const output: RepairFileVersion[] = [];
  for (const value of input) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "expectedBlobSha,path") return null;
    if (typeof record.path !== "string" ||
        !/^(src\/modules\/etnaraTower\/[a-zA-Z0-9.-]+\.ts|frontend-v23\/src\/pages\/platform\/PlatformTowerPage\.tsx)$/.test(record.path)) return null;
    if (typeof record.expectedBlobSha !== "string" || !/^[a-f0-9]{40}$/.test(record.expectedBlobSha)) return null;
    if (seen.has(record.path)) return null;
    seen.add(record.path);
    output.push({ path: record.path, expectedBlobSha: record.expectedBlobSha });
  }
  return output;
}
