import { randomBytes } from 'node:crypto';
import { Challenge, Credential, Receipt as MppReceipt } from 'mppx';
import type { Hex } from 'viem';
import {
    deadline,
    payloadSchema,
    PERMIT2,
    sameAddress,
    type Path,
    type PaymentChallenge,
    type PaymentCredential,
    type Terms,
    type Token,
} from './protocol.js';
import { settlePayment, type ChainAccess } from './settlement.js';

export type MerchantConfig = {
    chainId: number;
    realm: string;
    secret: string;
    token: Token;
    amount: string;
    chain: ChainAccess;
};

export function createMerchant(config: MerchantConfig) {
    if (config.secret.length < 32) {
        throw new Error('MPP_SECRET must contain at least 32 characters');
    }

    // the demo ledger is process-local; deployment requires durable storage.
    const claims = new Map<string, { expires: number; hash?: Hex }>();
    const issued = new Map<string, PaymentChallenge>();
    const consumed = new Set<string>();
    let queue: Promise<unknown> = Promise.resolve();
    const terms = (path: Path): Terms => ({
        amount: config.amount,
        currency: config.token.address,
        recipient: config.chain.account.address,
        externalId: `/report/${path}`,
        methodDetails: {
            chainId: config.chainId,
            permit2Address: PERMIT2,
            decimals: 6,
            credentialTypes: [path],
        },
    });

    function challenge(path: Path) {
        const result = Challenge.from({
            method: 'evm',
            intent: 'charge',
            realm: config.realm,
            request: terms(path),
            expires: new Date(Date.now() + 120_000).toISOString(),
            meta: { requestId: randomBytes(16).toString('hex') },
            secretKey: config.secret,
        }) as PaymentChallenge;

        issued.set(result.id, result);

        return result;
    }

    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
        Response.json(body, {
            status,
            headers: { 'cache-control': 'private, no-store', ...headers },
        });

    function reject(path: Path, type: string, detail: string, transaction?: Hex) {
        return json(
            {
                type: `https://paymentauth.org/problems/${type}`,
                title: 'Payment required',
                status: 402,
                detail,
                ...(transaction ? { transaction } : {}),
            },
            402,
            {
                'www-authenticate': Challenge.serialize(challenge(path)),
                'content-type': 'application/problem+json',
            },
        );
    }

    return async function handle(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/health' && request.method === 'GET') {
            return json({ status: 'ok', chainId: config.chainId });
        }

        const match = url.pathname.match(/^\/report\/(authorization|permit2)$/);

        if (!match) {
            return json({ error: 'Not found' }, 404);
        }

        if (request.method !== 'GET') {
            return json({ error: 'Use GET' }, 405, { allow: 'GET' });
        }

        if (url.search) {
            return json({ error: 'Query parameters are not supported' }, 400);
        }

        if (url.protocol !== 'https:') {
            return json({ error: 'HTTPS required' }, 400);
        }

        for (const [id, c] of issued) {
            if (Date.parse(c.expires!) < Date.now()) {
                issued.delete(id);
            }
        }

        for (const [id, value] of claims) {
            if (value.expires < Date.now()) {
                claims.delete(id);
            }
        }

        if (issued.size >= 1000) {
            return json({ error: 'Merchant busy' }, 503);
        }

        const path = match[1] as Path;
        const header = request.headers.get('authorization');

        if (!header) {
            return reject(path, 'payment-required', 'This report requires payment');
        }

        if (header.length > 16_384) {
            return json({ error: 'Credential too large' }, 431);
        }

        let credential: PaymentCredential;

        try {
            credential = Credential.deserialize(header) as PaymentCredential;
            credential.payload = payloadSchema.parse(credential.payload);
        } catch {
            return reject(
                path,
                'malformed-credential',
                'Invalid credential encoding or payload',
            );
        }

        const c = credential.challenge;

        if (Date.parse(c.expires ?? '') <= Date.now()) {
            return reject(path, 'payment-expired', 'Challenge expired');
        }

        try {
            const stored = issued.get(c.id);

            if (!stored || Challenge.serialize(c) !== Challenge.serialize(stored)) {
                throw new Error('Unknown or modified challenge');
            }

            if (!Challenge.verify(c, { secretKey: config.secret })) {
                throw new Error('Invalid challenge');
            }

            if (
                c.realm !== config.realm ||
                c.method !== 'evm' ||
                c.intent !== 'charge'
            ) {
                throw new Error('Wrong challenge context');
            }

            // a valid challenge must still belong to this route.
            const expected = terms(path);

            if (
                c.request.amount !== expected.amount ||
                !sameAddress(c.request.currency, expected.currency) ||
                !sameAddress(c.request.recipient, expected.recipient) ||
                c.request.externalId !== expected.externalId ||
                c.request.methodDetails.chainId !== expected.methodDetails.chainId ||
                !sameAddress(c.request.methodDetails.permit2Address, PERMIT2) ||
                c.request.methodDetails.decimals !== 6 ||
                c.request.methodDetails.credentialTypes.length !== 1 ||
                c.request.methodDetails.credentialTypes[0] !== path
            ) {
                throw new Error('Wrong route terms');
            }

            deadline(c);
        } catch {
            return reject(
                path,
                'invalid-challenge',
                'Unknown or modified payment challenge',
            );
        }

        const id = credential.challenge.id;
        const payer =
            credential.payload.type === 'authorization'
                ? credential.payload.from
                : credential.source;
        const nonce =
            credential.payload.type === 'authorization'
                ? credential.payload.nonce
                : credential.payload.permit.nonce;
        const replayKey = `${payer?.toLowerCase()}:${nonce}`;

        if (claims.has(id) || consumed.has(replayKey)) {
            return reject(
                path,
                'invalid-challenge',
                'Payment already claimed; inspect settlement before paying again',
                claims.get(id)?.hash,
            );
        }

        if (claims.size >= 1000) {
            return json({ error: 'Merchant busy' }, 503);
        }

        // claim synchronously before the first await, blocking concurrent copies of one credential.
        const state: { expires: number; hash?: Hex } = {
            expires: Date.parse(credential.challenge.expires!) + 60_000,
        };

        claims.set(id, state);
        const task = queue.then(async () => {
            try {
                const receipt = await settlePayment(
                    credential,
                    config.token,
                    config.chain,
                    (hash) => {
                        state.hash = hash;
                    },
                );

                consumed.add(replayKey);

                return json(
                    {
                        report: {
                            title: 'An agent just bought this report',
                            network: config.chainId,
                            settlementPath: path,
                            priceBaseUnits: config.amount,
                            note: 'Static demo data. Replace this handler with your paid service.',
                        },
                        transaction: receipt.reference,
                    },
                    200,
                    { 'payment-receipt': MppReceipt.serialize(receipt) },
                );
            } catch (error) {
                // keep the claim because the rpc may have lost a successful submission response.
                console.error(
                    'Payment failed:',
                    error instanceof Error
                        ? error.message.split('\n')[0]
                        : 'Unknown error',
                );

                return reject(
                    path,
                    'verification-failed',
                    'Payment not confirmed. Inspect settlement before paying again.',
                    state.hash,
                );
            }
        });

        queue = task.catch(() => undefined);

        return task;
    };
}
