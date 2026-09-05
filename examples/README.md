# Paper-trading examples

Both examples simulate fills locally. They do not contact an exchange or submit real orders.

- `bun examples/trading-system.ts` runs two orders through market, risk,
  execution and portfolio workers against a running Bunqueue 2.9.4 server.
  It verifies a transient retry and a rejected order that leaves cash unchanged.
  Defaults: TCP `127.0.0.1:6789`, HTTP `127.0.0.1:6790`.
  Override the ports with `PAPER_TCP_PORT` and `PAPER_HTTP_PORT`.
- `bun examples/trading-stress-test.ts` starts its own temporary broker and
  SQLite database, runs 400 orders, checks groups, concurrency, deduplication,
  retries, DLQ and persistence after restart, then removes the temporary database.
  Set `STRESS_ORDERS` between 50 and 2000 to change the workload.

The supporting modules in `trading/` and `trading-stress/` contain the models,
workers and disposable broker lifecycle. Run the entrypoints above rather than
importing those modules into an application.
