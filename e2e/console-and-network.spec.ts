// AC 1: each static info page loads with zero console errors and zero
// failed/4xx/5xx network responses.
import { test, expect } from "@playwright/test";
import { STATIC_PAGES } from "./support/pages";

for (const { path, metadataTitle } of STATIC_PAGES) {
  test(`loads ${path} with no console errors and no failed or 4xx/5xx responses`, async ({ page }) => {
    const consoleErrors: string[] = [];
    const badResponses: string[] = [];
    const requestFailures: string[] = [];

    // Listeners are attached before `page.goto` below — attaching them after
    // navigation would miss whatever the initial document request, early
    // hydration, or font loading emit before the test gets a chance to set
    // them up.
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => {
      consoleErrors.push(String(error));
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        badResponses.push(`${response.status()} ${response.url()}`);
      }
    });
    page.on("requestfailed", (request) => {
      // `requestfailed` also fires for requests the browser cancels on
      // purpose — e.g. a `net::ERR_ABORTED` on a prefetch or a preload that
      // loses a race with paint/navigation. That is not "the page is
      // broken", so only a failure with some other error text (DNS,
      // connection refused, timed out, etc.) counts as a genuine failure
      // here.
      const failure = request.failure();
      if (failure && failure.errorText !== "net::ERR_ABORTED") {
        requestFailures.push(`${request.url()} (${failure.errorText})`);
      }
    });

    // `waitUntil: "networkidle"` is deliberately not used here: it waits for
    // 500ms of no network activity, which never resolves if anything keeps
    // retrying in the background (e.g. a broken page's nav-link prefetch
    // retrying indefinitely) — turning a clean assertion failure into an
    // opaque timeout instead. `toHaveTitle` below is the deterministic wait
    // this test actually needs: it polls until the real condition (the
    // right page loaded) is true or the test's own timeout reports a clear
    // failure.
    const response = await page.goto(path);

    expect(response?.ok(), `navigation to ${path} did not return a 2xx response`).toBe(true);
    await expect(page).toHaveTitle(metadataTitle);

    expect(consoleErrors, `console error(s) on ${path}:\n${consoleErrors.join("\n")}`).toEqual([]);
    expect(badResponses, `failed/4xx/5xx response(s) on ${path}:\n${badResponses.join("\n")}`).toEqual([]);
    expect(requestFailures, `request failure(s) on ${path}:\n${requestFailures.join("\n")}`).toEqual([]);
  });
}
