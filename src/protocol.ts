import { Challenge, Credential, z } from 'mppx';
import {
    encodeAbiParameters,
    encodePacked,
    keccak256,
    parseAbi,
    toBytes,
    type Address,
    type Hex,
} from 'viem';

export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address;

export const USDC_SEPOLIA = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' as Address;

export type Path = 'authorization' | 'permit2';

const address = z.string().check(z.regex(/^0x[0-9a-fA-F]{40}$/));

const uint = z.string().check(z.regex(/^(0|[1-9][0-9]{0,77})$/));

const bytes32 = z.string().check(z.regex(/^0x[0-9a-fA-F]{64}$/));

const signature = z.string().check(z.regex(/^0x[0-9a-fA-F]{130}$/));

export const payloadSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('authorization'),
        from: address,
        to: address,
        value: uint,
        validAfter: uint,
        validBefore: uint,
        nonce: bytes32,
        signature,
    }),
    z.object({
        type: z.literal('permit2'),
        permit: z.object({
            permitted: z.array(z.object({ token: address, amount: uint })),
            nonce: uint,
            deadline: uint,
        }),
        transferDetails: z.array(z.object({ to: address, requestedAmount: uint })),
        witness: z.object({ challengeHash: bytes32, externalId: z.string() }),
        signature,
    }),
]);

export type Payload = z.infer<typeof payloadSchema>;

export type Terms = {
    amount: string;
    currency: Address;
    recipient: Address;
    externalId: string;
    methodDetails: {
        chainId: number;
        permit2Address: Address;
        decimals: number;
        credentialTypes: Path[];
    };
};

export type PaymentChallenge = Challenge.Challenge<Terms> & {
    header?: string;
};

export type PaymentCredential = Credential.Credential<Payload, PaymentChallenge>;

export type Token = { address: Address; name: string; version: string };

export const authorizationAbi = parseAbi([
    'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
]);

export const permitAbi = parseAbi([
    'function permitWitnessTransferFrom(((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,(address to,uint256 requestedAmount) transferDetails,address owner,bytes32 witness,string witnessTypeString,bytes signature)',
]);

export const witnessTypeString =
    'PaymentWitness witness)PaymentWitness(bytes32 challengeHash,string externalId)TokenPermissions(address token,uint256 amount)';

export function sameAddress(a: string, b: string) {
    return a.toLowerCase() === b.toLowerCase();
}

export function deadline(challenge: PaymentChallenge) {
    const value = Date.parse(challenge.expires ?? '');

    if (!Number.isFinite(value) || value <= Date.now()) {
        throw new Error('Challenge expired or missing expiry');
    }

    return BigInt(Math.floor(value / 1000));
}

// both payment paths bind their signature to the authenticated challenge.
export function challengeHash(challenge: PaymentChallenge): Hex {
    return keccak256(
        encodePacked(['string', 'string'], [challenge.id, challenge.realm]),
    );
}

export function authorizationData(
    challenge: PaymentChallenge,
    from: Address,
    token: Token,
) {
    return {
        domain: {
            name: token.name,
            version: token.version,
            chainId: challenge.request.methodDetails.chainId,
            verifyingContract: token.address,
        },
        primaryType: 'TransferWithAuthorization' as const,
        types: {
            TransferWithAuthorization: [
                { name: 'from', type: 'address' },
                { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'validAfter', type: 'uint256' },
                { name: 'validBefore', type: 'uint256' },
                { name: 'nonce', type: 'bytes32' },
            ],
        },
        message: {
            from,
            to: challenge.request.recipient,
            value: BigInt(challenge.request.amount),
            validAfter: 0n,
            validBefore: deadline(challenge),
            nonce: challengeHash(challenge),
        },
    } as const;
}

export function permitData(challenge: PaymentChallenge) {
    const hash = challengeHash(challenge);

    return {
        domain: {
            name: 'Permit2',
            chainId: challenge.request.methodDetails.chainId,
            verifyingContract: PERMIT2,
        },
        primaryType: 'PermitWitnessTransferFrom' as const,
        types: {
            PermitWitnessTransferFrom: [
                { name: 'permitted', type: 'TokenPermissions' },
                { name: 'spender', type: 'address' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
                { name: 'witness', type: 'PaymentWitness' },
            ],
            TokenPermissions: [
                { name: 'token', type: 'address' },
                { name: 'amount', type: 'uint256' },
            ],
            PaymentWitness: [
                { name: 'challengeHash', type: 'bytes32' },
                { name: 'externalId', type: 'string' },
            ],
        },
        message: {
            permitted: {
                token: challenge.request.currency,
                amount: BigInt(challenge.request.amount),
            },
            spender: challenge.request.recipient,
            nonce: BigInt(hash),
            deadline: deadline(challenge),
            witness: {
                challengeHash: hash,
                externalId: challenge.request.externalId ?? '',
            },
        },
    } as const;
}

export function witnessHash(hash: Hex, externalId: string) {
    return keccak256(
        encodeAbiParameters(
            [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
            [
                keccak256(
                    toBytes('PaymentWitness(bytes32 challengeHash,string externalId)'),
                ),
                hash,
                keccak256(toBytes(externalId)),
            ],
        ),
    );
}
