import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Challenge, Credential } from 'mppx';
import { erc20Abi } from 'viem';
import { localChain } from '../scripts/local-chain.js';
import { createMerchant } from '../src/merchant.js';
import { signPayment } from '../src/client.js';
import { preparePayment } from '../src/settlement.js';
import {
    authorizationData,
    PERMIT2,
    type Path,
    type PaymentChallenge,
    type PaymentCredential,
} from '../src/protocol.js';

let local: Awaited<ReturnType<typeof localChain>>;

let handle: ReturnType<typeof createMerchant>;

const secret = 'test-secret-for-authenticated-payment-challenges';

before(async () => {
    local = await localChain(18546);
    handle = createMerchant({
        chainId: 31337,
        realm: 'localhost',
        secret,
        token: local.token,
        amount: '10000',
        chain: local,
    });
});

after(async () => {
    await local?.stop();
});

const policy = () => ({
    chainId: 31337,
    recipient: local.account.address,
    token: local.token,
    maxAmount: 10000n,
    realm: 'localhost',
});

async function fresh(path: Path) {
    const response = await handle(new Request(`https://localhost/report/${path}`));

    assert.equal(response.status, 402);
    const challenge = Challenge.fromResponse(response) as PaymentChallenge;
    const header = await signPayment(challenge, local.payer, path, policy());

    return {
        challenge,
        header,
        credential: Credential.deserialize(header) as PaymentCredential,
    };
}

const send = (path: Path, header: string) =>
    handle(
        new Request(`https://localhost/report/${path}`, {
            headers: { authorization: header },
        }),
    );

const balance = (address = local.account.address) =>
    local.publicClient.readContract({
        address: local.token.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
    });

test('unpaid route returns an authenticated challenge with distinct request ids', async () => {
    const a = await fresh('authorization');
    const b = await fresh('authorization');

    assert.notEqual(a.challenge.id, b.challenge.id);
    assert.ok(Challenge.verify(a.challenge, { secretKey: secret }));
});

test('authorization transfers exact tokens without payer approval and rejects replay', async () => {
    const { header } = await fresh('authorization');
    const initial = await balance();
    const response = await send('authorization', header);

    assert.equal(response.status, 200);
    assert.ok(response.headers.has('payment-receipt'));
    assert.equal(await balance(), initial + 10000n);
    assert.equal((await send('authorization', header)).status, 402);
    assert.equal(await balance(), initial + 10000n);
});

test('concurrent duplicates produce exactly one settlement', async () => {
    const { header } = await fresh('authorization');
    const initial = await balance();
    const responses = await Promise.all([
        send('authorization', header),
        send('authorization', header),
    ]);

    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 402]);
    assert.equal(await balance(), initial + 10000n);
});

test('permit2 requires approval and transfers exactly the approved amount', async () => {
    const unpaid = await fresh('permit2');
    const initial = await balance();

    assert.equal((await send('permit2', unpaid.header)).status, 402);
    assert.equal(await balance(), initial);
    await local.approve(10000n);
    const { header } = await fresh('permit2');

    assert.equal((await send('permit2', header)).status, 200);
    assert.equal(await balance(), initial + 10000n);
    const allowance = await local.publicClient.readContract({
        address: local.token.address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [local.payer.address, PERMIT2],
    });

    assert.equal(allowance, 0n);
    assert.equal((await send('permit2', header)).status, 402);
});

test('token rejects authorization replay even after a merchant restart', async () => {
    const { header } = await fresh('authorization');

    assert.equal((await send('authorization', header)).status, 200);
    const initial = await balance();
    const restarted = createMerchant({
        chainId: 31337,
        realm: 'localhost',
        secret,
        token: local.token,
        amount: '10000',
        chain: local,
    });
    const response = await restarted(
        new Request('https://localhost/report/authorization', {
            headers: { authorization: header },
        }),
    );

    assert.equal(response.status, 402);
    assert.equal(await balance(), initial);
});

test('tampered challenge and cross-route credential are rejected', async () => {
    const { credential, header } = await fresh('authorization');

    credential.challenge.request.amount = '1';
    assert.equal(
        (await send('authorization', Credential.serialize(credential))).status,
        402,
    );
    assert.equal((await send('permit2', header)).status, 402);
});

test('expired authenticated challenge is rejected', async () => {
    const { credential } = await fresh('authorization');

    credential.challenge = Challenge.from({
        ...credential.challenge,
        id: undefined,
        secretKey: secret,
        expires: new Date(Date.now() - 1000).toISOString(),
    }) as PaymentChallenge;
    assert.equal(
        (await send('authorization', Credential.serialize(credential))).status,
        402,
    );
});

test('client refuses excessive price, wrong chain, token, recipient, and realm', async () => {
    const { challenge } = await fresh('authorization');

    for (const mutate of [
        (c: PaymentChallenge) => {
            c.request.amount = '10001';
        },
        (c: PaymentChallenge) => {
            c.request.methodDetails.chainId = 42161;
        },
        (c: PaymentChallenge) => {
            c.request.currency = PERMIT2;
        },
        (c: PaymentChallenge) => {
            c.request.recipient = local.payer.address;
        },
        (c: PaymentChallenge) => {
            c.realm = 'other';
        },
    ]) {
        const copy = structuredClone(challenge);

        mutate(copy);
        await assert.rejects(signPayment(copy, local.payer, 'authorization', policy()));
    }
});

test('server independently rejects altered authorization fields and wrong-chain signature', async () => {
    const { credential } = await fresh('authorization');

    if (credential.payload.type !== 'authorization') {
        throw new Error('Unexpected payload');
    }

    for (const [field, value] of Object.entries({
        to: local.payer.address,
        value: '1',
        validAfter: '1',
        validBefore: '9999999999',
        nonce: `0x${'00'.repeat(32)}`,
        signature: `0x${'00'.repeat(65)}`,
    })) {
        const copy = structuredClone(credential);

        Object.assign(copy.payload, { [field]: value });
        await assert.rejects(preparePayment(copy, local.token));
    }

    const typed = authorizationData(
        credential.challenge,
        local.payer.address,
        local.token,
    );

    credential.payload.signature = await local.payer.signTypedData({
        ...typed,
        domain: { ...typed.domain, chainId: 42161 },
    });
    await assert.rejects(preparePayment(credential, local.token), /Invalid signature/);
});

test('server rejects altered permit token, amount, recipient, nonce, deadline, witness, and source', async () => {
    const { credential } = await fresh('permit2');
    const changes = [
        (c: PaymentCredential) => {
            if (c.payload.type === 'permit2') {
                c.payload.permit.permitted[0]!.token = PERMIT2;
            }
        },
        (c: PaymentCredential) => {
            if (c.payload.type === 'permit2') {
                c.payload.permit.permitted[0]!.amount = '1';
            }
        },
        (c: PaymentCredential) => {
            if (c.payload.type === 'permit2') {
                c.payload.transferDetails[0]!.to = local.payer.address;
            }
        },
        (c: PaymentCredential) => {
            if (c.payload.type === 'permit2') {
                c.payload.permit.nonce = '1';
            }
        },
        (c: PaymentCredential) => {
            if (c.payload.type === 'permit2') {
                c.payload.permit.deadline = '9999999999';
            }
        },
        (c: PaymentCredential) => {
            if (c.payload.type === 'permit2') {
                c.payload.witness.challengeHash = `0x${'00'.repeat(32)}`;
            }
        },
        (c: PaymentCredential) => {
            c.source = `did:pkh:other:31337:${local.payer.address}`;
        },
        (c: PaymentCredential) => {
            c.source = `did:pkh:eip155:42161:${local.payer.address}`;
        },
        (c: PaymentCredential) => {
            if (c.payload.type === 'permit2') {
                c.payload.permit.permitted.push(c.payload.permit.permitted[0]!);
            }
        },
    ];

    for (const mutate of changes) {
        const copy = structuredClone(credential);

        mutate(copy);
        await assert.rejects(preparePayment(copy, local.token));
    }
});

test('malformed credentials and unsupported methods fail closed', async () => {
    assert.equal((await send('authorization', 'Payment garbage')).status, 402);
    assert.equal(
        (
            await handle(
                new Request('https://localhost/report/authorization', {
                    method: 'POST',
                }),
            )
        ).status,
        405,
    );
    assert.equal(
        (await handle(new Request('https://localhost/report/authorization?price=1')))
            .status,
        400,
    );
});

test('errors carry fresh challenges and problem details; success receipts include EVM fields', async () => {
    const malformed = await send('authorization', 'Payment garbage');

    assert.equal(malformed.status, 402);
    assert.match(malformed.headers.get('content-type')!, /application\/problem\+json/);
    assert.equal(
        (await malformed.json()).type,
        'https://paymentauth.org/problems/malformed-credential',
    );
    assert.ok(Challenge.fromResponse(malformed).id);
    const { header, challenge } = await fresh('authorization');
    const response = await send('authorization', header);
    const receipt = JSON.parse(
        Buffer.from(response.headers.get('payment-receipt')!, 'base64url').toString(),
    );

    assert.equal(receipt.method, 'evm');
    assert.equal(receipt.challengeId, challenge.id);
    assert.equal(receipt.chainId, 31337);
    assert.equal(receipt.externalId, '/report/authorization');
    assert.match(response.headers.get('cache-control')!, /private/);
    const replay = await send('authorization', header);

    assert.equal(replay.status, 402);
    assert.notEqual(Challenge.fromResponse(replay).id, challenge.id);
    assert.equal(replay.headers.has('payment-receipt'), false);
});

test('canonical mppx EVM client authorization settles with this merchant', async () => {
    const { charge } = await import('mppx/evm/client');
    const method = charge({
        account: local.payer,
        networks: [31337],
        maxAtomicAmount: '10000',
        authorization: { name: local.token.name, version: local.token.version },
    });
    const { challenge } = await fresh('authorization');
    const header = await method.createCredential({ challenge } as Parameters<
        typeof method.createCredential
    >[0]);

    assert.equal((await send('authorization', header)).status, 200);
});

test('the draft witness type string with a space fails canonical Permit2; EIP-712 encoding succeeds', async () => {
    const { decodeFunctionData, encodeFunctionData } = await import('viem');
    const { permitAbi } = await import('../src/protocol.js');

    await local.approve(10000n);
    const { credential } = await fresh('permit2');
    const prepared = await preparePayment(credential, local.token);
    const decoded = decodeFunctionData({ abi: permitAbi, data: prepared.data });
    const args = [...decoded.args] as [...typeof decoded.args];

    args[4] =
        'PaymentWitness witness)PaymentWitness(bytes32 challengeHash, string externalId)TokenPermissions(address token,uint256 amount)';
    await assert.rejects(
        local.publicClient.call({
            account: local.account,
            to: PERMIT2,
            data: encodeFunctionData({
                abi: permitAbi,
                functionName: 'permitWitnessTransferFrom',
                args,
            }),
        }),
    );
    await local.publicClient.call({
        account: local.account,
        to: PERMIT2,
        data: prepared.data,
    });
});

test('client and merchant reject plaintext payment transport', async () => {
    const { secureFetch } = await import('../src/transport.js');

    assert.throws(() => secureFetch('http://localhost/report/permit2'), /HTTPS/);
    const response = await handle(new Request('http://localhost/report/permit2'));

    assert.equal(response.status, 400);
    assert.equal(response.headers.has('www-authenticate'), false);
});
