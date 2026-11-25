/**
 * Variantes de una ruta concreta que Express 5 (router 2, path-to-regexp 8: sin distinguir mayúsculas, barra final
 * opcional, parámetros decodificados) puede aceptar. Para pruebas de guardas por ruta (seguridad 25-nov-2026).
 * `ids` son los segmentos que son parámetros (ids); el segmento 2 es siempre el de la organización.
 */
export function pathVariants(path: string, ids: string[]): Array<{ name: string; path: string }> {
  const enc = (s: string, i = 0) => s.slice(0, i) + "%" + s.charCodeAt(i).toString(16).toUpperCase() + s.slice(i + 1);
  const segs = path.split("/");
  const isId = (s: string) => ids.includes(s);
  const out: Array<{ name: string; path: string }> = [
    { name: "canónica", path },
    { name: "barra final", path: path + "/" },
    { name: "doble barra final", path: path + "//" },
    { name: "literales en mayúsculas", path: segs.map((s) => (isId(s) ? s : s.toUpperCase())).join("/") },
    { name: "ids en mayúsculas", path: segs.map((s) => (isId(s) ? s.toUpperCase() : s)).join("/") },
    { name: "todo en mayúsculas + barra final", path: path.toUpperCase() + "/" },
    { name: "id de organización codificado (%XX)", path: segs.map((s, i) => (i === 2 ? enc(s) : s)).join("/") },
    { name: "id de organización totalmente codificado", path: segs.map((s, i) => (i === 2 ? [...s].map((c) => "%" + c.charCodeAt(0).toString(16)).join("") : s)).join("/") },
    { name: "doble barra tras la organización", path: segs.slice(0, 3).join("/") + "//" + segs.slice(3).join("/") },
  ];
  const lastLiteral = segs.map((s, i) => [s, i] as const).filter(([s, i]) => i > 2 && s && !isId(s) && !/^\d{4}-/.test(s)).pop();
  if (lastLiteral) out.push({ name: "literal codificado (%XX)", path: segs.map((s, i) => (i === lastLiteral[1] ? enc(s) : s)).join("/") });
  const innerId = segs.findIndex((s, i) => i > 2 && isId(s));
  if (innerId > 0) out.push({ name: "id interno codificado", path: segs.map((s, i) => (i === innerId ? enc(s) : s)).join("/") });
  return out;
}
