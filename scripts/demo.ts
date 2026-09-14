import { createTls } from './tls.js';
import { once } from 'node:events';
import { localChain } from './local-chain.js';
import { createMerchant } from '../src/merchant.js';
import { serve } from '../src/server.js';
import { buy } from '../src/client.js';

const color = Boolean(
    (process.stdout.isTTY || process.env.FORCE_COLOR === '1') &&
    !process.env.NO_COLOR &&
    process.env.TERM !== 'dumb',
);

function accent(text: string) {
    return color ? `\u001b[1;34m${text}\u001b[0m` : text;
}

function showPayment(result: Awaited<ReturnType<typeof buy>>) {
    const transaction = String(result.body.transaction);

    console.log('  MPP challenge (HTTP 402) -> signed payment -> report');
    console.log(`  ${accent('OK')}  0.01 DUSD settled | payment receipt received`);
    // keep full hashes and encoded receipts available without crowding the demo.
    console.log(`  tx  ${transaction.slice(0, 14)}...${transaction.slice(-8)}`);

    if (process.argv.includes('--verbose')) {
        console.dir(result, { depth: null });
    }
}

console.log(`\n${accent('MPP ON ARBITRUM')}`);
console.log('Local demo | 0.01 DUSD per report | merchant pays gas');
console.log('\nStarting chain, deploying token, opening HTTPS server...');

const local = await localChain(Number(process.env.LOCAL_RPC_PORT ?? 18545));

const tls = await createTls();

let server: ReturnType<typeof serve> | undefined;

try {
    const config = {
        chainId: 31337,
        realm: 'localhost',
        token: local.token,
        amount: '10000',
        secret: 'local-demo-only-secret-do-not-use-on-a-public-network',
        chain: local,
    };

    server = serve(createMerchant(config), tls, 0);
    await once(server, 'listening');
    const address = server.address();

    if (!address || typeof address === 'string') {
        throw new Error('Missing HTTP port');
    }

    const policy = { ...config, recipient: local.account.address, maxAmount: 10000n };

    console.log(accent('Ready. Two ways to pay for the same report.'));
    console.log(`\n${accent('01 / EIP-3009')}  Transfer by signature`);
    console.log('  No token approval needed. Requesting report...');
    showPayment(
        await buy(
            `https://localhost:${address.port}/report/authorization`,
            local.payer,
            'authorization',
            policy,
            tls.cert,
        ),
    );
    console.log(`\n${accent('02 / PERMIT2')}   Pay with an ERC-20 token`);
    console.log('  Approving exactly 0.01 DUSD...');
    await local.approve(10000n);
    console.log('  Approval confirmed. Requesting report...');
    showPayment(
        await buy(
            `https://localhost:${address.port}/report/permit2`,
            local.payer,
            'permit2',
            policy,
            tls.cert,
        ),
    );
} finally {
    if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
    }

    await local.stop();
    await tls.cleanup();
}

console.log(`\n${accent('DONE')}  2 reports purchased | 0.02 DUSD total`);
console.log('Local chain and server stopped.\n');
