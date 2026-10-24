"""En Camino UI check (iPhone viewport): offline queue, auto-refresh on cancel and reassignment."""
import json, subprocess, time
from playwright.sync_api import sync_playwright

S = "/tmp/claude-0/-home-claude/48e03c40-820e-5911-8e71-825acbd9733b/scratchpad"
D = json.load(open(f"{S}/ec_ui.json"))
WEB, API = "http://localhost:4351", "http://localhost:4350"
PG = "postgres://postgres@127.0.0.1:55432/ec"
out = {}

def sql(q):
    return subprocess.run(["psql", PG, "-Atc", q], capture_output=True, text=True).stdout.strip()

def admin_token(page):
    r = page.request.post(f"{API}/auth/login", data={"email": D["admin"], "password": D["pw"]})
    t = r.json()["token"]
    page.request.post(f"{API}/me/active-organization", headers={"Authorization": f"Bearer {t}"}, data={"organizationId": D["org"]})
    return t

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 393, "height": 852}, device_scale_factor=3, is_mobile=True, has_touch=True)
    pg = ctx.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)[:120]))
    pg.goto(f"{WEB}/login"); pg.get_by_label("Correo electrónico o teléfono").fill(D["cg"]); pg.get_by_label("Contraseña").fill(D["pw"])
    pg.locator("button[type=submit]").click(); pg.wait_for_timeout(3000)
    s1, s2, s3 = D["shifts"]

    # ---- 1. offline «Voy en camino» + «Llegué», then sync
    pg.goto(f"{WEB}/caregiver/shifts/{s1}"); pg.get_by_role("button", name="Voy en camino").wait_for(timeout=15000)
    ctx.set_offline(True)
    pg.get_by_role("button", name="Voy en camino").click(); pg.wait_for_timeout(1500)
    out["enroute_pending_badge"] = pg.locator("[data-testid=journey-pending-sync]").count() == 1
    pg.screenshot(path=f"{S}/ui-ec-1-offline-enroute.png")
    pg.get_by_role("button", name="Llegué").click(); pg.wait_for_timeout(2500)
    out["arrival_pending_card"] = pg.locator("[data-testid=arrival-pending-sync]").count() == 1
    out["rows_while_offline"] = sql(f"select (select count(*) from shift_journey_events where shift_id='{s1}')||','||(select count(*) from shift_arrivals where shift_id='{s1}')")
    pg.screenshot(path=f"{S}/ui-ec-2-offline-arrival.png")
    ctx.set_offline(False); pg.evaluate("window.dispatchEvent(new Event('online'))")
    for _ in range(40):
        rows = sql(f"select (select count(*) from shift_journey_events where shift_id='{s1}')||','||(select count(*) from shift_arrivals where shift_id='{s1}')")
        if rows == "1,1": break
        time.sleep(1)
    out["rows_after_sync"] = rows
    out["stored_offline_flags"] = sql(f"select (select recorded_offline from shift_journey_events where shift_id='{s1}')||','||(select recorded_offline||'/'||proximity from shift_arrivals where shift_id='{s1}')")
    pg.wait_for_timeout(2000); pg.screenshot(path=f"{S}/ui-ec-3-synced.png")

    # ---- 2. cancellation while the screen is open (no reload)
    pg.goto(f"{WEB}/caregiver/shifts/{s2}"); pg.get_by_role("button", name="Voy en camino").wait_for(timeout=15000)
    pg.get_by_role("button", name="Voy en camino").click(); pg.wait_for_timeout(1500)
    tok = admin_token(pg)
    r = pg.request.post(f"{API}/organizations/{D['org']}/shifts/{s2}/cancel", headers={"Authorization": f"Bearer {tok}"}, data={})
    out["cancel_status"] = r.status
    t0 = time.time(); seen = False
    while time.time() - t0 < 60:
        if pg.locator("[data-testid=shift-cancelled-notice]").count() == 1: seen = True; break
        pg.wait_for_timeout(1000)
    out["cancel_seen_without_reload_s"] = round(time.time() - t0) if seen else None
    pg.screenshot(path=f"{S}/ui-ec-4-cancelled.png")

    # ---- 3. reassignment while the screen is open
    pg.goto(f"{WEB}/caregiver/shifts/{s3}"); pg.get_by_role("button", name="Voy en camino").wait_for(timeout=15000)
    aid = sql(f"select id from assignments where shift_id='{s3}'")
    r = pg.request.patch(f"{API}/organizations/{D['org']}/shifts/{s3}/assignments/{aid}", headers={"Authorization": f"Bearer {tok}"}, data={"reason": "Reasignada"})
    out["remove_status"] = r.status
    pg.evaluate("window.dispatchEvent(new Event('focus'))")   # app comes back to the front
    t0 = time.time(); seen = False
    while time.time() - t0 < 60:
        if pg.locator("[data-testid=shift-unassigned-notice]").count() == 1: seen = True; break
        pg.wait_for_timeout(1000)
    out["unassigned_seen_s"] = round(time.time() - t0) if seen else None
    pg.screenshot(path=f"{S}/ui-ec-5-unassigned.png")
    pg.goto(f"{WEB}/caregiver"); pg.wait_for_timeout(2000)
    import re; pg.get_by_role("button", name=re.compile("^Notificaciones")).first.click()
    pg.wait_for_timeout(1200)
    out["bell_has_cancel"] = pg.get_by_text("La agencia canceló uno de tus turnos").count() > 0
    out["bell_has_unassigned"] = pg.get_by_text("Ya no tienes asignado un turno").count() > 0
    pg.screenshot(path=f"{S}/ui-ec-6-bell.png")
    out["h_overflow"] = pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    out["errors"] = errs
    b.close()
print(json.dumps(out, ensure_ascii=False))
