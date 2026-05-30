// SPDX-License-Identifier: MIT
//
// Fly spike entry point. Selects the bot (telephony review) or synthetic-carrier
// server by role and starts it. We call the module's exported `main()` directly:
// the serve modules only auto-run `main()` when they are the *direct* process entry
// point, so a bare side-effect `import()` from this wrapper would load them without
// ever starting the HTTP server (the process would exit 0 and the Fly machine would
// never bind 0.0.0.0:PORT).

const role = process.env["SYRINX_SPIKE_ROLE"]?.trim().toLowerCase();

if (role === "synthetic-carrier" || role === "carrier") {
  const { main } = await import("./serve-synthetic-carrier.js");
  await main();
} else {
  const { main } = await import("./serve-telephony-review.js");
  await main();
}
