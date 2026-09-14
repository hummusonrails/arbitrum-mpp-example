import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { Abi, Hex } from 'viem';

const require = createRequire(import.meta.url);

export async function compileToken(): Promise<{ abi: Abi; bytecode: Hex }> {
    const solc = require('solc');
    const content = await readFile(
        new URL('../contracts/src/DemoToken.sol', import.meta.url),
        'utf8',
    );
    const output = JSON.parse(
        solc.compile(
            JSON.stringify({
                language: 'Solidity',
                sources: { 'DemoToken.sol': { content } },
                settings: {
                    optimizer: { enabled: true, runs: 200 },
                    evmVersion: 'cancun',
                    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
                },
            }),
        ),
    );
    const errors = output.errors?.filter(
        (e: { severity: string }) => e.severity === 'error',
    );

    if (errors?.length) {
        throw new Error(JSON.stringify(errors));
    }

    const contract = output.contracts['DemoToken.sol'].DemoToken;

    return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
}
