import * as config from '../config/config.json';

import { AssetType, Governance, ProtocolAddresses, TokenStandard, UnderlyingAsset } from 'tezoslendingplatformjs';
import { KeyStore, MultiAssetTokenHelper, Signer, TezosConseilClient, TezosConstants, TezosContractUtils, TezosNodeReader, TezosNodeWriter, TezosParameterFormat, Transaction, Tzip7ReferenceTokenHelper } from 'conseiljs';
import BigNumber from "bignumber.js"
import log from 'loglevel';
import { statOperation } from './util';

export async function postDeploy(keystore: KeyStore, signer: Signer, protocolAddresses: ProtocolAddresses) {
    for (const asset of config.supportMarket)
        await supportMarket(asset.name as AssetType, asset.priceExp, keystore, signer, protocolAddresses);
    for (const asset of config.unpauseMarkets)
        await unpauseMarkets(asset as AssetType, keystore, signer, protocolAddresses);
    // Required before borrow/redeem liquidity checks: max price age + per-market bounds.
    await setOracle(keystore, signer, protocolAddresses, protocolAddresses.oracle, config.oracleMaxPriceAge ?? 3600);
    await setPriceBoundsForListedMarkets(keystore, signer, protocolAddresses);
}

/** Loose test bounds so Previewnet e2e can update prices freely. */
const DEFAULT_TEST_PRICE_BOUNDS = {
    minPrice: 1,
    maxPrice: '100000000000000000000000000000000000000000000000000', // 10^50
    maxChangeBps: 10000,
};

export async function setPriceBoundsForListedMarkets(
    keystore: KeyStore,
    signer: Signer,
    protocolAddresses: ProtocolAddresses,
) {
    const boundsCfg = (config as any).priceBounds || DEFAULT_TEST_PRICE_BOUNDS;
    for (const asset of Object.keys(protocolAddresses.fTokens)) {
        await setPriceBounds(asset as AssetType, boundsCfg, keystore, signer, protocolAddresses);
    }
}

/** Governance that currently administers Comptroller (may differ from redeployed Governance in deploy.json). */
function comptrollerGovernanceAddress(protocolAddresses: ProtocolAddresses): string {
    return (config as any).comptrollerGovernance || protocolAddresses.governance;
}

export async function setPriceBounds(
    asset: AssetType,
    bounds: { minPrice: string | number; maxPrice: string | number; maxChangeBps: number },
    keystore: KeyStore,
    signer: Signer,
    protocolAddresses: ProtocolAddresses,
) {
    if (!Object.prototype.hasOwnProperty.call(protocolAddresses.fTokens, asset)) {
        return;
    }
    const governance = comptrollerGovernanceAddress(protocolAddresses);
    log.info(`setPriceBounds ${asset}: min=${bounds.minPrice} max=${bounds.maxPrice} maxChangeBps=${bounds.maxChangeBps} via ${governance}`);
    const head = await TezosNodeReader.getBlockHead(config.tezosNode);
    // Micheline layout: Pair(Pair(Pair(cToken, maxChangeBps), Pair(maxPrice, minPrice)), comptroller)
    const opId = await sendGovernanceOperation({
        to: protocolAddresses.governance,
        parameter: {
            entrypoint: 'setPriceBounds',
            value: {
                prim: 'Pair', args: [
                    { prim: 'Pair', args: [
                        { prim: 'Pair', args: [
                            { string: protocolAddresses.fTokens[asset] },
                            { int: String(bounds.maxChangeBps) },
                        ]},
                        { prim: 'Pair', args: [
                            { int: String(bounds.maxPrice) },
                            { int: String(bounds.minPrice) },
                        ]},
                    ]},
                    { string: protocolAddresses.comptroller },
                ],
            },
        },
    },
        keystore,
        signer,
    );
    await TezosNodeReader.awaitOperationConfirmation(config.tezosNode, head.header.level - 1, opId, 6)
        .then(res => {
            if (res['contents'][0]['metadata']['operation_result']['status'] === 'applied') return res;
            throw new Error('operation status not applied');
        })
        .catch((error) => { console.log(error); });
}

export async function mintFakeTokens(keystore: KeyStore, signer: Signer, protocolAddresses: ProtocolAddresses, address: string){
    for (const asset of config.tokenMint){
        if(!Object.prototype.hasOwnProperty.call(protocolAddresses.underlying, asset)) continue;
        const underlying = protocolAddresses.underlying[asset];
        const amount = new BigNumber(10).pow(underlying.decimals).multipliedBy(config.mintAmounts[asset]).toFixed();
        log.info(`minting ${config.mintAmounts[asset]} ${asset} tokens to ${address}`);
        let payload = "";
        if (underlying.tokenStandard === TokenStandard.FA12) {
            payload = `(Pair "${address}" ${amount})`;
        } else if (underlying.tokenStandard === TokenStandard.FA2) {
            payload = `(Pair (Pair "${address}" ${amount}) (Pair {Elt "" 0x32} 0))`;
        }
        const head = await TezosNodeReader.getBlockHead(config.tezosNode);
        const result = await TezosNodeWriter.sendContractInvocationOperation(
            config.tezosNode, signer, keystore,
            underlying.address!, 0, config.tx.fee, config.tx.freight, config.tx.gas,
            "mint", payload, TezosParameterFormat.Michelson,
        );
        const opId = TezosContractUtils.clearRPCOperationGroupHash(result.operationGroupID);
        console.log("confirming mint tx - " + opId);
        await TezosNodeReader.awaitOperationConfirmation(config.tezosNode, head.header.level - 1, opId, 6)
            .catch((error) => { console.log(error) });
        console.log("confirmed mint tx - " + opId);
    }
}

export async function setOracle(keystore: KeyStore, signer: Signer, protocolAddresses: ProtocolAddresses, oracleAddress: string, timeDiff: number){
    const governance = comptrollerGovernanceAddress(protocolAddresses);
    log.info(`setting oracle ${oracleAddress}, timeDiff ${timeDiff} via governance ${governance}`);
    const head = await TezosNodeReader.getBlockHead(config.tezosNode)
    const supportMarketOpId = await sendGovernanceOperation(
        Governance.SetOracleOperation({ comptrollerAddress: protocolAddresses.comptroller, oracleAddress, timeDiff }, governance),
        keystore,
        signer,
    );
    const conseilResult = await TezosNodeReader.awaitOperationConfirmation(config.tezosNode, head.header.level - 1, supportMarketOpId, 6).then(res => { if (res['contents'][0]['metadata']['operation_result']['status'] === "applied") return res; else throw new Error("operation status not applied"); }).catch((error) => { console.log(error) });
}


export function tokenMint(asset: string, keystore: KeyStore, signer: Signer, protocolAddresses: ProtocolAddresses, address: string, mintAmount: number, gas: number = 200_000, freight: number = 20_000) {
    if(!Object.prototype.hasOwnProperty.call(protocolAddresses.underlying, asset)){
        return undefined
    }
    let payload = ""
    log.info(`minting ${mintAmount} ${asset} tokens to ${address}`);
    const amount = new BigNumber(10).pow(protocolAddresses.underlying[asset].decimals).multipliedBy(mintAmount).toFixed();
    if (protocolAddresses.underlying[asset].tokenStandard === TokenStandard.FA12) {
        payload = `(Pair "${address}" ${amount.toString()})`
    } else if (protocolAddresses.underlying[asset].tokenStandard === TokenStandard.FA2) {
        payload = `(Pair (Pair "${address}" ${amount.toString()}) (Pair {Elt "" 0x32} 0))`
    }
    return TezosNodeWriter.constructContractInvocationOperation(
        keystore.publicKeyHash, 0, protocolAddresses.underlying[asset].address!, 0, config.tx.fee,
        freight, gas,
        "mint",
        payload,
        TezosParameterFormat.Michelson,
    );
}

async function supportMarket(asset: AssetType, priceExp: number, keystore: KeyStore, signer: Signer, protocolAddresses: ProtocolAddresses) {
    if(!Object.prototype.hasOwnProperty.call(protocolAddresses.fTokens, asset)){
        return
    }
    assertExactTransferUnderlying(asset, protocolAddresses.underlying[asset]);
    log.info(`supportMarket ${asset}`);
    const supportMarket: Governance.SupportMarketPair = {
        comptrollerAddress: protocolAddresses.comptroller,
        fTokenAddress: protocolAddresses.fTokens[asset],
        name: asset,
        priceExp: Math.pow(10, priceExp),
    };
    log.info(`${JSON.stringify(supportMarket)}`);
    const head = await TezosNodeReader.getBlockHead(config.tezosNode)
    const supportMarketOpId = await sendGovernanceOperation(
        Governance.SupportMarketOperation(supportMarket, comptrollerGovernanceAddress(protocolAddresses)),
        keystore,
        signer,
    );
    const conseilResult = await TezosNodeReader.awaitOperationConfirmation(config.tezosNode, head.header.level - 1, supportMarketOpId, 6).then(res => { if (res['contents'][0]['metadata']['operation_result']['status'] === "applied") return res; else throw new Error("operation status not applied"); }).catch((error) => { console.log(error) });
}

type ApprovedTokenStandard = 'FA12' | 'FA12_PACKED' | 'FA2' | 'XTZ';

interface ExactTransferApproval {
    address?: string;
    tokenStandard: ApprovedTokenStandard;
    tokenId?: number;
    native?: boolean;
}

/** Fail closed unless the exact configured underlying was reviewed for exact transfers. */
export function assertExactTransferUnderlying(asset: AssetType, underlying: UnderlyingAsset | undefined): void {
    const approvals = config.exactTransferUnderlyings as Record<string, ExactTransferApproval>;
    const approval = approvals[asset];
    if (!approval) {
        throw new Error(`${asset} is not approved for exact-transfer cash accounting`);
    }
    if (!underlying || underlying.assetType !== asset) {
        throw new Error(`${asset} exact-transfer approval does not match the configured underlying asset`);
    }

    const actualStandard = TokenStandard[underlying.tokenStandard] as ApprovedTokenStandard;
    if (approval.tokenStandard !== actualStandard) {
        throw new Error(`${asset} exact-transfer approval token standard mismatch: expected ${approval.tokenStandard}, got ${actualStandard}`);
    }

    if (approval.tokenStandard === 'XTZ') {
        if (approval.native !== true || approval.address !== undefined || underlying.address !== undefined) {
            throw new Error(`${asset} exact-transfer approval must explicitly designate native XTZ`);
        }
        return;
    }

    if (approval.native === true || !approval.address || approval.address !== underlying.address) {
        throw new Error(`${asset} exact-transfer approval address mismatch`);
    }

    if (approval.tokenStandard === 'FA2') {
        if (approval.tokenId === undefined || approval.tokenId !== underlying.tokenId) {
            throw new Error(`${asset} exact-transfer approval token ID mismatch`);
        }
    } else if (approval.tokenId !== undefined || underlying.tokenId !== undefined) {
        throw new Error(`${asset} exact-transfer approval unexpectedly specifies a token ID`);
    }
}

async function unpauseMarkets(asset: AssetType, keystore: KeyStore, signer: Signer, protocolAddresses: ProtocolAddresses) {
    // New markets begin with mint, borrow, and redemption paused.  Explicitly
    // enable all three only after the market listing operation has completed.
    if(!Object.prototype.hasOwnProperty.call(protocolAddresses.fTokens, asset)){
        return
    }
    log.info(`setMintPaused: ${asset}`);
    const setMintPaused: Governance.TokenPausePair = {
        comptrollerAddress: protocolAddresses.comptroller,
        tokenState: {
            state: false,
            fTokenAddress: protocolAddresses.fTokens[asset]
        }
    };
    log.info(`${JSON.stringify(setMintPaused)}`);
    let head = await TezosNodeReader.getBlockHead(config.tezosNode)
    const setMintPausedOpId = await sendGovernanceOperation(
        Governance.SetMintPausedOperation(setMintPaused, comptrollerGovernanceAddress(protocolAddresses)),
        keystore,
        signer,
    );
    const conseilResult = await TezosNodeReader.awaitOperationConfirmation(config.tezosNode, head.header.level - 1, setMintPausedOpId, 6).then(res => { if (res['contents'][0]['metadata']['operation_result']['status'] === "applied") return res; else throw new Error("operation status not applied"); }).catch((error) => { console.log(error) });
    log.info(`setBorrowPaused: ${asset}`);
    const setBorrowPaused: Governance.TokenPausePair = {
        comptrollerAddress: protocolAddresses.comptroller,
        tokenState: {
            state: false,
            fTokenAddress: protocolAddresses.fTokens[asset]
        }
    };
    head = await TezosNodeReader.getBlockHead(config.tezosNode)
    const setBorrowPausedOpId = await sendGovernanceOperation(
        Governance.SetBorrowPausedOperation(setBorrowPaused, comptrollerGovernanceAddress(protocolAddresses)),
        keystore,
        signer,
    );
    await TezosNodeReader.awaitOperationConfirmation(config.tezosNode, head.header.level - 1, setBorrowPausedOpId, 6).then(res => { if (res['contents'][0]['metadata']['operation_result']['status'] === "applied") return res; else throw new Error("operation status not applied"); }).catch((error) => { console.log(error) });
    log.info(`setRedeemPaused: ${asset}`);
    const setRedeemPaused: Governance.TokenPausePair = {
        comptrollerAddress: protocolAddresses.comptroller,
        tokenState: {
            state: false,
            fTokenAddress: protocolAddresses.fTokens[asset]
        }
    };
    head = await TezosNodeReader.getBlockHead(config.tezosNode)
    const setRedeemPausedOpId = await sendGovernanceOperation(
        Governance.SetRedeemPausedOperation(setRedeemPaused, comptrollerGovernanceAddress(protocolAddresses)),
        keystore,
        signer,
    );
    await TezosNodeReader.awaitOperationConfirmation(config.tezosNode, head.header.level - 1, setRedeemPausedOpId, 6).then(res => { if (res['contents'][0]['metadata']['operation_result']['status'] === "applied") return res; else throw new Error("operation status not applied"); }).catch((error) => { console.log(error) });
}

async function sendGovernanceOperation(operation: any, keystore: KeyStore, signer: Signer): Promise<string> {
    const nodeResult = await TezosNodeWriter.sendContractInvocationOperation(
        config.tezosNode,
        signer,
        keystore,
        operation.to,
        0,
        config.tx.fee,
        config.tx.freight,
        config.tx.gas,
        operation.parameter.entrypoint,
        JSON.stringify(operation.parameter.value),
        TezosParameterFormat.Micheline,
    );
    return TezosContractUtils.clearRPCOperationGroupHash(nodeResult.operationGroupID);
}

async function SetPrice(asset: AssetType, price: number, priceOracleAddress: string, server: string, signer: Signer, keystore: KeyStore, fee: number, gas: number = 200_000, freight: number = 20_000): Promise<string> {
    const entrypoint = 'setPrice';
    const parameters = `{"prim": "Pair", "args": [{"string": "${asset}"}, {"int": "${price}"}]} `;
    const nodeResult = await TezosNodeWriter.sendContractInvocationOperation(server, signer, keystore, priceOracleAddress, 0, fee, freight, gas, entrypoint, parameters, TezosParameterFormat.Micheline);
    return TezosContractUtils.clearRPCOperationGroupHash(nodeResult.operationGroupID);
}
