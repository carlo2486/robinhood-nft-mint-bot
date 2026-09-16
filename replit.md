# Robinhood Chain NFT public-mint bot

An isolated Node.js Telegram bot for one-shot, fail-closed NFT public mints on an EVM-compatible Robinhood Chain deployment.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/robinhood-nft-mint-bot run check` — syntax-check the bot
- `pnpm --filter @workspace/robinhood-nft-mint-bot start` — start the Telegram/Web3 bot after configuring its local `.env`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `packages/robinhood-nft-mint-bot/bot.js` — bot runtime and explicit transaction state machine
- `packages/robinhood-nft-mint-bot/.env.example` — non-secret configuration template
- `packages/robinhood-nft-mint-bot/README.md` — setup, contract-specific inputs, and safety model

## Architecture decisions

- The bot requires an exact NFT balance reader because a successful transaction is not enough; the wallet must be verified to have received the NFT before the workflow can stop as successful.
- The bot rejects unsupported mint signatures rather than fabricating proofs, signatures, nonces, deadlines, or other authorization inputs.
- Any unresolved transaction state is terminal for this process. Confirmed reverts are the only retryable transaction outcome.

## Product

Telegram-only control for a dedicated wallet: safe status, one monitoring loop, automatic public-trigger detection, one-NFT minting, receipt confirmation, NFT verification, conservative retries, and graceful stop behavior.

## User preferences

- Prioritize preventing duplicate NFT mints over convenience.

## Gotchas

- Do not fill in contract-specific configuration from assumptions; the bot intentionally refuses to start when required details are absent or incompatible.
- Never run the mint bot with a funded wallet until the exact contract behavior and trigger have been independently verified.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
