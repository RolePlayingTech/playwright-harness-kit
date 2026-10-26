import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const APP_HTML = readFileSync(resolve(here, '../app/index.html'), 'utf8');

export const ORIGIN = 'https://offline-ui-contract.invalid';

export interface MockApiState {
  forgotPasswordCalls: number;
  blockedRequests: string[];
  blockedWebSockets: string[];
  allowBlockedPatterns: RegExp[];
  bugMode: 'broken' | 'fixed';
}

/**
 * Isolated ui-contract fixture:
 * 1. Playwright config sets `serviceWorkers: 'block'` so Service Workers cannot bypass `context.route()`.
 *    Note: Browser-level routing (`context.route` and `context.routeWebSocket`) isolates the frontend UI under test;
 *    it never proves backend RBAC or OS-level egress isolation.
 * 2. Every HTTP request outside `https://offline-ui-contract.invalid` (or unmocked `/api/*` route) and every
 *    unmocked WebSocket connection is aborted/closed, recorded, and fails the test after `use(state)` unless
 *    explicitly registered in `allowBlockedPatterns` by a negative boundary test.
 */
export const test = base.extend<{ mockApi: MockApiState }>({
  mockApi: async ({ context, page }, use) => {
    const state: MockApiState = {
      forgotPasswordCalls: 0,
      blockedRequests: [],
      blockedWebSockets: [],
      allowBlockedPatterns: [],
      bugMode: process.env.UI_BUG_MODE === 'broken' ? 'broken' : 'fixed',
    };

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await context.routeWebSocket(/.*/, (ws) => {
      const wsUrl = typeof ws.url === 'function' ? ws.url() : String(ws);
      state.blockedWebSockets.push(wsUrl);
      ws.close({ code: 1008, reason: 'Blocked by ui-contract networkPolicy: deny-unhandled' });
    });

    await context.route('**/*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());

      if (url.origin !== ORIGIN || url.username || url.password) {
        state.blockedRequests.push(req.url());
        return route.abort('blockedbyclient');
      }

      if (url.pathname === '/api/auth/password/forgot' && req.method() === 'POST') {
        state.forgotPasswordCalls += 1;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'service_unavailable' }),
        });
      }

      if (url.pathname === '/' || url.pathname === '/forgot-password') {
        return route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: APP_HTML,
        });
      }

      state.blockedRequests.push(req.url());
      return route.abort('blockedbyclient');
    });

    await use(state);

    const unexpectedBlocked = state.blockedRequests.filter(
      (blockedUrl) => !state.allowBlockedPatterns.some((pattern) => pattern.test(blockedUrl))
    );
    const unexpectedWebSockets = state.blockedWebSockets.filter(
      (wsUrl) => !state.allowBlockedPatterns.some((pattern) => pattern.test(wsUrl))
    );
    expect(pageErrors, 'Uncaught pageerror exceptions must be 0').toEqual([]);
    expect(unexpectedBlocked, 'Unmocked or external HTTP requests must be 0').toEqual([]);
    expect(unexpectedWebSockets, 'Unmocked or external WebSocket connections must be 0').toEqual([]);
  },
});

export { expect };
