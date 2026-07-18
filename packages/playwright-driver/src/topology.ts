import type { BrowserContext, CDPSession, Page } from "playwright";

export interface PageTopologySnapshot {
  readonly currentPages: number;
  readonly maximumObservedPages: number;
}

export interface PageTopologyObservation {
  readonly synchronize: () => Promise<PageTopologySnapshot>;
}

interface ChromiumTargetState {
  readonly browserContextId: string;
  readonly pageTargetIds: Set<string>;
  readonly session: CDPSession;
}

async function chromiumTargetState(
  context: BrowserContext,
  page: Page,
  observePageCount: (count: number) => void,
): Promise<ChromiumTargetState> {
  const browser = context.browser();
  if (browser === null) {
    throw new TypeError("The guarded context must belong to a connected Chromium browser.");
  }

  const pageSession = await context.newCDPSession(page);
  let controlledTargetId: string;
  let browserContextId: string;
  try {
    const { targetInfo } = await pageSession.send("Target.getTargetInfo");
    controlledTargetId = targetInfo.targetId;
    browserContextId = targetInfo.browserContextId ?? "";
  } finally {
    await pageSession.detach().catch(() => undefined);
  }
  if (browserContextId === "") {
    throw new TypeError("Chromium did not report the guarded browser-context identity.");
  }

  const session = await browser.newBrowserCDPSession();
  const pageTargetIds = new Set<string>([controlledTargetId]);
  const belongsToGuardedContext = (targetInfo: {
    readonly browserContextId?: string;
    readonly type: string;
  }): boolean => targetInfo.browserContextId === browserContextId && targetInfo.type === "page";
  session.on("Target.targetCreated", ({ targetInfo }) => {
    if (belongsToGuardedContext(targetInfo)) {
      pageTargetIds.add(targetInfo.targetId);
      observePageCount(pageTargetIds.size);
    }
  });
  session.on("Target.targetDestroyed", ({ targetId }) => {
    pageTargetIds.delete(targetId);
  });
  context.once("close", () => {
    void session.detach().catch(() => undefined);
  });

  try {
    await session.send("Target.setDiscoverTargets", { discover: true });
  } catch (error) {
    await session.detach().catch(() => undefined);
    throw error;
  }

  return Object.freeze({ browserContextId, pageTargetIds, session });
}

export function createPageTopologyObservation(
  context: BrowserContext,
  page: Page,
): PageTopologyObservation {
  let maximumObservedPages = context.pages().length;
  let statePromise: Promise<ChromiumTargetState> | undefined;
  const observePageCount = (count: number): void => {
    maximumObservedPages = Math.max(maximumObservedPages, count);
  };
  context.on("page", () => observePageCount(context.pages().length));

  const getState = (): Promise<ChromiumTargetState> => {
    statePromise ??= chromiumTargetState(context, page, observePageCount);
    return statePromise;
  };

  return Object.freeze({
    synchronize: async () => {
      const state = await getState();
      const { targetInfos } = await state.session.send("Target.getTargets");
      const currentTargetIds = targetInfos
        .filter(
          (targetInfo) =>
            targetInfo.browserContextId === state.browserContextId && targetInfo.type === "page",
        )
        .map((targetInfo) => targetInfo.targetId);

      observePageCount(state.pageTargetIds.size);
      observePageCount(currentTargetIds.length);
      state.pageTargetIds.clear();
      for (const targetId of currentTargetIds) {
        state.pageTargetIds.add(targetId);
      }

      return Object.freeze({
        currentPages: currentTargetIds.length,
        maximumObservedPages,
      });
    },
  });
}
