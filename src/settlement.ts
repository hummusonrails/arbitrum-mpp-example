import {
    encodeFunctionData,
    erc20Abi,
    parseEventLogs,
    parseSignature,
    verifyTypedData,
    type Account,
    type Address,
    type Hex,
    type PublicClient,
    type WalletClient,
} from 'viem';
import {
    authorizationAbi,
    authorizationData,
    challengeHash,
    deadline,
    payloadSchema,
    PERMIT2,
    permitAbi,
    permitData,
    sameAddress,
    witnessHash,
    witnessTypeString,
    type PaymentCredential,
    type Token,
} from './protocol.js';

export type ChainAccess = {
    publicClient: PublicClient;
    walletClient: WalletClient;
    account: Account;
};

export type Receipt = {
    method: 'evm';
    status: 'success';
    timestamp: string;
    reference: Hex;
    challengeId: string;
    chainId: number;
    externalId: string;
};

function requireEqual(ok: boolean, message: string): asserts ok {
    if (!ok) {
        throw new Error(message);
    }
}

export async function preparePayment(credential: PaymentCredential, token: Token) {
    const payload = payloadSchema.parse(credential.payload);
    const { challenge } = credential;
    const { request } = challenge;

    requireEqual(
        sameAddress(token.address, request.currency),
        'Wrong configured token',
    );
    requireEqual(
        request.methodDetails.credentialTypes.length === 1 &&
            request.methodDetails.credentialTypes[0] === payload.type,
        'Wrong settlement path',
    );
    const expires = deadline(challenge);
    let payer: Address;
    let to: Address;
    let data: Hex;

    if (payload.type === 'authorization') {
        payer = payload.from as Address;
        const typed = authorizationData(challenge, payer, token);

        requireEqual(sameAddress(payload.to, request.recipient), 'Wrong recipient');
        requireEqual(payload.value === request.amount, 'Wrong amount');
        requireEqual(
            payload.validAfter === '0' && payload.validBefore === expires.toString(),
            'Wrong validity window',
        );
        requireEqual(payload.nonce === typed.message.nonce, 'Wrong challenge nonce');
        requireEqual(
            await verifyTypedData({
                ...typed,
                address: payer,
                signature: payload.signature as Hex,
            }),
            'Invalid signature',
        );
        const sig = parseSignature(payload.signature as Hex);

        to = token.address;
        data = encodeFunctionData({
            abi: authorizationAbi,
            functionName: 'transferWithAuthorization',
            args: [
                payer,
                request.recipient,
                typed.message.value,
                0n,
                expires,
                typed.message.nonce,
                Number(sig.v ?? BigInt(27 + sig.yParity!)),
                sig.r,
                sig.s,
            ],
        });
    } else {
        const match = credential.source?.match(
            /^did:pkh:eip155:([0-9]+):(0x[0-9a-fA-F]{40})$/,
        );

        requireEqual(
            !!match && match[1] === String(request.methodDetails.chainId),
            'Wrong payer source chain or namespace',
        );
        payer = match[2] as Address;
        requireEqual(
            payload.permit.permitted.length === 1 &&
                payload.transferDetails.length === 1,
            'Expected one transfer',
        );
        const permission = payload.permit.permitted[0]!;
        const transfer = payload.transferDetails[0]!;

        requireEqual(
            sameAddress(permission.token, request.currency),
            'Wrong permit token',
        );
        requireEqual(
            permission.amount === request.amount &&
                transfer.requestedAmount === request.amount,
            'Wrong permit amount',
        );
        requireEqual(
            sameAddress(transfer.to, request.recipient),
            'Wrong permit recipient',
        );
        const typed = permitData(challenge);

        requireEqual(
            payload.permit.nonce === typed.message.nonce.toString(),
            'Wrong permit nonce',
        );
        requireEqual(
            payload.permit.deadline === expires.toString(),
            'Wrong permit deadline',
        );
        requireEqual(
            payload.witness.challengeHash === challengeHash(challenge),
            'Wrong challenge witness',
        );
        requireEqual(
            payload.witness.externalId === (request.externalId ?? ''),
            'Wrong external id',
        );
        requireEqual(
            await verifyTypedData({
                ...typed,
                address: payer,
                signature: payload.signature as Hex,
            }),
            'Invalid signature',
        );
        to = PERMIT2;
        data = encodeFunctionData({
            abi: permitAbi,
            functionName: 'permitWitnessTransferFrom',
            args: [
                {
                    permitted: typed.message.permitted,
                    nonce: typed.message.nonce,
                    deadline: expires,
                },
                { to: request.recipient, requestedAmount: BigInt(request.amount) },
                payer,
                witnessHash(
                    typed.message.witness.challengeHash,
                    typed.message.witness.externalId,
                ),
                witnessTypeString,
                payload.signature as Hex,
            ],
        });
    }

    return { payer, to, data, path: payload.type };
}

export async function settlePayment(
    credential: PaymentCredential,
    token: Token,
    chain: ChainAccess,
    onSubmitted: (hash: Hex) => void,
): Promise<Receipt> {
    const { request } = credential.challenge;

    requireEqual(
        sameAddress(request.recipient, chain.account.address),
        'Merchant must be Permit2 spender and recipient',
    );
    const prepared = await preparePayment(credential, token);

    requireEqual(
        (await chain.publicClient.getChainId()) === request.methodDetails.chainId,
        'RPC chain mismatch',
    );
    const amount = BigInt(request.amount);
    const balance = await chain.publicClient.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [prepared.payer],
    });

    requireEqual(balance >= amount, 'Insufficient token balance');

    if (prepared.path === 'permit2') {
        const allowance = await chain.publicClient.readContract({
            address: token.address,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [prepared.payer, PERMIT2],
        });

        requireEqual(allowance >= amount, 'Approve Permit2 before paying');
    }

    const transaction = {
        account: chain.account,
        to: prepared.to,
        data: prepared.data,
    };

    // simulate with exactly the sender, destination, and calldata that will be submitted.
    await chain.publicClient.call(transaction);
    const gas = await chain.publicClient.estimateGas(transaction);
    const fees = await chain.publicClient.estimateFeesPerGas();
    const nativeBalance = await chain.publicClient.getBalance({
        address: chain.account.address,
    });

    requireEqual(
        nativeBalance >= gas * fees.maxFeePerGas,
        'Merchant cannot cover settlement gas',
    );
    const hash = await chain.walletClient.sendTransaction({
        ...transaction,
        chain: chain.walletClient.chain,
    });

    onSubmitted(hash);
    const receipt = await chain.publicClient.waitForTransactionReceipt({
        hash,
        timeout: 60_000,
    });

    requireEqual(receipt.status === 'success', 'Settlement reverted');
    const transfers = parseEventLogs({
        abi: erc20Abi,
        eventName: 'Transfer',
        logs: receipt.logs.filter((log) => sameAddress(log.address, token.address)),
    });

    requireEqual(
        transfers.length === 1 &&
            sameAddress(transfers[0]!.args.from, prepared.payer) &&
            sameAddress(transfers[0]!.args.to, request.recipient) &&
            transfers[0]!.args.value === amount,
        'Settlement did not emit the expected token transfer',
    );

    return {
        method: 'evm',
        status: 'success',
        timestamp: new Date().toISOString(),
        reference: hash,
        challengeId: credential.challenge.id,
        chainId: request.methodDetails.chainId,
        externalId: request.externalId,
    };
}
