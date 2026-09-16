import dotenv from "dotenv";
import { ethers } from "ethers";
import TelegramBot from "node-telegram-bot-api";

dotenv.config();

const STATES = Object.freeze({
  IDLE: "IDLE",
  MONITORING: "MONITORING",
  PUBLIC_MINT_ACTIVE: "PUBLIC_MINT_ACTIVE",
  SAFETY_CHECKS: "SAFETY_CHECKS",
  READY_TO_MINT: "READY_TO_MINT",
  TRANSACTION_SUBMITTED: "TRANSACTION_SUBMITTED",
  WAITING_CONFIRMATION: "WAITING_CONFIRMATION",
  VERIFYING_NFT: "VERIFYING_NFT",
  RETRY_WAIT: "RETRY_WAIT",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  UNKNOWN_TRANSACTION_STATE: "UNKNOWN_TRANSACTION_STATE",
  STOPPED: "STOPPED",
});

const TERMINAL_STATES = new Set([
  STATES.SUCCESS,
  STATES.FAILED,
  STATES.UNKNOWN_TRANSACTION_STATE,
]);

const GAS_ESTIMATE_SAFETY_MARGIN_PERCENT = 10n;

class SafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "SafetyError";
  }
}

const raw = process.env;

function required(name) {
  const value = raw[name]?.trim();
  if (!value) {
    throw new SafetyError(`${name} is required.`);
  }
  return value;
}

function numberFromEnv(name, { integer = false, positive = false, defaultValue } = {}) {
  const value = raw[name]?.trim() || (defaultValue === undefined ? "" : String(defaultValue));
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    throw new SafetyError(`${name} must be a valid ${integer ? "integer" : "number"}.`);
  }
  if (positive && parsed <= 0) {
    throw new SafetyError(`${name} must be greater than zero.`);
  }
  if (parsed < 0) {
    throw new SafetyError(`${name} cannot be negative.`);
  }
  return parsed;
}

function optionalNumberFromEnv(name, options = {}) {
  return raw[name]?.trim() ? numberFromEnv(name, options) : null;
}

function normalizeHumanReadableSignature(signature) {
  return signature
    .replace(/\b(external|public|internal|private)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFunctionFragment(value, label) {
  const normalized = normalizeHumanReadableSignature(value);
  let iface;
  try {
    iface = new ethers.Interface([normalized]);
  } catch (error) {
    throw new SafetyError(`${label} is not a valid function signature: ${safeError(error)}`);
  }

  const functions = iface.fragments.filter((fragment) => fragment.type === "function");
  if (functions.length !== 1) {
    throw new SafetyError(`${label} must contain exactly one function fragment.`);
  }

  return { iface, fragment: functions[0], signature: normalized };
}

function parseNftBalanceFragment(value, label) {
  const normalized = normalizeHumanReadableSignature(value);
  if (normalized === "balanceOf(address)") {
    return parseFunctionFragment(
      "function balanceOf(address) view returns (uint256)",
      label,
    );
  }
  return parseFunctionFragment(value, label);
}

function parseOptionalFunctionFragment(value, label) {
  const trimmed = value?.trim();
  return trimmed ? parseFunctionFragment(trimmed, label) : null;
}

function parseWatchTime(value, label) {
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 2_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new SafetyError(`${label} must be an ISO timestamp or Unix timestamp.`);
  }
  return parsed;
}

function parseConfig() {
  const mintFunction = parseFunctionFragment(required("MINT_FUNCTION_SIGNATURE"), "MINT_FUNCTION_SIGNATURE");
  const nftBalance = parseNftBalanceFragment(required("NFT_BALANCE_SIGNATURE"), "NFT_BALANCE_SIGNATURE");
  const triggerType = required("MINT_TRIGGER_TYPE").toLowerCase();
  const triggerValue = required("MINT_TRIGGER_VALUE");
  if (!["function", "timestamp", "block"].includes(triggerType)) {
    throw new SafetyError("MINT_TRIGGER_TYPE must be function, timestamp, or block.");
  }

  const mintPriceEth = required("MINT_PRICE_ETH");
  let mintPriceWei;
  try {
    mintPriceWei = ethers.parseEther(mintPriceEth);
  } catch (error) {
    throw new SafetyError(`MINT_PRICE_ETH is invalid: ${safeError(error)}`);
  }
  if (mintPriceWei < 0n) {
    throw new SafetyError("MINT_PRICE_ETH cannot be negative.");
  }
  if (mintPriceWei !== 0n) {
    throw new SafetyError("MINT_PRICE_ETH must be exactly 0 for the SeaDrop public mint.");
  }

  const maxFeePerGasGwei = raw.MAX_FEE_PER_GAS_GWEI?.trim() || null;
  const maxPriorityFeePerGasGwei = raw.MAX_PRIORITY_FEE_PER_GAS_GWEI?.trim() || null;
  let maxFeePerGas = null;
  let maxPriorityFeePerGas = null;
  try {
    if (maxFeePerGasGwei) maxFeePerGas = ethers.parseUnits(maxFeePerGasGwei, "gwei");
    if (maxPriorityFeePerGasGwei) {
      maxPriorityFeePerGas = ethers.parseUnits(maxPriorityFeePerGasGwei, "gwei");
    }
  } catch (error) {
    throw new SafetyError(`Gas fee configuration is invalid: ${safeError(error)}`);
  }
  if (maxFeePerGas !== null && maxFeePerGas <= 0n) {
    throw new SafetyError("MAX_FEE_PER_GAS_GWEI must be greater than zero when configured.");
  }
  if (maxPriorityFeePerGas !== null && maxPriorityFeePerGas < 0n) {
    throw new SafetyError("MAX_PRIORITY_FEE_PER_GAS_GWEI cannot be negative.");
  }
  if (
    maxFeePerGas !== null &&
    maxPriorityFeePerGas !== null &&
    maxPriorityFeePerGas > maxFeePerGas
  ) {
    throw new SafetyError("MAX_PRIORITY_FEE_PER_GAS_GWEI must be no greater than MAX_FEE_PER_GAS_GWEI.");
  }

  const watchStart = parseWatchTime(required("WATCH_START"), "WATCH_START");
  const watchEnd = parseWatchTime(required("WATCH_END"), "WATCH_END");
  if (watchEnd <= watchStart) {
    throw new SafetyError("WATCH_END must be after WATCH_START.");
  }

  let wallet;
  try {
    wallet = new ethers.Wallet(required("PRIVATE_KEY"));
  } catch (error) {
    throw new SafetyError(`PRIVATE_KEY is invalid: ${safeError(error)}`);
  }

  let contractAddress;
  try {
    contractAddress = ethers.getAddress(required("CONTRACT_ADDRESS"));
  } catch (error) {
    throw new SafetyError(`CONTRACT_ADDRESS is invalid: ${safeError(error)}`);
  }

  let seaDropAddress;
  try {
    seaDropAddress = ethers.getAddress(required("SEADROP_ADDRESS"));
  } catch (error) {
    throw new SafetyError(`SEADROP_ADDRESS is invalid: ${safeError(error)}`);
  }

  let feeRecipient;
  try {
    feeRecipient = ethers.getAddress(required("MINT_FEE_RECIPIENT"));
  } catch (error) {
    throw new SafetyError(`MINT_FEE_RECIPIENT is invalid: ${safeError(error)}`);
  }

  const config = {
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    telegramUserId: required("TELEGRAM_USER_ID"),
    privateKey: required("PRIVATE_KEY"),
    rpcUrl: required("RPC_URL"),
    contractAddress,
    seaDropAddress,
    feeRecipient,
    wallet,
    mintFunction,
    nftBalance,
    walletMintCount: parseOptionalFunctionFragment(raw.WALLET_MINT_COUNT_SIGNATURE, "WALLET_MINT_COUNT_SIGNATURE"),
    pauseFunction: parseOptionalFunctionFragment(raw.PAUSE_FUNCTION_SIGNATURE, "PAUSE_FUNCTION_SIGNATURE"),
    soldOutFunction: parseOptionalFunctionFragment(raw.SOLD_OUT_FUNCTION_SIGNATURE, "SOLD_OUT_FUNCTION_SIGNATURE"),
    mintPriceEth,
    mintPriceWei,
    maxPerWallet: numberFromEnv("MAX_PER_WALLET", { integer: true, positive: true }),
    trigger: {
      type: triggerType,
      value: triggerValue,
      function:
        triggerType === "function"
          ? parseFunctionFragment(triggerValue, "MINT_TRIGGER_VALUE")
          : null,
      numeric:
        triggerType === "function"
          ? null
          : numberFromEnv("MINT_TRIGGER_VALUE", { integer: triggerType === "block", positive: true }),
    },
    maxFeePerGasGwei,
    maxPriorityFeePerGasGwei,
    maxFeePerGas,
    maxPriorityFeePerGas,
    gasLimit: optionalNumberFromEnv("GAS_LIMIT", { integer: true, positive: true }),
    maxGasCostEth: raw.MAX_GAS_COST_ETH?.trim() || null,
    maxGasCostWei: (() => {
      const value = raw.MAX_GAS_COST_ETH?.trim();
      if (!value) return null;
      try {
        const parsed = ethers.parseEther(value);
        if (parsed < 0n) throw new Error("must not be negative");
        return parsed;
      } catch (error) {
        throw new SafetyError(`MAX_GAS_COST_ETH is invalid: ${safeError(error)}`);
      }
    })(),
    confirmations: numberFromEnv("CONFIRMATIONS", { integer: true, positive: true, defaultValue: 1 }),
    maxAttempts: numberFromEnv("MAX_ATTEMPTS", { integer: true, positive: true, defaultValue: 3 }),
    retryBaseDelayMs: numberFromEnv("RETRY_BASE_DELAY_MS", { integer: true, positive: true, defaultValue: 2000 }),
    retryMaxDelayMs: numberFromEnv("RETRY_MAX_DELAY_MS", { integer: true, positive: true, defaultValue: 30000 }),
    totalMints: numberFromEnv("TOTAL_MINTS", { integer: true, positive: true, defaultValue: 1 }),
    watchStart,
    watchEnd,
    pollIntervalMs: numberFromEnv("POLL_INTERVAL_MS", { integer: true, positive: true, defaultValue: 1000 }),
  };

  if (config.totalMints !== 1) {
    throw new SafetyError("TOTAL_MINTS must be exactly 1.");
  }
  if (config.mintFunction.fragment.format() !== "mintPublic(address,address,address,uint256)") {
    throw new SafetyError(
      "MINT_FUNCTION_SIGNATURE must be exactly mintPublic(address,address,address,uint256).",
    );
  }
  if (config.mintFunction.fragment.stateMutability === "view" || config.mintFunction.fragment.stateMutability === "pure") {
    throw new SafetyError("MINT_FUNCTION_SIGNATURE must be a state-changing function.");
  }
  if (!["view", "pure"].includes(config.nftBalance.fragment.stateMutability)) {
    throw new SafetyError("NFT_BALANCE_SIGNATURE must be view or pure.");
  }
  for (const optional of [config.walletMintCount, config.pauseFunction, config.soldOutFunction]) {
    if (optional && !["view", "pure"].includes(optional.fragment.stateMutability)) {
      throw new SafetyError("Read-only safety-check signatures must be view or pure.");
    }
  }
  if (config.trigger.function && !["view", "pure"].includes(config.trigger.function.fragment.stateMutability)) {
    throw new SafetyError("MINT_TRIGGER_VALUE must be a view or pure function signature.");
  }
  if (config.nftBalance.fragment.inputs.length !== 1 || config.nftBalance.fragment.inputs[0].type !== "address") {
    throw new SafetyError("NFT_BALANCE_SIGNATURE must accept exactly one address argument.");
  }
  for (const [label, optional] of [
    ["WALLET_MINT_COUNT_SIGNATURE", config.walletMintCount],
    ["PAUSE_FUNCTION_SIGNATURE", config.pauseFunction],
    ["SOLD_OUT_FUNCTION_SIGNATURE", config.soldOutFunction],
  ]) {
    if (optional && optional.fragment.inputs.length > 1) {
      throw new SafetyError(`${label} must accept zero or one address argument.`);
    }
    if (optional && optional.fragment.inputs.length === 1 && optional.fragment.inputs[0].type !== "address") {
      throw new SafetyError(`${label} must accept an address when it has an argument.`);
    }
  }

  return config;
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/0x[a-fA-F0-9]{64}/g, "[redacted-hash]")
    .replace(/https?:\/\/\S+/g, "[redacted-url]")
    .replace(/\b[a-fA-F0-9]{64}\b/g, "[redacted-secret]");
}

function formatEth(value) {
  try {
    return ethers.formatEther(value);
  } catch {
    return "unknown";
  }
}

function shortHash(hash) {
  return hash ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : "none";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTimestamp(timestamp) {
  return new Date(timestamp).toISOString();
}

function fragmentName(fragment) {
  return fragment.name ?? fragment.format();
}

function argsForAddress(fragment, address) {
  if (fragment.inputs.length === 0) return [];
  if (fragment.inputs.length === 1 && fragment.inputs[0].type === "address") return [address];
  throw new SafetyError(`${fragmentName(fragment)} has unsupported arguments for a safe read.`);
}

function isWithinWatchWindow(config, now = Date.now()) {
  return now >= config.watchStart && now <= config.watchEnd;
}

function extractHashFromError(error) {
  const candidates = [
    error?.hash,
    error?.transactionHash,
    error?.receipt?.hash,
    error?.transaction?.hash,
    error?.info?.transactionHash,
    error?.info?.hash,
  ];
  return candidates.find((candidate) => typeof candidate === "string" && /^0x[a-fA-F0-9]{64}$/.test(candidate)) ?? null;
}

function readBooleanResult(iface, fragment, data, label) {
  try {
    const [result] = iface.decodeFunctionResult(fragment, data);
    if (typeof result !== "boolean") {
      throw new SafetyError(`${label} did not return bool.`);
    }
    return result;
  } catch (error) {
    throw new SafetyError(`Could not safely read ${label}: ${safeError(error)}`);
  }
}

async function main() {
  let config;
  try {
    config = parseConfig();
  } catch (error) {
    console.error(`[startup] Refusing to start: ${safeError(error)}`);
    process.exitCode = 1;
    return;
  }

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = config.wallet.connect(provider);
  const state = {
    current: STATES.IDLE,
    watchActive: false,
    shuttingDown: false,
    successfulMintCount: 0,
    currentAttempt: 0,
    publicMintActive: false,
    lastTransactionHash: null,
    lastTransactionStatus: "none",
    lastError: null,
    finalResult: "not started",
    nftBalance: null,
    ethBalance: null,
    chainId: null,
    networkName: "unknown",
    watchLoopPromise: null,
    mintWorkflowPromise: null,
    lastNotification: "",
  };

  const mintIface = config.mintFunction.iface;
  const balanceIface = config.nftBalance.iface;

  function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
  }

  function setState(next, reason = "") {
    state.current = next;
    log(`state=${next}${reason ? ` reason=${reason}` : ""}`);
  }

  function markError(error) {
    state.lastError = safeError(error);
    log(`error=${state.lastError}`);
  }

  async function notify(message) {
    state.lastNotification = message;
    try {
      await bot.sendMessage(config.telegramUserId, message);
    } catch (error) {
      log(`telegram notification failed: ${safeError(error)}`);
    }
  }

  async function readEthBalance() {
    state.ethBalance = await provider.getBalance(wallet.address);
    return state.ethBalance;
  }

  async function getCurrentTransactionFees() {
    let feeData;
    try {
      feeData = await provider.getFeeData();
    } catch (error) {
      throw new SafetyError(`Could not read current network fee data: ${safeError(error)}`);
    }

    const networkMaxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
    const networkPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? 0n;
    if (networkMaxFeePerGas === null || networkMaxFeePerGas <= 0n) {
      throw new SafetyError("RPC provider did not return a usable current max fee per gas.");
    }

    const maxFeePerGas =
      config.maxFeePerGas === null || networkMaxFeePerGas < config.maxFeePerGas
        ? networkMaxFeePerGas
        : config.maxFeePerGas;
    const maxPriorityFeePerGas = [
      networkPriorityFeePerGas,
      ...(config.maxPriorityFeePerGas === null ? [] : [config.maxPriorityFeePerGas]),
      maxFeePerGas,
    ].reduce((lowest, fee) => (fee < lowest ? fee : lowest));

    if (maxFeePerGas <= 0n || maxPriorityFeePerGas < 0n || maxPriorityFeePerGas > maxFeePerGas) {
      throw new SafetyError("Current network fee data cannot satisfy the configured gas ceilings.");
    }

    log(
      `networkFees maxFeePerGasGwei=${ethers.formatUnits(maxFeePerGas, "gwei")} ` +
        `maxPriorityFeePerGasGwei=${ethers.formatUnits(maxPriorityFeePerGas, "gwei")}`,
    );
    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  function calculateMaximumGasCost(gasLimit, maxFeePerGas) {
    const maximumGasCost = gasLimit * maxFeePerGas;
    if (config.maxGasCostWei !== null && maximumGasCost > config.maxGasCostWei) {
      throw new SafetyError(
        `Maximum gas cost ${formatEth(maximumGasCost)} exceeds MAX_GAS_COST_ETH ${config.maxGasCostEth}.`,
      );
    }
    return maximumGasCost;
  }

  async function readNftBalance() {
    const data = balanceIface.encodeFunctionData(config.nftBalance.fragment, [wallet.address]);
    const result = await provider.call({ to: config.contractAddress, data });
    try {
      const [balance] = balanceIface.decodeFunctionResult(config.nftBalance.fragment, result);
      if (typeof balance !== "bigint") throw new Error("result was not an integer");
      state.nftBalance = balance;
      return balance;
    } catch (error) {
      throw new SafetyError(`Could not decode NFT balance: ${safeError(error)}`);
    }
  }

  async function readOptionalBoolean(check, label) {
    if (!check) return null;
    const args = argsForAddress(check.fragment, wallet.address);
    const data = check.iface.encodeFunctionData(check.fragment, args);
    const result = await provider.call({ to: config.contractAddress, data });
    return readBooleanResult(check.iface, check.fragment, result, label);
  }

  async function readOptionalCount(check, label) {
    if (!check) return null;
    const args = argsForAddress(check.fragment, wallet.address);
    const data = check.iface.encodeFunctionData(check.fragment, args);
    const result = await provider.call({ to: config.contractAddress, data });
    try {
      const [count] = check.iface.decodeFunctionResult(check.fragment, result);
      if (typeof count !== "bigint") throw new Error("result was not an integer");
      return count;
    } catch (error) {
      throw new SafetyError(`Could not decode ${label}: ${safeError(error)}`);
    }
  }

  async function getPublicMintStatus() {
    if (config.trigger.type === "timestamp") {
      const block = await provider.getBlock("latest");
      if (!block) throw new SafetyError("Could not read the latest block for timestamp trigger.");
      const active = block.timestamp * 1000 >= config.trigger.numeric;
      state.publicMintActive = active;
      return active;
    }
    if (config.trigger.type === "block") {
      const blockNumber = await provider.getBlockNumber();
      const active = blockNumber >= config.trigger.numeric;
      state.publicMintActive = active;
      return active;
    }

    const { iface, fragment } = config.trigger.function;
    if (fragment.inputs.length !== 0 || fragment.outputs.length !== 1 || fragment.outputs[0].type !== "bool") {
      throw new SafetyError("A function mint trigger must be a zero-argument function returning bool.");
    }
    const data = iface.encodeFunctionData(fragment, []);
    const result = await provider.call({ to: config.contractAddress, data });
    const active = readBooleanResult(iface, fragment, result, "public-mint trigger");
    state.publicMintActive = active;
    return active;
  }

  async function waitForConfirmedReceipt(hash) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && !state.shuttingDown) {
      let receipt;
      try {
        receipt = await provider.getTransactionReceipt(hash);
      } catch (error) {
        throw new SafetyError(`Could not resolve transaction ${shortHash(hash)}: ${safeError(error)}`);
      }
      if (receipt) {
        if (config.confirmations > 1) {
          const blockNumber = await provider.getBlockNumber();
          if (blockNumber < receipt.blockNumber + config.confirmations - 1) {
            await sleep(1000);
            continue;
          }
        }
        return receipt;
      }
      await sleep(1000);
    }
    return null;
  }

  async function verifyMint(baselineBalance) {
    setState(STATES.VERIFYING_NFT);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const balance = await readNftBalance();
      log(`nftBalanceAfterMint=${balance.toString()}`);
      if (balance >= baselineBalance + 1n) return balance;
      await sleep(1000);
    }
    throw new SafetyError("Transaction was confirmed successful but NFT balance did not increase; refusing to retry.");
  }

  async function preflight() {
    setState(STATES.SAFETY_CHECKS);
    const active = await getPublicMintStatus();
    if (!active) throw new SafetyError("Public mint is not active.");

    const nftBalance = await readNftBalance();
    const walletMintCount = await readOptionalCount(config.walletMintCount, "wallet mint count");
    const effectiveCount = walletMintCount ?? nftBalance;
    log(`nftBalance=${nftBalance.toString()} walletMintCount=${walletMintCount?.toString() ?? "using-nft-balance"}`);
    if (effectiveCount >= BigInt(config.maxPerWallet)) {
      throw new SafetyError(`Wallet limit reached (${effectiveCount.toString()}/${config.maxPerWallet}).`);
    }

    const paused = await readOptionalBoolean(config.pauseFunction, "pause status");
    if (paused === true) throw new SafetyError("Contract is paused.");
    const soldOut = await readOptionalBoolean(config.soldOutFunction, "sold-out status");
    if (soldOut === true) throw new SafetyError("Collection is sold out.");

    const mintArgs = [
      config.contractAddress,
      config.feeRecipient,
      ethers.ZeroAddress,
      1n,
    ];
    const data = mintIface.encodeFunctionData(config.mintFunction.fragment, mintArgs);
    let estimatedGas;
    try {
      estimatedGas = await provider.estimateGas({
        from: wallet.address,
        to: config.seaDropAddress,
        data,
        value: config.mintPriceWei,
      });
    } catch (error) {
      throw new SafetyError(`Gas estimation failed: ${safeError(error)}`);
    }

    let gasLimit;
    if (config.gasLimit !== null) {
      gasLimit = BigInt(config.gasLimit);
      if (estimatedGas > gasLimit) {
        throw new SafetyError(`Estimated gas ${estimatedGas.toString()} exceeds GAS_LIMIT ${config.gasLimit}.`);
      }
    } else {
      const safetyMargin = (estimatedGas * GAS_ESTIMATE_SAFETY_MARGIN_PERCENT + 99n) / 100n;
      gasLimit = estimatedGas + safetyMargin;
    }

    const fees = await getCurrentTransactionFees();
    const maximumGasCost = calculateMaximumGasCost(gasLimit, fees.maxFeePerGas);
    log(
      `estimatedGas=${estimatedGas.toString()} gasLimit=${gasLimit.toString()} ` +
        `maximumGasCostEth=${formatEth(maximumGasCost)}`,
    );

    const ethBalance = await readEthBalance();
    const requiredBalance = maximumGasCost + config.mintPriceWei;
    log(`ethBalance=${formatEth(ethBalance)} requiredBalance=${formatEth(requiredBalance)}`);
    if (ethBalance < requiredBalance) {
      throw new SafetyError(`Insufficient ETH. Need up to ${formatEth(requiredBalance)}, have ${formatEth(ethBalance)}.`);
    }

    setState(STATES.READY_TO_MINT);
    return { baselineBalance: nftBalance, data, mintArgs, estimatedGas, gasLimit, fees, maximumGasCost };
  }

  async function resolveSubmittedTransaction(hash, baselineBalance) {
    state.lastTransactionHash = hash;
    state.lastTransactionStatus = "pending";
    setState(STATES.WAITING_CONFIRMATION);
    const receipt = await waitForConfirmedReceipt(hash);
    if (!receipt) {
      throw new SafetyError("Transaction receipt was not resolved before the safety timeout.");
    }
    if (Number(receipt.status) === 0) {
      state.lastTransactionStatus = "confirmed_failed";
      return { success: false, receipt };
    }
    state.lastTransactionStatus = "confirmed";
    const balance = await verifyMint(baselineBalance);
    return { success: true, receipt, balance };
  }

  async function submitMint(preflightResult) {
    const maximumGasCost = calculateMaximumGasCost(preflightResult.gasLimit, preflightResult.fees.maxFeePerGas);
    const transaction = {
      to: config.seaDropAddress,
      data: preflightResult.data,
      value: config.mintPriceWei,
      gasLimit: preflightResult.gasLimit,
      maxFeePerGas: preflightResult.fees.maxFeePerGas,
      maxPriorityFeePerGas: preflightResult.fees.maxPriorityFeePerGas,
    };
    setState(STATES.TRANSACTION_SUBMITTED);
    log(
      `mintAttempt=${state.currentAttempt} gasLimit=${preflightResult.gasLimit.toString()} ` +
        `maxFeePerGasGwei=${ethers.formatUnits(preflightResult.fees.maxFeePerGas, "gwei")} ` +
        `maxPriorityFeePerGasGwei=${ethers.formatUnits(preflightResult.fees.maxPriorityFeePerGas, "gwei")} ` +
        `maximumGasCostEth=${formatEth(maximumGasCost)} mintPriceEth=${config.mintPriceEth}`,
    );
    let response;
    try {
      response = await wallet.sendTransaction(transaction);
    } catch (error) {
      const hash = extractHashFromError(error);
      if (hash) {
        state.lastTransactionHash = hash;
        log(`transactionHashFromError=${shortHash(hash)}`);
        return await resolveSubmittedTransaction(hash, preflightResult.baselineBalance);
      }
      throw new SafetyError(
        `Transaction submission failed without a safely trackable hash. Treating state as unknown; no retry will be attempted. ${safeError(error)}`,
      );
    }
    state.lastTransactionHash = response.hash;
    log(`transactionHash=${shortHash(response.hash)}`);
    await notify(`Transaction submitted.\nAttempt: ${state.currentAttempt}/${config.maxAttempts}\nTransaction: ${response.hash}`);
    return await resolveSubmittedTransaction(response.hash, preflightResult.baselineBalance);
  }

  async function executeMintWorkflow(source) {
    if (state.successfulMintCount >= config.totalMints) {
      setState(STATES.SUCCESS, "target already reached");
      return;
    }
    if (!isWithinWatchWindow(config)) {
      throw new SafetyError("The current time is outside WATCH_START/WATCH_END.");
    }

    state.watchActive = false;
    state.finalResult = "in progress";
    log(`mintWorkflowSource=${source}`);
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      try {
        if (state.shuttingDown) throw new SafetyError("Shutdown requested; no new transaction will be submitted.");
        state.currentAttempt = attempt;
        const preflightResult = await preflight();
        await notify(
          `Safety checks passed.\nAttempt: ${attempt}/${config.maxAttempts}\nEstimated gas: ${preflightResult.estimatedGas.toString()}\nMaximum gas cost: ${formatEth(preflightResult.maximumGasCost)} ETH`,
        );
        await notify(`Mint attempt started.\nAttempt: ${attempt}/${config.maxAttempts}`);
        const result = await submitMint(preflightResult);
        if (result.success) {
          state.successfulMintCount = 1;
          state.finalResult = "success";
          setState(STATES.SUCCESS, "confirmed and verified");
          state.watchActive = false;
          await notify(
            `NFT Mint Successful\nMinted: 1 NFT\nSuccessful mints: 1/1\nTransaction: ${result.receipt.hash}\nNFT balance: ${result.balance.toString()}\nStatus: CONFIRMED + VERIFIED\nBot stopped.`,
          );
          return;
        }

        const observedBalance = await readNftBalance();
        if (observedBalance >= preflightResult.baselineBalance + 1n) {
          state.successfulMintCount = 1;
          state.finalResult = "success";
          setState(STATES.SUCCESS, "balance increased after failed receipt");
          await notify("NFT balance increased after the receipt reported failure. Bot stopped without retrying.");
          return;
        }

        await notify(
          `Mint attempt failed.\nAttempt: ${attempt}/${config.maxAttempts}\nReason: confirmed transaction revert.\nTransaction: ${state.lastTransactionHash ?? "unknown"}`,
        );
        if (attempt >= config.maxAttempts) {
          state.finalResult = "all retries failed";
          setState(STATES.FAILED, "maximum attempts reached");
          await notify("All retries failed. Bot stopped.");
          return;
        }

        const delay = Math.min(
          config.retryBaseDelayMs * 2 ** (attempt - 1),
          config.retryMaxDelayMs,
        );
        setState(STATES.RETRY_WAIT, `${delay}ms`);
        await notify(`Retry scheduled after confirmed failure.\nNext attempt in ${delay} ms.`);
        await sleep(delay);
      } catch (error) {
        markError(error);
        state.watchActive = false;
        if (error instanceof SafetyError && /unknown|trackable|receipt|balance did not increase|shutdown/i.test(error.message)) {
          setState(STATES.UNKNOWN_TRANSACTION_STATE, "manual blockchain-status resolution required");
          state.finalResult = "stopped because transaction state is uncertain";
          await notify(
            `Transaction state uncertain.\n${error.message}\nNo retry will be submitted.\nBot stopped to prevent duplicate minting.`,
          );
        } else {
          setState(STATES.STOPPED, "safety check failed");
          state.finalResult = "stopped by safety check";
          await notify(`Safety check failed.\nReason: ${safeError(error)}\nNo transaction was submitted by this workflow.`);
        }
        return;
      }
    }
  }

  async function runMintWorkflow(source) {
    if (state.mintWorkflowPromise) {
      throw new SafetyError("A mint workflow is already running.");
    }
    const workflow = executeMintWorkflow(source);
    state.mintWorkflowPromise = workflow;
    try {
      await workflow;
    } finally {
      if (state.mintWorkflowPromise === workflow) {
        state.mintWorkflowPromise = null;
      }
    }
  }

  async function startWatching(chatId) {
    if (state.watchActive) {
      await bot.sendMessage(chatId, "Monitoring is already active.");
      return;
    }
    const userStoppedWithoutSubmission =
      state.current === STATES.STOPPED &&
      state.finalResult === "stopped by user" &&
      !state.lastTransactionHash;
    if (
      state.mintWorkflowPromise ||
      state.successfulMintCount >= config.totalMints ||
      (TERMINAL_STATES.has(state.current) && !userStoppedWithoutSubmission) ||
      (state.current === STATES.STOPPED && !userStoppedWithoutSubmission)
    ) {
      await bot.sendMessage(chatId, `Monitoring cannot start from state ${state.current}. Restart the process after a terminal result.`);
      return;
    }
    state.watchActive = true;
    state.finalResult = "monitoring";
    setState(STATES.MONITORING, "telegram /watch");
    await notify(`Monitoring started.\nWindow: ${formatTimestamp(config.watchStart)} to ${formatTimestamp(config.watchEnd)}`);
    state.watchLoopPromise = (async () => {
      while (state.watchActive && !state.shuttingDown) {
        if (!isWithinWatchWindow(config)) {
          state.watchActive = false;
          state.finalResult = "watch window ended";
          setState(STATES.STOPPED, "watch window ended");
          await notify("Bot stopped. Public mint did not activate within the configured watch window.");
          return;
        }
        try {
          const active = await getPublicMintStatus();
          log(`publicMintActive=${active}`);
          if (active) {
            state.watchActive = false;
            setState(STATES.PUBLIC_MINT_ACTIVE, "official trigger active");
            await notify("Public mint detected. Starting safety checks.");
            await runMintWorkflow("automatic");
            return;
          }
        } catch (error) {
          markError(error);
          state.watchActive = false;
          state.finalResult = "stopped because public-mint status was not safely established";
          setState(STATES.STOPPED, "public trigger read failed");
          await notify(`Unable to safely establish public-mint status.\n${safeError(error)}\nBot stopped without submitting a transaction.`);
          return;
        }
        await sleep(config.pollIntervalMs);
      }
    })().finally(() => {
      state.watchLoopPromise = null;
    });
  }

  async function stopWatching(chatId) {
    state.watchActive = false;
    if (state.current === STATES.STOPPED && state.finalResult !== "stopped by user") {
      await bot.sendMessage(chatId, `Bot is already stopped.\nReason: ${state.finalResult}`);
      return;
    }
    if (!state.mintWorkflowPromise && ![STATES.SUCCESS, STATES.UNKNOWN_TRANSACTION_STATE].includes(state.current)) {
      setState(STATES.STOPPED, "telegram /stop");
      state.finalResult = "stopped by user";
      await bot.sendMessage(chatId, "Monitoring stopped safely. No new transaction will be submitted.");
      return;
    }
    await bot.sendMessage(
      chatId,
      `Monitoring stopped. Existing transaction state will not be cancelled or retried blindly.${state.lastTransactionHash ? `\nTransaction: ${state.lastTransactionHash}` : ""}`,
    );
  }

  function statusText() {
    return [
      `Watch state: ${state.watchActive ? "ACTIVE" : "INACTIVE"}`,
      `Mint state: ${state.current}`,
      `Public mint status: ${state.publicMintActive ? "ACTIVE" : "INACTIVE/UNKNOWN"}`,
      `Wallet address: ${wallet.address}`,
      `ETH balance: ${state.ethBalance === null ? "not read" : formatEth(state.ethBalance)}`,
      `NFT balance: ${state.nftBalance === null ? "not read" : state.nftBalance.toString()}`,
      `Successful mint count: ${state.successfulMintCount}`,
      `Remaining target: ${Math.max(config.totalMints - state.successfulMintCount, 0)}`,
      `Current attempt: ${state.currentAttempt}`,
      `Maximum attempts: ${config.maxAttempts}`,
      `Last transaction hash: ${state.lastTransactionHash ?? "none"}`,
      `Last transaction status: ${state.lastTransactionStatus}`,
      `Last error: ${state.lastError ?? "none"}`,
      `Final result: ${state.finalResult}`,
    ].join("\n");
  }

  const bot = new TelegramBot(config.telegramBotToken, { polling: true });

  bot.on("message", async (message) => {
    const senderId = message.from?.id;
    if (senderId === undefined || String(senderId) !== config.telegramUserId) return;

    const text = message.text?.trim() ?? "";
    const [commandWithBot, ...args] = text.split(/\s+/);
    const command = commandWithBot?.split("@")[0]?.toLowerCase();
    const chatId = message.chat.id;

    try {
      if (command === "/start") {
        await bot.sendMessage(
          chatId,
          `Bot is online.\nNetwork: ${state.networkName}\nChain ID: ${state.chainId ?? "loading"}\nContract: ${config.contractAddress}\nWallet: ${wallet.address}\nMint state: ${state.current}`,
        );
      } else if (command === "/watch") {
        await startWatching(chatId);
      } else if (command === "/mint") {
        if (args.length !== 1 || args[0] !== "1") {
          await bot.sendMessage(chatId, "Only /mint 1 is valid. Quantities of 0 or greater than 1 are rejected.");
          return;
        }
        if (state.mintWorkflowPromise) {
          await bot.sendMessage(chatId, "A mint workflow is already running. No duplicate transaction will be submitted.");
          return;
        }
        await runMintWorkflow("manual");
      } else if (command === "/status") {
        await bot.sendMessage(chatId, statusText());
      } else if (command === "/stop") {
        await stopWatching(chatId);
      }
    } catch (error) {
      markError(error);
      await bot.sendMessage(chatId, `Command could not be completed safely.\nReason: ${safeError(error)}`);
    }
  });

  bot.on("polling_error", (error) => log(`telegram polling error: ${safeError(error)}`));

  try {
    const network = await provider.getNetwork();
    state.chainId = network.chainId.toString();
    state.networkName = network.name || "unknown";
    const code = await provider.getCode(config.contractAddress);
    if (code === "0x") throw new SafetyError("CONTRACT_ADDRESS has no deployed contract code at RPC_URL.");
    await readEthBalance();
    await readNftBalance();
    log(`network=${state.networkName}`);
    log(`chainId=${state.chainId}`);
    log(`contract=${config.contractAddress}`);
    log(`wallet=${wallet.address}`);
    log(`initialEthBalance=${formatEth(state.ethBalance)}`);
    log(`initialNftBalance=${state.nftBalance.toString()}`);
    log(`gas maxFeePerGasGwei=${config.maxFeePerGasGwei} maxPriorityFeePerGasGwei=${config.maxPriorityFeePerGasGwei} gasLimit=${config.gasLimit}`);
    await notify(`Bot online.\nNetwork: ${state.networkName}\nChain ID: ${state.chainId}\nWallet: ${wallet.address}\nMint state: ${state.current}`);
  } catch (error) {
    console.error(`[startup] Refusing to operate: ${safeError(error)}`);
    bot.stopPolling();
    process.exitCode = 1;
    return;
  }

  async function shutdown(signal) {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    state.watchActive = false;
    log(`shutdown=${signal}`);
    await notify(
      `Bot stopped gracefully (${signal}).${state.lastTransactionHash ? `\nA transaction was already submitted: ${state.lastTransactionHash}` : "\nNo transaction was submitted."}`,
    );
    bot.stopPolling();
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();