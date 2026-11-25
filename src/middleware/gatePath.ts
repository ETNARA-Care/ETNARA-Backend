import type { Response } from "express";

/**
 * Normalización común de rutas para las guardas por ruta (revisión de seguridad 25-nov-2026).
 *
 * Express 5 (router 2 / path-to-regexp 8) enruta SIN distinguir mayúsculas, con la barra final opcional y entrega
 * los parámetros DECODIFICADOS: /organizations/%61bc…/smartmatch llega a la ruta con el id «abc…». Una guarda que
 * compara req.path tal cual puede no reconocer una variante que la ruta sí acepta. Las guardas comparan aquí con
 * la forma canónica (segmentos decodificados, barras repetidas y finales quitadas, minúsculas) y, además, con la
 * ruta original. Reconocer de más solo puede cerrar una petición, nunca abrirla. Las reglas no cambian.
 */
export function canonicalGatePath(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "").map((segment) => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
  return ("/" + segments.join("/")).toLowerCase();
}

/** Rutas a comparar, en orden: la canónica primero y la original después (si es distinta). */
export function gatePathCandidates(path: string): string[] {
  const canonical = canonicalGatePath(path);
  return canonical === path ? [path] : [canonical, path];
}

/**
 * Respuesta segura cuando una guarda no puede decidir (base caída, permisos, función inexistente…): 503 y nunca
 * continuar. El registro lleva solo la guarda, la etapa y el código de PostgreSQL; nunca el mensaje ni datos.
 */
export function respondGateUnavailable(res: Response, gate: string, stage: "session" | "check", error: unknown, body: { error: string }): void {
  const code = (error as { code?: unknown } | null)?.code;
  console.error("GATE_UNAVAILABLE", { gate, stage, code: typeof code === "string" ? code : "UNKNOWN" });
  res.status(503).json(body);
}
