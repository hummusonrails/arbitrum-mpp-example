import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Challenge, Credential } from 'mppx';
import { getAddress, type Account, type Address } from 'viem';
import { chainAccess, configuration, required } from './config.js';
import { secureFetch } from './transport.js';
import {
    authorizationData,
    deadline,
    PERMIT2,
    permitData,
    sameAddress,
    type Path,
    type PaymentChallenge,
    type Token,
} from './protocol.js';

export type Policy = {
    chainId: number;
    recipient: Address;
    token: Token;
    maxAmount: bigint;
    realm: string;
};

export async function signPayment(
    challenge: PaymentChallenge,
    account: Account,
    path: Path,
    policy: Policy,
) {
    const { request } = challenge;

    deadline(challenge);

    if ('splits' in request.methodDetails || challenge.digest !== undefined) {
        throw new Error('Unsupported split or body-bound challenge');
    }

    if (challenge.header !== undefined && challenge.header !== 'Authorization') {
        throw new Error('Unsupported credential header');
    }

    // validate merchant terms before the wallet signs anything.
    if (
        challenge.method !== 'evm' ||
        challenge.intent !== 'charge' ||
        challenge.realm !== policy.realm ||
        request.methodDetails.chainId !== policy.chainId ||
        request.externalId !== `/report/${path}` ||
        !sameAddress(request.methodDetails.permit2Address, PERMIT2) ||
        request.methodDetails.decimals !== 6 ||
        request.methodDetails.credentialTypes.length !== 1 ||
        request.methodDetails.credentialTypes[0] !== path ||
        !sameAddress(request.currency, policy.token.address) ||
        !sameAddress(request.recipient, policy.recipient) ||
        !/^[1-9][0-9]*$/.test(request.amount) ||
        BigInt(request.amount) > policy.maxAmount
    ) {
        throw new Error('Challenge exceeds the configured payment policy');
    }

    if (!account.signTypedData) {
        throw new Error('A local signing account is required');
    }

    if (path === 'authorization') {
        const typed = authorizationData(challenge, account.address, policy.token);
        const signature = await account.signTypedData(typed);

        return Credential.serialize({
            challenge,
            payload: {
                type: path,
                from: account.address,
                to: request.recipient,
                value: request.amount,
                validAfter: '0',
                validBefore: typed.message.validBefore.toString(),
                nonce: typed.message.nonce,
                signature,
            },
        });
    }

    const typed = permitData(challenge);
    const signature = await account.signTypedData(typed);

    return Credential.serialize({
        challenge,
        source: `did:pkh:eip155:${policy.chainId}:${account.address}`,
        payload: {
            type: path,
            permit: {
                permitted: [{ token: request.currency, amount: request.amount }],
                nonce: typed.message.nonce.toString(),
                deadline: typed.message.deadline.toString(),
            },
            transferDetails: [
                { to: request.recipient, requestedAmount: request.amount },
            ],
            witness: typed.message.witness,
            signature,
        },
    });
}

export async function buy(
    url: string,
    account: Account,
    path: Path,
    policy: Policy,
    ca?: string,
) {
    const initial = await secureFetch(url, undefined, ca);

    if (initial.status !== 402) {
        throw new Error(`Expected 402, got ${initial.status}`);
    }

    const challenge = Challenge.fromResponse(initial) as PaymentChallenge;
    const authorization = await signPayment(challenge, account, path, policy);
    const response = await secureFetch(url, authorization, ca);
    const body = await response.json();

    if (!response.ok) {
        throw new Error(JSON.stringify(body));
    }

    if (!response.headers.has('payment-receipt')) {
        throw new Error('Missing settlement receipt');
    }

    return { body, receipt: response.headers.get('payment-receipt') };
}

export async function main() {
    const path = process.argv[2] ?? 'authorization';

    if (path !== 'authorization' && path !== 'permit2') {
        throw new Error('Use authorization or permit2');
    }

    const config = configuration();
    const chain = chainAccess(required('PAYER_PRIVATE_KEY'), config);

    if ((await chain.publicClient.getChainId()) !== config.chainId) {
        throw new Error('RPC chain mismatch');
    }

    const policy = {
        ...config,
        recipient: getAddress(required('MERCHANT_ADDRESS')),
        maxAmount: BigInt(config.amount),
    };

    console.log(
        await buy(
            `${process.env.MERCHANT_URL ?? 'https://localhost:3000'}/report/${path}`,
            chain.account,
            path,
            policy,
            await readFile(process.env.TLS_CA ?? '.local/tls/cert.pem', 'utf8'),
        ),
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
