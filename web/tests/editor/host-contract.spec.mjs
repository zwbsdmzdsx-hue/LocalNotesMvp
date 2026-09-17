import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const cases = JSON.parse(readFileSync(new URL("../../../tests/contracts/save-cases.json", import.meta.url), "utf8"));

test("Mock satisfies the shared SQLite save cases", async ({ page }) => {
  await page.goto("/");
  const outcomes = await page.evaluate(async cases => {
    const { BrowserMockHost } = await import("/src/browser-mock-host.ts");
    const { EditorHostApi } = await import("/src/editor-host-api.ts");
    const mock = new BrowserMockHost();
    mock.docs.get("alpha").references = [];
    mock.docs.get("alpha").blocks = [mock.docs.get("alpha").blocks[0]];
    mock.docs.get("beta").blocks[0].content = { text: "protected", html: "protected" };
    const api = new EditorHostApi(mock);
    const results = [];
    for (const c of cases) {
      const blocks = ("blocks" in c ? c.blocks : [{ id: "a1" }])?.map(({ omitContent, omitProperties, ...b }) => ({
        parentId: null, position: "00001000", type: "paragraph", revision: 1,
        content: omitContent ? undefined : { text: c.text ?? "invalid", html: c.text ?? "invalid" },
        properties: omitProperties ? undefined : {}, ...b
      })) ?? null;
      const before = JSON.stringify(mock.docs.get("alpha"));
      let ack, error;
      try { ack = await api.saveDocument({ documentId: "alpha", mutationId: c.mutationId, clientVersion: c.version, title: "Alpha", blocks }); }
      catch (e) { error = e.message; }
      const state = await api.loadDocument("alpha");
      results.push({ name: c.name, ok: !error, ack: ack?.clientVersion, text: state.blocks[0].content.text,
        protected: mock.docs.get("beta").blocks[0].content.text,
        unchanged: !error || JSON.stringify(mock.docs.get("alpha")) === before });
    }
    api.dispose();
    return results;
  }, cases);
  for (let i = 0; i < cases.length; i++) {
    expect(outcomes[i], cases[i].name).toMatchObject({ ok: cases[i].ok, text: cases[i].expectedText, protected: "protected", unchanged: true });
    if (cases[i].ok) expect(outcomes[i].ack).toBe(cases[i].ack);
  }
});

test("Mock rejects unknown commands and retains local moves across source refresh", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { BrowserMockHost } = await import("/src/browser-mock-host.ts");
    const { EditorHostApi } = await import("/src/editor-host-api.ts");
    const mock = new BrowserMockHost(); const api = new EditorHostApi(mock);
    let unknown = false, foreign = false;
    try { await api.executeCommand({ operation: "unsupported" }, "alpha"); } catch { unknown = true; }
    try { await api.executeCommand({ operation: "reset-reference", referenceInstanceId: "ref1" }, "beta"); } catch { foreign = true; }
    await api.executeCommand({ operation: "move-reference-block", referenceInstanceId: "ref1", targetBlockId: "b1", parentBlockId: null, position: "99999000" }, "alpha");
    mock.updateSourceBlock("beta", "b1", "updated source");
    const moved = (await api.loadDocument("alpha")).references[0].blocks[0];
    await api.executeCommand({ operation: "reset-override", referenceInstanceId: "ref1", targetBlockId: "b1" }, "alpha");
    const reset = (await api.loadDocument("alpha")).references[0].blocks[0];
    api.dispose(); return { unknown, foreign, moved, reset };
  });
  expect(result).toMatchObject({ unknown: true, foreign: true, moved: { position: "99999000", content: { text: "updated source" } }, reset: { position: "00001000" } });
});
