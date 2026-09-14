import { config as dotenv } from 'dotenv';
import {
    createPublicClient,
    createWalletClient,
    defineChain,
    getAddress,
    http,
    type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { USDC_SEPOLIA } from './protocol.js';

dotenv({ path: process.env.ENV_FILE ?? '.env', quiet: true });

export function required(name: string) {
    const value = process.env[name];

    if (!value) {
        throw new Error(`Set ${name} in your environment or ENV_FILE`);
    }

    return value;
}

export function configuration() {
    const chainId = Number(process.env.CHAIN_ID ?? 421614);

    if (![421614, 31337, 412346].includes(chainId)) {
        throw new Error('Only Sepolia and local development chains are supported');
    }

    const rpc = process.env.RPC_URL ?? arbitrumSepolia.rpcUrls.default.http[0];
    const chain =
        chainId === 421614
            ? arbitrumSepolia
            : defineChain({
                  id: chainId,
                  name: 'Local development',
                  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                  rpcUrls: { default: { http: [rpc] } },
              });
    const amount = process.env.PRICE_BASE_UNITS ?? '10000';

    if (!/^[1-9][0-9]*$/.test(amount) || BigInt(amount) > 1_000_000n) {
        throw new Error('Price must be between 1 and 1000000 base units');
    }

    return {
        chain,
        chainId,
        rpc,
        amount,
        realm: process.env.MPP_REALM ?? 'localhost',
        token: {
            address: getAddress(process.env.TOKEN_ADDRESS ?? USDC_SEPOLIA),
            name: process.env.TOKEN_NAME ?? 'USD Coin',
            version: process.env.TOKEN_VERSION ?? '2',
        },
    };
}

export function chainAccess(privateKey: string, settings = configuration()) {
    const account = privateKeyToAccount(privateKey as Hex);

    return {
        account,
        publicClient: createPublicClient({
            chain: settings.chain,
            transport: http(settings.rpc),
        }),
        walletClient: createWalletClient({
            account,
            chain: settings.chain,
            transport: http(settings.rpc, { retryCount: 0 }),
        }),
    };
}
