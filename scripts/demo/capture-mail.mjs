// SOLO DEMO (rama demo/independientes-25nov, nunca se fusiona con main).
// Intercepta los envíos a Resend: ningún correo sale. Cada correo queda en un archivo local del
// contenedor (para la carga de datos ficticios) y en el registro con su enlace, para entregarlo a mano.
// Se carga con NODE_OPTIONS=--import ./scripts/demo/capture-mail.mjs y se niega a funcionar fuera de la demo.
import { appendFileSync } from "node:fs";

if (process.env.DEMO_MODE === "etnara-demo-independientes") {
  const OUT = process.env.DEMO_MAIL_FILE || "/tmp/etnara-demo-mail.jsonl";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.resend.com/")) {
      let body = {};
      try { body = JSON.parse(init?.body ?? "{}"); } catch { /* cuerpo no JSON */ }
      const to = [].concat(body.to ?? []).join(",");
      const html = String(body.html ?? "") + " " + String(body.text ?? "");
      const link = /https?:\/\/[^\s"'<>]+token=[A-Za-z0-9%._-]+/.exec(html)?.[0] ?? "(sin enlace)";
      try { appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), to, subject: body.subject, link }) + "\n"); } catch { /* sin archivo */ }
      console.log(`[DEMO-CORREO] interceptado (no enviado) para=${to} asunto="${body.subject ?? ""}" enlace=${link}`);
      return new Response(JSON.stringify({ id: "demo-" + Date.now() }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(url, init);
  };
}
