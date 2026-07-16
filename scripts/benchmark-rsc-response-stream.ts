#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { type Request, type Response, chromium } from 'playwright';
import {
  RSC_USER_INTENT_WINDOW_MS,
  matchesIntendedRoute,
  shouldStreamResponseBody,
} from '../src/imprint/response-body-stream.ts';

const DEFAULT_SITES = [
  'https://nextjs.org',
  'https://vercel.com',
  'https://react.dev',
  'https://ui.shadcn.com',
  'https://payloadcms.com',
  'https://clerk.com',
  'https://supabase.com',
  'https://resend.com',
  'https://raycast.com',
  'https://dub.co',
  'https://next-ts-template-fullstack.vercel.app/example',
  'https://search-nextjs13.vercel.app',
  'https://next-app-gamma-lovat.vercel.app/features/infinite-scrolling/with-server-action',
  'https://linear.app',
  'https://www.notion.so/product',
  'https://www.figma.com',
  'https://cal.com',
  'https://www.prisma.io',
  'https://sentry.io',
  'https://www.netlify.com',
  'https://www.hashicorp.com',
  'https://www.sanity.io',
  'https://tailwindcss.com',
  'https://turborepo.com',
  'https://orm.drizzle.team',
  'https://neon.com',
  'https://www.convex.dev',
  'https://uploadthing.com',
  'https://magicui.design',
  'https://motion.dev',
  'https://ai-sdk.dev',
  'https://cursor.com',
  'https://browserbase.com',
  'https://lucide.dev',
];

interface RscObservation {
  requestStartedAt: number;
  bodyBytes: number | null;
  bodyUnavailable: boolean;
  bodyErrorKind: 'cdp_no_data' | 'timeout' | 'other' | null;
  selected: boolean;
  passiveSelected: boolean;
  userFlow: boolean;
  intentDelayMs: number | null;
  isPrefetch: boolean;
  declaredContentLength: number | null;
  hasRscRequestSignal: boolean;
  requestHeaderReadError: boolean;
  responseHeaderReadError: boolean;
}

class BodyReadTimeoutError extends Error {}
class HeaderReadTimeoutError extends Error {}

async function readBodyWithTimeout(response: Response): Promise<Buffer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      response.body(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new BodyReadTimeoutError('response body timed out')),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readHeadersWithTimeout(
  read: () => Promise<Record<string, string>>,
): Promise<{ headers: Record<string, string>; error: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const headers = await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HeaderReadTimeoutError()), 2_000);
      }),
    ]);
    return { headers, error: false };
  } catch {
    return { headers: {}, error: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const args = process.argv.slice(2);
const outputFlagIndex = args.indexOf('--output');
const outputPath = outputFlagIndex >= 0 ? args[outputFlagIndex + 1] : undefined;
if (outputFlagIndex >= 0) {
  if (!outputPath) throw new Error('--output requires a path');
  args.splice(outputFlagIndex, 2);
}
const sites = args;
const corpus = sites.length > 0 ? sites : DEFAULT_SITES;
const browser = await chromium.launch({ headless: true });
const results = [];

for (const [siteIndex, site] of corpus.entries()) {
  console.error(`[${siteIndex + 1}/${corpus.length}] ${site}`);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'allow',
  });
  const page = await context.newPage();
  const requestStartedAt = new WeakMap<Request, number>();
  const observations: RscObservation[] = [];
  const responseWork = new Set<Promise<void>>();
  let intendedUrl: string | undefined;
  let intentAt: number | undefined;
  let interaction: { text: string; href: string } | null = null;
  let loadError: string | null = null;

  page.on('request', (request) => requestStartedAt.set(request, Date.now()));
  page.on('response', (response: Response) => {
    const work = (async () => {
      const request = response.request();
      const startedAt = requestStartedAt.get(request) ?? Date.now();
      const [requestHeaderRead, responseHeaderRead] = await Promise.all([
        readHeadersWithTimeout(() => request.allHeaders()),
        readHeadersWithTimeout(() => response.allHeaders()),
      ]);
      const requestHeaders = { ...request.headers(), ...requestHeaderRead.headers };
      const responseHeaders = { ...response.headers(), ...responseHeaderRead.headers };
      const mimeType = (responseHeaders['content-type'] ?? '').split(';', 1)[0]?.trim();
      if (
        request.method() !== 'GET' ||
        request.resourceType() !== 'fetch' ||
        response.status() < 200 ||
        response.status() >= 300 ||
        mimeType?.toLowerCase() !== 'text/x-component'
      ) {
        return;
      }

      let bodyBytes: number | null = null;
      let bodyUnavailable = false;
      let bodyErrorKind: RscObservation['bodyErrorKind'] = null;
      try {
        bodyBytes = (await readBodyWithTimeout(response)).byteLength;
      } catch (error) {
        bodyUnavailable = true;
        const message = String(error).toLowerCase();
        bodyErrorKind =
          error instanceof BodyReadTimeoutError
            ? 'timeout'
            : message.includes('no data found') ||
                message.includes('no resource with given identifier')
              ? 'cdp_no_data'
              : 'other';
      }
      const intentDelayMs =
        intentAt !== undefined && startedAt >= intentAt ? startedAt - intentAt : null;
      const recentUserIntent = intentDelayMs !== null && intentDelayMs <= RSC_USER_INTENT_WINDOW_MS;
      const userFlow = Boolean(
        intendedUrl &&
          intentAt !== undefined &&
          startedAt >= intentAt &&
          matchesIntendedRoute(request.url(), intendedUrl),
      );
      const declaredLength = Number(responseHeaders['content-length']);
      const normalizedRequestHeaders = Object.fromEntries(
        Object.entries(requestHeaders).map(([name, value]) => [name.toLowerCase(), value]),
      );
      const isPrefetch =
        normalizedRequestHeaders['next-router-prefetch']?.trim() === '1' ||
        Boolean(normalizedRequestHeaders['next-router-segment-prefetch']?.trim());
      const hasRscRequestSignal =
        normalizedRequestHeaders.rsc?.trim() === '1' ||
        normalizedRequestHeaders.accept?.toLowerCase().includes('text/x-component') === true ||
        Boolean(normalizedRequestHeaders['next-router-state-tree']?.trim()) ||
        new URL(request.url()).searchParams.has('_rsc');
      const candidate = {
        method: request.method(),
        resourceType: 'Fetch',
        status: response.status(),
        mimeType,
        contentLength:
          Number.isFinite(declaredLength) && declaredLength >= 0 ? declaredLength : undefined,
        url: request.url(),
        requestHeaders,
      };
      observations.push({
        requestStartedAt: startedAt,
        bodyBytes,
        bodyUnavailable,
        bodyErrorKind,
        userFlow,
        intentDelayMs,
        isPrefetch,
        declaredContentLength: Number.isFinite(declaredLength) ? declaredLength : null,
        hasRscRequestSignal,
        requestHeaderReadError: requestHeaderRead.error,
        responseHeaderReadError: responseHeaderRead.error,
        selected: shouldStreamResponseBody({
          ...candidate,
          recentUserIntent,
          intendedUrl,
        }),
        passiveSelected: shouldStreamResponseBody(candidate),
      });
    })();
    responseWork.add(work);
    void work.finally(() => responseWork.delete(work));
  });

  try {
    await page.goto(site, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2_500);
    const origin = new URL(page.url()).origin;
    const candidates = await page.locator('a[href]').evaluateAll(
      (links, currentOrigin) =>
        links
          .map((link, index) => {
            const url = new URL((link as HTMLAnchorElement).href, location.href);
            const text = (link.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
            const rect = link.getBoundingClientRect();
            return {
              index,
              href: url.href,
              origin: url.origin,
              text,
              visible: rect.width > 0 && rect.height > 0,
            };
          })
          .filter(
            (item) =>
              item.visible &&
              item.origin === currentOrigin &&
              item.href !== location.href &&
              !item.href.includes('#'),
          ),
      origin,
    );
    const target =
      candidates.find(
        (item) =>
          !/login|sign.?in|signup|register|contact|pricing|download/i.test(
            `${item.text} ${item.href}`,
          ),
      ) ?? candidates[0];
    if (target) {
      interaction = { text: target.text, href: target.href };
      intendedUrl = target.href;
      intentAt = Date.now();
      const link = page.locator('a[href]').nth(target.index);
      await link.hover({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(1_500);
      await link.click({ timeout: 8_000 });
      await page.waitForTimeout(3_000);
    }
  } catch (error) {
    loadError = String(error);
  }

  await Promise.allSettled([...responseWork]);
  const sumBytes = (rows: RscObservation[]): number =>
    rows.reduce((sum, row) => sum + (row.bodyBytes ?? 0), 0);
  const userFlow = observations.filter((row) => row.userFlow);
  const selected = observations.filter((row) => row.selected);
  const passiveSelected = observations.filter((row) => row.passiveSelected);
  const exclusionReason =
    observations.length === 0
      ? 'no_exact_mime_rsc'
      : userFlow.length === 0
        ? 'no_post_intent_same_route_rsc'
        : userFlow.every((row) => row.selected)
          ? 'eligible_covered'
          : 'eligible_uncovered';
  const siteResult = {
    site,
    finalUrl: page.url(),
    interaction,
    interactionError: loadError
      ? /locator\.click|click.*timeout|timeout.*click/i.test(loadError)
        ? 'click_timeout'
        : 'navigation_error'
      : null,
    rscResponses: observations.length,
    readableBytes: sumBytes(observations),
    bodyUnavailable: observations.filter((row) => row.bodyUnavailable).length,
    cdpNoData: observations.filter((row) => row.bodyErrorKind === 'cdp_no_data').length,
    bodyReadTimeouts: observations.filter((row) => row.bodyErrorKind === 'timeout').length,
    otherBodyErrors: observations.filter((row) => row.bodyErrorKind === 'other').length,
    requestHeaderReadErrors: observations.filter((row) => row.requestHeaderReadError).length,
    responseHeaderReadErrors: observations.filter((row) => row.responseHeaderReadError).length,
    prefetchResponses: observations.filter((row) => row.isPrefetch).length,
    prefetchReadableBytes: sumBytes(observations.filter((row) => row.isPrefetch)),
    userFlowResponses: userFlow.length,
    selectedUserFlowResponses: userFlow.filter((row) => row.selected).length,
    selectedResponses: selected.length,
    selectedReadableBytes: sumBytes(selected),
    selectedBodyUnavailable: selected.filter((row) => row.bodyUnavailable).length,
    passiveSelectedResponses: passiveSelected.length,
    passiveSelectedReadableBytes: sumBytes(passiveSelected),
    exclusionReason,
    unselectedUserFlow: userFlow
      .filter((row) => !row.selected)
      .map((row) => ({
        intentDelayMs: row.intentDelayMs,
        isPrefetch: row.isPrefetch,
        declaredContentLength: row.declaredContentLength,
        hasRscRequestSignal: row.hasRscRequestSignal,
      })),
  };
  results.push(siteResult);
  console.error(
    `  done: rsc=${siteResult.rscResponses} userFlow=${siteResult.userFlowResponses} selected=${siteResult.selectedUserFlowResponses} errors=${siteResult.bodyUnavailable}`,
  );
  await context.close();
}

const browserVersion = browser.version();
await browser.close();

const qualified = results.filter((row) => row.rscResponses > 0);
const eligible = results.filter((row) => row.userFlowResponses > 0);
const covered = eligible.filter((row) => row.selectedUserFlowResponses === row.userFlowResponses);
const playwrightPackage = (await Bun.file(
  new URL('../node_modules/playwright/package.json', import.meta.url),
).json()) as { version: string };
const gitHead = Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim();
const gitDirty = Bun.spawnSync(['git', 'status', '--porcelain']).stdout.length > 0;
const sha256 = async (url: URL): Promise<string> =>
  createHash('sha256')
    .update(Buffer.from(await Bun.file(url).arrayBuffer()))
    .digest('hex');
const interactionErrors = {
  clickTimeout: results
    .filter((row) => row.interactionError === 'click_timeout')
    .map((row) => row.site),
  navigationError: results
    .filter((row) => row.interactionError === 'navigation_error')
    .map((row) => row.site),
};
const artifact = {
  generatedAt: new Date().toISOString(),
  command: [
    'bun',
    'scripts/benchmark-rsc-response-stream.ts',
    ...(outputPath ? ['--output', outputPath] : []),
    ...sites,
  ].join(' '),
  scope: 'GET selection coverage for eligible post-intent, same-route public RSC flows',
  baseGitHead: gitHead,
  sourceState: gitDirty ? 'uncommitted worktree snapshot' : 'clean checkout',
  sourceSha256: {
    'scripts/benchmark-rsc-response-stream.ts': await sha256(new URL(import.meta.url)),
    'src/imprint/response-body-stream.ts': await sha256(
      new URL('../src/imprint/response-body-stream.ts', import.meta.url),
    ),
  },
  runtime: {
    bun: Bun.version,
    playwright: playwrightPackage.version,
    chromium: browserVersion,
  },
  counts: {
    attemptedSites: results.length,
    qualifiedRscSites: qualified.length,
    eligibleUserFlowSites: eligible.length,
    fullyCoveredUserFlowSites: covered.length,
    userFlowSiteCoverage: eligible.length === 0 ? null : covered.length / eligible.length,
  },
  totals: {
    rscResponses: qualified.reduce((sum, row) => sum + row.rscResponses, 0),
    readableBytes: qualified.reduce((sum, row) => sum + row.readableBytes, 0),
    bodyUnavailable: qualified.reduce((sum, row) => sum + row.bodyUnavailable, 0),
    cdpNoData: qualified.reduce((sum, row) => sum + row.cdpNoData, 0),
    bodyReadTimeouts: qualified.reduce((sum, row) => sum + row.bodyReadTimeouts, 0),
    otherBodyErrors: qualified.reduce((sum, row) => sum + row.otherBodyErrors, 0),
    requestHeaderReadErrors: qualified.reduce(
      (sum, row) => sum + row.requestHeaderReadErrors,
      0,
    ),
    responseHeaderReadErrors: qualified.reduce(
      (sum, row) => sum + row.responseHeaderReadErrors,
      0,
    ),
    prefetchResponses: qualified.reduce((sum, row) => sum + row.prefetchResponses, 0),
    prefetchReadableBytes: qualified.reduce((sum, row) => sum + row.prefetchReadableBytes, 0),
    userFlowResponses: eligible.reduce((sum, row) => sum + row.userFlowResponses, 0),
    selectedUserFlowResponses: eligible.reduce(
      (sum, row) => sum + row.selectedUserFlowResponses,
      0,
    ),
    selectedResponses: qualified.reduce((sum, row) => sum + row.selectedResponses, 0),
    selectedReadableBytes: qualified.reduce((sum, row) => sum + row.selectedReadableBytes, 0),
    selectedBodyUnavailable: qualified.reduce(
      (sum, row) => sum + row.selectedBodyUnavailable,
      0,
    ),
    passiveSelectedResponses: qualified.reduce(
      (sum, row) => sum + row.passiveSelectedResponses,
      0,
    ),
    passiveSelectedReadableBytes: qualified.reduce(
      (sum, row) => sum + row.passiveSelectedReadableBytes,
      0,
    ),
  },
  eligibleAndCovered: covered.map((row) => row.site),
  qualifiedButIneligible: qualified
    .filter((row) => row.userFlowResponses === 0)
    .map((row) => row.site),
  noExactMimeRsc: results.filter((row) => row.rscResponses === 0).map((row) => row.site),
  interactionErrors,
  cdpNoDataBySite: Object.fromEntries(
    results
      .filter((row) => row.cdpNoData > 0)
      .map((row) => [
        row.site,
        { total: row.cdpNoData, selected: row.selectedBodyUnavailable },
      ]),
  ),
  sites: results,
};
const json = `${JSON.stringify(artifact, null, 2)}\n`;
if (outputPath) {
  await Bun.write(outputPath, json);
  console.error(`wrote ${outputPath}`);
} else {
  console.log(json.trimEnd());
}
