import { test, expect, ORIGIN } from './fixtures';

test.describe('Offline UI Contract Suite (DEMO-AUTH-01 & DEMO-UX-01)', () => {
  test('DEMO-AUTH-01: password recovery HTTP 503 preserves typed email and makes zero background retries', async ({
    page,
    mockApi,
  }) => {
    await page.goto(`${ORIGIN}/forgot-password?mode=${mockApi.bugMode}`);

    const emailInput = page.getByLabel('Email');
    await emailInput.fill('qa-reset@example.invalid');
    await page.getByRole('button', { name: 'Send reset link' }).click();

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('HTTP 503');

    // In broken mode, the input was wiped to "" and a background retry fires after 50ms.
    await expect(emailInput, 'Typed email must remain in input after HTTP 503').toHaveValue(
      'qa-reset@example.invalid'
    );
    await page.waitForTimeout(120);
    expect(mockApi.forgotPasswordCalls, 'Must not auto-retry POST on HTTP 503').toBe(1);
  });

  test('DEMO-UX-01: mobile release drawer fits 390x844 viewport without horizontal overflow or off-screen controls', async ({
    page,
    mockApi,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${ORIGIN}/forgot-password?mode=${mockApi.bugMode}`);

    // 1. ARIA semantics: the dialog and button exist in the accessibility tree in BOTH broken and fixed modes.
    const dialog = page.getByRole('dialog', { name: 'Release schedule preview' });
    const closeBtn = page.getByRole('button', { name: 'Close drawer' });
    await expect(dialog).toBeVisible();
    await expect(closeBtn).toBeVisible();

    // 2. Targeted synthetic-data screenshot + structured review rubric (captured before geometry assertions
    //    so both broken and fixed runs emit inspectable visual artifacts without any live session secrets).
    //    Note: Screenshot review (by a human or optional VLM) is non-deterministic and complements—never
    //    replaces—the deterministic DOM geometry assertions in step 3.
    const screenshotPath = testInfo.outputPath(`demo-ux-01-mobile-390x844-${mockApi.bugMode}.png`);
    const screenshotBytes = await page.screenshot({ path: screenshotPath, fullPage: true });
    expect(screenshotBytes.byteLength, 'Captured mobile screenshot must not be empty').toBeGreaterThan(0);
    await testInfo.attach(`demo-ux-01-mobile-390x844-${mockApi.bugMode}`, {
      body: screenshotBytes,
      contentType: 'image/png',
    });
    await testInfo.attach('demo-ux-01-visual-rubric', {
      body: JSON.stringify(
        {
          scenarioId: 'DEMO-UX-01',
          viewport: '390x844',
          mode: mockApi.bugMode,
          screenshotPath,
          nonDeterministicNote:
            'Visual screenshot review complements deterministic DOM geometry assertions; it never replaces scrollWidth/boundingBox checks.',
          rubric: [
            'Truncation: Heading and schedule row text remain uncut with no unplanned ellipsis',
            'Occlusion: Close drawer button and status badge are not overlapped or clipped by adjacent elements',
            'Alignment: Drawer header controls and schedule row align cleanly within the 390px card padding',
            'Contrast: Alert banner (#991b1b on #fef2f2) and primary action button (#ffffff on #0f172a) remain legible',
          ],
        },
        null,
        2
      ),
      contentType: 'application/json',
    });

    // 3. Programmatic DOM geometry invariants catch the 540px mobile overflow that ARIA-only checks miss.
    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(
      dimensions.scrollWidth,
      `Document scrollWidth (${dimensions.scrollWidth}px) must not exceed mobile innerWidth (${dimensions.innerWidth}px)`
    ).toBeLessThanOrEqual(dimensions.innerWidth);

    const closeBox = await closeBtn.boundingBox();
    expect(closeBox).not.toBeNull();
    expect(
      closeBox!.x + closeBox!.width,
      'Dialog close button right edge must sit inside the 390px viewport'
    ).toBeLessThanOrEqual(390);
  });

  test('Default-deny ui-contract guard aborts unmocked external HTTP and WebSocket connections', async ({
    page,
    mockApi,
  }) => {
    await page.goto(`${ORIGIN}/forgot-password?mode=fixed`);

    const httpRejected = await page.evaluate(async () => {
      try {
        await fetch('https://analytics.example.com/ping');
        return false;
      } catch {
        return true;
      }
    });
    expect(httpRejected).toBe(true);
    expect(mockApi.blockedRequests).toEqual(['https://analytics.example.com/ping']);

    const wsClosed = await page.evaluate(
      () =>
        new Promise<boolean>((resolvePromise) => {
          const ws = new WebSocket('wss://realtime.example.com/socket');
          ws.addEventListener('close', () => resolvePromise(true), { once: true });
          ws.addEventListener('error', () => resolvePromise(true), { once: true });
          ws.addEventListener('open', () => resolvePromise(false), { once: true });
        })
    );
    expect(wsClosed).toBe(true);
    expect(mockApi.blockedWebSockets).toEqual(['wss://realtime.example.com/socket']);

    // Acknowledge both expected blocks so the fixture's post-test fail-closed assertion passes:
    mockApi.allowBlockedPatterns.push(
      /^https:\/\/analytics\.example\.com\/ping$/,
      /^wss:\/\/realtime\.example\.com\/socket$/
    );
  });
});
