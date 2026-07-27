import { chromium } from "/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs";

const FILE = "file:///private/tmp/claude-501/-Users-mithushancj-Documents-asyncdot-openscoped-voice-media-transport-syrinx/7066d39a-6af2-4eb7-832b-73d126cae106/scratchpad/syrinx-studio-ui.html";

const results = [];
const rec = (id, ok, note = "") => {
  results.push({ id, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${note ? "  — " + note : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(FILE);
await page.waitForTimeout(400);

const vis = (sel) => page.locator(sel).first().isVisible();
const canvasDrew = (sel) =>
  page.locator(sel).first().evaluate((c) => {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });

// ---- D: dashboard ----
rec("D01 no console errors on load", consoleErrors.length === 0, consoleErrors.join(" | "));
rec("D02 home is the landing screen", await vis('[data-screen="home"]'));
rec("D03 agent tabs hidden outside an agent", !(await vis("#agentTabs")));
rec("D04 publish action hidden outside an agent", !(await vis("#agentActions")));
rec("D05 verdict leads with exceptions", (await page.locator(".verdict h2").innerText()).includes("need you"));
rec("D06 three attention items", (await page.locator(".home-wrap .att").count()) >= 3);
rec("D07 severity encoded in form not just colour", (await page.locator(".sev-crit").count()) >= 2);
const sparkPx = await canvasDrew(".spark");
rec("D08 sparkline actually rendered", sparkPx > 50, `${sparkPx} px drawn`);

// ---- A: agents ----
await page.click('.nav-item[data-nav="agents"]');
await page.waitForTimeout(150);
rec("A01 agents list reachable from nav", await vis('[data-screen="agents"]'));
rec("A02 three agents listed", (await page.locator("#agentsFull .arow:not(.arow-head)").count()) === 3);
rec("A03 guardrail health visible in list", (await page.locator("#agentsFull .meter").count()) >= 2);
rec("A04 draft/live/paused states distinguished", (await page.locator("#agentsFull .chip").count()) >= 3);

await page.click("#emptyToggle");
await page.waitForTimeout(120);
rec("A05 empty state shows presets not a blank table", (await page.locator(".preset").count()) === 4);
rec("A06 empty state offers <=4 choices", (await page.locator(".preset").count()) <= 4);
await page.click("#emptyToggle");
await page.waitForTimeout(120);
rec("A07 empty preview is reversible", await vis("#agentsFull"));

// ---- C: connectors + oauth ----
await page.click('.nav-item[data-nav="connectors"]');
await page.waitForTimeout(150);
rec("C01 connectors reachable", await vis('[data-screen="connectors"]'));
rec("C02 expired connector visually marked", (await page.locator(".conn-expired").count()) === 1);
rec("C03 expiry states caller impact", (await page.locator('[data-screen="connectors"] .note').innerText()).includes("failing mid-call"));
rec("C04 nav badge surfaces the broken connector", (await page.locator(".nav-badge").count()) === 1);

await page.click('.conn-connect[data-provider="Calendly"]');
await page.waitForTimeout(200);
rec("C05 oauth opens at disclosure, not straight to provider", await vis('.dlg-step[data-step="1"]'));
const scopeTxt = await page.locator('.dlg-step[data-step="1"]').innerText();
rec("C06 discloses can / cannot / revoke before hand-off",
  scopeTxt.includes("It can") && scopeTxt.includes("It cannot") && scopeTxt.includes("revoke"));

await page.click('[data-oauth-next="2"]');
await page.waitForTimeout(150);
rec("C07 hand-off state exists", await vis('.dlg-step[data-step="2"]'));
await page.click('.dlg-step[data-step="2"] [data-oauth-next="3"]');
await page.waitForTimeout(150);
rec("C08 returns to tool selection", await vis('.dlg-step[data-step="3"]'));

const offCount = await page.locator('.oauth-tool[aria-checked="false"]').count();
rec("C09 every tool arrives OFF", offCount === 3, `${offCount}/3 off`);
rec("C10 empty allow-list rendered explicitly",
  (await page.locator("#oauthAllowed").innerText()).includes("[]"));

await page.click('.oauth-tool[data-otool="create_booking"]');
await page.waitForTimeout(120);
rec("C11 allow-list updates live",
  (await page.locator("#oauthAllowed").innerText()).includes('"create_booking"'));
// The allow-list IS the security boundary, so the switch and the emitted array must
// never disagree — a desync would show a tool as off while granting it.
const oState = await page.getAttribute('.oauth-tool[data-otool="create_booking"]', "aria-checked");
const oText = await page.locator("#oauthAllowed").innerText();
rec("C11b switch state and allow-list agree",
  (oState === "true") === oText.includes('"create_booking"'),
  `switch=${oState} list=${oText.trim()}`);
rec("C12 destructive tool flagged", (await page.locator('.dlg-step[data-step="3"] .chip-crit').count()) === 1);

await page.click('.dlg-step[data-step="3"] .btn-primary');
await page.waitForTimeout(200);
rec("C13 dialog closes on save", !(await vis("#oauthDlg")));

// ---- R: regressions in the existing screens ----
await page.click('.nav-item[data-nav="agents"]');
await page.click('[data-open-agent="1"]');
await page.waitForTimeout(200);
rec("R01 opening an agent enters agent context", await vis("#agentTabs"));
rec("R02 agent name shown in context", await vis("#agentCtx"));

await page.click('.rail-item[data-panel="tools"]');
await page.waitForTimeout(120);
const before = await page.locator("#allowedOut").innerText();
await page.click('[data-tool="create_draft"]');
await page.waitForTimeout(120);
const after = await page.locator("#allowedOut").innerText();
rec("R03 build-screen tool toggle still works (double-bind regression)",
  before !== after && after.includes("create_draft"));

await page.click('.tab[data-screen="calls"]');
await page.waitForTimeout(300);
const wavePx = await canvasDrew("#wave");
rec("R04 waveform renders", wavePx > 500, `${wavePx} px drawn`);

await page.click('.nav-item[data-nav="stub"]');
await page.waitForTimeout(150);
rec("R05 undesigned nav targets explain themselves",
  (await page.locator("#stubTitle").innerText()).length > 0 && !(await vis("#agentTabs")));

// ---- L: layout ----
const hscroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
rec("L01 no horizontal page scroll at 1440", !hscroll);

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
await page.click('.nav-item[data-nav="home"]');
await page.waitForTimeout(250);
const hscrollM = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
rec("L02 no horizontal page scroll at 390", !hscrollM);
rec("L03 dashboard usable at mobile width", await vis(".verdict"));

// ---- dark theme ----
await page.setViewportSize({ width: 1440, height: 900 });
await page.emulateMedia({ colorScheme: "dark" });
await page.waitForTimeout(200);
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
rec("T01 dark theme applies", bg === "rgb(10, 10, 11)", bg);
const sparkDark = await canvasDrew(".spark");
rec("T02 canvas redraws for dark theme", sparkDark > 50, `${sparkDark} px`);

rec("D01b still no console errors after full pass", consoleErrors.length === 0, consoleErrors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("FAILURES:");
  failed.forEach((f) => console.log(`  ${f.id} — ${f.note}`));
  process.exit(1);
}
