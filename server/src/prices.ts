// USD prices from CoinGecko's free simple-price endpoint, cached 10 minutes. Stablecoins count as $1.
const STABLES = new Set(["usdc", "usdc.e", "usdbc", "usdt", "usd₮0", "usdt0", "dai", "xdai", "gho", "usdb", "pyusd", "frax", "lusd", "susd", "usde", "usds"]);
const IDS: Record<string, string> = {
  eth: "ethereum", weth: "ethereum", wsteth: "wrapped-steth", meth: "mantle-staked-ether", plume: "plume", soph: "sophon", celo: "celo",
  mnt: "mantle", wmnt: "mantle", slp: "smooth-love-potion", imx: "immutable-x", axs: "axie-infinity", matic: "polygon-ecosystem-token",
  wmatic: "polygon-ecosystem-token", pol: "polygon-ecosystem-token", gods: "gods-unchained", sol: "solana", myria: "myria",
  gog: "guild-of-guardians", ilv: "illuvium", bnb: "binancecoin", wbnb: "binancecoin", arb: "arbitrum", ftm: "fantom", wftm: "fantom",
  lsk: "lisk", wbtc: "wrapped-bitcoin", sui: "sui", grt: "the-graph", gno: "gnosis", apt: "aptos", cow: "cow-protocol", wld: "worldcoin-wld",
  bonk: "bonk", pixel: "pixels", apecoin: "apecoin", ape: "apecoin", op: "optimism", link: "chainlink", uni: "uniswap", pepe: "pepe",
  shib: "shiba-inu", blur: "blur", sdai: "savings-dai", comp: "compound-governance-token", olas: "autonolas",
};
const cache = new Map<string, { usd: number; at: number }>();

const key = (sym: string) => sym.trim().toLowerCase();

export function priceOf(px: Record<string, number>, sym: string): number | null {
  const k = key(sym);
  if (STABLES.has(k)) return 1;
  return px[k] ?? null;
}

export async function prices(symbols: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const need = new Set<string>();
  for (const s of symbols) {
    const k = key(s);
    const id = IDS[k];
    if (!id) continue;
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < 600_000) out[k] = hit.usd;
    else need.add(id);
  }
  if (need.size) {
    try {
      const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${[...need].join(",")}&vs_currencies=usd`, { signal: AbortSignal.timeout(3_000) });
      const j = await r.json() as Record<string, { usd?: number }>;
      for (const [id, v] of Object.entries(j)) if (typeof v.usd === "number") cache.set(id, { usd: v.usd, at: Date.now() });
    } catch { /* unpriced rows still show their amounts */ }
    for (const s of symbols) {
      const k = key(s), id = IDS[k];
      const hit = id ? cache.get(id) : undefined;
      if (hit) out[k] = hit.usd;
    }
  }
  return out;
}
