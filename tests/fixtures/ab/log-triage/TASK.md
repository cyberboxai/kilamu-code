Last night's billing batch produced wrong totals. Finance noticed that the invoiced amount is far too low. The production log from that run is in `logs/nightly-2026-11-25.log`. It is large and mostly noise.

Find the root cause and fix it in `src/`. Do not special-case the test data. The regression test in test/ replays the batch.
