import { test, expect, ORIGIN } from './fixtures';

test.describe('Offline UI Contract Suite (M-AUTH-01 & M-UX-01)', () => {
  test('M-AUTH-01: password recovery HTTP 503 preserves typed email and makes zero background retries', async ({
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

  test('M-UX-01: mobile release drawer fits 390x844 viewport without horizontal overflow or off-screen controls', async ({
    page,
    mockApi,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${ORIGIN}/forgot-password?mode=${mockApi.bugMode}`);

    // 1. ARIA semantics: the dialog and button exist in the accessibility tree in BOTH broken and fixed modes.
    const dialog = page.getByRole('dialog', { name: 'Release schedule preview' });
    const closeBtn = page.getByRole('button', { name: 'Close drawer' });
    await expect(dialog).toBeVisible();
    await expect(closeBtn).toBeVisible();

    // 2. Programmatic DOM geometry invariants catch the 540px mobile overflow that ARIA-only checks miss.
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

  test('Default-deny ui-contract guard aborts unmocked external outbound requests', async ({ page, mockApi }) => {
    mockApi.allowBlockedPatterns.push(/^https:\/\/analytics\.example\.com\/ping$/);
    await page.goto(`${ORIGIN}/forgot-password?mode=fixed`);

    const failedAsExpected = await page.evaluate(async () => {
      try {
        await fetch('https://analytics.example.com/ping');
        return false;
      } catch {
        return true;
      }
    });

    expect(failedAsExpected).toBe(true);
    expect(mockApi.blockedRequests).toContain('https://analytics.example.com/ping');
  });
});
