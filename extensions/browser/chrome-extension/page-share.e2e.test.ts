import { appendFile, cp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type CDPSession } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  startBrowserBridgeServer,
  stopBrowserBridgeServer,
} from "../src/browser/bridge-server.js";
import {
  browserDoctor,
  browserStatus,
  type BrowserDoctorReport,
  type BrowserStatus,
} from "../src/browser/client.js";
import { resolveBrowserConfig } from "../src/browser/config.js";
import {
  startExtensionRelayServer,
  type ExtensionRelayHandle,
} from "../src/browser/extension-relay/relay-server.js";
import { useAutoCleanupTempDirTracker } from "../test-support.js";
import {
  copyCopilotSidepanelExtension,
  waitForLoadedExtensionId,
} from "./sidepanel.e2e-support.js";

declare const chrome: {
  runtime: {
    getManifest(): { version: string };
    reload(): void;
    sendMessage(message: Record<string, unknown>): Promise<{
      ok?: boolean;
      error?: string;
    }>;
  };
  tabs: {
    get(tabId: number): Promise<{ id?: number; url?: string; windowId?: number }>;
    query(query: Record<string, unknown>): Promise<Array<{ id?: number; url?: string }>>;
    update(tabId: number, update: { active: boolean }): Promise<unknown>;
  };
  windows: {
    update(windowId: number, update: { focused: boolean }): Promise<unknown>;
  };
};

const runE2E = process.env.OPENCLAW_BROWSER_COPILOT_E2E === "1";
const cleanups: Array<() => Promise<void>> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let nextPopupCommandId = 0;
const proofSourceHead = "afd28d905bbb180ef58c804440214bdae8e3ae86";
const staleExtensionVersion = "2.0.0";

type ChromeTarget = { targetId: string; type: string; url: string };

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup().catch(() => undefined);
  }
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("page-share test server did not bind a TCP port");
  }
  return address.port;
}

async function evaluateToolbarPopup<T>(
  browserCdp: CDPSession,
  sessionId: string,
  expression: string,
): Promise<T> {
  const id = ++nextPopupCommandId;
  let listener: ((event: { message: string; sessionId: string }) => void) | undefined;
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    listener = (event) => {
      if (event.sessionId !== sessionId) {
        return;
      }
      const message = JSON.parse(event.message) as {
        error?: { message?: string };
        id?: number;
        result?: Record<string, unknown>;
      };
      if (message.id !== id) {
        return;
      }
      if (message.error) {
        reject(new Error(message.error.message ?? "Chrome toolbar popup evaluation failed."));
        return;
      }
      resolve(message.result ?? {});
    };
    browserCdp.on("Target.receivedMessageFromTarget", listener);
  });

  try {
    await browserCdp.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    });
    const result = await response;
    const exception = result.exceptionDetails as { text?: string } | undefined;
    if (exception) {
      throw new Error(exception.text ?? "Chrome toolbar popup evaluation failed.");
    }
    return (result.result as { value?: T } | undefined)?.value as T;
  } finally {
    if (listener) {
      browserCdp.off("Target.receivedMessageFromTarget", listener);
    }
  }
}

async function readExtensionManifestVersion(extensionPath: string): Promise<string> {
  const raw = await readFile(path.join(extensionPath, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("copied extension manifest does not contain a version");
  }
  return manifest.version;
}

async function writeExtensionManifestVersion(
  extensionPath: string,
  version: string,
): Promise<void> {
  const manifestPath = path.join(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function refreshUnpackedExtensionInPlace(extensionPath: string): Promise<void> {
  const extensionSource = path.dirname(fileURLToPath(import.meta.url));
  await cp(extensionSource, extensionPath, {
    recursive: true,
    force: true,
    filter: (source) => !source.endsWith(".test.ts"),
  });
}

function extensionVersionCheck(report: BrowserDoctorReport) {
  const check = report.checks.find((candidate) => candidate.id === "extension-version");
  if (!check) {
    throw new Error("browser Doctor omitted the extension-version check");
  }
  return check;
}

function redactedStatus(status: BrowserStatus) {
  return {
    profile: status.profile,
    transport: status.transport,
    running: status.running,
    chromeExtension: status.chromeExtension,
  };
}

async function emitRealBrowserProof(lines: string[]): Promise<void> {
  const output = lines.map((line) => `[OPENCLAW-PROOF] ${line}`).join("\n") + "\n";
  process.stdout.write(output);
  const stepSummary = process.env.GITHUB_STEP_SUMMARY?.trim();
  if (stepSummary) {
    await appendFile(
      stepSummary,
      `\n## PR #119641 real unpacked-Chromium proof\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`,
      "utf8",
    );
  }
}

describe.runIf(runE2E)("Chrome page sharing with a real Gateway extension relay", () => {
  it("recovers after an in-place refresh, runtime reload, and browser restart", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-extension-version-proof-state-");
    cleanups.push(async () => {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    });

    const { ensureExtensionRelayToken } = await import(
      "../src/browser/extension-relay/relay-auth.js"
    );
    const relayToken = await ensureExtensionRelayToken();
    const relay = await startExtensionRelayServer({
      port: 0,
      token: relayToken,
      onPageShare: async () => {},
    });

    let bridge: Awaited<ReturnType<typeof startBrowserBridgeServer>> | undefined;
    cleanups.push(async () => {
      if (bridge) {
        const bridgeOwnsRelay = bridge.state.extensionRelays?.get("chrome") === relay;
        await stopBrowserBridgeServer(bridge.server);
        if (!bridgeOwnsRelay) {
          await relay.close();
        }
        return;
      }
      await relay.close();
    });

    const resolved = resolveBrowserConfig({
      enabled: true,
      defaultProfile: "chrome",
      profiles: {
        chrome: {
          driver: "extension",
          cdpPort: relay.port,
        },
      },
    });
    expect(resolved.extensionRelayToken).toBe(relay.token);
    bridge = await startBrowserBridgeServer({
      resolved,
      authToken: "openclaw-proof-browser-control-placeholder",
    });
    bridge.state.extensionRelays = new Map([["chrome", relay]]);

    const unpackedExtension = await copyCopilotSidepanelExtension(tempDirs);
    const bundledVersion = await readExtensionManifestVersion(unpackedExtension);
    expect(bundledVersion).not.toBe(staleExtensionVersion);
    await writeExtensionManifestVersion(unpackedExtension, staleExtensionVersion);

    const userDataDir = tempDirs.make("openclaw-extension-version-proof-profile-");
    const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
      channel: "chromium",
      headless: true,
      // Playwright disables extensions by default, which overrides the unpacked fixture below.
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        "--enable-unsafe-extension-debugging",
        `--disable-extensions-except=${unpackedExtension}`,
        `--load-extension=${unpackedExtension}`,
      ],
    };
    const initialContext = await chromium.launchPersistentContext(userDataDir, launchOptions);
    cleanups.push(async () => await initialContext.close());

    const browser = initialContext.browser();
    if (!browser) {
      throw new Error("Chromium browser connection unavailable");
    }
    const browserCdp = await browser.newBrowserCDPSession();
    const extensionId = await waitForLoadedExtensionId(browserCdp, unpackedExtension);
    const pairingPage = initialContext.pages()[0] ?? (await initialContext.newPage());
    await pairingPage.goto(`chrome-extension://${extensionId}/popup.html`);
    const worker =
      initialContext.serviceWorkers()[0] ??
      (await initialContext.waitForEvent("serviceworker"));

    const pairing = await pairingPage.evaluate(
      async (pairingString) => await chrome.runtime.sendMessage({ type: "pair", pairingString }),
      `ws://127.0.0.1:${relay.port}/extension#${relay.token}`,
    );
    expect(pairing).toEqual({ ok: true });
    await expect
      .poll(() => relay.bridge.identity?.extensionVersion, { timeout: 10_000 })
      .toBe(staleExtensionVersion);

    const beforeStatus = await browserStatus(bridge.baseUrl, { profile: "chrome" });
    const beforeDoctor = await browserDoctor(bridge.baseUrl, { profile: "chrome" });
    expect(redactedStatus(beforeStatus)).toEqual({
      profile: "chrome",
      transport: "extension",
      running: true,
      chromeExtension: {
        runningVersion: staleExtensionVersion,
        bundledVersion,
        versionState: "mismatch",
      },
    });
    const beforeVersionCheck = extensionVersionCheck(beforeDoctor);
    expect(beforeVersionCheck).toMatchObject({
      status: "warn",
      summary: `running ${staleExtensionVersion}; bundled ${bundledVersion} (mismatch)`,
    });

    await refreshUnpackedExtensionInPlace(unpackedExtension);
    expect(await readExtensionManifestVersion(unpackedExtension)).toBe(bundledVersion);
    const workerClosed = worker.waitForEvent("close", { timeout: 15_000 });
    await worker.evaluate(() => {
      setTimeout(() => chrome.runtime.reload(), 0);
    });
    await workerClosed;
    await initialContext.close();
    await expect.poll(() => relay.bridge.identity, { timeout: 10_000 }).toBeNull();

    const reloadedContext = await chromium.launchPersistentContext(userDataDir, launchOptions);
    cleanups.push(async () => await reloadedContext.close());
    const reloadedBrowser = reloadedContext.browser();
    if (!reloadedBrowser) {
      throw new Error("Reloaded Chromium browser connection unavailable");
    }
    const reloadedBrowserCdp = await reloadedBrowser.newBrowserCDPSession();
    const reloadedExtensionId = await waitForLoadedExtensionId(
      reloadedBrowserCdp,
      unpackedExtension,
    );
    expect(reloadedExtensionId).toBe(extensionId);
    const wakePage = reloadedContext.pages()[0] ?? (await reloadedContext.newPage());
    await wakePage.goto(`chrome-extension://${reloadedExtensionId}/popup.html`);
    expect(await wakePage.evaluate(() => chrome.runtime.getManifest().version)).toBe(
      bundledVersion,
    );
    await wakePage.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: "getStatus" });
    });
    await expect
      .poll(() => relay.bridge.identity?.extensionVersion, { timeout: 15_000 })
      .toBe(bundledVersion);

    const afterStatus = await browserStatus(bridge.baseUrl, { profile: "chrome" });
    const afterDoctor = await browserDoctor(bridge.baseUrl, { profile: "chrome" });
    expect(redactedStatus(afterStatus)).toEqual({
      profile: "chrome",
      transport: "extension",
      running: true,
      chromeExtension: {
        runningVersion: bundledVersion,
        bundledVersion,
        versionState: "match",
      },
    });
    const afterVersionCheck = extensionVersionCheck(afterDoctor);
    expect(afterVersionCheck).toMatchObject({
      status: "pass",
      summary: `running ${bundledVersion}; bundled ${bundledVersion} (match)`,
    });

    const browserVersion = relay.bridge.identity?.browserVersion ?? "Chrome/unknown";
    await emitRealBrowserProof([
      `SOURCE production-head=${proofSourceHead}; browser=${browserVersion}; isolated temporary profile`,
      `BEFORE status=${JSON.stringify(redactedStatus(beforeStatus))}; doctor=WARN extension-version: ${beforeVersionCheck.summary}`,
      "ACTION refreshed in place; chrome.runtime.reload() closed the stale worker; then fully quit and reopened Chromium with the same isolated profile and unpacked path; pairing storage and extension id persisted",
      `AFTER status=${JSON.stringify(redactedStatus(afterStatus))}; doctor=OK extension-version: ${afterVersionCheck.summary}`,
    ]);
  });

  it.each([
    { label: "relay disconnection", unpair: false },
    { label: "user unpair", unpair: true },
  ])("immediately reports $label instead of leaving the popup sending", async ({ unpair }) => {
    const receivedShares: Array<{ url: string; content: string }> = [];
    let releaseDelivery: () => void = () => {};
    const delivery = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const relay = await startExtensionRelayServer({
      port: 0,
      token: "openclaw-autoqa-page-share-relay-placeholder",
      onPageShare: async (payload) => {
        receivedShares.push({ url: payload.url, content: payload.content });
        await delivery;
      },
    });
    let relayClosed = false;
    const closeRelay = async (handle: ExtensionRelayHandle) => {
      if (!relayClosed) {
        relayClosed = true;
        await handle.close();
      }
    };
    cleanups.push(async () => {
      releaseDelivery();
      await closeRelay(relay);
    });

    const fixture = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><title>Page-share relay article</title><main>Page-share relay article body.</main>",
      );
    });
    const fixturePort = await listen(fixture);
    cleanups.push(
      async () =>
        await new Promise<void>((resolve, reject) => {
          fixture.close((error) => (error ? reject(error) : resolve()));
        }),
    );

    const unpackedExtension = await copyCopilotSidepanelExtension(tempDirs);
    const context = await chromium.launchPersistentContext(
      tempDirs.make("openclaw-page-share-disconnect-profile-"),
      {
        channel: "chromium",
        headless: true,
        // Playwright disables extensions by default, which overrides the unpacked fixture below.
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [
          "--enable-unsafe-extension-debugging",
          `--disable-extensions-except=${unpackedExtension}`,
          `--load-extension=${unpackedExtension}`,
        ],
      },
    );
    cleanups.push(async () => await context.close());

    const browser = context.browser();
    if (!browser) {
      throw new Error("Chromium browser connection unavailable");
    }
    const browserCdp = await browser.newBrowserCDPSession();
    const extensionId = await waitForLoadedExtensionId(browserCdp, unpackedExtension);
    const pairingPage = context.pages()[0] ?? (await context.newPage());
    await pairingPage.goto(`chrome-extension://${extensionId}/popup.html`);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));

    const pairing = await pairingPage.evaluate(
      async (pairingString) => await chrome.runtime.sendMessage({ type: "pair", pairingString }),
      `ws://127.0.0.1:${relay.port}/extension#${relay.token}`,
    );
    expect(pairing).toEqual({ ok: true });
    await expect.poll(() => relay.bridge.extensionConnected, { timeout: 10_000 }).toBe(true);

    const article = await context.newPage();
    await article.goto(`http://127.0.0.1:${fixturePort}/article`);
    const articleTabId = await worker.evaluate(async (expectedUrl) => {
      const tabs = await chrome.tabs.query({});
      const articleTab = tabs.find((tab) => tab.url === expectedUrl);
      if (typeof articleTab?.id !== "number") {
        throw new Error("Chrome did not expose the page-share article tab");
      }
      return articleTab.id;
    }, article.url());

    // Headless Chromium does not establish a last-focused window from
    // Playwright page focus alone, but popup.js intentionally queries one.
    await worker.evaluate(async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      if (typeof tab.windowId !== "number") {
        throw new Error("Chrome did not expose the page-share article window");
      }
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tabId, { active: true });
    }, articleTabId);
    await article.bringToFront();
    await expect
      .poll(
        async () =>
          await worker.evaluate(async (expectedTabId) => {
            const [activeTab] = await chrome.tabs.query({
              active: true,
              lastFocusedWindow: true,
            });
            return activeTab?.id === expectedTabId;
          }, articleTabId),
        { timeout: 10_000 },
      )
      .toBe(true);
    const prior = (await browserCdp.send("Target.getTargets", {
      filter: [{}],
    })) as { targetInfos: ChromeTarget[] };
    const articleTarget = prior.targetInfos.find(
      (target) => target.type === "tab" && target.url === article.url(),
    );
    if (!articleTarget) {
      throw new Error("Chromium did not expose the actual page-share article tab target");
    }
    const priorTargetIds = new Set(prior.targetInfos.map((target) => target.targetId));

    // CDP invokes the actual toolbar action, including Chrome's activeTab
    // consent grant; navigating popup.html directly cannot grant page access.
    await browserCdp.send("Extensions.triggerAction", {
      id: extensionId,
      targetId: articleTarget.targetId,
    });

    await expect
      .poll(
        async () => {
          const targets = (await browserCdp.send("Target.getTargets", {
            filter: [{}],
          })) as { targetInfos: ChromeTarget[] };
          return targets.targetInfos.find(
            (target) =>
              !priorTargetIds.has(target.targetId) &&
              target.url === `chrome-extension://${extensionId}/popup.html`,
          );
        },
        { timeout: 10_000 },
      )
      .toBeTruthy();

    const targets = (await browserCdp.send("Target.getTargets", {
      filter: [{}],
    })) as { targetInfos: ChromeTarget[] };
    const popupTarget = targets.targetInfos.find(
      (target) =>
        !priorTargetIds.has(target.targetId) &&
        target.url === `chrome-extension://${extensionId}/popup.html`,
    );
    if (!popupTarget) {
      throw new Error("Chromium did not open the actual OpenClaw toolbar popup");
    }
    const attached = (await browserCdp.send("Target.attachToTarget", {
      targetId: popupTarget.targetId,
      flatten: false,
    })) as { sessionId: string };
    await expect
      .poll(
        async () =>
          await evaluateToolbarPopup<string>(browserCdp, attached.sessionId, "document.readyState"),
        { timeout: 10_000 },
      )
      .toBe("complete");

    // Opening an action popup clears lastFocusedWindow in headless Chromium.
    // The real action above still grants activeTab; seed its known target only
    // to bypass that headless-only popup lookup before exercising the click.
    await evaluateToolbarPopup<void>(
      browserCdp,
      attached.sessionId,
      `(() => {
        const button = document.querySelector("#sendPageButton");
        button.dataset.tabId = ${JSON.stringify(String(articleTabId))};
        button.disabled = false;
        button.click();
      })()`,
    );

    await expect
      .poll(
        async () => ({
          receivedShares: receivedShares.length,
          popupStatus: await evaluateToolbarPopup<string>(
            browserCdp,
            attached.sessionId,
            'document.querySelector("#pageShareStatus")?.textContent',
          ),
        }),
        { timeout: 10_000 },
      )
      .toEqual({ receivedShares: 1, popupStatus: "Sending…" });
    expect(receivedShares[0]).toEqual({
      url: article.url(),
      content: "Page-share relay article body.",
    });

    if (unpair) {
      await evaluateToolbarPopup<void>(
        browserCdp,
        attached.sessionId,
        'document.querySelector("#unpairButton").click()',
      );
    } else {
      await closeRelay(relay);
    }

    await expect
      .poll(
        async () =>
          await evaluateToolbarPopup<string>(
            browserCdp,
            attached.sessionId,
            'document.querySelector("#pageShareStatus")?.textContent',
          ),
        { timeout: 1_500, interval: 25 },
      )
      .toBe("Browser relay disconnected before OpenClaw acknowledged the page share.");
    expect(
      await evaluateToolbarPopup<boolean>(
        browserCdp,
        attached.sessionId,
        'document.querySelector("#pageShareStatus")?.classList.contains("error")',
      ),
    ).toBe(true);
    releaseDelivery();
  });
});
