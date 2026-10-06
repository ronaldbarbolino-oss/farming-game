// Farming online API: player directory + farm snapshots for visiting, stored in Netlify Blobs.
import { getStore } from "@netlify/blobs";

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const norm = u => String(u || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
async function sha(t) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const ADMIN_KEY = {"kty": "EC", "crv": "P-256", "x": "9Nf6dApAv7FNUSXvwWd5dVdozkL4NAkO6u-nGl5mtDc", "y": "bn8Ey4cZU7kJDB3t2cbDNrFyZMJDNijYlcg1E9Lq_vE"};
const b64u = t => { t = t.replace(/-/g, "+").replace(/_/g, "/"); while (t.length % 4) t += "="; return Uint8Array.from(atob(t), c => c.charCodeAt(0)) };
async function adminOk(msg, sig) {
  try { const k = await crypto.subtle.importKey("jwk", ADMIN_KEY, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, b64u(sig), new TextEncoder().encode(msg)) } catch { return false }
}
const pub = m => ({ u: m.u, farm: m.farm, farmer: m.farmer, shirt: m.shirt, lv: m.lv, size: m.size, seen: m.seen });

// a restart time shipped with a deploy: open games reload once after it
const DEPLOY_RESTART = 1791288561321;
export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/api\/?/, "").replace(/^\.netlify\/functions\/api\/?/, "").replace(/\/$/, "");
  if (path === "health" || path === "") return J({ ok: true, service: "farming-api", path: url.pathname });
  if (path === "mailcheck") { let mod = false; try { await import("nodemailer"); mod = true } catch {} const gp = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, ""); return J({ gmailUser: !!process.env.GMAIL_USER, gmailPassLength: gp.length, nodemailer: mod, resend: !!process.env.RESEND_API_KEY }) }
  const meta = getStore({ name: "meta", consistency: "strong" });
  const farms = getStore({ name: "farms", consistency: "strong" });
  try {
    const ctl = getStore({ name: "control", consistency: "strong" });
    if (req.method === "GET" && path === "restart") {
      const r = await ctl.get("restart", { type: "json" });
      const dep = DEPLOY_RESTART <= Date.now() ? DEPLOY_RESTART : 0;
      return J({ at: Math.max(r ? r.at : 0, dep), now: Date.now() });
    }
    if (req.method === "POST" && path === "restart") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const at = Number(b.at) || 0;
      if (Math.abs(Date.now() - at) > 5 * 60000) return J({ error: "expired" }, 400);
      if (!(typeof b.sig === "string" && await adminOk("restart:" + at, b.sig))) return J({ error: "not allowed" }, 403);
      await ctl.setJSON("restart", { at });
      return J({ ok: true, at });
    }
    if (req.method === "POST" && path === "admin/players") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const at = Number(b.at) || 0;
      if (Math.abs(Date.now() - at) > 5 * 60000) return J({ error: "expired" }, 400);
      if (!(typeof b.sig === "string" && await adminOk("players:" + at, b.sig))) return J({ error: "not allowed" }, 403);
      const { blobs } = await meta.list();
      const all = await Promise.all(blobs.slice(0, 2000).map(x => meta.get(x.key, { type: "json" }).catch(() => null)));
      const rs = await ctl.get("restart", { type: "json" });
      return J({ now: Date.now(), restartAt: rs ? rs.at : 0, players: all.filter(Boolean).map(m => ({ u: m.u, farm: m.farm, farmer: m.farmer, lv: m.lv, coins: m.coins || 0, animals: m.animals || 0, size: m.size, plots: m.plots || 0, seen: m.seen, created: m.created, sessions: m.sessions || 0 })) });
    }
    // ---- email: verify an address for recovery, then recover a lost username/password by code ----
    const authS = getStore({ name: "auth", consistency: "strong" });
    const emailOk = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i.test(e);
    const code6 = () => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    const sendMail = async (to, subject, text) => {
      const gu = process.env.GMAIL_USER, gp = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
      if (gu && gp) {
        try { const nm = (await import("nodemailer")).default; const tr = nm.createTransport({ service: "gmail", auth: { user: gu, pass: gp } });
          await tr.sendMail({ from: '"Farming" <' + gu + '>', to, subject, text }); return { ok: true } }
        catch (e) { const c = String(e && (e.code || e.responseCode) || ""); console.log("mail error", c, String(e && e.message || e).slice(0, 300));
          return { ok: false, error: c === "EAUTH" || /535|Username and Password/i.test(String(e && e.message)) ? "Email login failed: the Gmail address or App Password on the server is wrong." : "Couldn't send the email right now (" + (c || "error") + "). Try again later." } }
      }
      const key = process.env.RESEND_API_KEY, from = process.env.MAIL_FROM || "Farming <onboarding@resend.dev>";
      if (!key) return { ok: false, error: "Email isn't set up on the server yet. Please tell the game admin." };
      const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ from, to: [to], subject, text }) });
      if (!r.ok) return { ok: false, error: "Couldn't send the email right now. Try again later." };
      return { ok: true };
    };
    const ownU = async (u, tok) => { if (u.length < 3 || typeof tok !== "string" || tok.length < 16) return null; const m = await meta.get(u, { type: "json" }); return m && m.th === await sha(tok) ? m : null };
    if (req.method === "POST" && path === "email/start") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const u = norm(b.u), email = String(b.email || "").trim().toLowerCase().slice(0, 254);
      if (!emailOk(email)) return J({ error: "That email doesn't look right." }, 400);
      const m = await ownU(u, b.tok); if (!m) return J({ error: "Open your farm online first, then try again." }, 403);
      const prev = await authS.get("v/" + u, { type: "json" });
      if (prev && Date.now() - prev.at < 60000) return J({ error: "Please wait a minute before asking for another code." }, 429);
      const code = code6();
      const sent = await sendMail(email, "Your Farming verification code: " + code, "Hi " + (m.farmer || u) + ",\n\nYour Farming verification code is " + code + "\n\nType it in the game to verify this email for your farm \"" + (m.farm || u) + "\" (username: " + u + "). It expires in 15 minutes.\n\nIf you didn't ask for this, you can ignore this email.");
      if (!sent.ok) return J({ error: sent.error }, 503);
      await authS.setJSON("v/" + u, { email, ch: await sha(u + ":" + code), exp: Date.now() + 15 * 60000, tries: 0, at: Date.now() });
      return J({ ok: true });
    }
    if (req.method === "POST" && path === "email/verify") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const u = norm(b.u), code = String(b.code || "").replace(/\D/g, "");
      const m = await ownU(u, b.tok); if (!m) return J({ error: "Open your farm online first, then try again." }, 403);
      const v = await authS.get("v/" + u, { type: "json" });
      if (!v || Date.now() > v.exp) return J({ error: "The code expired. Ask for a new one." }, 400);
      if (v.tries >= 5) return J({ error: "Too many tries. Ask for a new code." }, 429);
      if (v.ch !== await sha(u + ":" + code)) { await authS.setJSON("v/" + u, { ...v, tries: v.tries + 1 }); return J({ error: "Wrong code." }, 400) }
      if (m.email && m.email !== v.email) { const ok = await sha(m.email); const L = (await authS.get("e/" + ok, { type: "json" })) || []; await authS.setJSON("e/" + ok, L.filter(x => x !== u)) }
      const eh = await sha(v.email); const L = (await authS.get("e/" + eh, { type: "json" })) || []; if (!L.includes(u)) L.push(u); await authS.setJSON("e/" + eh, L.slice(-20));
      await meta.setJSON(u, { ...m, email: v.email, emailOk: true }); await authS.delete("v/" + u);
      return J({ ok: true, email: v.email });
    }
    if (req.method === "POST" && path === "recover/start") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const email = String(b.email || "").trim().toLowerCase().slice(0, 254);
      if (!emailOk(email)) return J({ error: "That email doesn't look right." }, 400);
      const eh = await sha(email), users = (await authS.get("e/" + eh, { type: "json" })) || [];
      const prev = await authS.get("r/" + eh, { type: "json" });
      if (prev && Date.now() - prev.at < 60000) return J({ error: "Please wait a minute before asking for another code." }, 429);
      if (!users.length) return J({ ok: true });
      const code = code6();
      const sent = await sendMail(email, "Your Farming recovery code: " + code, "Your Farming recovery code is " + code + "\n\nYour username" + (users.length > 1 ? "s" : "") + ": " + users.join(", ") + "\n\nType the code in the game to set a new password. It expires in 15 minutes.\n\nIf you didn't ask for this, you can ignore this email.");
      if (!sent.ok) return J({ error: sent.error }, 503);
      await authS.setJSON("r/" + eh, { ch: await sha(eh + ":" + code), exp: Date.now() + 15 * 60000, tries: 0, at: Date.now(), users });
      return J({ ok: true });
    }
    if (req.method === "POST" && path === "recover/finish") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const email = String(b.email || "").trim().toLowerCase(), code = String(b.code || "").replace(/\D/g, ""), eh = await sha(email);
      const r = await authS.get("r/" + eh, { type: "json" });
      if (!r || Date.now() > r.exp) return J({ error: "The code expired. Ask for a new one." }, 400);
      if (r.tries >= 5) return J({ error: "Too many tries. Ask for a new code." }, 429);
      if (r.ch !== await sha(eh + ":" + code)) { await authS.setJSON("r/" + eh, { ...r, tries: r.tries + 1 }); return J({ error: "Wrong code." }, 400) }
      const u = norm(b.u);
      if (!u) return J({ ok: true, users: r.users });
      if (!r.users.includes(u)) return J({ error: "That username isn't linked to this email." }, 400);
      if (typeof b.tok !== "string" || b.tok.length < 16) return J({ error: "bad token" }, 400);
      const m = await meta.get(u, { type: "json" }); if (!m) return J({ error: "Farm not found." }, 404);
      await meta.setJSON(u, { ...m, th: await sha(b.tok), seen: Date.now() });
      const f = await farms.get(u, { type: "json" });
      await authS.delete("r/" + eh);
      return J({ ok: true, u, farm: m.farm, farmer: m.farmer, shirt: m.shirt | 0, email, state: f && f.state || null });
    }
    // ---- transfer: move a farm to another device or the app with a one-time code ----
    if (req.method === "POST" && path === "transfer/start") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const u = norm(b.u), aS = getStore({ name: "auth", consistency: "strong" });
      const m = await meta.get(u, { type: "json" });
      if (!m || typeof b.tok !== "string" || m.th !== await sha(b.tok)) return J({ error: "Open your farm online first, then try again." }, 403);
      const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", r = crypto.getRandomValues(new Uint8Array(8));
      const code = [...r].map(x => A[x % A.length]).join("");
      await aS.setJSON("t/" + code, { u, exp: Date.now() + 30 * 60000 });
      return J({ ok: true, code, exp: Date.now() + 30 * 60000 });
    }
    if (req.method === "POST" && path === "admin/transfer") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const u = norm(b.u), at = Number(b.at) || 0, aS = getStore({ name: "auth", consistency: "strong" });
      if (Math.abs(Date.now() - at) > 5 * 60000) return J({ error: "expired" }, 400);
      if (!(typeof b.sig === "string" && await adminOk("transfer:" + u + ":" + at, b.sig))) return J({ error: "not allowed" }, 403);
      const m = await meta.get(u, { type: "json" });
      if (!m) return J({ error: "No player with the username " + u + "." }, 404);
      const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", r = crypto.getRandomValues(new Uint8Array(8));
      const code = [...r].map(x => A[x % A.length]).join(""), exp = Date.now() + 24 * 3600000;
      await aS.setJSON("t/" + code, { u, exp, admin: true });
      return J({ ok: true, u, farm: m.farm, code, exp });
    }
    if (req.method === "POST" && path === "transfer/finish") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""), aS = getStore({ name: "auth", consistency: "strong" });
      if (code.length !== 8) return J({ error: "The transfer code has 8 letters and numbers." }, 400);
      const t = await aS.get("t/" + code, { type: "json" });
      if (!t || Date.now() > t.exp) return J({ error: "That code is wrong or expired. Make a new one on your old device." }, 400);
      if (typeof b.tok !== "string" || b.tok.length < 16) return J({ error: "bad token" }, 400);
      const m = await meta.get(t.u, { type: "json" }); if (!m) return J({ error: "Farm not found." }, 404);
      await meta.setJSON(t.u, { ...m, th: await sha(b.tok), seen: Date.now() });
      const f = await farms.get(t.u, { type: "json" });
      await aS.delete("t/" + code);
      return J({ ok: true, u: t.u, farm: m.farm, farmer: m.farmer, shirt: m.shirt | 0, email: m.email || "", state: f && f.state || null });
    }
    // ---- coin shop: players pay by QR, the admin approves, the game redeems the signed code ----
    const buys = getStore({ name: "buys", consistency: "strong" });
    const PACKS = { p1500: { coins: 1500, price: 100 }, p5000: { coins: 5000, price: 300 }, p10000: { coins: 10000, price: 500 } };
    const own = async (u, tok) => { if (u.length < 3 || typeof tok !== "string" || tok.length < 16) return false; const m = await meta.get(u, { type: "json" }); return !!m && m.th === await sha(tok) };
    if (req.method === "POST" && path === "buy") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const u = norm(b.u), pk = PACKS[b.pack], ref = String(b.ref || "").replace(/[^A-Za-z0-9 -]/g, "").trim().slice(0, 40);
      if (!pk) return J({ error: "Pick a coin pack." }, 400);
      if (ref.length < 4) return J({ error: "Type the reference number from your payment." }, 400);
      if (!await own(u, b.tok)) return J({ error: "Open your farm online first, then try again." }, 403);
      const { blobs } = await buys.list({ prefix: u + "/" });
      const mine = await Promise.all(blobs.map(x => buys.get(x.key, { type: "json" }).catch(() => null)));
      if (mine.filter(x => x && x.status === "pending").length >= 5) return J({ error: "You already have 5 requests waiting. Please wait for the admin." }, 429);
      if (mine.some(x => x && x.ref === ref)) return J({ error: "That reference number was already sent." }, 409);
      const m = await meta.get(u, { type: "json" });
      const id = u + "/" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const rec = { id, u, farm: m && m.farm || "", pack: b.pack, coins: pk.coins, price: pk.price, ref, status: "pending", at: Date.now() };
      await buys.setJSON(id, rec);
      return J({ ok: true, req: rec });
    }
    if (req.method === "POST" && path === "mybuys") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const u = norm(b.u);
      if (!await own(u, b.tok)) return J({ buys: [] });
      const { blobs } = await buys.list({ prefix: u + "/" });
      const mine = (await Promise.all(blobs.map(x => buys.get(x.key, { type: "json" }).catch(() => null)))).filter(Boolean).sort((a, c) => c.at - a.at).slice(0, 20);
      return J({ buys: mine });
    }
    if (req.method === "POST" && path === "admin/buys") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const at = Number(b.at) || 0;
      if (Math.abs(Date.now() - at) > 5 * 60000) return J({ error: "expired" }, 400);
      if (!(typeof b.sig === "string" && await adminOk("buys:" + at, b.sig))) return J({ error: "not allowed" }, 403);
      const { blobs } = await buys.list();
      const all = (await Promise.all(blobs.slice(0, 1000).map(x => buys.get(x.key, { type: "json" }).catch(() => null)))).filter(Boolean).sort((a, c) => c.at - a.at);
      return J({ now: Date.now(), buys: all });
    }
    if (req.method === "POST" && path === "admin/buyset") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const at = Number(b.at) || 0, id = String(b.id || ""), st = b.status === "approved" ? "approved" : "rejected";
      if (Math.abs(Date.now() - at) > 5 * 60000) return J({ error: "expired" }, 400);
      if (!(typeof b.sig === "string" && await adminOk("buyset:" + id + ":" + st + ":" + at, b.sig))) return J({ error: "not allowed" }, 403);
      const rec = await buys.get(id, { type: "json" });
      if (!rec) return J({ error: "not found" }, 404);
      if (st === "approved" && !(typeof b.code === "string" && b.code.startsWith("FARM-"))) return J({ error: "missing code" }, 400);
      const nr = { ...rec, status: st, code: st === "approved" ? b.code : undefined, done: Date.now() };
      await buys.setJSON(id, nr);
      return J({ ok: true, req: nr });
    }
    if (req.method === "GET" && path === "farms") {
      const { blobs } = await meta.list();
      const all = await Promise.all(blobs.slice(0, 2000).map(b => meta.get(b.key, { type: "json" }).catch(() => null)));
      return J({ now: Date.now(), farms: all.filter(Boolean).map(pub) });
    }
    if (req.method === "GET" && path === "farm") {
      const u = norm(url.searchParams.get("u"));
      const f = u && await farms.get(u, { type: "json" });
      if (!f) return J({ error: "This farm hasn't been shared yet." }, 404);
      const m = await meta.get(u, { type: "json" });
      return J({ ...f, seen: m ? m.seen : f.seen, now: Date.now() });
    }
    if (req.method === "POST" && (path === "publish" || path === "ping")) {
      const txt = await req.text();
      if (txt.length > 400000) return J({ error: "Farm is too big to share." }, 413);
      let b; try { b = JSON.parse(txt) } catch { return J({ error: "bad json" }, 400) }
      const u = norm(b.u);
      if (u.length < 3 || typeof b.tok !== "string" || b.tok.length < 16) return J({ error: "bad user" }, 400);
      const th = await sha(b.tok);
      const m = await meta.get(u, { type: "json" });
      if (m && m.th !== th) return J({ error: "taken" }, 403);
      const nm = { u, th, farm: String(b.farm || "").slice(0, 40), farmer: String(b.farmer || "").slice(0, 24), shirt: b.shirt | 0, lv: b.lv | 0, size: b.size | 0, coins: Math.max(0, Math.floor(Number(b.coins) || 0)), animals: b.animals | 0, plots: b.plots | 0, seen: Date.now(), created: m ? m.created : Date.now(), sessions: (m && m.sessions || 0) + (path === "publish" && b.first ? 1 : 0), ...(m && m.email ? { email: m.email, emailOk: !!m.emailOk } : {}) };
      await meta.setJSON(u, nm);
      if (path === "publish" && b.state && typeof b.state === "object") await farms.setJSON(u, { ...pub(nm), state: b.state });
      return J({ ok: true });
    }
    return J({ error: "not found" }, 404);
  } catch (e) {
    return J({ error: "server error", detail: String(e && e.message || e) }, 500);
  }
};

export const config = { path: "/api/*" };
