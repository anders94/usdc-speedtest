import { Contract, type Signer, type Provider } from "ethers";

export const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

export const USDC_DECIMALS = 6;
export const USDC_CENT = BigInt(10_000); // $0.01 in 6-decimal units

export function getUsdcContract(
  address: string,
  signerOrProvider: Signer | Provider
): Contract {
  return new Contract(address, ERC20_ABI, signerOrProvider);
}

export function formatUsdc(amount: bigint): string {
  const whole = amount / BigInt(10 ** USDC_DECIMALS);
  const frac = amount % BigInt(10 ** USDC_DECIMALS);
  return `$${whole}.${frac.toString().padStart(USDC_DECIMALS, "0")}`;
}
