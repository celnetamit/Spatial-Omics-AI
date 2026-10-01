#!/usr/bin/env bash
#
# Trains the propagation model pack with the ensemble members and the
# graph-free baseline running concurrently.
#
# Each job rebuilds the corpus from the same seed — which is deterministic, so
# they train on identical data — and then trains one model. Sequentially this
# takes four times as long for no reason: the members are independent by
# construction, which is what makes the ensemble an ensemble.
#
#   ./scripts/train-parallel.sh
#   SPATIAL_EPOCHS=50 SPATIAL_CELLS=500 ./scripts/train-parallel.sh
set -euo pipefail

cd "$(dirname "$0")/.."
LOGS="${SPATIAL_TRAIN_LOGS:-/tmp/spatial-train}"
mkdir -p "$LOGS"

export SPATIAL_SECTIONS="${SPATIAL_SECTIONS:-14}"
export SPATIAL_CELLS="${SPATIAL_CELLS:-500}"
export SPATIAL_EPOCHS="${SPATIAL_EPOCHS:-50}"
export SPATIAL_ENSEMBLE="${SPATIAL_ENSEMBLE:-3}"

npm run engine:build >/dev/null

echo "corpus: $SPATIAL_SECTIONS sections x $SPATIAL_CELLS cells, $SPATIAL_EPOCHS epochs, $SPATIAL_ENSEMBLE members"
echo "logs in $LOGS"

pids=()
for i in $(seq 0 $((SPATIAL_ENSEMBLE - 1))); do
  SPATIAL_JOB="member:$i" node engine/tools/train-propagation.mjs > "$LOGS/member-$i.log" 2>&1 &
  pids+=($!)
done
SPATIAL_JOB=baseline node engine/tools/train-propagation.mjs > "$LOGS/baseline.log" 2>&1 &
pids+=($!)

failed=0
for pid in "${pids[@]}"; do
  wait "$pid" || failed=1
done

if [ "$failed" -ne 0 ]; then
  echo "at least one training job failed; see $LOGS" >&2
  exit 1
fi

SPATIAL_JOB=combine node engine/tools/train-propagation.mjs 2>&1 | tee "$LOGS/combine.log"
