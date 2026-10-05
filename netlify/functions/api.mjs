// Farming online API: player directory + farm snapshots for visiting, stored in Netlify Blobs.
import { getStore } from "@netlify/blobs";

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const norm = u => String(u || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
async function sha(t) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const pub = m => ({ u: m.u, farm: m.farm, farmer: m.farmer, shirt: m.shirt, lv: m.lv, size: m.size, seen: m.seen });

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const meta = getStore({ name: "meta", consistency: "strong" });
  const farms = getStore({ name: "farms", consistency: "strong" });
  try {
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
      const nm = { u, th, farm: String(b.farm || "").slice(0, 40), farmer: String(b.farmer || "").slice(0, 24), shirt: b.shirt | 0, lv: b.lv | 0, size: b.size | 0, seen: Date.now(), created: m ? m.created : Date.now() };
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
