import { Mnemonic, HDNodeWallet } from "ethers";

export type WalletPair = {
  index: number;
  sender: HDNodeWallet;
  receiver: HDNodeWallet;
};

export function deriveWallets(
  masterPrivateKey: string,
  count: number
): HDNodeWallet[] {
  const key = masterPrivateKey.startsWith("0x")
    ? masterPrivateKey.slice(2)
    : masterPrivateKey;
  const entropy = Buffer.from(key, "hex");
  const mnemonic = Mnemonic.fromEntropy(entropy);
  const hdNode = HDNodeWallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0");

  const wallets: HDNodeWallet[] = [];
  for (let i = 0; i < count; i++) {
    wallets.push(hdNode.deriveChild(i));
  }
  return wallets;
}

export function pairWallets(wallets: HDNodeWallet[]): WalletPair[] {
  const pairs: WalletPair[] = [];
  for (let i = 0; i < wallets.length; i += 2) {
    pairs.push({
      index: i / 2,
      sender: wallets[i],
      receiver: wallets[i + 1],
    });
  }
  return pairs;
}
