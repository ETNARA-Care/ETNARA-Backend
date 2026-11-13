// Reglas puras del módulo contractual (152), sin acceso a la base: se prueban sin servidor.

/** CONTRACTS_MODULE=on habilita las rutas; cualquier otro valor (o ausente) las deja en 404. */
export const contractsModuleEnabled = () => process.env.CONTRACTS_MODULE === "on";
/** CONTRACTS_OFFICIAL_PUBLISHING=on permite publicar un documento no marcado como prueba. */
export const officialPublishingEnabled = () => process.env.CONTRACTS_OFFICIAL_PUBLISHING === "on";

/** Datos de la representante autorizada que firma por la agencia. */
export interface ContractSigner { fullName: string; title: string }

/** Texto exacto que se guarda como declaración de aceptación (lo arma el servidor, no el cliente). */
export function acceptanceStatement(organizationName: string, title: string, versionLabel: string, sha256: string, signer: ContractSigner) {
  return `Yo, ${signer.fullName.trim()}, ${signer.title.trim()} de «${organizationName}», acepto en nombre de la organización la versión ${versionLabel} de «${title}» (huella SHA-256 ${sha256}).`;
}
