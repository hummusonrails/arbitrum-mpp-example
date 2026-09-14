import { createTls } from './tls.js';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { generatePrivateKey } from 'viem/accounts';
import { erc20Abi, parseEther } from 'viem';
import { chainAccess, configuration, required } from '../src/config.js';
import { PERMIT2 } from '../src/protocol.js';
import { createMerchant } from '../src/merchant.js';
import { serve } from '../src/server.js';
import { buy } from '../src/client.js';
import { compileToken } from './token.js';

async function main() {
    const config = configuration();

    if (config.chainId !== 421614) {
        throw new Error('Live smoke test requires Arbitrum Sepolia');
    }

    const merchant = chainAccess(required('PRIVATE_KEY'), config);
    const client = merchant.publicClient;

    if ((await client.getChainId()) !== 421614) {
        throw new Error('Wrong RPC chain');
    }

    if (
        (await client.getBalance({ address: merchant.account.address })) <
        parseEther('0.0003')
    ) {
        throw new Error('Test wallet needs at least 0.0003 Sepolia ETH');
    }

    const code = await client.getCode({ address: PERMIT2 });

    if (!code || code === '0x') {
        throw new Error('Canonical Permit2 is missing');
    }

    const payerKey = generatePrivateKey();
    const payer = chainAccess(payerKey, config);

    await mkdir('.local', { recursive: true });
    const runId = Date.now();

    await writeFile(
        `.local/sepolia-payer-${runId}.env`,
        `PAYER_PRIVATE_KEY=${payerKey}\n`,
        { mode: 0o600, flag: 'wx' },
    );
    const confirmed = async (hash: `0x${string}`) => {
        const receipt = await client.waitForTransactionReceipt({
            hash,
            timeout: 120_000,
        });

        if (receipt.status !== 'success') {
            throw new Error(`Transaction reverted: ${hash}`);
        }

        return receipt;
    };
    const artifact = await compileToken();
    const deployment = await confirmed(
        await merchant.walletClient.deployContract(artifact),
    );

    if (!deployment.contractAddress) {
        throw new Error('Missing deployed token');
    }

    const token = {
        address: deployment.contractAddress,
        name: 'Demo USD',
        version: '1',
    };
    const mint = await client.simulateContract({
        account: merchant.account,
        address: token.address,
        abi: artifact.abi,
        functionName: 'mint',
        args: [payer.account.address, 20000n],
    });

    await confirmed(await merchant.walletClient.writeContract(mint.request));
    await confirmed(
        await merchant.walletClient.sendTransaction({
            to: payer.account.address,
            value: parseEther('0.0001'),
        }),
    );
    const app = createMerchant({
        chainId: 421614,
        realm: 'localhost',
        amount: '10000',
        token,
        secret: randomBytes(32).toString('hex'),
        chain: merchant,
    });
    const tls = await createTls();
    const server = serve(app, tls, 0);

    await once(server, 'listening');
    const address = server.address();

    if (!address || typeof address === 'string') {
        throw new Error('Missing server port');
    }

    const policy = {
        chainId: 421614,
        realm: 'localhost',
        token,
        recipient: merchant.account.address,
        maxAmount: 10000n,
    };
    const balance = () =>
        client.readContract({
            address: token.address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [merchant.account.address],
        });

    try {
        const before = await balance();
        const authorization = await buy(
            `https://localhost:${address.port}/report/authorization`,
            payer.account,
            'authorization',
            policy,
            tls.cert,
        );
        const approval = await client.simulateContract({
            account: payer.account,
            address: token.address,
            abi: erc20Abi,
            functionName: 'approve',
            args: [PERMIT2, 10000n],
        });

        await confirmed(await payer.walletClient.writeContract(approval.request));
        const permit2 = await buy(
            `https://localhost:${address.port}/report/permit2`,
            payer.account,
            'permit2',
            policy,
            tls.cert,
        );

        if ((await balance()) !== before + 20000n) {
            throw new Error('Unexpected merchant balance change');
        }

        const evidence = {
            date: new Date().toISOString(),
            chainId: 421614,
            token: token.address,
            tokenName: token.name,
            merchant: merchant.account.address,
            payer: payer.account.address,
            deployment: deployment.transactionHash,
            authorization: authorization.body,
            permit2: permit2.body,
            receivedBaseUnits: '20000',
        };

        await writeFile(
            `.local/sepolia-evidence-${runId}.json`,
            JSON.stringify(evidence, null, 2) + '\n',
        );
        console.log(JSON.stringify(evidence, null, 2));
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await tls.cleanup();
    }
}

main().catch((error) => {
    console.error(
        error.shortMessage ?? error.message?.split('\n')[0] ?? 'Sepolia test failed',
    );
    process.exitCode = 1;
});
