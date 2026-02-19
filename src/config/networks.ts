export type NetworkConfig = {
  name: string;
  chainId: number;
  rpcUrl: string;
  usdcAddress: string;
  estimatedBlockTimeMs: number;
  blockExplorerUrl?: string;
  supported: boolean;
};

const networks: Record<string, NetworkConfig> = {
  mainnet: {
    name: "Ethereum Mainnet",
    chainId: 1,
    rpcUrl: "https://eth.llamarpc.com",
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    estimatedBlockTimeMs: 12_000,
    blockExplorerUrl: "https://etherscan.io",
    supported: true,
  },
  sepolia: {
    name: "Ethereum Sepolia",
    chainId: 11155111,
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    estimatedBlockTimeMs: 12_000,
    blockExplorerUrl: "https://sepolia.etherscan.io",
    supported: true,
  },
  base: {
    name: "Base",
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    estimatedBlockTimeMs: 2_000,
    blockExplorerUrl: "https://basescan.org",
    supported: true,
  },
  baseSepolia: {
    name: "Base Sepolia",
    chainId: 84532,
    rpcUrl: "https://sepolia.base.org",
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    estimatedBlockTimeMs: 2_000,
    blockExplorerUrl: "https://sepolia.basescan.org",
    supported: true,
  },
  radius: {
    name: "Radius",
    chainId: 0,
    rpcUrl: "",
    usdcAddress: "",
    estimatedBlockTimeMs: 500,
    supported: false,
  },
  radiusTestnet: {
    name: "Radius Testnet",
    chainId: 0,
    rpcUrl: "",
    usdcAddress: "",
    estimatedBlockTimeMs: 500,
    supported: false,
  },
};

export function getNetwork(name: string): NetworkConfig {
  const config = networks[name];
  if (!config) {
    const available = Object.keys(networks).join(", ");
    throw new Error(`Unknown network "${name}". Available: ${available}`);
  }
  return config;
}

export function getNetworkNames(): string[] {
  return Object.keys(networks);
}

export function applyOverrides(
  config: NetworkConfig,
  overrides: { rpc?: string; usdcAddress?: string; chainId?: number }
): NetworkConfig {
  const result = { ...config };
  if (overrides.rpc) result.rpcUrl = overrides.rpc;
  if (overrides.usdcAddress) result.usdcAddress = overrides.usdcAddress;
  if (overrides.chainId) result.chainId = overrides.chainId;

  if (result.rpcUrl && result.usdcAddress && result.chainId) {
    result.supported = true;
  }

  return result;
}
