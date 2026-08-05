import { TezosToolkit } from '@taquito/taquito';
import config from '../config/config.json';
import { initKeystore } from './util';
import { sendBatchedOperations, ContractOperation } from './operations';

const { TezosLendingPlatform } = require('tezoslendingplatformjs');

async function switchToGuardComptroller() {
    const protocolAddresses = require(config.protocolAddressesPath);
    const guardAddress = config.guardComptroller;
    const keystore = initKeystore(config.keystore);
    const tezos = new TezosToolkit(config.tezosNode);
    const signer = keystore;

    if (!guardAddress) {
        throw new Error(`guardComptroller not configured in config.json`);
    }

    console.log(`[INFO] Switching fTokens to GuardComptroller: ${guardAddress}`);

    const fTokenAddresses = [
        protocolAddresses.fTokens.XTZ,
        protocolAddresses.fTokens.USDT,
        protocolAddresses.fTokens.TZBTC,
    ];

    // Create setComptroller operations for each fToken
    const ops: ContractOperation[] = [];
    for (const fTokenAddress of fTokenAddresses) {
        const fTokenName = Object.entries(protocolAddresses.fTokens).find(
            ([_, addr]) => addr === fTokenAddress
        )?.[0] || fTokenAddress;

        console.log(`[INFO] Creating setComptroller operation for ${fTokenName} at ${fTokenAddress}`);

        ops.push({
            to: fTokenAddress,
            amount: 0,
            mutez: true,
            parameter: {
                entrypoint: 'setComptroller',
                value: { string: guardAddress },
            },
        });
    }

    console.log(`[INFO] Batching ${ops.length} setComptroller operations`);

    // Send as single batched transaction
    const opHash = await sendBatchedOperations(ops, keystore, signer);
    console.log(`[INFO] Submitted batch, waiting for confirmation: ${opHash}`);

    // Wait for confirmation
    const confirmed = await tezos.operation.confirmOperation(opHash, 90, 3000);
    console.log(`[SUCCESS] All fTokens switched to GuardComptroller`);
    console.log(`[INFO] Operation: ${opHash}`);
}

switchToGuardComptroller().catch((error) => {
    console.error(`[ERROR] Switch failed: ${error.message}`);
    process.exitCode = 1;
});
