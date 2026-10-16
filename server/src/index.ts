// Lost & Found API for the PayBox plugin. Runs on the Vultr box behind Caddy (lostfound.ziphaonchain.xyz).
//   GET /v1/stats                         public totals across all 32 bridge lists
//   GET /v1/scan?address=0x…              a wallet's unclaimed withdrawals (needs the API key)
//   GET /v1/claim?id=<list:tx>&claimer=0x… one simulated claim call, or why it can't be claimed yet (needs the API key)
// The key arrives as the X-LostFound-Key header, injected by PayBox as a brokered secret; it never ships in the plugin.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { buildClaim, confirmedSendCount } from "./claim.js";
import { bridgeName, guideFor, openIndex, rowFor, scan } from "./scan.js";
import { claimKind } from "./chains.js";

const PORT = Number(process.env.PORT ?? 8099);
const KEY = process.env.LOSTFOUND_KEY ?? "";
const STATS_URL = process.env.STATS_URL ?? "http://127.0.0.1:8097/api/stuck/stats";
openIndex(process.env.STUCK_DB ?? "/opt/wallet-exposure-api/stuck_index.db", process.env.GUIDES ?? "/opt/lostfound/guides.json");

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

function authorized(req: IncomingMessage): boolean {
  if (!KEY) return true;
  const got = Buffer.from(String(req.headers["x-lostfound-key"] ?? ""));
  const want = Buffer.from(KEY);
  return got.length === want.length && timingSafeEqual(got, want);
}

// 60 requests a minute per client address is far above what an agent conversation needs.
const hits = new Map<string, number[]>();
function limited(req: IncomingMessage): boolean {
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 60;
}

function address(v: string | null, name: string): Address {
  if (!v || !isAddress(v, { strict: false })) throw new HttpError(400, `${name} must be a 0x wallet address`);
  return getAddress(v);
}

let statsCache: { at: number; body: unknown } | null = null;
async function stats() {
  if (statsCache && Date.now() - statsCache.at < 600_000) return statsCache.body;
  const r = await fetch(STATS_URL, { signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new HttpError(502, "stats unavailable");
  const s = await r.json() as { updated: string; wallets: number; totals: Record<string, number>; lists: { name: string; usd: number; usd_claimable: number; wallets: number; withdrawals: number }[] };
  const body = {
    updated: s.updated, wallets: s.wallets, bridges: s.lists.length,
    total_usd: Math.round((s.totals.claimable + s.totals.blocked) || 0), claimable_usd: Math.round(s.totals.claimable || 0),
    claimed_back_usd: Math.round(s.totals.claimed || 0),
    top: s.lists.slice(0, 10).map((l) => ({ bridge: l.name, usd: Math.round(l.usd), wallets: l.wallets, withdrawals: l.withdrawals })),
    one_tap_bridges: ["Arbitrum One", "Arbitrum Nova", "Scroll", "OP Mainnet", "Base", "Ink", "Unichain", "Soneium", "Lisk", "World Chain", "Mode", "Zora", "Celo"],
  };
  statsCache = { at: Date.now(), body };
  return body;
}

async function claim(id: string | null, claimerRaw: string | null) {
  const m = /^([a-z_]+):(0x[0-9a-f]{64})$/.exec((id ?? "").trim().toLowerCase());
  if (!m) throw new HttpError(400, "id must look like <bridge>:<withdrawal tx hash>, as returned by the scan");
  const [, list, tx] = m;
  const claimer = address(claimerRaw, "claimer");
  const row = rowFor(list, tx);
  if (!claimKind(list)) {
    return { id, bridge: bridgeName(list), claimable: false, reason: "One-tap claims are not supported for this bridge yet.", next: "Follow the guide.", guide: guideFor(list) };
  }
  const c = await buildClaim(list, tx as Hex, claimer);
  const base = { id, bridge: bridgeName(list), asset: row?.token ?? null, amount: row?.amount ?? null };
  if (!c.ready) return { ...base, claimable: false, reason: c.reason, next: c.next, guide: guideFor(list) };
  return { ...base, claimable: true, chain: "eip155:1", transaction: { to: c.to, value: c.value, data: c.data }, estimated_gas: c.gas, method: c.method, summary: c.summary };
}

async function route(req: IncomingMessage) {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method !== "GET") throw new HttpError(405, "GET only");
  if (url.pathname === "/health") return { ok: true };
  if (url.pathname === "/v1/stats") return stats();
  if (!authorized(req)) throw new HttpError(401, "missing or wrong X-LostFound-Key");
  if (url.pathname === "/v1/scan") return scan(address(url.searchParams.get("address"), "address"));
  if (url.pathname === "/v1/claim") return claim(url.searchParams.get("id"), url.searchParams.get("claimer"));
  throw new HttpError(404, "not found");
}

createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const t = Date.now();
  let status = 200, body: unknown;
  try {
    if (limited(req)) throw new HttpError(429, "too many requests");
    body = await route(req);
  } catch (e) {
    status = e instanceof HttpError ? e.status : 500;
    body = { error: e instanceof HttpError ? e.message : "internal error" };
    if (!(e instanceof HttpError)) console.error(e);
  }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
  console.log(`${req.method} ${(req.url ?? "").split("?")[0]} ${status} ${Date.now() - t}ms`);
}).listen(PORT, "127.0.0.1", () => console.log(`lostfound api on 127.0.0.1:${PORT}${KEY ? "" : " (no key: dev mode)"}`));

// Keep the Arbitrum confirmation height warm so claims stay well inside the plugin's 10-second budget.
const warm = () => Promise.all(["arbitrum", "nova"].map((l) => confirmedSendCount(l).catch(() => null)));
warm();
setInterval(warm, 9 * 60_000).unref();
