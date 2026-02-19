import { Command } from "commander";
import { config as dotenvConfig } from "dotenv";
import { JsonRpcProvider, Wallet } from "ethers";
import chalk from "chalk";
import {
  getNetwork,
  getNetworkNames,
  applyOverrides,
} from "./config/networks.js";
import { deriveWallets, pairWallets } from "./wallet/derive.js";
import { checkAndFund } from "./wallet/fund.js";
import { runTest } from "./test/runner.js";
import { sweepFunds } from "./cleanup/sweep.js";
import * as log from "./utils/logger.js";

dotenvConfig();

const program = new Command();

program
  .name("usdc-speedtest")
  .description(
    "Benchmark EVM network throughput by sending USDC transfers in parallel"
  )
  .version("1.0.0")
  .option(
    "-n, --network <name>",
    `network name (${getNetworkNames().join(", ")})`,
    "baseSepolia"
  )
  .option("-p, --parallel <count>", "number of parallel testers", "5")
  .option("-d, --duration <seconds>", "test duration in seconds", "60")
  .option("--rpc <url>", "override RPC endpoint")
  .option("--usdc-address <addr>", "override USDC contract address")
  .option("--chain-id <id>", "override chain ID")
  .option("--cleanup", "sweep funds from derived wallets back to master")
  .option("--skip-funding", "skip the wallet funding step");

program.parse();

const opts = program.opts();

async function main() {
  // Resolve network config
  let network = getNetwork(opts.network);
  network = applyOverrides(network, {
    rpc: opts.rpc,
    usdcAddress: opts.usdcAddress,
    chainId: opts.chainId ? parseInt(opts.chainId) : undefined,
  });

  if (!network.supported) {
    log.error(
      `Network "${opts.network}" is not yet fully supported. Use --rpc, --usdc-address, and --chain-id to provide configuration.`
    );
    process.exit(1);
  }

  // Load private key
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    log.error(
      "PRIVATE_KEY environment variable is required. Set it in .env or your shell."
    );
    process.exit(1);
  }

  const parallelCount = parseInt(opts.parallel);
  const durationSec = parseInt(opts.duration);
  const walletCount = parallelCount * 2;

  log.header("USDC Speedtest");
  log.info(`Network:    ${network.name} (chainId: ${network.chainId})`);
  log.info(`RPC:        ${network.rpcUrl}`);
  log.info(`Parallel:   ${parallelCount} testers (${walletCount} wallets)`);
  log.info(`Duration:   ${durationSec}s`);
  console.log();

  // Connect
  const provider = new JsonRpcProvider(network.rpcUrl, network.chainId, {
    staticNetwork: true,
  });
  const masterWallet = new Wallet(privateKey, provider);

  log.info(`Master wallet: ${masterWallet.address}`);
  console.log();

  // Derive wallets
  const wallets = deriveWallets(privateKey, walletCount);
  log.info("Derived wallets:");
  for (let i = 0; i < wallets.length; i++) {
    const role = i % 2 === 0 ? chalk.cyan("sender  ") : chalk.magenta("receiver");
    log.info(`  #${i} ${role} ${wallets[i].address}`);
  }
  console.log();

  if (opts.cleanup) {
    await sweepFunds(wallets, masterWallet.address, provider, network);
    return;
  }

  // Check and fund wallets
  if (!opts.skipFunding) {
    await checkAndFund(wallets, masterWallet, provider, network, durationSec);
  }

  // Pair wallets and run test
  const pairs = pairWallets(wallets);
  await runTest(pairs, provider, network, durationSec);
}

main().catch((err) => {
  log.error(err.message || String(err));
  process.exit(1);
});
