# PNG Squeeze — Lossless Screenshot Re-encoder

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/cos43/makefun-png-squeeze-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/cos43/makefun-png-squeeze-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

An original lossless PNG re-encoder for make.fun's png-squeeze bounty. It reads
each 1280×720 RGBA screenshot the contest hands it and writes the same pixels
back as a much smaller PNG, byte-exact:

- **Sample reduction first**: ≤256 distinct colours become a palette image
  (colour type 3 + tRNS), with the palette sorted by colour so neighbouring
  similar colours get close indices; all-grey images become grey (type 0) or
  grey+alpha (type 4); opaque colour images become RGB (type 2).
- **Per-row filter choice**: every row tries all five PNG filters and keeps
  the one with the smallest sum of absolute signed residuals.
- **One zlib level-9 stream**, one IDAT, no ancillary chunks, fully
  deterministic output.

Local practice-set score (`grade-local`, process driver): **621,828 / 1,000,000**
(house baseline fixed-paeth: 420,399; all 8 instances answered exactly).

## Run

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22+, no dependencies beyond Node's built-ins. The whole program is the
single file `main.ts`.
