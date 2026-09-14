import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { pathToFileURL } from 'node:url';
import { chainAccess, configuration, required } from './config.js';
import { createMerchant } from './merchant.js';
import { PERMIT2 } from './protocol.js';

export function serve(
    handle: (request: Request) => Promise<Response>,
    tls: { key: string; cert: string },
    port = 3000,
) {
    const server = createServer({ ...tls, minVersion: 'TLSv1.2' }, async (req, res) => {
        try {
            const headers = new Headers();

            for (const [name, value] of Object.entries(req.headers)) {
                if (typeof value === 'string') {
                    headers.set(name, value);
                }
            }

            const response = await handle(
                new Request(`https://localhost:${port}${req.url}`, {
                    method: req.method,
                    headers,
                }),
            );

            res.writeHead(response.status, Object.fromEntries(response.headers));
            res.end(Buffer.from(await response.arrayBuffer()));
        } catch {
            res.writeHead(500);
            res.end('Internal server error');
        }
    });

    server.listen(port, '127.0.0.1');

    return server;
}

export async function main() {
    const config = configuration();
    const chain = chainAccess(required('MERCHANT_PRIVATE_KEY'), config);

    if ((await chain.publicClient.getChainId()) !== config.chainId) {
        throw new Error('RPC chain mismatch');
    }

    for (const address of [config.token.address, PERMIT2]) {
        const code = await chain.publicClient.getCode({ address });

        if (!code || code === '0x') {
            throw new Error(`No contract at ${address}`);
        }
    }

    const server = serve(
        createMerchant({ ...config, chain, secret: required('MPP_SECRET') }),
        {
            key: await readFile(process.env.TLS_KEY ?? '.local/tls/key.pem', 'utf8'),
            cert: await readFile(process.env.TLS_CERT ?? '.local/tls/cert.pem', 'utf8'),
        },
        Number(process.env.PORT ?? 3000),
    );

    console.log(
        `Merchant ${chain.account.address}; chain ${config.chainId}; https://localhost:${process.env.PORT ?? 3000}`,
    );

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => server.close());
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
