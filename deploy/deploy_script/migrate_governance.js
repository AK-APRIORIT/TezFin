/**
 * Migrates Comptroller to new Governance and sets market supply/borrow caps.
 *
 * Run AFTER recompiling and deploying new Governance:
 *   ~/smartpy-cli/SmartPy.sh compile deploy/compile_targets/CompileGovernance.py \
 *     ./TezFinBuild/compiled_contracts --protocol kathmandu
 *   node ./deploy/deploy_script/deploy.js
 *   node ./deploy/deploy_script/migrate_governance.js <old_governance_address>
 *
 * Requires TEZOS_PRIVATE_KEY in env.
 */
const { run, createTezosClient, resolveDeployResultPath, config } = require('./util.js');

const BIG_CAP = '1000000000000000000000000000'; // 10^27 — effectively unlimited

async function migrate() {
    const oldGovernance = process.argv[2];
    if (!oldGovernance) {
        throw new Error('Usage: node migrate_governance.js <old_governance_address>');
    }

    const { TezosToolkit } = require('@taquito/taquito');
    const { tezos } = await createTezosClient();

    const manifestPath = resolveDeployResultPath();
    const fs = require('fs');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    const newGovernance = manifest.Governance;
    const comptroller = manifest.Comptroller;
    const fTokens = [manifest.CXTZ, manifest.CUSDt, manifest.CtzBTC].filter(Boolean);

    console.log(`Old Governance: ${oldGovernance}`);
    console.log(`New Governance: ${newGovernance}`);
    console.log(`Comptroller:    ${comptroller}`);
    console.log(`fTokens:        ${fTokens.join(', ')}`);

    if (oldGovernance === newGovernance) {
        throw new Error('Old and new Governance are the same — did you forget to redeploy?');
    }

    // 1. Old Governance → Comptroller.setPendingGovernance(new_governance)
    console.log('\n[1] Old Governance: setContractGovernance on Comptroller...');
    const oldGov = await tezos.contract.at(oldGovernance);
    let op = await oldGov.methodsObject.setContractGovernance({
        contractAddress: comptroller,
        governance: newGovernance,
    }).send();
    console.log(`  op: ${op.hash}`);
    await op.confirmation(1);
    console.log('  confirmed');

    // 2. New Governance → Comptroller.acceptGovernance()
    console.log('\n[2] New Governance: acceptContractGovernance on Comptroller...');
    op = await tezos.contract.transfer({
        to: newGovernance,
        amount: 0,
        parameter: {
            entrypoint: 'acceptContractGovernance',
            value: { string: comptroller },
        },
    });
    console.log(`  op: ${op.hash}`);
    await op.confirmation(1);
    console.log('  confirmed');

    // 3. New Governance → Comptroller.setMarketCaps for each fToken
    console.log('\n[3] New Governance: setMarketCaps for each market...');
    for (const cToken of fTokens) {
        console.log(`  setMarketCaps for ${cToken}...`);
        // Micheline layout: Pair(Pair(borrowCap, Pair(cToken, supplyCap)), comptroller)
        op = await tezos.contract.transfer({
            to: newGovernance,
            amount: 0,
            parameter: {
                entrypoint: 'setMarketCaps',
                value: {
                    prim: 'Pair', args: [
                        { prim: 'Pair', args: [
                            { int: BIG_CAP },
                            { prim: 'Pair', args: [
                                { string: cToken },
                                { int: BIG_CAP },
                            ]},
                        ]},
                        { string: comptroller },
                    ],
                },
            },
        });
        console.log(`  op: ${op.hash}`);
        await op.confirmation(1);
        console.log('  confirmed');
    }

    console.log('\nMigration complete.');
}

migrate().catch((err) => {
    console.error('[ERROR]', err.message || err);
    process.exitCode = 1;
});
