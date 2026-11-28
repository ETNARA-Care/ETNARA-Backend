import { randomInt } from "node:crypto";

// Alfabeto sin caracteres ambiguos (sin 0/O, 1/I/L). 10 caracteres ≈ 49 bits, de un solo uso y 10 minutos.
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");
export function newLinkCode(): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += ALFABETO[randomInt(ALFABETO.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
