#!/bin/sh
set -u

repo='/Users/user/Work/TezFin'
out_dir="$repo/TezFinBuild/pyth_onchain_samples"
count_file="$out_dir/cron_count"
log_file="$out_dir/collector.log"
node='/opt/homebrew/opt/node@22/bin/node'

exec >>"$log_file" 2>&1
printf '[%s] cron invocation\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

count=$(cat "$count_file" 2>/dev/null || printf '0')
case "$count" in
    ''|*[!0-9]*)
        printf '[ERROR] invalid cron_count: %s\n' "$count"
        exit 1
        ;;
esac

if [ "$count" -ge 1440 ]; then
    printf '[INFO] collection limit reached: %s/1440\n' "$count"
    exit 0
fi

printf '%s\n' "$((count + 1))" >"$count_file"
cd "$repo" || exit 1
DEPLOY_MANIFEST=TezFinBuild/deploy_result/deploy.shadownet.json \
PYTH_EVM_RPC=https://node.mainnet.etherlink.com \
"$node" deploy/deploy_script/measure_pyth_confidence.js \
collect-onchain --out-dir "$out_dir"
printf '[%s] collector exit=%s count=%s/1440\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$?" "$((count + 1))"
