import {
  Wallet,
  formatEther,
  type JsonRpcProvider,
  type HDNodeWallet,
} from "ethers";
import ora from "ora";
import { getUsdcContract, formatUsdc } from "../utils/usdc.js";
import { pMap } from "../utils/concurrency.js";
import { confirm } from "../utils/prompt.js";
import * as log from "../utils/logger.js";
import type { NetworkConfig } from "../config/networks.js";

export async function sweepFunds(
  wallets: HDNodeWallet[],
  masterAddress: string,
  provider: JsonRpcProvider,
  network: NetworkConfig
): Promise<void> {
  const spinner = ora("Checking derived wallet balances...").start();

  const usdc = getUsdcContract(network.usdcAddress, provider);
  const gasToken = network.gasTokenAddress
    ? getUsdcContract(network.gasTokenAddress, provider)
    : null;
  const gasLabel = gasToken ? "Gas Token" : "ETH";

  type SweepItem = {
    index: number;
    address: string;
    ethBalance: bigint;
    usdcBalance: bigint;
  };

  // Query balances with limited concurrency to avoid RPC rate limits
  const allBalances = await pMap(
    wallets,
    async (w, i) => {
      const [ethBalance, usdcBalance] = await Promise.all([
        provider.getBalance(w.address),
        usdc.balanceOf(w.address) as Promise<bigint>,
      ]);
      return { index: i, address: w.address, ethBalance, usdcBalance };
    },
    10
  );

  const items: SweepItem[] = allBalances.filter(
    (b) => b.ethBalance > 0n || b.usdcBalance > 0n
  );

  spinner.stop();

  if (items.length === 0) {
    log.success("All derived wallets are empty. Nothing to sweep.");
    return;
  }

  log.header(`Cleanup Plan — ${network.name}`);

  const totalEth = items.reduce((s, i) => s + i.ethBalance, 0n);
  const totalUsdc = items.reduce((s, i) => s + i.usdcBalance, 0n);

  log.info(`${gasLabel} to recover:  ${formatEther(totalEth)}`);
  log.info(`USDC to recover: ${formatUsdc(totalUsdc)}`);
  console.log();

  const rows: string[][] = [["Wallet", "Address", gasLabel, "USDC"]];
  for (const item of items) {
    rows.push([
      `#${item.index}`,
      item.address,
      formatEther(item.ethBalance),
      formatUsdc(item.usdcBalance),
    ]);
  }
  log.table(rows);
  console.log();

  const ok = await confirm("Sweep all funds back to master wallet?");
  if (!ok) {
    log.warn("Cleanup cancelled.");
    return;
  }

  const sweepSpinner = ora("Sweeping funds...").start();

  // Step 1: Sweep USDC from all wallets
  const usdcSweeps: Promise<void>[] = [];
  for (const item of items) {
    if (item.usdcBalance > 0n) {
      const wallet = new Wallet(wallets[item.index].privateKey, provider);
      const usdcWithSigner = getUsdcContract(network.usdcAddress, wallet);
      const promise = (usdcWithSigner.transfer as any)(
        masterAddress,
        item.usdcBalance
      )
        .then((tx: any) => tx.wait())
        .then(() => {});
      usdcSweeps.push(promise);
    }
  }

  if (usdcSweeps.length > 0) {
    sweepSpinner.text = `Sweeping USDC from ${usdcSweeps.length} wallet(s)...`;
    await Promise.all(usdcSweeps);
  }

  // Step 2: Sweep ETH / gas token (estimate gas cost and send the remainder)
  const ethSweeps: Promise<void>[] = [];
  for (const item of items) {
    const wallet = new Wallet(wallets[item.index].privateKey, provider);

    if (gasToken) {
      // Gas-token chain: sweep the ERC-20 gas token (same pattern as USDC sweep)
      const balance = await (gasToken.balanceOf(wallet.address) as Promise<bigint>);
      if (balance > 0n) {
        const gasTokenWithSigner = getUsdcContract(network.gasTokenAddress!, wallet);
        const promise = (gasTokenWithSigner.transfer as any)(
          masterAddress,
          balance
        )
          .then((tx: any) => tx.wait())
          .then(() => {});
        ethSweeps.push(promise);
      }
    } else {
      const currentBalance = await provider.getBalance(wallet.address);

      if (currentBalance === 0n) continue;

      try {
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice ?? 50_000_000_000n;
        const gasCost = 21000n * gasPrice;

        if (currentBalance > gasCost) {
          const sendAmount = currentBalance - gasCost;
          const promise = wallet
            .sendTransaction({
              to: masterAddress,
              value: sendAmount,
              gasLimit: 21000,
            })
            .then((tx) => tx.wait())
            .then(() => {});
          ethSweeps.push(promise);
        }
      } catch {
        // If we can't estimate, skip this wallet
      }
    }
  }

  if (ethSweeps.length > 0) {
    sweepSpinner.text = `Sweeping ${gasLabel} from ${ethSweeps.length} wallet(s)...`;
    await Promise.all(ethSweeps);
  }

  sweepSpinner.succeed(
    `Swept ${usdcSweeps.length} USDC + ${ethSweeps.length} ${gasLabel} transfers back to master`
  );
}
