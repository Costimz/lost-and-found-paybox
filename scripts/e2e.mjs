// End-to-end check of the built dist/plugin.mjs against the live Lost & Found API.
// A local proxy adds the X-LostFound-Key header the way PayBox's brokered credential does in production, so the
// plugin itself still never sees the key. Each call runs in a fresh process like the hosted sandbox.
//   LOSTFOUND_UPSTREAM=https://lostfound.ziphaonchain.xyz LOSTFOUND_KEY_FILE=.secrets/lostfound-key.txt node scripts/e2e.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import Ajv2020 from "ajv/dist/2020.js";

const upstream = process.env.LOSTFOUND_UPSTREAM ?? "https://lostfound.ziphaonchain.xyz";
const key = readFileSync(process.env.LOSTFOUND_KEY_FILE ?? ".secrets/lostfound-key.txt", "utf8").trim();
const PROPOSAL = "io.paybox/transactionProposal";

const proxy = createServer(async (req, res) => {
  const r = await fetch(upstream + req.url, { headers: { Accept: "application/json", "X-LostFound-Key": key } });
  res.writeHead(r.status, { "content-type": "application/json" });
  res.end(await r.text());
});
await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${proxy.address().port}`;

function call(method, params) {
  return new Promise((resolve, reject) => {
    const t = Date.now();
    const child = spawn(process.execPath, ["dist/plugin.mjs"], { env: { PATH: process.env.PATH, LOSTFOUND_API_URL: base }, stdio: ["pipe", "pipe", "inherit"] });
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${method} exceeded 10 s`)); }, 10_000);
    lines.on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.id !== 1) return;
      clearTimeout(timer); child.kill();
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve({ result: msg.result, ms: Date.now() - t });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "lostfound-e2e", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    } } }) + "\n");
  });
}

const ajv = new Ajv2020({ strict: false });
const { result: listed } = await call("tools/list", {});
const tools = Object.fromEntries(listed.tools.map((t) => [t.name, t]));
let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failures++; };

async function run(name, args, expect) {
  const { result, ms } = await call("tools/call", { name, arguments: args });
  const text = result.content?.map((c) => c.text).join(" ") ?? "";
  if (!result.isError) {
    const valid = ajv.validate(tools[name].outputSchema, result.structuredContent);
    check(valid, `${name} output matches its schema${valid ? "" : ` ${JSON.stringify(ajv.errors).slice(0, 200)}`}`);
  }
  check(ms < 10_000, `${name} finished in ${ms} ms`);
  expect(result, text);
  console.log(`      ${text.slice(0, 220).replace(/\n/g, " | ")}`);
  return result;
}

check(Object.keys(tools).sort().join() === "claim_lost_funds,find_lost_funds,lost_funds_overview", "three tools listed");

await run("lost_funds_overview", {}, (r) => check(!r.isError && r.structuredContent.total_usd > 1_000_000, "overview reports the stuck total"));

const ARB_WALLET = "0x0c28e0109cedf9c2757701b815a983897e63c42e";
const scan = await run("find_lost_funds", { address: ARB_WALLET }, (r) =>
  check(!r.isError && r.structuredContent.items.some((i) => i.action === "claim"), "scan finds a claimable Arbitrum withdrawal"));
await run("find_lost_funds", { address: "0x000000000000000000000000000000000000dEaD" }, (r) => check(!r.isError, "scan of an address with nothing stuck succeeds"));

const claimable = scan.structuredContent.items.find((i) => i.action === "claim");
await run("claim_lost_funds", { withdrawal_id: claimable.id, claimer: ARB_WALLET }, (r) => {
  const p = r.structuredContent?.[PROPOSAL];
  check(!r.isError && p?.kind === "evm" && p.chain === "eip155:1", "Arbitrum claim returns an Ethereum proposal");
  check(p?.transaction.to.toLowerCase() === "0x0b9857ae2d4a3dbe74ffe1d7df045bb7f96e4840" && p.transaction.data.startsWith("0x08635a95") && p.transaction.value === "0",
    "proposal calls Outbox.executeTransaction with 0 ETH");
});

const SIM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // any funded address works for the simulation
for (const [id, to] of [
  ["scroll:0xebe0321f33395e1ecc394985a0d379657d8733dedf752b9aadfc69d6881db269", "0x6774bcbd5cecef1336b5300fb5186a12ddd8b367"],
  ["optimism:0xf4c77089aacadc3dab097ad507a0c346c764a2b94d9ab9d789e086ed334a3c99", "0xbeb5fc579115071764c7423a4f12edde41f106ed"],
]) {
  await run("claim_lost_funds", { withdrawal_id: id, claimer: SIM }, (r) =>
    check(!r.isError && r.structuredContent?.[PROPOSAL]?.transaction.to.toLowerCase() === to, `${id.split(":")[0]} claim proposal targets the official contract`));
}
await run("claim_lost_funds", { withdrawal_id: "zora:0xf99764826405167355a29614953db8d27ae70dc23fdcb8cf793a948e1d65c6e9", claimer: SIM }, (r) =>
  check(r.isError && !r.structuredContent && /prove/i.test(r.content[0].text), "unproven OP Stack withdrawal explains the prove step, no proposal"));
await run("claim_lost_funds", { withdrawal_id: "linea:0xebe0321f33395e1ecc394985a0d379657d8733dedf752b9aadfc69d6881db269", claimer: SIM }, (r) =>
  check(r.isError && !r.structuredContent, "unsupported bridge returns guidance, no proposal"));

// Without the brokered header the API must refuse and the plugin must say why.
const direct = await new Promise((resolve) => {
  const child = spawn(process.execPath, ["dist/plugin.mjs"], { env: { PATH: process.env.PATH, LOSTFOUND_API_URL: upstream }, stdio: ["pipe", "pipe", "inherit"] });
  createInterface({ input: child.stdout }).on("line", (l) => { const m = JSON.parse(l); if (m.id === 1) { child.kill(); resolve(m.result); } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_lost_funds", arguments: { address: ARB_WALLET }, _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) + "\n");
});
check(direct.isError && /access key/.test(direct.content[0].text), "missing key is reported clearly");

proxy.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
