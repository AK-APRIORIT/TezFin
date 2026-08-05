import * as config from '../config/config.json';

import {
    KeyStore,
    Signer,
    TezosContractUtils,
    TezosNodeReader,
    TezosNodeWriter,
    TezosParameterFormat,
} from 'conseiljs';

export interface ContractOperation {
    to: string;
    amount: number;
    mutez?: boolean;
    parameter?: {
        entrypoint: string;
        value: unknown;
    };
}

/** Submit operations sequentially to avoid prepareOperationGroup gas overestimation on Previewnet. */
export async function sendOperations(
    operations: ContractOperation[],
    keystore: KeyStore,
    signer: Signer,
): Promise<string> {
    let lastOpId = '';
    for (const operation of operations) {
        if (!operation.parameter) {
            throw new Error(`Missing contract parameters for operation to ${operation.to}`);
        }
        if (operation.mutez === false) {
            throw new Error(`Operation amount for ${operation.to} must be expressed in mutez`);
        }
        const head = await TezosNodeReader.getBlockHead(config.tezosNode);
        const result = await TezosNodeWriter.sendContractInvocationOperation(
            config.tezosNode,
            signer,
            keystore,
            operation.to,
            operation.amount,
            config.tx.fee,
            config.tx.freight,
            config.tx.gas,
            operation.parameter.entrypoint,
            JSON.stringify(operation.parameter.value),
            TezosParameterFormat.Micheline,
        );
        lastOpId = TezosContractUtils.clearRPCOperationGroupHash(result.operationGroupID);
        await TezosNodeReader.awaitOperationConfirmation(config.tezosNode, head.header.level - 1, lastOpId, 6)
            .catch((e) => { console.log(e); });
    }
    return lastOpId;
}

/**
 * Send multiple operations in a single block (required for accrueInterest + mint/borrow).
 * Bypasses prepareOperationGroup to avoid gas overestimation on Previewnet's
 * low hard_gas_limit_per_block. Sets counters and gas limits manually.
 */
export async function sendBatchedOperations(
    operations: ContractOperation[],
    keystore: KeyStore,
    signer: Signer,
): Promise<string> {
    // reveal account if needed (required before first operation from a new account)
    const isRevealed = await (TezosNodeReader as any).isManagerKeyRevealedForAccount(config.tezosNode, keystore.publicKeyHash).catch(() => true);
    if (!isRevealed) {
        console.log(`Revealing account ${keystore.publicKeyHash}...`);
        const revealHead = await TezosNodeReader.getBlockHead(config.tezosNode);
        const revealResult = await TezosNodeWriter.sendKeyRevealOperation(config.tezosNode, signer, keystore);
        const revealOpId = TezosContractUtils.clearRPCOperationGroupHash(revealResult.operationGroupID);
        await TezosNodeReader.awaitOperationConfirmation(config.tezosNode, revealHead.header.level - 1, revealOpId, 6)
            .catch((e) => { console.log(e); });
        console.log(`Account ${keystore.publicKeyHash} revealed: ${revealOpId}`);
    }

    const counter = await TezosNodeReader.getCounterForAccount(config.tezosNode, keystore.publicKeyHash);
    const head = await TezosNodeReader.getBlockHead(config.tezosNode);

    // hard_gas_limit_per_block = 660000 on this Previewnet; split evenly across ops
    const BLOCK_GAS_LIMIT = 660_000;
    const gasPerOp = Math.min(config.tx.gas, Math.floor(BLOCK_GAS_LIMIT / operations.length) - 1000);

    const transactions = operations.map((operation, i) => {
        if (!operation.parameter) {
            throw new Error(`Missing contract parameters for operation to ${operation.to}`);
        }
        // Use explicit counters (counter+1, counter+2, ...) and explicit gas limits
        return TezosNodeWriter.constructContractInvocationOperation(
            keystore.publicKeyHash,
            counter + 1 + i,
            operation.to,
            operation.amount,
            config.tx.fee,
            config.tx.freight,
            gasPerOp,
            operation.parameter.entrypoint,
            JSON.stringify(operation.parameter.value),
            TezosParameterFormat.Micheline,
        );
    });
    console.log(`sendBatchedOperations: ${operations.length} ops, gasPerOp=${gasPerOp}, totalGas=${operations.length * gasPerOp}`);

    // sendOperation forges+signs+injects directly without preapply gas validation
    const result = await TezosNodeWriter.sendOperation(config.tezosNode, transactions, signer);
    const operationGroupId = TezosContractUtils.clearRPCOperationGroupHash(result.operationGroupID);
    await TezosNodeReader.awaitOperationConfirmation(config.tezosNode, head.header.level - 1, operationGroupId, 6)
        .catch((e) => { console.log(e); });
    return operationGroupId;
}
