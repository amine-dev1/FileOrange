#!/bin/bash
# usage: capture.sh <exe> <out.json> [env assignments...]
exe=$1; out=$2; shift 2
d=$(mktemp -d)
( cd "$d" && env "$@" FILE_API_TOKEN=capturetokencapturetokencapturetoken FILE_API_BIND=127.0.0.1:0 FILE_API_DATA_DIR="$d/data" "$exe" > "$d/log" 2>&1 & echo $! > "$d/pid" )
for i in $(seq 1 50); do grep -q listening "$d/log" && break; sleep 0.2; done
url=$(grep -o 'http://[0-9.:]*' "$d/log" | head -1)
curl -s -H "authorization: Bearer capturetokencapturetokencapturetoken" "$url/api/v1/capabilities" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin), indent=2))" > "$out.tmp" && mv "$out.tmp" "$out"
kill $(cat "$d/pid")
