"""Per-pool mispricing snapshots (bps) for the preset scenarios.  dev>0: pool pays `dev` bps more token_b per token_a."""
PROFILES = {
    # 3-hop USDC→WBTC→ETH→USDC dislocation through deep pools
    "alpha": {"P04": -110, "P03": -60, "P01": 70},
    # fat, deep dislocation USDC→ETH→WBTC→USDC (looks irresistible — and is exactly what searchers hunt)
    "beta": {"P01": -140, "P03": 170, "P04": 190},
    # USDC→WBTC→ETH→SOL→USDC 4-hop wormhole; the 3-hop shortcuts are thin
    "gamma": {"P04": -110, "P03": -70, "P06": -210, "P05": 250, "P01": 50},
}
