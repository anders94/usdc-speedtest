import { formatEther, type JsonRpcProvider, type Wallet } from "ethers";
import ora from "ora";
import { getUsdcContract } from "../utils/usdc.js";
import * as log from "../utils/logger.js";
import type { NetworkConfig } from "../config/networks.js";

export async function seedGas(
  masterWallet: Wallet,
  provider: JsonRpcProvider,
  network: NetworkConfig,
  targetAddress: string,
  rounds: number
): Promise<void> {
  const sbcContract = getUsdcContract(network.gasTokenAddress!, masterWallet);
  const sbcRead = getUsdcContract(network.gasTokenAddress!, provider);
  const master = masterWallet.address;

  log.header("RUSD Seeding");
  log.info(`Target:  ${targetAddress}`);
  log.info(`Rounds:  ${rounds}`);
  console.log();

  // Estimate gas costs up front
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 50_000_000_000n;
  const nativeSendGas = 21_000n;
  const erc20SendGas = 100_000n; // conservative estimate for ERC-20 transfer
  const gasCostPerRound = (nativeSendGas + erc20SendGas) * gasPrice;

  let totalRusdMoved = 0n;
  let totalSbcSpent = 0n;
  let completed = 0;

  const spinner = ora("Starting seed loop...").start();

  for (let i = 0; i < rounds; i++) {
    spinner.text = `Round ${i + 1}/${rounds}: querying balances...`;

    const [rusdBalance, sbcBalance] = await Promise.all([
      provider.send("rad_getBalanceRaw", [master, "latest"]).then(
        (hex: string) => BigInt(hex)
      ),
      sbcRead.balanceOf(master) as Promise<bigint>,
    ]);

    // Stop if SBC balance is too low to trigger turnstile
    if (sbcBalance < 10n) {
      spinner.warn(`SBC balance too low (${sbcBalance}), stopping early.`);
      break;
    }

    // Stop if available RUSD is dust (not worth sending after gas)
    const minUseful = gasCostPerRound * 2n;
    if (rusdBalance <= minUseful) {
      spinner.text = `Round ${i + 1}/${rounds}: waiting for turnstile (RUSD=${formatEther(rusdBalance)})...`;
      // Send tiny SBC to trigger turnstile and continue
    } else {
      // Send available RUSD minus gas reserve to target
      const sendAmount = rusdBalance - gasCostPerRound * 2n;
      spinner.text = `Round ${i + 1}/${rounds}: sending ${formatEther(sendAmount)} RUSD...`;

      const tx = await masterWallet.sendTransaction({
        to: targetAddress,
        value: sendAmount,
        gasLimit: nativeSendGas,
      });
      await tx.wait();
      totalRusdMoved += sendAmount;
    }

    // Send 1 wei SBC to target — triggers turnstile on master, refilling ~$0.10 RUSD
    spinner.text = `Round ${i + 1}/${rounds}: triggering turnstile (SBC transfer)...`;
    const sbcTx = await (sbcContract.transfer as any)(targetAddress, 1n);
    await sbcTx.wait();
    totalSbcSpent += 1n;

    completed++;
    log.info(
      `  Round ${i + 1}: moved ${formatEther(totalRusdMoved)} RUSD total`
    );
  }

  spinner.succeed(`Seeding complete after ${completed} round(s).`);
  console.log();

  // Summary table
  log.header("Seed Summary");
  log.table([
    ["Metric", "Value"],
    ["Rounds completed", String(completed)],
    ["Total RUSD moved", formatEther(totalRusdMoved)],
    ["Total SBC spent", `${totalSbcSpent} wei`],
    ["Target", targetAddress],
  ]);
}
