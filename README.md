# Lost & Found: a PayBox plugin

Finds money stuck in unclaimed bridge withdrawals and claims it through PayBox.

$85M+ sits unclaimed in bridge withdrawals across 32 bridges and ~392k wallets. Many owners never pressed "claim" on Ethereum. Lost & Found scans a wallet, re-checks every withdrawal live on chain, and builds the single Ethereum claim transaction. PayBox shows that transaction for approval, then signs and sends it.

## Tools

| Tool | What it does |
|---|---|
| `lost_funds_overview` | Live totals: USD stuck, wallets affected, biggest bridges. |
| `find_lost_funds {address}` | A wallet's unclaimed withdrawals across 32 bridges: amount, USD value, status, an id, and the next step. Includes live Scroll withdrawals not yet in the index. |
| `claim_lost_funds {withdrawal_id, claimer}` | An `io.paybox/transactionProposal` (EVM, `eip155:1`, 0 ETH) that releases the withdrawal. One-tap bridges: Arbitrum One and Nova, Scroll, and OP Stack chains (OP Mainnet, Base, Ink, Unichain, Soneium, Lisk, World Chain, Mode, Zora, Celo). Other bridges get a step-by-step guide. |

Safety:
- Every claim is permissionless, and the funds always go to the withdrawal's original recipient.
- The plugin proposes only calls to a pinned list of official claim contracts and claim functions (Outbox.executeTransaction, L1ScrollMessenger.relayMessageWithProof, OptimismPortal finalize). Anything else is refused, even if the API returned it.
- Each claim is simulated on Ethereum before it is proposed.
- The plugin never asks for keys, and the bundle holds no secret.

## Developer portal setup

1. Upload `dist/plugin.mjs`.
2. **Network hosts**: add `lostfound.ziphaonchain.xyz`.
3. **Variables & Secrets** → Secret (brokered header):
   - Host: `lostfound.ziphaonchain.xyz`
   - Header name: `X-LostFound-Key`
   - Value: the contents of `.secrets/lostfound-key.txt`. Copy it from that file; never paste it in chat or commit it.
4. No environment variables are needed. Optionally set `LOSTFOUND_API_URL` to point the plugin at another backend.
5. Run the checks. In **Test**, try:
   - `lost_funds_overview` `{}`
   - `find_lost_funds` `{"address":"0x0c28e0109cedf9c2757701b815a983897e63c42e"}` (a real wallet with 0.53 ETH stuck on Arbitrum)
   - `claim_lost_funds` `{"withdrawal_id":"arbitrum:0x74c91ba296819e042977b33956f740d2bcf5ca083ba48e4e8bdb2dbbcdb4853c","claimer":"<your PayBox wallet>"}`, then **Validate transaction** with your wallet.

## Backend (`server/`)

`lostfound-api` runs on the Vultr box: systemd unit `lostfound-api`, Node 22, on 127.0.0.1:8099, behind Caddy at `lostfound.ziphaonchain.xyz`.
- Key file: `/etc/lostfound.env`.
- Data: the stuck-funds index `/opt/wallet-exposure-api/stuck_index.db`, refreshed nightly. It is opened read-only, once per request.
- Totals: read from `127.0.0.1:8097/api/stuck/stats`.

Redeploy:

```bash
cd server && pnpm run build && scp dist/server.mjs root@64.177.119.86:/opt/lostfound/server.mjs && ssh root@64.177.119.86 systemctl restart lostfound-api
```

Backend changes don't need a new plugin upload, so they can still ship after the hackathon deadline.

## Build and test

Requires Node 24.21.0 and pnpm 11.11.0.

```bash
pnpm install --frozen-lockfile
pnpm test
LOSTFOUND_UPSTREAM=https://lostfound.ziphaonchain.xyz node scripts/e2e.mjs
```

`pnpm test` runs PayBox conformance. `scripts/e2e.mjs` runs end-to-end checks against the live API, with the key injected the way PayBox injects it.

## Pre-existing material (disclose in the submission)

The stuck-funds index (32 bridge lists, built 2026-09-28 → 2026-10-14 from public on-chain data, re-checked nightly) and the claim guides come from the author's earlier ZIPHA Onchain research. The plugin, API, claim builders and tests were written for this hackathon.
