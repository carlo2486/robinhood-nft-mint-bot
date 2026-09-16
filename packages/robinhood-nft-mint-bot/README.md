# Robinhood Chain NFT public-mint bot

This is a Telegram-controlled Node.js bot for attempting exactly one public NFT mint on an EVM-compatible Robinhood Chain deployment. It is deliberately fail-closed: it does not invent a contract ABI, public-mint trigger, authorization payload, wallet-limit method, or ownership check.

## Before you run it

The contract-specific details cannot be inferred from Robinhood Chain or an NFT collection name. Before enabling a live wallet, obtain the official contract documentation or verified source and confirm:

- the exact public mint function and every parameter;
- the exact transaction value and mint price;
- the official public-mint trigger;
- the public-mint start and end behavior;
- wallet-limit behavior and whether transferred NFTs count;
- pause and sold-out methods, if available;
- the ownership/balance method used to verify the received NFT;
- any signature, Merkle proof, nonce, deadline, or replay-protection requirement;
- any chain-specific gas or transaction requirements.

This implementation supports a zero-argument mint function or an exact one-argument unsigned-integer quantity function. It intentionally refuses functions needing proofs, signatures, nonces, deadlines, or other parameters because fabricating those values could mint in the wrong phase or create an unsafe retry path.

Do not run with a funded wallet until these values have been independently checked. Start with a disposable wallet and a verified RPC endpoint.

## Requirements

- Node.js 20 or newer
- npm or pnpm
- A Telegram bot token created with BotFather
- The numeric Telegram user ID that is allowed to control the bot
- An RPC endpoint for the intended chain
- A wallet private key loaded through a local `.env` file or a secret manager

## Installation

From this directory:

```bash
pnpm install
cp .env.example .env
```

If you are running the package outside this workspace, `npm install` is equivalent.

Never commit `.env`. The example file contains placeholders only.

## Configuration

Copy `.env.example` to `.env` and fill in every required value.

### Telegram

- `TELEGRAM_BOT_TOKEN` is the token from BotFather. Keep it private.
- `TELEGRAM_USER_ID` is the numeric ID of the only user allowed to control the wallet. Use a trusted Telegram user-ID lookup bot or Telegram's documented user information flow, then verify the result independently.

Every incoming message is checked against this exact ID. Messages from every other user are ignored without a response.

### Wallet and contract

- `PRIVATE_KEY` is the key for the dedicated mint wallet. Never send it to Telegram or put it in source control.
- `RPC_URL` is the RPC endpoint for the intended network.
- `CONTRACT_ADDRESS` must be the deployed NFT contract address.
- `MINT_FUNCTION_SIGNATURE` must be the exact public-mint function signature from official documentation. The code does not assume `publicMint`, `mint`, or any other function name.
- `MINT_PRICE_ETH` is the exact configured transaction value. If it is `0`, the transaction sends `value = 0`; ETH is used only for gas.
- `MAX_PER_WALLET` is the official wallet limit.
- `NFT_BALANCE_SIGNATURE` is the exact read-only ownership/balance function used to verify that the wallet received an NFT. A common example is `function balanceOf(address owner) view returns (uint256)`, but this example is not assumed by the bot.

Optional read-only checks:

- `WALLET_MINT_COUNT_SIGNATURE` can provide an official mint counter. If omitted, the configured NFT balance is used as the wallet-limit counter. If transferred NFTs must not count toward the mint limit, configure the official mint-count function instead.
- `PAUSE_FUNCTION_SIGNATURE` can provide an official boolean pause method.
- `SOLD_OUT_FUNCTION_SIGNATURE` can provide an official boolean sold-out method.

### Public-mint trigger

Set `MINT_TRIGGER_TYPE` to one of:

- `function` — `MINT_TRIGGER_VALUE` is an exact zero-argument read-only function signature that returns `bool`, such as `function mintActive() view returns (bool)`.
- `timestamp` — `MINT_TRIGGER_VALUE` is the official Unix timestamp in seconds or an ISO timestamp. The latest chain block timestamp is compared with it.
- `block` — `MINT_TRIGGER_VALUE` is the official block number at which public mint starts.

The timestamp and block forms only express a start trigger. If the contract has a separate end condition, use the official boolean function trigger instead. The bot stops if it cannot safely establish the configured trigger.

### Gas and watch window

- `MAX_FEE_PER_GAS_GWEI` and `MAX_PRIORITY_FEE_PER_GAS_GWEI` are hard fee ceilings.
- `GAS_LIMIT` is a hard gas-limit ceiling and the gas limit sent with the transaction.
- `MAX_GAS_COST_ETH` is the maximum gas budget. The bot refuses to submit if `GAS_LIMIT * MAX_FEE_PER_GAS_GWEI` exceeds it.
- `WATCH_START` and `WATCH_END` accept ISO timestamps or Unix timestamps. No monitoring occurs outside this window.
- `POLL_INTERVAL_MS` controls trigger polling.

The bot also checks the wallet balance against the configured mint price plus the maximum gas cost before every attempt.

## Start and commands

Start the process:

```bash
pnpm start
```

The process validates the RPC, contract code, wallet address, initial ETH balance, and configured NFT balance reader before announcing itself online.

Telegram commands:

- `/start` — confirms the bot is online and shows safe network, contract, wallet, and state information.
- `/watch` — starts one monitoring loop. Repeated `/watch` commands do not create duplicate timers.
- `/mint 1` — starts one immediate mint workflow, but still requires the public trigger, wallet limit, balance, pause/sold-out checks, gas checks, and transaction-state protections.
- `/status` — reports state, balances, attempts, hashes, errors, and the final result without secrets.
- `/stop` — stops monitoring. It never cancels or blindly replaces a submitted transaction.

Only `/mint 1` is accepted. `/mint 0`, `/mint 2`, malformed quantities, and all other quantities are rejected.

## Safety behavior

The successful path is:

```text
public trigger → safety checks → one transaction → confirmed receipt → NFT balance increase → SUCCESS → stop
```

There is one explicit workflow lock and one transaction path. The bot never uses concurrent mint submissions, `Promise.all`, or a second submission while a previous transaction is pending or unresolved.

Retries happen only after the chain returns a confirmed reverted receipt. Before a retry, the bot runs the complete preflight again and uses exponential backoff:

```text
min(RETRY_BASE_DELAY_MS * 2^(attempt - 1), RETRY_MAX_DELAY_MS)
```

If submission may have been broadcast but no safely trackable hash exists, the bot enters `UNKNOWN_TRANSACTION_STATE`, stops, and notifies Telegram. If a hash exists, it tracks that exact transaction. A missing receipt after the resolution timeout is also treated as uncertain. None of these cases is retried.

After one confirmed receipt and a verified NFT-balance increase, the bot records `1/1`, disables further attempts, and stops monitoring permanently.

## Security warnings

- Use a dedicated wallet with only the ETH needed for the mint and gas budget.
- Do not put the private key, seed phrase, Telegram token, or RPC credentials in source code, logs, Telegram messages, screenshots, or Git.
- Do not paste a private key or seed phrase into Telegram.
- Verify the contract address, ABI, chain ID, trigger, price, wallet limit, and recipient wallet independently.
- An RPC provider error after submission is not proof of failure. Resolve the on-chain transaction before taking any further action.
- This software cannot guarantee that a third-party contract is safe or that a mint will succeed. It only enforces the configured safety rules and fails closed when required facts are missing.