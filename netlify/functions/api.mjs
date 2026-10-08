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
const thOk = (m, th) => !!m && (m.th === th || (Array.isArray(m.ths) && m.ths.includes(th)));
const addTh = (m, th) => { const L = [th, ...((m && m.ths) || (m && m.th ? [m.th] : [])).filter(x => x !== th)].slice(0, 6); return { th, ths: L } };
const pub = m => ({ u: m.u, farm: m.farm, farmer: m.farmer, shirt: m.shirt, lv: m.lv, size: m.size, seen: m.seen, ...(m.app ? { app: 1 } : {}) });

// a restart time shipped with a deploy: open games reload once after it
const DEPLOY_RESTART = 1791476543470;
export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/api\/?/, "").replace(/^\.netlify\/functions\/api\/?/, "").replace(/\/$/, "");
  // test server (branch deploy "test"): its own data, never touching the live farms
  const TEST = /^test--/.test(url.hostname);
  const gs = (o) => getStore({ ...o, name: (TEST ? "test-" : "") + o.name });
  if (path === "health" || path === "") return J({ ok: true, service: "farming-api", path: url.pathname });
  if (path === "mailcheck") { let mod = false; try { await import("nodemailer"); mod = true } catch {} const gp = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, ""); return J({ gmailUser: !!process.env.GMAIL_USER, gmailPassLength: gp.length, nodemailer: mod, resend: !!process.env.RESEND_API_KEY }) }
  const meta = gs({ name: "meta", consistency: "strong" });
  const farms = gs({ name: "farms", consistency: "strong" });
  try {
    const ctl = gs({ name: "control", consistency: "strong" });
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
      return J({ now: Date.now(), restartAt: rs ? rs.at : 0, players: all.filter(Boolean).map(m => ({ u: m.u, farm: m.farm, farmer: m.farmer, lv: m.lv, coins: m.coins || 0, animals: m.animals || 0, size: m.size, plots: m.plots || 0, seen: m.seen, created: m.created, sessions: m.sessions || 0, app: m.app ? 1 : 0, sync: m.ph || m.lh ? 1 : 0, devices: Array.isArray(m.ths) ? m.ths.length : (m.th ? 1 : 0), email: m.email || "" })) });
    }
    // ---- email: verify an address for recovery, then recover a lost username/password by code ----
    const authS = gs({ name: "auth", consistency: "strong" });
    const emailOk = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i.test(e);
    const code6 = () => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    const sendMail = async (to, subject, text, replyTo) => {
      const gu = process.env.GMAIL_USER, gp = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
      if (gu && gp) {
        try { const nm = (await import("nodemailer")).default; const tr = nm.createTransport({ service: "gmail", auth: { user: gu, pass: gp } });
          await tr.sendMail({ from: '"Farming" <' + gu + '>', to, subject, text, ...(replyTo ? { replyTo } : {}) }); return { ok: true } }
        catch (e) { const c = String(e && (e.code || e.responseCode) || ""); console.log("mail error", c, String(e && e.message || e).slice(0, 300));
          return { ok: false, error: c === "EAUTH" || /535|Username and Password/i.test(String(e && e.message)) ? "Email login failed: the Gmail address or App Password on the server is wrong." : "Couldn't send the email right now (" + (c || "error") + "). Try again later." } }
      }
      const key = process.env.RESEND_API_KEY, from = process.env.MAIL_FROM || "Farming <onboarding@resend.dev>";
      if (!key) return { ok: false, error: "Email isn't set up on the server yet. Please tell the game admin." };
      const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ from, to: [to], subject, text }) });
      if (!r.ok) return { ok: false, error: "Couldn't send the email right now. Try again later." };
      return { ok: true };
    };
    const ownU = async (u, tok) => { if (u.length < 3 || typeof tok !== "string" || tok.length < 16) return null; const m = await meta.get(u, { type: "json" }); return m && thOk(m, await sha(tok)) ? m : null };
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
      { const nth = await sha(b.tok); await meta.setJSON(u, { ...m, th: nth, ths: [nth], seen: Date.now() }) }
      const f = await farms.get(u, { type: "json" });
      await authS.delete("r/" + eh);
      return J({ ok: true, u, farm: m.farm, farmer: m.farmer, shirt: m.shirt | 0, email, state: f && f.state || null });
    }
    // ---- cloud sync: the same farm on the web and in the app ----
    if (req.method === "POST" && path === "pull") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const u = norm(b.u), m = await meta.get(u, { type: "json" });
      if (!m || typeof b.tok !== "string" || !thOk(m, await sha(b.tok))) return J({ error: "not yours" }, 403);
      const f = await farms.get(u, { type: "json" }).catch(() => null);
      return J({ ok: true, farm: m.farm, farmer: m.farmer, shirt: m.shirt | 0, email: m.email || "", state: f && f.state || null });
    }
    if (req.method === "POST" && path === "setpw") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const u = norm(b.u), pw = String(b.pw || ""), m = await meta.get(u, { type: "json" });
      if (pw.length < 4 || pw.length > 64) return J({ error: "bad password" }, 400);
      if (!m || typeof b.tok !== "string" || !thOk(m, await sha(b.tok))) return J({ error: "not yours" }, 403);
      const ps = crypto.randomUUID(); await meta.setJSON(u, { ...m, ps, ph: await sha(ps + ":" + pw) });
      return J({ ok: true });
    }
    if (req.method === "POST" && path === "avail") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const u = norm(b.u); if (u.length < 3) return J({ ok: false });
      const m = await meta.get(u, { type: "json" });
      return J({ ok: !m });
    }
    if (req.method === "POST" && path === "setlh") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const u = norm(b.u), m = await meta.get(u, { type: "json" }), ls = String(b.salt || ""), lh = String(b.hash || "");
      if (!m || typeof b.tok !== "string" || !thOk(m, await sha(b.tok))) return J({ error: "not yours" }, 403);
      if (ls.length < 4 || ls.length > 80 || !/^[0-9a-f]{64}$/.test(lh)) return J({ error: "bad" }, 400);
      if (m.ph || (m.ls === ls && m.lh === lh)) return J({ ok: true });
      await meta.setJSON(u, { ...m, ls, lh });
      return J({ ok: true });
    }
    if (req.method === "GET" && path === "server") return J({ test: TEST });
    if (req.method === "POST" && path === "testcopy") {
      // copy one farm from the live server into the test server (live data is only read)
      if (!TEST) return J({ error: "Only on the test server." }, 400);
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const u = norm(b.u), pw = String(b.pw || ""), aS = gs({ name: "auth", consistency: "strong" });
      if (typeof b.tok !== "string" || b.tok.length < 16) return J({ error: "bad token" }, 400);
      const lk = "tc/" + u, lt = (await aS.get(lk, { type: "json" }).catch(() => null)) || { n: 0, at: Date.now() };
      if (Date.now() - lt.at > 3600000) { lt.n = 0; lt.at = Date.now() }
      if (lt.n >= 10) return J({ error: "Too many tries. Wait an hour." }, 429);
      const lm = await getStore({ name: "meta", consistency: "strong" }).get(u, { type: "json" });
      if (!lm) return J({ error: "No farm with that username on the live server." }, 404);
      let ok = false;
      if (lm.ph) ok = await sha(lm.ps + ":" + pw) === lm.ph; else if (lm.lh) ok = await sha(lm.ls + ":" + pw) === lm.lh;
      else return J({ error: "That farm isn't linked for online login yet. Open it once on your own device first." }, 409);
      if (!ok) { lt.n++; await aS.setJSON(lk, lt); return J({ error: "Wrong username or password." }, 401) }
      const lf = await getStore({ name: "farms", consistency: "strong" }).get(u, { type: "json" }).catch(() => null);
      const th = await sha(b.tok), ps = crypto.randomUUID();
      const nm = { ...lm, th, ths: [th], ps, ph: await sha(ps + ":" + pw), seen: Date.now(), copiedFromLive: Date.now() };
      delete nm.ls; delete nm.lh;
      await meta.setJSON(u, nm);
      if (lf) await farms.setJSON(u, lf);
      return J({ ok: true, u, farm: nm.farm, farmer: nm.farmer, shirt: nm.shirt | 0, email: nm.email || "", state: lf && lf.state || null });
    }
    if (req.method === "POST" && path === "login") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const u = norm(b.u), pw = String(b.pw || ""), aS = gs({ name: "auth", consistency: "strong" });
      if (typeof b.tok !== "string" || b.tok.length < 16) return J({ error: "bad token" }, 400);
      const lk = "lt/" + u, lt = (await aS.get(lk, { type: "json" }).catch(() => null)) || { n: 0, at: Date.now() };
      if (Date.now() - lt.at > 3600000) { lt.n = 0; lt.at = Date.now() }
      if (lt.n >= 10) return J({ error: "Too many tries. Wait an hour, or use Forgot password." }, 429);
      const m = await meta.get(u, { type: "json" });
      if (!m) return J({ error: "No farm with that username online." }, 404);
      if (!m.ph && m.lh) { if (await sha(m.ls + ":" + pw) !== m.lh) { lt.n++; await aS.setJSON(lk, lt); return J({ error: "Wrong username or password." }, 401) } const ps = crypto.randomUUID(); m.ps = ps; m.ph = await sha(ps + ":" + pw) }
      if (!m.ph) return J({ error: "This farm isn't linked for online login yet. On your old device, log out and log in again once, or use a transfer code." }, 409);
      if (await sha(m.ps + ":" + pw) !== m.ph) { lt.n++; await aS.setJSON(lk, lt); return J({ error: "Wrong username or password." }, 401) }
      try { await aS.delete(lk) } catch {}
      await meta.setJSON(u, { ...m, ...addTh(m, await sha(b.tok)), seen: Date.now() });
      const f = await farms.get(u, { type: "json" }).catch(() => null);
      return J({ ok: true, u, farm: m.farm, farmer: m.farmer, shirt: m.shirt | 0, email: m.email || "", state: f && f.state || null });
    }
    // ---- transfer: move a farm to another device or the app with a one-time code ----
    if (req.method === "POST" && path === "transfer/start") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const u = norm(b.u), aS = gs({ name: "auth", consistency: "strong" });
      const m = await meta.get(u, { type: "json" });
      if (!m || typeof b.tok !== "string" || !thOk(m, await sha(b.tok))) return J({ error: "Open your farm online first, then try again." }, 403);
      const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", r = crypto.getRandomValues(new Uint8Array(8));
      const code = [...r].map(x => A[x % A.length]).join("");
      await aS.setJSON("t/" + code, { u, exp: Date.now() + 30 * 60000 });
      return J({ ok: true, code, exp: Date.now() + 30 * 60000 });
    }
    if (req.method === "POST" && path === "admin/transfer") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const u = norm(b.u), at = Number(b.at) || 0, aS = gs({ name: "auth", consistency: "strong" });
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
      const code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""), aS = gs({ name: "auth", consistency: "strong" });
      if (code.length !== 8) return J({ error: "The transfer code has 8 letters and numbers." }, 400);
      const t = await aS.get("t/" + code, { type: "json" });
      if (!t || Date.now() > t.exp) return J({ error: "That code is wrong or expired. Make a new one on your old device." }, 400);
      if (typeof b.tok !== "string" || b.tok.length < 16) return J({ error: "bad token" }, 400);
      const m = await meta.get(t.u, { type: "json" }); if (!m) return J({ error: "Farm not found." }, 404);
      await meta.setJSON(t.u, { ...m, ...addTh(m, await sha(b.tok)), seen: Date.now() });
      const f = await farms.get(t.u, { type: "json" });
      await aS.delete("t/" + code);
      return J({ ok: true, u: t.u, farm: m.farm, farmer: m.farmer, shirt: m.shirt | 0, email: m.email || "", state: f && f.state || null });
    }
    // ---- customer support: players send a message with their email; the admin replies from farmgaming.ph@gmail.com ----
    const SUPPORT_TO = "farmgaming.ph@gmail.com";
    const sup = gs({ name: "support", consistency: "strong" });
    if (req.method === "POST" && path === "support") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const email = String(b.email || "").trim().slice(0, 200), topic = String(b.topic || "Other").replace(/[^\w &/-]/g, "").slice(0, 40), msg = String(b.msg || "").trim().slice(0, 2000), u = norm(b.u || ""), farm = String(b.farm || "").slice(0, 40);
      if (!emailOk(email)) return J({ error: "Type a real email address so we can reply." }, 400);
      if (msg.length < 5) return J({ error: "Write your message first." }, 400);
      const ip = req.headers.get("x-nf-client-connection-ip") || "x", day = new Date().toISOString().slice(0, 10), rk = "rate/" + (await sha(ip + day)).slice(0, 16);
      const rate = (await sup.get(rk, { type: "json" }).catch(() => null)) || { n: 0 }; if (rate.n >= 8) return J({ error: "Too many messages today. Please wait for our reply." }, 429);
      await sup.setJSON(rk, { n: rate.n + 1 });
      const id = "t/" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), rec = { id, email, topic, msg, u, farm, at: Date.now(), status: "open" };
      await sup.setJSON(id, rec);
      const m = await sendMail(SUPPORT_TO, "[Farming support] " + topic + (u ? " · " + u : ""), "From: " + email + "\nUsername: " + (u || "(not logged in)") + "\nFarm: " + (farm || "-") + "\nTopic: " + topic + "\n\n" + msg + "\n\n— Reply to this email to answer the player.", email);
      return J({ ok: true, mailed: !!(m && m.ok) });
    }
    if (req.method === "POST" && path === "admin/support") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const at = Number(b.at) || 0; if (Math.abs(Date.now() - at) > 5 * 60000) return J({ error: "expired" }, 400);
      if (!(typeof b.sig === "string" && await adminOk("support:" + at, b.sig))) return J({ error: "not allowed" }, 403);
      if (b.set && typeof b.set.id === "string" && b.set.id.startsWith("t/")) { const r = await sup.get(b.set.id, { type: "json" }); if (r) await sup.setJSON(b.set.id, { ...r, status: b.set.status === "done" ? "done" : "open" }) }
      const { blobs } = await sup.list({ prefix: "t/" });
      const all = (await Promise.all(blobs.slice(-300).map(x => sup.get(x.key, { type: "json" }).catch(() => null)))).filter(Boolean).sort((a, c) => c.at - a.at);
      return J({ tickets: all });
    }
    // ---- coin shop: players pay by QR, the admin approves, the game redeems the signed code ----
    const buys = gs({ name: "buys", consistency: "strong" });
    const DEF_PACKS = [{ id: "c5000", coins: 5000, price: 100 }, { id: "c10000", coins: 10000, price: 180, tag: "Popular" }, { id: "c15000", coins: 15000, price: 250 }, { id: "c20000", coins: 20000, price: 320 }, { id: "c50000", coins: 50000, price: 700, tag: "Best value" }];
    const getPacks = async () => { const p = await ctl.get("packs", { type: "json" }).catch(() => null); return Array.isArray(p) && p.length ? p : DEF_PACKS };
    if (req.method === "GET" && path === "packs") return J({ packs: await getPacks() });
    if (req.method === "POST" && path === "admin/packs") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const at = Number(b.at) || 0; if (Math.abs(Date.now() - at) > 5 * 60000) return J({ error: "expired" }, 400);
      if (!Array.isArray(b.packs) || b.packs.length < 1 || b.packs.length > 8) return J({ error: "Add 1 to 8 packs." }, 400);
      const packs = b.packs.map((p, i) => ({ id: "c" + (p.coins | 0) + "_" + i, coins: Math.floor(Number(p.coins)), price: Math.floor(Number(p.price)), ...(p.tag ? { tag: String(p.tag).replace(/[<>&"]/g, "").slice(0, 16) } : {}) }));
      if (packs.some(p => !(p.coins >= 100 && p.coins <= 10000000 && p.price >= 1 && p.price <= 100000))) return J({ error: "Coins must be 100 to 10,000,000 and the price 1 to 100,000 pesos." }, 400);
      if (!(typeof b.sig === "string" && await adminOk("packs:" + at + ":" + JSON.stringify(b.packs), b.sig))) return J({ error: "not allowed" }, 403);
      await ctl.setJSON("packs", packs); return J({ ok: true, packs });
    }
    const own = async (u, tok) => { if (u.length < 3 || typeof tok !== "string" || tok.length < 16) return false; const m = await meta.get(u, { type: "json" }); return thOk(m, await sha(tok)) };
    if (req.method === "POST" && path === "buy") {
      let b; try { b = await req.json() } catch { return J({ error: "bad json" }, 400) }
      const u = norm(b.u), pk = (await getPacks()).find(p => p.id === b.pack), ref = String(b.ref || "").replace(/[^A-Za-z0-9 -]/g, "").trim().slice(0, 40);
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
      if (m && !thOk(m, th)) return J({ error: "taken" }, 403);
      const nm = { ...(m || {}), u, th: m ? m.th : th, ...(m ? {} : { ths: [th] }), farm: String(b.farm || "").slice(0, 40), farmer: String(b.farmer || "").slice(0, 24), shirt: b.shirt | 0, lv: b.lv | 0, size: b.size | 0, coins: Math.max(0, Math.floor(Number(b.coins) || 0)), animals: b.animals | 0, plots: b.plots | 0, seen: Date.now(), created: m ? m.created : Date.now(), sessions: (m && m.sessions || 0) + (path === "publish" && b.first ? 1 : 0), ...((b.app || (m && m.app)) ? { app: 1 } : {}), ...(m && m.email ? { email: m.email, emailOk: !!m.emailOk } : {}) };
      await meta.setJSON(u, nm);
      let newer = 0;
      if (path === "publish" && b.state && typeof b.state === "object") {
        const cur = await farms.get(u, { type: "json" }).catch(() => null), ct = Number(cur && cur.state && cur.state.seen) || 0, nt = Number(b.state.seen) || 0;
        if (cur && ct > nt + 5) newer = ct; else await farms.setJSON(u, { ...pub(nm), state: b.state });
      } else { const cur = await farms.get(u, { type: "json" }).catch(() => null); const ct = Number(cur && cur.state && cur.state.seen) || 0; if (ct > (Number(b.seen) || 0) + 5) newer = ct }
      return J({ ok: true, newer });
    }
    return J({ error: "not found" }, 404);
  } catch (e) {
    return J({ error: "server error", detail: String(e && e.message || e) }, 500);
  }
};

export const config = { path: "/api/*" };
