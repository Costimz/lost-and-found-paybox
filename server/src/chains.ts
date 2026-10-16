// Bridge and RPC configuration for the Lost & Found API.
import type { Address } from "viem";

export const L1_RPCS = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://rpc.mevblocker.io"];

// RPCs for the network a list's "is it claimed?" check runs on (wd.net in stuck_index.db).
export const CHECK_RPCS: Record<string, string[]> = {
  eth: L1_RPCS, Ethereum: L1_RPCS,
  Avalanche: ["https://api.avax.network/ext/bc/C/rpc", "https://avalanche-c-chain-rpc.publicnode.com"],
  Optimism: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
  Arbitrum: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
  Base: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
  Polygon: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
  Unichain: ["https://mainnet.unichain.org", "https://unichain-rpc.publicnode.com"],
};

// Arbitrum-style rollups: claims go through Outbox.executeTransaction with a proof from NodeInterface on L2.
export const ARBITRUM: Record<string, { outbox: Address; rpcs: string[] }> = {
  arbitrum: { outbox: "0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840", rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"] },
  nova: { outbox: "0xD4B80C3D7240325D18E645B49e6535A3Bf95cc58", rpcs: ["https://nova.arbitrum.io/rpc", "https://arbitrum-nova-rpc.publicnode.com"] },
};

// OP Stack chains with the standard OptimismPortal: claims finalize a withdrawal that is already proven.
export const OPSTACK: Record<string, { portal: Address; rpcs: string[] }> = {
  optimism: { portal: "0xbEb5Fc579115071764c7423A4f12eDde41f106Ed", rpcs: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"] },
  base: { portal: "0x49048044D57e1C92A77f79988d21Fa8fAF74E97e", rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"] },
  ink: { portal: "0x5d66C1782664115999C47c9fA5cd031f495D3e4F", rpcs: ["https://rpc-gel.inkonchain.com", "https://ink-rpc.publicnode.com"] },
  unichain: { portal: "0x0bd48f6B86a26D3a217d0Fa6FfE2B491B956A7a2", rpcs: ["https://mainnet.unichain.org", "https://unichain-rpc.publicnode.com"] },
  soneium: { portal: "0x88e529A6ccd302c948689Cd5156C83D4614FAE92", rpcs: ["https://rpc.soneium.org"] },
  lisk: { portal: "0x26dB93F8b8b4f7016240af62F7730979d353f9A7", rpcs: ["https://rpc.api.lisk.com"] },
  worldchain: { portal: "0xd5ec14a83B7d95BE1E2Ac12523e2dEE12Cbeea6C", rpcs: ["https://worldchain-mainnet.g.alchemy.com/public"] },
  mode: { portal: "0x8B34b14c7c7123459Cf3076b8Cb929BE097d0C07", rpcs: ["https://mainnet.mode.network"] },
  zora: { portal: "0x1a0ad011913A150f69f6A19DF447A0CfD9551054", rpcs: ["https://rpc.zora.energy"] },
  celo: { portal: "0xc5c5D157928BDBD2ACf6d0777626b6C75a9EAEDC", rpcs: ["https://forno.celo.org"] },
};

export const SCROLL = {
  messenger: "0x6774Bcbd5ceCeF1336b5300fb5186a12DDD8b367" as Address,
  api: "https://mainnet-api-bridge-v2.scroll.io/api",
};

// Lists whose withdrawals the plugin can turn into a one-tap claim transaction.
export function claimKind(list: string): "arbitrum" | "opstack" | "scroll" | null {
  if (list in ARBITRUM) return "arbitrum";
  if (list in OPSTACK) return "opstack";
  if (list === "scroll") return "scroll";
  return null;
}

export const GUIDE_OF: Record<string, string> = {
  ...Object.fromEntries(["optimism", "base", "mantle", "zora", "mode", "unichain", "ink", "soneium", "lisk", "worldchain", "celo"].map((c) => [c, "opstack"])),
  blast: "blast_shutdown", arbitrum: "arbitrum", nova: "arbitrum", plume: "arbitrum",
  zksync_era: "zkstack", abstract: "zkstack", sophon: "zkstack", lens: "zkstack",
  zksync_lite: "zksync_lite", debridge: "debridge", linea: "linea", scroll: "scroll", starkex: "starkex", cctp: "cctp",
  layerzero: "layerzero", wormhole: "wormhole", polygon_zkevm: "agglayer", gnosis: "gnosis", ronin: "roninnetwork", taiko: "taiko", morph: "morph",
};
