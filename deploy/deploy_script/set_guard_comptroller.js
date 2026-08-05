/**
 * Point all Previewnet fTokens at the deployed GuardComptroller.
 *
 * Reads markets + GuardComptroller from TezFinBuild/deploy_result/deploy.json.
 * Calls Governance.setComptroller(cToken, guard) for each market.
 *
 * IMPORTANT: use the Governance that currently administers the fTokens
 * (on this Previewnet deploy that is KT1CGYi…, not the Comptroller-admin KT1BGt…).
 *
 * Usage:
 *   export TEZOS_PRIVATE_KEY=<originator edsk>
 *   node ./deploy/deploy_script/set_guard_comptroller.js
 *
 * Optional env:
 *   GOVERNANCE_ADDRESS  — override fToken admin Governance
 *   GUARD_ADDRESS       — override GuardComptroller address
 *   DEPLOY_MANIFEST     — override deploy.json path
 */
const fs = require('fs');
const { createTezosClient, resolveDeployResultPath } = require('./util.js');

const MARKET_KEYS = ['CXTZ', 'CUSDt', 'CUSDtz', 'CtzBTC', 'CstXTZ', 'CETHtz', 'CBTCtz'];

/** Known fToken admin on the current Previewnet stack (differs from Comptroller admin). */
const DEFAULT_FTOKEN_GOVERNANCE = 'KT1CGYiDAzwFmgub9Fr1gHGzLJ6t8154XPup';

async function main() {
    const manifestPath = resolveDeployResultPath();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    const guard = process.env.GUARD_ADDRESS || manifest.GuardComptroller;
    if (!guard) {
        throw new Error(`No GuardComptroller in ${manifestPath}. Deploy it first or set GUARD_ADDRESS.`);
    }

    const governance = process.env.GOVERNANCE_ADDRESS
        || DEFAULT_FTOKEN_GOVERNANCE;
    if (manifest.Governance && manifest.Governance !== governance) {
        console.log(
            `[WARN] deploy.json Governance=${manifest.Governance} differs from fToken admin ` +
            `${governance}. Using ${governance} (override with GOVERNANCE_ADDRESS).`,
        );
    }

    const markets = MARKET_KEYS
        .filter((key) => manifest[key])
        .map((key) => ({ name: key, address: manifest[key] }));
    if (markets.length === 0) {
        throw new Error(`No fToken markets found in ${manifestPath}`);
    }

    const { tezos, publicKeyHash } = await createTezosClient();
    console.log(`Signer:     ${publicKeyHash}`);
    console.log(`Governance: ${governance}`);
    console.log(`Guard:      ${guard}`);
    console.log(`Markets:    ${markets.map((m) => m.name).join(', ')}`);

    for (const market of markets) {
        console.log(`\nsetComptroller ${market.name} (${market.address}) -> ${guard}`);
        // Governance parameter: pair %setComptroller (address %cToken) (address %comptroller)
        const op = await tezos.contract.transfer({
            to: governance,
            amount: 0,
            parameter: {
                entrypoint: 'setComptroller',
                value: {
                    prim: 'Pair',
                    args: [
                        { string: market.address },
                        { string: guard },
                    ],
                },
            },
        });
        console.log(`  op: ${op.hash}`);
        await op.confirmation(1);
        console.log('  confirmed');
    }

    console.log('\nDone. All listed fTokens now point at GuardComptroller.');
}

main().catch((err) => {
    console.error('[ERROR]', err.message || err);
    process.exitCode = 1;
});
