<p align="center">
  <img src=".github/banner.svg" alt="MPP on Arbitrum" width="100%">
</p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-12AAFF?style=flat-square" alt="MIT license"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-22%2B-12AAFF?style=flat-square" alt="Node 22 or later"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.9-12AAFF?style=flat-square" alt="TypeScript 5.9"></a>
  <a href="https://arbitrum.io/"><img src="https://img.shields.io/badge/arbitrum-sepolia-12AAFF?style=flat-square" alt="Arbitrum Sepolia"></a>
</p>
<p align="center">
  <strong>A self-contained merchant and client for MPP payments on Arbitrum, with EIP-3009 and Permit2 settlement.</strong><br>
  <a href="#quick-start">Quick start</a> · <a href="https://github.com/hummusonrails/arbitrum-mpp-example/issues">Report a bug</a>
</p>

## What it does

A client requests a report, receives an HTTP 402 payment challenge, signs a payment, and retries. The merchant verifies the payment, simulates and submits the transaction, then returns the report with a settlement receipt.

Both EIP-3009 and Permit2 paths have been tested on Arbitrum Sepolia with the included Solidity Demo USD token. No cloud accounts or external facilitator are needed.

## Quick start

Install [Node.js 22.13+](https://nodejs.org/), [pnpm 10](https://pnpm.io/installation), [Foundry](https://getfoundry.sh/introduction/installation/) with `anvil` on your PATH, and OpenSSL.

```bash
git clone https://github.com/hummusonrails/arbitrum-mpp-example.git
cd arbitrum-mpp-example
pnpm install --frozen-lockfile
pnpm demo
```

The demo starts a local chain and HTTPS server, deploys Demo USD, and buys one report through each payment path for 0.01 DUSD. It prints the receipts and shuts everything down when finished.

```bash
pnpm verify
```

This checks formatting, linting, types, and the payment tests.

## How the payments work

<details>
<summary>EIP-712: signing structured data</summary>

EIP-712 gives wallet signatures a defined structure: named fields such as the recipient and amount, plus a domain identifying the chain and contract. Both payment paths use it so the client signs specific payment terms rather than an opaque message.

See [src/protocol.ts](src/protocol.ts) for the typed data and [src/client.ts](src/client.ts) for signing.

</details>

<details>
<summary>EIP-3009: token transfers by signature</summary>

EIP-3009 lets a token holder authorize a transfer with a signature. The merchant submits that authorization to the token contract and pays the gas. The payer needs no token approval or ETH for the payment itself.

Use this path for tokens with transfer authorization support, such as native USDC. Each authorization has a validity window and a nonce that prevents reuse.

</details>

<details>
<summary>Permit2: signed payments for ERC-20 tokens</summary>

Permit2 is Uniswap's shared approval contract. The payer first approves the token to Permit2, then signs individual payments offchain. The merchant submits each payment and pays settlement gas.

This path works with compatible ERC-20 tokens that do not have EIP-3009 built in. The initial approval requires payer ETH; this example approves exactly one report's amount. A signed witness binds the payment to the merchant's challenge.

</details>

The merchant checks the signed terms, simulates the transfer with `eth_call`, and verifies the token transfer in the receipt before serving the report. Follow that flow in [src/settlement.ts](src/settlement.ts).

## Arbitrum Sepolia

Put a funded Sepolia key in `.env` under `PRIVATE_KEY`, then run:

```bash
pnpm test:sepolia
```

The wallet needs at least 0.0003 Sepolia ETH. This deploys Demo USD, creates and funds a payer wallet, and buys both reports. Payer keys and transaction results are saved in the ignored `.local/` directory. Each run creates a new token and payer.

<details>
<summary>Run a merchant and client separately with test USDC</summary>

```bash
pnpm setup:sepolia wallets
pnpm tls
```

Fund the printed merchant address with Sepolia ETH, and the payer with test USDC plus some Sepolia ETH for its Permit2 approval. Get tokens from [Circle's faucet](https://faucet.circle.com/) and the [Arbitrum faucet guide](https://docs.arbitrum.io/build-decentralized-apps/reference/tools/faucet).

```bash
export ENV_FILE=.local/sepolia.env
pnpm setup:sepolia preflight
pnpm dev
```

In another terminal:

```bash
export ENV_FILE=.local/sepolia.env
pnpm client authorization
pnpm setup:sepolia approve
pnpm client permit2
```

The approval covers one report. Run `approve` again before another Permit2 payment. Configuration options are in [.env.example](.env.example).

</details>

## Find your way around

| Path                | Purpose                                             |
| :------------------ | :-------------------------------------------------- |
| `src/client.ts`     | Check spending policy, sign, and request the report |
| `src/merchant.ts`   | Issue challenges and serve paid routes              |
| `src/protocol.ts`   | Payment schemas and EIP-712 messages                |
| `src/settlement.ts` | Verify, simulate, and settle payments               |
| `contracts/`        | Solidity demo token and local Permit2 fixture       |
| `scripts/`          | Local demo and Sepolia setup                        |
| `test/`             | Payment and rejection tests                         |

## Build at Open House

Use this repo as a starting point for an agent that buys data, calls a paid API, or sells a service. Replace the report handler with your own endpoint for current and future Arbitrum Open House projects.

For an alternative using x402, see [Arbitrum x402 on AWS](https://github.com/hummusonrails/arbitrum-x402-aws), which pairs an AWS merchant with a paying agent and USDC settlement on Arbitrum.

[Sign up for Arbitrum Open House](https://openhouse.arbitrum.io/?utm_source=github&utm_medium=social&utm_campaign=devrel-content-agentic-development&utm_content=github-repo).

## Contributing

Issues and focused pull requests are welcome. Run `pnpm verify` before submitting changes.

## License

[MIT](LICENSE). Third-party licenses are retained for [Permit2](contracts/fixtures/PERMIT2-LICENSE) and the [Arbitrum MPP reference](licenses/ARBITRUM-MPP-LICENSE).
