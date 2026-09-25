import { test, expect } from "@playwright/test";

test("save session serializes concurrent snapshots and keeps the latest edit", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { DocumentSaveSession } = await import("/src/document-session.ts");
    const calls = [];
    let releaseFirst;
    let firstStarted;
    const started = new Promise(resolve => { firstStarted = resolve; });
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    const session = new DocumentSaveSession(async value => {
      calls.push(value);
      if (value === 1) { firstStarted(); await gate; }
    }, () => {});
    session.schedule(1);
    const firstFlush = session.flush();
    await started;
    session.schedule(2);
    const secondFlush = session.flush();
    releaseFirst();
    await Promise.all([firstFlush, secondFlush]);
    return calls;
  });
  expect(result).toEqual([1, 2]);
});

test("save session blocks flush after failure until a newer snapshot succeeds", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { DocumentSaveSession } = await import("/src/document-session.ts");
    const calls = [];
    const session = new DocumentSaveSession(async value => {
      calls.push(value);
      if (value === "first") throw new Error("save rejected");
    }, () => {});
    session.schedule("first");
    let firstError = "";
    let repeatedError = "";
    try { await session.flush(); } catch (error) { firstError = error.message; }
    try { await session.flush(); } catch (error) { repeatedError = error.message; }
    session.schedule("revised");
    await session.flush();
    return { calls, firstError, repeatedError };
  });
  expect(result).toEqual({ calls: ["first", "revised"], firstError: "save rejected", repeatedError: "save rejected" });
});

test("an older failed save cannot replace a newer queued snapshot", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { DocumentSaveSession } = await import("/src/document-session.ts");
    const calls = [];
    const phases = [];
    let failFirst;
    let firstStarted;
    const started = new Promise(resolve => { firstStarted = resolve; });
    const gate = new Promise(resolve => { failFirst = resolve; });
    const session = new DocumentSaveSession(async value => {
      calls.push(value);
      if (value === 1) { firstStarted(); await gate; throw new Error("old save failed"); }
    }, phase => phases.push(phase));
    session.schedule(1);
    const firstFlush = session.flush();
    await started;
    session.schedule(2);
    const latestFlush = session.flush();
    failFirst();
    await Promise.all([firstFlush, latestFlush]);
    return { calls, lastPhase: phases.at(-1) };
  });
  expect(result).toEqual({ calls: [1, 2], lastPhase: "saved" });
});
