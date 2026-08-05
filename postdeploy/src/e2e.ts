import { initConseil, initKeystore, parseProtocolAddress } from "./util";
import * as DeployHelper from './deploy';
import * as FTokenHelper from './ftoken';
import { ConseilServerInfo, KeyStore, Signer } from "conseiljs";
import * as ComptrollerHelper from './comptroller';
import { AssetType, Comptroller, ProtocolAddresses } from "tezoslendingplatformjs";
import * as config from '../config/config.json';

async function test(keystore: KeyStore, signer: Signer, keystore1: KeyStore, signer1: Signer, protocolAddresses: ProtocolAddresses, oracle: string) {
    try {
        // mint underlying tokens to both users 
        await DeployHelper.mintFakeTokens(keystore!, signer!, protocolAddresses!, keystore.publicKeyHash);
        await DeployHelper.mintFakeTokens(keystore!, signer!, protocolAddresses!, keystore1.publicKeyHash);

        // Comptroller requests `${market.name}-USD` from the oracle overrides map
        await FTokenHelper.updatePrice([
            { asset: "USDT-USD", price: 1 * Math.pow(10, 6) },
            { asset: "TZBTC-USD", price: 20000 * Math.pow(10, 6) },
            { asset: "XTZ-USD", price: 2 * Math.pow(10, 6) },
        ], oracle, keystore!, signer!, protocolAddresses!);

        // supply FOR USER 0
        for (const mint of ["TZBTC"])
            await FTokenHelper.mint(mint as AssetType, 900, keystore!, signer!, protocolAddresses!);
        // supply FOR USER 1
        for (const mint of ["USDT"])
            await FTokenHelper.mint(mint as AssetType, 2000000, keystore1!, signer1!, protocolAddresses!);
        // collateralize for user 1
        await ComptrollerHelper.enterMarkets(["USDT"] as AssetType[], keystore1!, signer1!, protocolAddresses!);
        // get comptroller
        const comptroller = await Comptroller.GetStorage(protocolAddresses!.comptroller, protocolAddresses!, config.tezosNode);
        // borrow for user 1
        // 2M USDT collateral @ CF 50% ≈ $1M borrow power; 20 TZBTC @ $20k = $400k (fits).
        // (500 TZBTC would be $10M and triggers CMPT_REDEEMER_SHORTFALL.)
        for (const borrow of ["TZBTC"])
            await FTokenHelper.borrow(borrow as AssetType, 20, comptroller, protocolAddresses!, keystore1!, signer1!);
        // --- STOP HERE for Guard testing ---
    } catch (err) {
        console.log(JSON.stringify(err))
    }
}

async function runE2E() {
    await initConseil();
    const { keystore, signer } = await initKeystore();
    const { keystore: keystore1, signer: signer1 } = await initKeystore(config.keystore1);
    const { protoAddress, oracle } = await parseProtocolAddress(config.protocolAddressesPath);
    console.log(`protocolAddresses: ${JSON.stringify(protoAddress!)}`);

    // supportMarket + unpause already done; still need oracle age + price bounds for borrow
    await DeployHelper.setOracle(
        keystore!, signer!, protoAddress!, protoAddress!.oracle,
        (config as any).oracleMaxPriceAge ?? 3600,
    );
    await DeployHelper.setPriceBoundsForListedMarkets(keystore!, signer!, protoAddress!);

    return test(keystore, signer, keystore1, signer1, protoAddress, oracle);
}

runE2E();
