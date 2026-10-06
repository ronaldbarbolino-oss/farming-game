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
const DEPLOY_RESTART = 1791260586409;
export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/api\/?/, "").replace(/^\.netlify\/functions\/api\/?/, "").replace(/\/$/, "");
  if (path === "health" || path === "") return J({ ok: true, service: "farming-api", path: url.pathname });
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
    if (req.method === "GET" && path === "farms") {
      const { blobs } = await meta.list();
      const all = await Promise.all(blobs.slice(0, 400).map(b => meta.get(b.key, { type: "json" }).catch(() => null)));
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
      const nm = { u, th, farm: String(b.farm || "").slice(0, 40), farmer: String(b.farmer || "").slice(0, 24), shirt: b.shirt | 0, lv: b.lv | 0, size: b.size | 0, coins: Math.max(0, Math.floor(Number(b.coins) || 0)), animals: b.animals | 0, plots: b.plots | 0, seen: Date.now(), created: m ? m.created : Date.now(), sessions: (m && m.sessions || 0) + (path === "publish" && b.first ? 1 : 0) };
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
