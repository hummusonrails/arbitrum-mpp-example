import { createTls } from './tls.js';
import { once } from 'node:events';
import { localChain } from './local-chain.js';
import { createMerchant } from '../src/merchant.js';
import { serve } from '../src/server.js';
import { buy } from '../src/client.js';

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

    console.log('Local EVM demo: 0.01 DUSD per report; merchant pays settlement gas.');
    console.log('EIP-3009: no payer approval');
    console.log(
        await buy(
            `https://localhost:${address.port}/report/authorization`,
            local.payer,
            'authorization',
            policy,
            tls.cert,
        ),
    );
    console.log('Permit2: approve exactly one report, then sign the payment');
    await local.approve(10000n);
    console.log(
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
