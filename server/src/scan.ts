// Finds a wallet's unclaimed bridge withdrawals: the 32-list index (stuck_index.db), re-checked live on chain,
// plus Scroll's own bridge API so brand-new withdrawals show up before the index is rebuilt.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { encodeFunctionData, decodeFunctionResult, getAddress, parseAbi, type Address, type Hex } from "viem";
import { CHECK_RPCS, GUIDE_OF, OPSTACK, claimKind } from "./chains.js";
import { client, scrollFetch } from "./claim.js";
import { priceOf, prices } from "./prices.js";

const MC3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const mc3 = parseAbi(["function tryAggregate(bool requireSuccess, (address target, bytes callData)[] calls) returns ((bool success, bytes returnData)[])"]);
const LIVE_MAX = 3000;
const MAX_ITEMS = 40;

type Row = { list: string; token: string; amount: string; status: string; date: string; tx: string; net: string; target: string; data: string; kind: string; role: string };
type Guide = { title: string; sub?: string; steps: string[] };

export type Item = {
  id: string; bridge: string; asset: string; amount: string; usd: number | null; date: string; status: string;
  action: "claim" | "prove_first" | "wait" | "guide"; role: string; l2_tx: string; next: string;
};

let dbPath = "";
let names: Record<string, string> = {};
let guides: Record<string, Guide> = {};

// The nightly refresh rewrites the index, so open it per request (cheap) instead of holding a stale handle.
function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

// Some lists store the source tx in a wrapper string; the 32-byte hash inside it is the id.
const txOf = (tx: string) => (tx.match(/0x[0-9a-fA-F]{64}/)?.[0] ?? tx).toLowerCase();

export function openIndex(path: string, guidesPath: string) {
  dbPath = path;
  names = withDb((db) => Object.fromEntries((db.prepare("SELECT list, name FROM names").all() as { list: string; name: string }[]).map((r) => [r.list, r.name])));
  guides = JSON.parse(readFileSync(guidesPath, "utf8"));
}

export const bridgeName = (list: string) => names[list] ?? list;

export function guideFor(list: string): Guide | null {
  return guides[GUIDE_OF[list] ?? "other"] ?? guides.other ?? null;
}

// Same rules as the ZIPHA site: each list's stored call answers "has this been claimed?" in its own encoding.
function isClaimed(kind: string, x: Hex | null): boolean | null {
  if (!x || x === "0x" || !kind) return null;
  const v = BigInt(x.slice(0, 66));
  if (kind === "nz") return v !== 0n;
  if (kind === "z") return v === 0n;
  if (kind === "inbox") return v !== 1n;
  if (kind === "taiko") return ![0n, 1n, 3n].includes(v);
  return null;
}

async function liveCheck(net: string, calls: { target: Address; callData: Hex }[]): Promise<(Hex | null)[]> {
  const rpcs = CHECK_RPCS[net];
  if (!rpcs) return calls.map(() => null);
  const c = client(rpcs);
  const out: (Hex | null)[] = [];
  for (let i = 0; i < calls.length; i += 200) {
    const part = calls.slice(i, i + 200);
    try {
      const data = encodeFunctionData({ abi: mc3, functionName: "tryAggregate", args: [false, part] });
      const r = await c.call({ to: MC3, data, gas: 300_000_000n });
      const res = decodeFunctionResult({ abi: mc3, functionName: "tryAggregate", data: r.data! });
      out.push(...res.map((x) => (x.success ? x.returnData : null)));
    } catch {
      out.push(...part.map(() => null));
    }
  }
  return out;
}

function actionFor(list: string, status: string): Item["action"] {
  const k = claimKind(list);
  if (k === "arbitrum" || k === "scroll") return "claim";
  if (k === "opstack") {
    if (/ready to finalize|proven, finalize now/.test(status)) return "claim";
    if (/waiting|challenge period/.test(status)) return "wait";
    return "prove_first";
  }
  return "guide";
}

const NEXT: Record<Item["action"], string> = {
  claim: "Ready: call claim_lost_funds with this id to get a one-tap claim transaction for PayBox.",
  prove_first: "Needs a prove step in the official bridge first, then a finalize 7 days later (claim_lost_funds can finalize it).",
  wait: "Still inside the bridge's waiting period. Scan again later.",
  guide: "Claim it with the bridge's own app; see the guide in this result.",
};

async function scrollLive(addr: Address, known: Set<string>): Promise<Item[]> {
  let rows;
  try {
    rows = await scrollFetch(`/l2/unclaimed/withdrawals?address=${getAddress(addr)}&page=1&page_size=50`);
  } catch {
    return [];
  }
  return rows.filter((r) => !known.has(r.hash.toLowerCase()) && !r.counterpart_chain_tx?.hash).map((r) => {
    const ready = !!r.claim_info?.proof?.merkle_proof && r.claim_info.proof.merkle_proof !== "0x";
    const eth = r.token_type === 1;
    const amt = r.token_amounts?.[0] ?? "0";
    return {
      id: `scroll:${r.hash.toLowerCase()}`, bridge: "Scroll", asset: eth ? "ETH" : `token ${r.l1_token_address ?? ""}`.trim(),
      amount: eth ? (Number(amt) / 1e18).toString() : amt, usd: null, date: "", role: "recipient", l2_tx: r.hash.toLowerCase(),
      status: ready ? "ready to claim" : "waiting for Scroll to finalize", action: ready ? "claim" : "wait",
      next: ready ? NEXT.claim : "Scroll has not finalized this batch yet (usually a few hours). Scan again later.",
    } satisfies Item;
  });
}

export async function scan(address: Address) {
  const addr = address.toLowerCase();
  const rows = withDb((db) => db.prepare("SELECT list, token, amount, status, date, tx, net, target, data, kind, role FROM wd WHERE wallet = ?").all(addr) as Row[]);
  const res: (Hex | null)[] = rows.map(() => null);
  let live = false;
  if (rows.length && rows.length <= LIVE_MAX) {
    const byNet = new Map<string, number[]>();
    rows.forEach((r, i) => { if (r.net && r.target && r.data) byNet.set(r.net, [...(byNet.get(r.net) ?? []), i]); });
    await Promise.all([...byNet].map(async ([net, idx]) => {
      const got = await liveCheck(net, idx.map((i) => ({ target: rows[i].target as Address, callData: rows[i].data as Hex })));
      idx.forEach((i, k) => { res[i] = got[k]; });
    }));
    live = true;
  }
  let claimedSince = 0;
  const open = rows.filter((r, i) => {
    const c = isClaimed(r.kind, res[i]);
    if (c) claimedSince++;
    return !c;
  });
  const known = new Set(rows.map((r) => txOf(r.tx)));
  const extra = await scrollLive(address, known);
  const symbols = open.filter((r) => !/unverified/i.test(r.token)).map((r) => r.token);
  const px = await prices([...symbols, "ETH"]);
  const items: Item[] = open.map((r) => {
    const action = actionFor(r.list, r.status);
    const p = /unverified/i.test(r.token) || r.amount.startsWith("#") || r.amount === "NFT" ? null : priceOf(px, r.token);
    const usd = p === null ? null : Math.round(Number(r.amount) * p * 100) / 100;
    return {
      id: `${r.list}:${txOf(r.tx)}`, bridge: names[r.list] ?? r.list, asset: r.token, amount: r.amount, usd,
      date: r.date, status: r.status || "unclaimed", action, role: r.role, l2_tx: txOf(r.tx),
      next: r.role === "sender" ? "You sent this transfer for someone else; it is the recipient's money." : NEXT[action],
    };
  });
  for (const e of extra) e.usd = e.asset === "ETH" ? Math.round(Number(e.amount) * (px.eth ?? 0) * 100) / 100 : null;
  const all = [...extra, ...items].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  const mine = all.filter((i) => i.role !== "sender");
  const sum = (xs: Item[]) => Math.round(xs.reduce((s, i) => s + (i.usd ?? 0), 0) * 100) / 100;
  const bridges = [...new Set(mine.filter((i) => i.action !== "claim").map((i) => i.id.split(":")[0]))];
  return {
    address: getAddress(address),
    found: mine.length,
    total_usd: sum(mine),
    claimable_now: { count: mine.filter((i) => i.action === "claim").length, usd: sum(mine.filter((i) => i.action === "claim")) },
    live_checked: live,
    claimed_since_index: claimedSince,
    items: all.slice(0, MAX_ITEMS),
    truncated: all.length > MAX_ITEMS,
    guides: Object.fromEntries(bridges.map((l) => [names[l] ?? l, guideFor(l)]).filter(([, g]) => g)),
    checked_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

export function rowFor(list: string, tx: string): Row | undefined {
  return withDb((db) => db.prepare("SELECT list, token, amount, status, date, tx, net, target, data, kind, role FROM wd WHERE list = ? AND lower(tx) = ? LIMIT 1").get(list, tx) as Row | undefined);
}

export const supportedLists = () => [...new Set([...Object.keys(OPSTACK), "arbitrum", "nova", "scroll"])];
