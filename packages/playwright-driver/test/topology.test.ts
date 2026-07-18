import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPageTopologyObservation } from "../src/topology.js";

interface TopologyFixture {
  readonly browserContextId: string;
  readonly context: BrowserContext;
  readonly control: CDPSession;
  readonly observation: ReturnType<typeof createPageTopologyObservation>;
  readonly page: Page;
}

describe("Chromium page-topology barrier", () => {
  let browser: Browser;
  let fixture: TopologyFixture | undefined;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterEach(async () => {
    await fixture?.control.detach().catch(() => undefined);
    await fixture?.context.close();
    fixture = undefined;
  });

  afterAll(async () => {
    await browser.close();
  });

  async function createFixture(): Promise<TopologyFixture> {
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageSession = await context.newCDPSession(page);
    const { targetInfo } = await pageSession.send("Target.getTargetInfo");
    await pageSession.detach();
    if (targetInfo.browserContextId === undefined) {
      throw new TypeError("Expected a Chromium browser-context ID.");
    }
    fixture = {
      browserContextId: targetInfo.browserContextId,
      context,
      control: await browser.newBrowserCDPSession(),
      observation: createPageTopologyObservation(context, page),
      page,
    };
    await fixture.observation.synchronize();
    return fixture;
  }

  it("snapshots an auxiliary target before Playwright page timing can hide it", async () => {
    const current = await createFixture();
    const { targetId } = await current.control.send("Target.createTarget", {
      browserContextId: current.browserContextId,
      url: "about:blank",
    });

    try {
      await expect(current.observation.synchronize()).resolves.toEqual({
        currentPages: 2,
        maximumObservedPages: 2,
      });
    } finally {
      await current.control.send("Target.closeTarget", { targetId }).catch(() => undefined);
    }
  });

  it("retains target creation that closes before the snapshot", async () => {
    const current = await createFixture();
    const { targetId } = await current.control.send("Target.createTarget", {
      browserContextId: current.browserContextId,
      url: "about:blank",
    });
    await current.control.send("Target.closeTarget", { targetId });
    await expect
      .poll(async () => {
        const { targetInfos } = await current.control.send("Target.getTargets");
        return targetInfos.some((targetInfo) => targetInfo.targetId === targetId);
      })
      .toBe(false);

    await expect(current.observation.synchronize()).resolves.toEqual({
      currentPages: 1,
      maximumObservedPages: 2,
    });
  });
});
