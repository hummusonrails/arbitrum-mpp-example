import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { erc20Abi, parseAbi } from 'viem';
import { chainAccess, configuration, required } from '../src/config.js';
import { PERMIT2 } from '../src/protocol.js';
import { compileToken } from './token.js';

const command = process.argv[2] ?? 'preflight';

if (command === 'wallets') {
    await mkdir('.local', { recursive: true });
    const merchantKey = generatePrivateKey();
    const payerKey = generatePrivateKey();
    const template = await readFile('.env.example', 'utf8');
    const env = template
        .replace('MERCHANT_PRIVATE_KEY=', `MERCHANT_PRIVATE_KEY=${merchantKey}`)
        .replace('PAYER_PRIVATE_KEY=', `PAYER_PRIVATE_KEY=${payerKey}`)
        .replace(
            'MERCHANT_ADDRESS=',
            `MERCHANT_ADDRESS=${privateKeyToAccount(merchantKey).address}`,
        )
        .replace('MPP_SECRET=', `MPP_SECRET=${randomBytes(32).toString('hex')}`);

    await writeFile('.local/sepolia.env', env, { flag: 'wx', mode: 0o600 });
    console.log('Wrote .local/sepolia.env (private, ignored by git).');
    console.log(`Merchant: ${privateKeyToAccount(merchantKey).address}`);
    console.log(`Payer: ${privateKeyToAccount(payerKey).address}`);
} else {
    const config = configuration();

    if (config.chainId !== 421614) {
        throw new Error('This setup command only supports Arbitrum Sepolia');
    }

    const merchant = chainAccess(required('MERCHANT_PRIVATE_KEY'), config);
    const payer = chainAccess(required('PAYER_PRIVATE_KEY'), config);
    const client = merchant.publicClient;

    if ((await client.getChainId()) !== 421614) {
        throw new Error('RPC chain mismatch');
    }

    const confirmed = async (hash: `0x${string}`) => {
        const receipt = await client.waitForTransactionReceipt({ hash });

        if (receipt.status !== 'success') {
            throw new Error(`Transaction reverted: ${hash}`);
        }

        console.log(`https://sepolia.arbiscan.io/tx/${hash}`);

        return receipt;
    };

    if (command === 'preflight') {
        for (const [role, account] of [
            ['merchant', merchant.account],
            ['payer', payer.account],
        ] as const) {
            console.log(
                `${role}: ${account.address}; ETH base units: ${await client.getBalance({ address: account.address })}`,
            );
            const code = await client.getCode({ address: config.token.address });

            if (code && code !== '0x') {
                console.log(
                    `${role} token balance: ${await client.readContract({
                        address: config.token.address,
                        abi: erc20Abi,
                        functionName: 'balanceOf',
                        args: [account.address],
                    })}`,
                );
            }
        }

        for (const address of [config.token.address, PERMIT2]) {
            const code = await client.getCode({ address });

            if (!code || code === '0x') {
                throw new Error(`No bytecode at ${address}`);
            }
        }

        const abi = parseAbi([
            'function name() view returns (string)',
            'function version() view returns (string)',
            'function decimals() view returns (uint8)',
        ]);
        const name = await client.readContract({
            address: config.token.address,
            abi,
            functionName: 'name',
        });
        const version = await client.readContract({
            address: config.token.address,
            abi,
            functionName: 'version',
        });
        const decimals = await client.readContract({
            address: config.token.address,
            abi,
            functionName: 'decimals',
        });

        if (
            name !== config.token.name ||
            version !== config.token.version ||
            decimals !== 6
        ) {
            throw new Error('Token identity or decimals mismatch');
        }

        console.log('Token identity, deployed code, and RPC chain verified.');
    } else if (command === 'approve') {
        const { request } = await client.simulateContract({
            account: payer.account,
            address: config.token.address,
            abi: erc20Abi,
            functionName: 'approve',
            args: [PERMIT2, BigInt(config.amount)],
        });

        await confirmed(await payer.walletClient.writeContract(request));
    } else if (command === 'deploy-token') {
        const token = await compileToken();
        const receipt = await confirmed(
            await merchant.walletClient.deployContract(token),
        );

        console.log(
            `TOKEN_ADDRESS=${receipt.contractAddress}\nTOKEN_NAME=Demo USD\nTOKEN_VERSION=1`,
        );
        console.log(
            'Update those three values in the environment file, then run mint.',
        );
    } else if (command === 'mint') {
        if (config.token.name !== 'Demo USD' || config.token.version !== '1') {
            throw new Error('Mint is for the demo token only');
        }

        const abi = parseAbi(['function mint(address to,uint256 value)']);
        const { request } = await client.simulateContract({
            account: merchant.account,
            address: config.token.address,
            abi,
            functionName: 'mint',
            args: [payer.account.address, 1_000_000n],
        });

        await confirmed(await merchant.walletClient.writeContract(request));
    } else {
        throw new Error('Use wallets, preflight, approve, deploy-token, or mint');
    }
}
