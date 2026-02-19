import { Contract, type Provider, type Signer } from "ethers";

export const DISPERSE_ADDRESS = "0xD152f549545093347A162Dce210e7293f1452150";

const DISPERSE_ABI = [
  "function disperseEther(address[] recipients, uint256[] values) payable",
  "function disperseToken(address token, address[] recipients, uint256[] values)",
];

export async function isDisperseAvailable(
  provider: Provider
): Promise<boolean> {
  const code = await provider.getCode(DISPERSE_ADDRESS);
  return code !== "0x";
}

export function getDisperseContract(
  signerOrProvider: Signer | Provider
): Contract {
  return new Contract(DISPERSE_ADDRESS, DISPERSE_ABI, signerOrProvider);
}
