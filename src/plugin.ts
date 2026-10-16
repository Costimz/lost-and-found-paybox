import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { evmOutputSchema, proposeEvm } from "./paybox.js";

const PROTOCOL_VERSION = "2026-07-28";

// Lost & Found finds money stuck in bridge withdrawals (32 bridges, ~392k wallets) and turns the ones that are
// ready into a single Ethereum claim call for PayBox to approve, sign and send. The index and proof building live
// in the Lost & Found API; its key is a PayBox brokered header, so this bundle holds no secret.
const API = (process.env.LOSTFOUND_API_URL ?? "https://lostfound.ziphaonchain.xyz").replace(/\/+$/, "");

// Only the official claim contracts and claim functions may ever be proposed, whatever the API returns.
const CLAIM_CONTRACTS: Record<string, string> = {
  "0x0b9857ae2d4a3dbe74ffe1d7df045bb7f96e4840": "Arbitrum One Outbox",
  "0xd4b80c3d7240325d18e645b49e6535a3bf95cc58": "Arbitrum Nova Outbox",
  "0x6774bcbd5cecef1336b5300fb5186a12ddd8b367": "Scroll L1 messenger",
  "0xbeb5fc579115071764c7423a4f12edde41f106ed": "OP Mainnet portal",
  "0x49048044d57e1c92a77f79988d21fa8faf74e97e": "Base portal",
  "0x5d66c1782664115999c47c9fa5cd031f495d3e4f": "Ink portal",
  "0x0bd48f6b86a26d3a217d0fa6ffe2b491b956a7a2": "Unichain portal",
  "0x88e529a6ccd302c948689cd5156c83d4614fae92": "Soneium portal",
  "0x26db93f8b8b4f7016240af62f7730979d353f9a7": "Lisk portal",
  "0xd5ec14a83b7d95be1e2ac12523e2dee12cbeea6c": "World Chain portal",
  "0x8b34b14c7c7123459cf3076b8cb929be097d0c07": "Mode portal",
  "0x1a0ad011913a150f69f6a19df447a0cfd9551054": "Zora portal",
  "0xc5c5d157928bdbd2acf6d0777626b6c75a9eaedc": "Celo portal",
};
const CLAIM_SELECTORS: Record<string, string> = {
  "0x08635a95": "executeTransaction",
  "0xc311b6fc": "relayMessageWithProof",
  "0x8c3152e9": "finalizeWithdrawalTransaction",
  "0x43ca1c50": "finalizeWithdrawalTransactionExternalProof",
};

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const withdrawalId = z.string().regex(/^[a-z_]+:0x[0-9a-fA-F]{64}$/);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

class ApiError extends Error {}

async function api<T>(path: string, timeoutMs: number): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  } catch {
    throw new ApiError("The Lost & Found service did not answer in time. Try again in a moment.");
  }
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok || !body) {
    if (response.status === 401) throw new ApiError("The Lost & Found service rejected the request: the plugin's access key is not configured.");
    if (response.status === 429) throw new ApiError("Too many requests to Lost & Found. Wait a minute and try again.");
    throw new ApiError(body?.error ? `Lost & Found: ${body.error}` : "The Lost & Found service is unavailable right now.");
  }
  return body as T;
}

const fail = (e: unknown) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: e instanceof ApiError ? e.message : "Lost & Found returned an unexpected answer. Nothing was proposed." }],
});

const usd = (n: number | null | undefined) => (n == null ? "unpriced" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

// ------------------------------------------------------------------ schemas
const overviewSchema = z.object({
  updated: z.string(), wallets: z.number().int(), bridges: z.number().int(), total_usd: z.number(), claimable_usd: z.number(),
  claimed_back_usd: z.number(),
  top: z.array(z.object({ bridge: z.string(), usd: z.number(), wallets: z.number().int(), withdrawals: z.number().int() })),
  one_tap_bridges: z.array(z.string()),
});

const item = z.object({
  id: z.string(), bridge: z.string(), asset: z.string(), amount: z.string(), usd: z.number().nullable(), date: z.string(),
  status: z.string(), action: z.enum(["claim", "prove_first", "wait", "guide"]), role: z.string(), l2_tx: z.string(), next: z.string(),
});
const guide = z.object({ title: z.string(), sub: z.string().optional(), steps: z.array(z.string()) });
const scanSchema = z.object({
  address: z.string(), found: z.number().int(), total_usd: z.number(),
  claimable_now: z.object({ count: z.number().int(), usd: z.number() }),
  live_checked: z.boolean(), claimed_since_index: z.number().int(), items: z.array(item), truncated: z.boolean(),
  guides: z.record(z.string(), guide.nullable()), checked_at: z.string(),
});

const claimResponse = z.union([
  z.object({
    id: z.string(), bridge: z.string(), asset: z.string().nullable(), amount: z.string().nullable(), claimable: z.literal(true),
    chain: z.literal("eip155:1"), transaction: z.object({ to: address, value: z.literal("0"), data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/) }),
    estimated_gas: z.string(), method: z.string(), summary: z.string(),
  }),
  z.object({ id: z.string(), bridge: z.string(), claimable: z.literal(false), reason: z.string(), next: z.string(), guide: guide.nullable().optional() }).loose(),
]);

function createServer() {
  const server = new McpServer(
    { name: "lost-and-found", version: "1.0.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );

  server.registerTool(
    "lost_funds_overview",
    {
      title: "How much money is stuck in bridges",
      description: "Live totals of unclaimed bridge withdrawals across 32 bridges (Arbitrum, Base, OP, Scroll, ZKsync, Blast, Linea and more): wallets affected, USD stuck, biggest bridges, and which bridges Lost & Found can claim in one tap.",
      inputSchema: z.object({}).strict(),
      outputSchema: overviewSchema,
      annotations: readOnly,
    },
    async () => {
      try {
        const s = overviewSchema.parse(await api("/v1/stats", 6_000));
        const top = s.top.slice(0, 5).map((t) => `${t.bridge} ${usd(t.usd)}`).join(", ");
        return {
          content: [{ type: "text", text: `${usd(s.total_usd)} is sitting unclaimed in bridge withdrawals across ${s.bridges} bridges and ${s.wallets.toLocaleString("en-US")} wallets (index ${s.updated}). Largest: ${top}. Ask Lost & Found to scan a wallet to find its share.` }],
          structuredContent: s,
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "find_lost_funds",
    {
      title: "Find a wallet's stuck bridge withdrawals",
      description: "Scans an EVM wallet for bridge withdrawals it never claimed on Ethereum, across 32 bridges, re-checked live on chain. Pass the user's PayBox wallet address (or any address they ask about). Each result has an id, the amount and USD value, and whether it can be claimed now with claim_lost_funds.",
      inputSchema: z.object({ address: address.describe("EVM wallet address to scan, e.g. the user's PayBox wallet") }).strict(),
      outputSchema: scanSchema,
      annotations: readOnly,
    },
    async ({ address: wallet }) => {
      try {
        const s = scanSchema.parse(await api(`/v1/scan?address=${wallet}`, 8_000));
        const lines = s.items.slice(0, 10).map((i) => `- ${i.bridge}: ${i.amount} ${i.asset} (${usd(i.usd)}), ${i.action === "claim" ? "ready to claim" : i.status} [${i.id}]`);
        const text = s.found === 0
          ? `No unclaimed bridge withdrawals found for ${s.address} across 32 bridges.`
          : `Found ${s.found} unclaimed withdrawal${s.found === 1 ? "" : "s"} for ${s.address}${s.total_usd > 0 ? `, worth about ${usd(s.total_usd)}` : " (tokens without a market price)"}. ${s.claimable_now.count}${s.claimable_now.usd > 0 ? ` (${usd(s.claimable_now.usd)})` : ""} can be claimed now with claim_lost_funds.\n${lines.join("\n")}${s.items.length > 10 ? `\n…and ${s.items.length - 10} more in the structured result.` : ""}`;
        return { content: [{ type: "text", text }], structuredContent: s };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "claim_lost_funds",
    {
      title: "Claim a stuck bridge withdrawal",
      description: "Builds the one Ethereum transaction that releases a stuck withdrawal found by find_lost_funds (Arbitrum One/Nova, Scroll, and OP Stack chains such as OP Mainnet, Base, Unichain, Ink). The claim is simulated first; the funds always go to the withdrawal's original recipient. claimer is the PayBox wallet that will pay the Ethereum gas. PayBox shows the transaction for approval, signs and sends it.",
      inputSchema: z.object({
        withdrawal_id: withdrawalId.describe("id from find_lost_funds, e.g. arbitrum:0x…"),
        claimer: address.describe("address of the PayBox wallet that will send the claim and pay gas on Ethereum"),
      }).strict(),
      outputSchema: evmOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ withdrawal_id, claimer }) => {
      try {
        const c = claimResponse.parse(await api(`/v1/claim?id=${encodeURIComponent(withdrawal_id.toLowerCase())}&claimer=${claimer}`, 8_500));
        if (!c.claimable) {
          return { isError: true as const, content: [{ type: "text" as const, text: `Not claimable yet (${c.bridge}): ${c.reason} Next: ${c.next}` }] };
        }
        const to = c.transaction.to.toLowerCase();
        const fn = CLAIM_SELECTORS[c.transaction.data.slice(0, 10).toLowerCase()];
        if (!CLAIM_CONTRACTS[to] || !fn) {
          return { isError: true as const, content: [{ type: "text" as const, text: "Refused: the claim did not target an official bridge claim contract. Nothing was proposed." }] };
        }
        const proposal = proposeEvm({ chain: "eip155:1", to: c.transaction.to, value: "0", data: c.transaction.data });
        const what = c.amount && c.asset ? `${c.amount} ${c.asset}` : "the withdrawal";
        proposal.content = [{
          type: "text",
          text: `Claim prepared for ${what} from ${c.bridge}: ${c.summary}. Calls ${fn} on the ${CLAIM_CONTRACTS[to]} (${c.transaction.to}) on Ethereum, sends 0 ETH, simulated OK at about ${Number(c.estimated_gas).toLocaleString("en-US")} gas. Funds go to the withdrawal's original recipient. Unsigned: PayBox must show it for approval, then sign and send it.`,
        }];
        return proposal;
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
