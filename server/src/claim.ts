// Builds the single Ethereum call that releases a stuck bridge withdrawal, then simulates it from the claimer.
// Every claim here is permissionless: the funds always go to the withdrawal's own recipient, whoever pays the gas.
import {
  createPublicClient, decodeEventLog, encodeFunctionData, fallback, getAddress, http, parseAbi, parseAbiItem,
  type Address, type Hex, type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import { ARBITRUM, L1_RPCS, OPSTACK, SCROLL } from "./chains.js";

const TIMEOUT = 4_000;

export function client(rpcs: string[]): PublicClient {
  return createPublicClient({ transport: fallback(rpcs.map((u) => http(u, { timeout: TIMEOUT, retryCount: 0 }))) }) as PublicClient;
}
export const l1 = createPublicClient({
  chain: mainnet, transport: fallback(L1_RPCS.map((u) => http(u, { timeout: TIMEOUT, retryCount: 0 }))),
}) as PublicClient;

export type Claim = {
  ready: true; to: Address; data: Hex; value: "0"; gas: string; summary: string; method: string;
} | { ready: false; reason: string; next: string };

const notReady = (reason: string, next: string): Claim => ({ ready: false, reason, next });

// The withdrawal must be releasable right now: simulate it from the claimer before proposing anything.
async function finish(to: Address, data: Hex, claimer: Address, method: string, summary: string): Promise<Claim> {
  try {
    const gas = await l1.estimateGas({ account: claimer, to, data, value: 0n });
    return { ready: true, to, data, value: "0", gas: gas.toString(), method, summary };
  } catch (e) {
    const msg = ((e as { shortMessage?: string }).shortMessage ?? String(e)).replace(/\s+/g, " ");
    if (/insufficient funds/i.test(msg)) {
      return notReady("The claim is valid, but the claiming wallet has no ETH on Ethereum for gas.",
        "Fund the wallet with a little ETH on Ethereum mainnet, then ask for the claim again.");
    }
    return notReady(`Ethereum rejected a simulated claim: ${msg.slice(0, 160)}`, "The withdrawal may have been claimed already or is not final yet. Scan the wallet again.");
  }
}

// ---------------------------------------------------------------- Arbitrum / Nova
const L2ToL1Tx = parseAbiItem("event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)");
const outboxAbi = parseAbi([
  "event SendRootUpdated(bytes32 indexed outputRoot, bytes32 indexed l2BlockHash)",
  "function isSpent(uint256 index) view returns (bool)",
  "function executeTransaction(bytes32[] proof, uint256 index, address l2Sender, address to, uint256 l2Block, uint256 l1Block, uint256 l2Timestamp, uint256 value, bytes data)",
]);
const nodeInterface = parseAbi(["function constructOutboxProof(uint64 size, uint64 leaf) view returns (bytes32 send, bytes32 root, bytes32[] proof)"]);
const ARBSYS = "0x0000000000000000000000000000000000000064";
const NODE_INTERFACE = "0x00000000000000000000000000000000000000C8";

const sizeCache = new Map<string, { size: bigint; at: number }>();

// Messages confirmed on Ethereum so far = sendCount of the L2 block behind the newest SendRootUpdated on the Outbox.
export async function confirmedSendCount(list: string): Promise<bigint> {
  const hit = sizeCache.get(list);
  if (hit && Date.now() - hit.at < 600_000) return hit.size;
  const { outbox, rpcs } = ARBITRUM[list];
  const head = await l1.getBlockNumber();
  let log: { args: { l2BlockHash?: Hex } } | undefined;
  for (let to = head, i = 0; i < 6 && !log; i++, to -= 10_000n) {
    const logs = await l1.getLogs({ address: outbox, event: outboxAbi[0], fromBlock: to - 9_999n, toBlock: to });
    log = logs.at(-1);
  }
  if (!log?.args.l2BlockHash) throw new Error("no recent Outbox confirmation found");
  const block = await client(rpcs).request({ method: "eth_getBlockByHash", params: [log.args.l2BlockHash, false] }) as { sendCount?: Hex } | null;
  if (!block?.sendCount) throw new Error("L2 block has no sendCount");
  const size = BigInt(block.sendCount);
  sizeCache.set(list, { size, at: Date.now() });
  return size;
}

async function arbitrumClaim(list: string, tx: Hex, claimer: Address): Promise<Claim> {
  const { outbox, rpcs } = ARBITRUM[list];
  const l2 = client(rpcs);
  const receipt = await l2.getTransactionReceipt({ hash: tx }).catch(() => null);
  if (!receipt) return notReady("The withdrawal transaction was not found on the rollup.", "Check the transaction hash.");
  const events = receipt.logs.filter((l) => l.address.toLowerCase() === ARBSYS).flatMap((l) => {
    try { return [decodeEventLog({ abi: [L2ToL1Tx], data: l.data, topics: l.topics }).args]; } catch { return []; }
  });
  if (!events.length) return notReady("This transaction holds no withdrawal message.", "Check the transaction hash.");
  const spent = await Promise.all(events.map((e) => l1.readContract({ address: outbox, abi: outboxAbi, functionName: "isSpent", args: [e.position] })));
  const ev = events.find((_, i) => !spent[i]);
  if (!ev) return notReady("This withdrawal was already claimed.", "Nothing to do.");
  const size = await confirmedSendCount(list);
  if (ev.position >= size) {
    return notReady("The withdrawal is not confirmed on Ethereum yet (about 7 days after it was sent).", "Ask again once the challenge period has passed.");
  }
  const [, , proof] = await l2.readContract({ address: NODE_INTERFACE, abi: nodeInterface, functionName: "constructOutboxProof", args: [size, ev.position] });
  const data = encodeFunctionData({
    abi: outboxAbi, functionName: "executeTransaction",
    args: [proof, ev.position, ev.caller, ev.destination, ev.arbBlockNum, ev.ethBlockNum, ev.timestamp, ev.callvalue, ev.data],
  });
  return finish(outbox, data, claimer, "Outbox.executeTransaction", `Release ${list === "nova" ? "Arbitrum Nova" : "Arbitrum One"} withdrawal #${ev.position} through the official Outbox`);
}

// ---------------------------------------------------------------- OP Stack
const MessagePassed = parseAbiItem("event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)");
const PASSER = "0x4200000000000000000000000000000000000016";
const wTx = "(uint256 nonce, address sender, address target, uint256 value, uint256 gasLimit, bytes data)";
const portalAbi = parseAbi([
  "function finalizedWithdrawals(bytes32) view returns (bool)",
  "function numProofSubmitters(bytes32) view returns (uint256)",
  "function proofSubmitters(bytes32, uint256) view returns (address)",
  "function checkWithdrawal(bytes32 withdrawalHash, address proofSubmitter) view",
  "function provenWithdrawals(bytes32) view returns (bytes32 outputRoot, uint128 timestamp, uint128 l2OutputIndex)",
  `function finalizeWithdrawalTransaction(${wTx} tx)`,
  `function finalizeWithdrawalTransactionExternalProof(${wTx} tx, address proofSubmitter)`,
]);

const OP_NAMES: Record<string, string> = { optimism: "OP Mainnet", base: "Base", ink: "Ink", unichain: "Unichain", soneium: "Soneium", lisk: "Lisk", worldchain: "World Chain", mode: "Mode", zora: "Zora", celo: "Celo" };

async function opClaim(list: string, tx: Hex, claimer: Address): Promise<Claim> {
  const { portal, rpcs } = OPSTACK[list];
  const receipt = await client(rpcs).getTransactionReceipt({ hash: tx }).catch(() => null);
  if (!receipt) return notReady("The withdrawal transaction was not found on the L2.", "Check the transaction hash.");
  const events = receipt.logs.filter((l) => l.address.toLowerCase() === PASSER).flatMap((l) => {
    try { return [decodeEventLog({ abi: [MessagePassed], data: l.data, topics: l.topics }).args]; } catch { return []; }
  });
  for (const ev of events) {
    const hash = ev.withdrawalHash;
    if (await l1.readContract({ address: portal, abi: portalAbi, functionName: "finalizedWithdrawals", args: [hash] })) continue;
    const t = { nonce: ev.nonce, sender: ev.sender, target: ev.target, value: ev.value, gasLimit: ev.gasLimit, data: ev.data };
    const n = await l1.readContract({ address: portal, abi: portalAbi, functionName: "numProofSubmitters", args: [hash] }).catch(() => null);
    if (n === null) {
      // Older portal (L2OutputOracle): one proof per withdrawal, anyone may finalize it.
      const [, ts] = await l1.readContract({ address: portal, abi: portalAbi, functionName: "provenWithdrawals", args: [hash] });
      if (ts === 0n) return notReady("This withdrawal still needs its prove step on Ethereum before it can be finalized.", "Use the chain's official bridge to prove it; finalize here 7 days later.");
      return finish(portal, encodeFunctionData({ abi: portalAbi, functionName: "finalizeWithdrawalTransaction", args: [t] }),
        claimer, "OptimismPortal.finalizeWithdrawalTransaction", `Finalize the ${OP_NAMES[list] ?? list} withdrawal on its OptimismPortal`);
    }
    if (n === 0n) return notReady("This withdrawal still needs its prove step on Ethereum before it can be finalized.", "Use the chain's official bridge to prove it; finalize here 7 days later.");
    const subs = await Promise.all(Array.from({ length: Number(n > 5n ? 5n : n) }, (_, i) =>
      l1.readContract({ address: portal, abi: portalAbi, functionName: "proofSubmitters", args: [hash, BigInt(i)] })));
    let lastErr = "";
    for (const sub of subs) {
      try {
        await l1.readContract({ address: portal, abi: portalAbi, functionName: "checkWithdrawal", args: [hash, sub] });
      } catch (e) {
        lastErr = ((e as { shortMessage?: string }).shortMessage ?? String(e)).replace(/\s+/g, " ");
        continue;
      }
      return finish(portal, encodeFunctionData({ abi: portalAbi, functionName: "finalizeWithdrawalTransactionExternalProof", args: [t, sub] }),
        claimer, "OptimismPortal2.finalizeWithdrawalTransactionExternalProof", `Finalize the ${OP_NAMES[list] ?? list} withdrawal using its existing proof`);
    }
    return notReady(`The proof on Ethereum is not final yet or no longer valid (${lastErr.slice(0, 120)}).`,
      "If it was proven under an older dispute game it must be proven again in the official bridge.");
  }
  return notReady("This withdrawal was already finalized.", "Nothing to do.");
}

// ---------------------------------------------------------------- Scroll
const scrollAbi = parseAbi(["function relayMessageWithProof(address from, address to, uint256 value, uint256 nonce, bytes message, (uint256 batchIndex, bytes merkleProof) proof)"]);

export type ScrollTx = {
  hash: Hex; token_amounts?: string[]; token_type?: number; l1_token_address?: string; block_number?: number; tx_status?: number;
  counterpart_chain_tx?: { hash: string }; claim_info?: { from: Address; to: Address; value: string; nonce: string; message: Hex; proof?: { batch_index: string; merkle_proof: Hex } } | null;
};

export async function scrollFetch(path: string, init?: RequestInit): Promise<ScrollTx[]> {
  const r = await fetch(SCROLL.api + path, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`Scroll API ${r.status}`);
  const j = await r.json() as { errcode: number; data?: { results?: ScrollTx[] | null } };
  return j.data?.results ?? [];
}

async function scrollClaim(tx: Hex, claimer: Address): Promise<Claim> {
  const [row] = await scrollFetch("/txsbyhashes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txs: [tx] }) });
  if (!row) return notReady("Scroll's bridge has no record of this withdrawal.", "Check the transaction hash.");
  if (row.counterpart_chain_tx?.hash) return notReady("This withdrawal was already claimed on Ethereum.", "Nothing to do.");
  const c = row.claim_info;
  if (!c?.proof?.merkle_proof || c.proof.merkle_proof === "0x") {
    return notReady("Scroll has not finalized the batch holding this withdrawal yet.", "Usually ready within a few hours; ask again later.");
  }
  const data = encodeFunctionData({
    abi: scrollAbi, functionName: "relayMessageWithProof",
    args: [getAddress(c.from), getAddress(c.to), BigInt(c.value), BigInt(c.nonce), c.message, { batchIndex: BigInt(c.proof.batch_index), merkleProof: c.proof.merkle_proof }],
  });
  return finish(SCROLL.messenger, data, claimer, "L1ScrollMessenger.relayMessageWithProof", "Release the Scroll withdrawal through the official L1 messenger");
}

export async function buildClaim(list: string, tx: Hex, claimer: Address): Promise<Claim> {
  if (list in ARBITRUM) return arbitrumClaim(list, tx, claimer);
  if (list in OPSTACK) return opClaim(list, tx, claimer);
  if (list === "scroll") return scrollClaim(tx, claimer);
  return notReady("One-tap claims are not supported for this bridge yet.", "Follow the claim guide returned by the scan.");
}
