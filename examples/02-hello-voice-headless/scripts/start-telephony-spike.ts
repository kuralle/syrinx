// SPDX-License-Identifier: MIT

const role = process.env["SYRINX_SPIKE_ROLE"]?.trim().toLowerCase();

if (role === "synthetic-carrier" || role === "carrier") {
  await import("./serve-synthetic-carrier.js");
} else {
  await import("./serve-telephony-review.js");
}
