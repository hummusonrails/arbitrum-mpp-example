import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
    createPublicClient,
    createWalletClient,
    defineChain,
    erc20Abi,
    hashDomain,
    http,
    parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PERMIT2 } from '../src/protocol.js';
import { compileToken } from './token.js';

export async function localChain(port = 18545) {
    const rpc = `http://127.0.0.1:${port}`;
    const chain = defineChain({
        id: 31337,
        name: 'Local EVM',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [rpc] } },
    });
    const publicClient = createPublicClient({
        chain,
        transport: http(rpc, { retryCount: 0 }),
    });

    try {
        await publicClient.getChainId();
        throw new Error(`Port ${port} is already serving an RPC`);
    } catch (error) {
        if (error instanceof Error && error.message.includes('already serving')) {
            throw error;
        }
    }

    const node = spawn(
        'anvil',
        ['--port', String(port), '--chain-id', '31337', '--silent'],
        { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let startError: Error | undefined;

    node.on('error', (error) => {
        startError = error;
    });
    const stop = async () => {
        if (node.exitCode === null && !node.killed) {
            node.kill('SIGTERM');
            await new Promise((resolve) => node.once('exit', resolve));
        }
    };

    try {
        let ready = false;

        for (let i = 0; i < 100; i++) {
            if (startError) {
                throw startError;
            }

            try {
                if ((await publicClient.getChainId()) === 31337) {
                    ready = true;
                    break;
                }
            } catch {}

            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        if (!ready) {
            throw new Error('Anvil did not start');
        }

        const merchant = privateKeyToAccount(`0x${'11'.repeat(32)}`);
        const payer = privateKeyToAccount(`0x${'22'.repeat(32)}`);
        const walletClient = createWalletClient({
            chain,
            account: merchant,
            transport: http(rpc, { retryCount: 0 }),
        });

        for (const account of [merchant, payer]) {
            await publicClient.request({
                method: 'anvil_setBalance' as never,
                params: [account.address, '0x56bc75e2d63100000'] as never,
            });
        }

        const artifact = JSON.parse(
            await readFile(
                new URL('../contracts/fixtures/Permit2.json', import.meta.url),
                'utf8',
            ),
        );

        // zeroed immutable cache forces permit2 to derive its domain for this chain and address.
        await publicClient.request({
            method: 'anvil_setCode' as never,
            params: [PERMIT2, artifact.deployedBytecode] as never,
        });
        const domain = await publicClient.readContract({
            address: PERMIT2,
            abi: parseAbi(['function DOMAIN_SEPARATOR() view returns (bytes32)']),
            functionName: 'DOMAIN_SEPARATOR',
        });

        if (
            domain !==
            hashDomain({
                domain: {
                    name: 'Permit2',
                    chainId: 31337n,
                    verifyingContract: PERMIT2,
                },
                types: {
                    EIP712Domain: [
                        { name: 'name', type: 'string' },
                        { name: 'chainId', type: 'uint256' },
                        { name: 'verifyingContract', type: 'address' },
                    ],
                },
            })
        ) {
            throw new Error('Permit2 domain mismatch');
        }

        const tokenArtifact = await compileToken();
        const hash = await walletClient.deployContract({ ...tokenArtifact });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });

        if (receipt.status !== 'success' || !receipt.contractAddress) {
            throw new Error('Token deployment failed');
        }

        const token = {
            address: receipt.contractAddress,
            name: 'Demo USD',
            version: '1',
        };
        const mint = await walletClient.writeContract({
            address: token.address,
            abi: tokenArtifact.abi,
            functionName: 'mint',
            args: [payer.address, 1_000_000n],
        });

        await publicClient.waitForTransactionReceipt({ hash: mint });
        const approve = async (amount: bigint) => {
            const hash = await walletClient.writeContract({
                account: payer,
                address: token.address,
                abi: erc20Abi,
                functionName: 'approve',
                args: [PERMIT2, amount],
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash });

            if (receipt.status !== 'success') {
                throw new Error('Approval failed');
            }
        };

        return {
            rpc,
            publicClient,
            walletClient,
            account: merchant,
            payer,
            token,
            approve,
            stop,
        };
    } catch (error) {
        await stop();
        throw error;
    }
}
