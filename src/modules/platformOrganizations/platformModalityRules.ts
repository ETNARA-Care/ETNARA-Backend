import { z } from "zod";

/** 163 · Reglas puras del interruptor de modalidades (sin base de datos; las usan el servicio y las pruebas). */
export const MODALITY_CODES = ["INDEPENDENT_PROVIDER"] as const;
/** Encender exige INDEPENDENT_MODALITY_ACTIVATION_ALLOWED=on en el servidor; cualquier otro valor (o ausente) = no. */
export const modalityActivationAllowed = () => process.env.INDEPENDENT_MODALITY_ACTIVATION_ALLOWED === "on";
export const setModalitySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(10).max(1000),
});
