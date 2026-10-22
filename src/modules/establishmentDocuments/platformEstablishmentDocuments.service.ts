import { withPlatformContext } from "../../context/tenantContext.js";
import { UnauthorizedPlatformAccessError } from "../../context/errors.js";

// The former platform-wide queue, download and review endpoints exposed
// tenant-private document metadata and signed object URLs. Keep their routes
// fail-closed until a metadata-only verification product is designed.
export async function listPlatformEstablishmentDocumentQueue(userId: string): Promise<never> {
  await withPlatformContext(userId, async () => undefined);
  throw new UnauthorizedPlatformAccessError("PLATFORM_PRIVATE_DOCUMENT_ACCESS_DENIED");
}
export async function getPlatformEstablishmentDocumentDownload(userId: string, _id: string): Promise<never> {
  await withPlatformContext(userId, async () => undefined);
  throw new UnauthorizedPlatformAccessError("PLATFORM_PRIVATE_DOCUMENT_ACCESS_DENIED");
}
export async function reviewPlatformEstablishmentDocument(userId: string, _id: string, _status: "approved" | "rejected", _reason?: string): Promise<never> {
  await withPlatformContext(userId, async () => undefined);
  throw new UnauthorizedPlatformAccessError("PLATFORM_PRIVATE_DOCUMENT_ACCESS_DENIED");
}
