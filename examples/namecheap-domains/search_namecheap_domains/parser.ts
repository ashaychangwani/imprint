/**
 * Parser for the Namecheap domain-search workflow.
 *
 * Input (context.responses):
 *   [0] tlds.ashx               → TLD catalog with category & pricing metadata
 *   [1] /api/search/{sld}       → exact_match + first 5 picks + 25 ranks
 *   [2] /api/picks/{sld}        → expanded picks with aftermarket pricing
 *   [3] /readBySld              → marketplace listings (Items[]) from Spaceship
 *   [4] /v1/domainStatus        → availability + whois for all suggested domains
 *
 * Returns a clean object that merges all four sources into agent-usable shape.
 * If `params.category` is provided, picks/ranks are filtered to TLDs that
 * carry that CategoryName in the TLD catalog.
 */

interface TldCategory {
  CategoryName: string;
  SeqNoOfProduct?: number;
}

interface TldPricing {
  Price?: number;
  Regular?: number;
  Renewal?: number;
  Hint?: string;
  Duration?: number;
  DurationType?: string;
}

interface TldEntry {
  Name: string;
  Type?: string;
  Categories?: TldCategory[] | null;
  Pricing?: TldPricing;
  TldsState?: string;
  WhoisguardCompatibile?: boolean;
}

interface SearchAftermarket {
  domain?: string;
  fast_transfer?: boolean;
  price?: number;
  status?: string;
  type?: string;
  username?: string;
}

interface SearchStatus {
  available?: boolean;
  lookupType?: string;
  name?: string;
  premium?: boolean;
  reason?: string;
  whois?: { createdYear?: number };
}

interface SearchPick {
  domain: string;
  tld: string;
  type?: string;
  priority?: number;
  info?: string;
  enable_cart_verification?: boolean;
  aftermarket?: SearchAftermarket;
  status?: SearchStatus;
}

interface SearchResponse {
  exact_match?: {
    domain?: string;
    tld?: string;
    is_supported?: boolean;
    enable_cart_verification?: boolean;
    campaignType?: string | null;
    status?: SearchStatus;
  };
  picks?: SearchPick[];
  ranks?: Array<{ domain: string; tld: string; enable_cart_verification?: boolean }>;
  hasNextPage?: boolean;
  type?: string;
}

interface PicksResponse {
  type?: string;
  picks?: SearchPick[];
}

interface MarketplaceMoney {
  OriginalAmount?: number;
  Amount?: number;
  Currency?: string;
}

interface MarketplaceSource {
  EntryPoints?: Record<string, string | null>;
  DomainDisplayName?: string;
  LogoUrl?: string | null;
  BuyItNow?: MarketplaceMoney | null;
  MinOffer?: MarketplaceMoney | null;
  LeaseToOwn?: {
    DownPayment?: MarketplaceMoney | null;
    InstallmentPayment?: { Amount?: MarketplaceMoney; Cycles?: number } | null;
    FinalPayment?: MarketplaceMoney | null;
    Total?: MarketplaceMoney | null;
  } | null;
  Description?: string | null;
  Keywords?: string[] | null;
}

interface MarketplaceItem {
  DomainName: string;
  DomainDisplayName?: string;
  Tld?: string;
  Sld?: string;
  DomainHasSalePageEnabled?: boolean;
  ResponseStatus?: string;
  EntryPoints?: Record<string, string | null>;
  Source?: { brandStore?: MarketplaceSource | null; sellerHub?: MarketplaceSource | null };
}

interface MarketplaceResponse {
  Items?: MarketplaceItem[];
  TotalCount?: number;
}

function buildTldIndex(tlds: TldEntry[]): Map<string, TldEntry> {
  const map = new Map<string, TldEntry>();
  for (const t of tlds) {
    if (t && typeof t.Name === 'string') map.set(t.Name.toLowerCase(), t);
  }
  return map;
}

function enrichDomain(
  pick: SearchPick | { domain: string; tld: string; enable_cart_verification?: boolean },
  tldIndex: Map<string, TldEntry>,
  statusByDomain: Map<string, { available: boolean; reason?: string; createdYear?: number; registrar?: string }>,
) {
  const tldKey = (pick.tld || '').toLowerCase();
  const tldMeta = tldIndex.get(tldKey);
  const aftermarket = (pick as SearchPick).aftermarket;
  const aftermarketActive = !!(aftermarket && aftermarket.status && aftermarket.domain);
  const domainStatus = statusByDomain.get((pick.domain || '').toLowerCase());

  const available = domainStatus?.available ?? null;
  const isPremium = aftermarketActive && (aftermarket?.price ?? 0) > 0;

  return {
    domain: pick.domain,
    tld: pick.tld,
    available,
    is_premium: isPremium,
    registered_year: domainStatus?.createdYear ?? null,
    registrar: domainStatus?.registrar ?? null,
    status_reason: domainStatus?.reason ?? null,
    aftermarket: aftermarketActive
      ? {
          domain: aftermarket?.domain,
          price: aftermarket?.price,
          status: aftermarket?.status,
          type: aftermarket?.type,
          fast_transfer: aftermarket?.fast_transfer,
        }
      : null,
    registration_price: available !== false && tldMeta?.Pricing
      ? {
          price: tldMeta.Pricing.Price ?? null,
          regular: tldMeta.Pricing.Regular ?? null,
          renewal: tldMeta.Pricing.Renewal ?? null,
          hint: tldMeta.Pricing.Hint ?? null,
        }
      : null,
    categories: (tldMeta?.Categories ?? []).map((c) => c.CategoryName),
  };
}

function pickHasCategory(tld: string, category: string, tldIndex: Map<string, TldEntry>): boolean {
  const meta = tldIndex.get(tld.toLowerCase());
  if (!meta || !Array.isArray(meta.Categories)) return false;
  const target = category.toLowerCase();
  return meta.Categories.some((c) => (c.CategoryName || '').toLowerCase() === target);
}

function dedupeByDomain<T extends { domain: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = (item.domain || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function mergePicks(
  searchPicks: SearchPick[],
  picksDetail: SearchPick[],
): SearchPick[] {
  // Index detail picks by domain so we can prefer the richer record.
  const detailIndex = new Map<string, SearchPick>();
  for (const p of picksDetail) {
    if (p && p.type === 'domain' && p.domain) detailIndex.set(p.domain.toLowerCase(), p);
  }
  const merged: SearchPick[] = [];
  const seen = new Set<string>();
  for (const p of searchPicks) {
    if (!p || !p.domain) continue;
    const key = p.domain.toLowerCase();
    seen.add(key);
    const detail = detailIndex.get(key);
    merged.push(detail ? { ...p, ...detail } : p);
  }
  // Add any picksDetail entries not already represented (e.g. from /api/picks).
  for (const [key, p] of detailIndex.entries()) {
    if (!seen.has(key)) merged.push(p);
  }
  return merged;
}

function summariseMarketplace(item: MarketplaceItem) {
  const sources: Array<{
    name: string;
    entry_points: Record<string, string | null>;
    buy_it_now: number | null;
    min_offer: number | null;
    currency: string | null;
    description: string | null;
    keywords: string[] | null;
    lease_to_own: {
      down_payment: number | null;
      installment: { amount: number | null; cycles: number | null } | null;
      total: number | null;
    } | null;
  }> = [];
  const src = item.Source ?? {};
  for (const [name, info] of Object.entries(src)) {
    if (!info) continue;
    const lto = info.LeaseToOwn ?? null;
    sources.push({
      name,
      entry_points: info.EntryPoints ?? {},
      buy_it_now: info.BuyItNow?.Amount ?? null,
      min_offer: info.MinOffer?.Amount ?? null,
      currency:
        info.BuyItNow?.Currency ??
        info.MinOffer?.Currency ??
        info.LeaseToOwn?.Total?.Currency ??
        null,
      description: info.Description ?? null,
      keywords: info.Keywords ?? null,
      lease_to_own: lto
        ? {
            down_payment: lto.DownPayment?.Amount ?? null,
            installment: lto.InstallmentPayment
              ? {
                  amount: lto.InstallmentPayment.Amount?.Amount ?? null,
                  cycles: lto.InstallmentPayment.Cycles ?? null,
                }
              : null,
            total: lto.Total?.Amount ?? null,
          }
        : null,
    });
  }
  return {
    domain: item.DomainName,
    tld: item.Tld,
    sld: item.Sld,
    sale_page_enabled: !!item.DomainHasSalePageEnabled,
    entry_points: item.EntryPoints ?? {},
    sources,
  };
}

export function extract(
  rawResponse: unknown,
  context?: {
    params: Record<string, string | number | boolean>;
    responses: unknown[];
  },
): unknown {
  const responses = context?.responses ?? [rawResponse];
  const params = context?.params ?? {};
  const query = String(params.query ?? '').trim();
  const category = String(params.category ?? '').trim().toLowerCase();

  const tldsRaw = responses[0];
  const searchRaw = responses[1] as SearchResponse | undefined;
  const picksRaw = responses[2] as PicksResponse | undefined;
  const marketplaceRaw = responses[3] as MarketplaceResponse | undefined;
  const domainStatusRaw = responses[4] as {
    status?: Array<{
      name: string;
      available: boolean;
      lookupType?: string;
      reason?: string;
      whois?: { createdYear?: number };
      extra?: { createdYear?: number; registrar?: string; extensionsTaken?: number; ns?: string[] };
    }>;
  } | undefined;

  const statusByDomain = new Map<string, { available: boolean; reason?: string; createdYear?: number; registrar?: string }>();
  for (const s of domainStatusRaw?.status ?? []) {
    statusByDomain.set(s.name.toLowerCase(), {
      available: s.available,
      reason: s.reason,
      createdYear: s.whois?.createdYear ?? s.extra?.createdYear,
      registrar: s.extra?.registrar,
    });
  }

  const tldList: TldEntry[] = Array.isArray(tldsRaw) ? (tldsRaw as TldEntry[]) : [];
  const tldIndex = buildTldIndex(tldList);

  const exactMatchRaw = searchRaw?.exact_match ?? null;
  const exactMatch = exactMatchRaw
    ? (() => {
        const ds = statusByDomain.get((exactMatchRaw.domain || '').toLowerCase());
        const meta = tldIndex.get((exactMatchRaw.tld || '').toLowerCase());
        return {
          domain: exactMatchRaw.domain,
          tld: exactMatchRaw.tld,
          available: ds?.available ?? null,
          registered_year: ds?.createdYear ?? null,
          registrar: ds?.registrar ?? null,
          status_reason: ds?.reason ?? null,
          registration_price: ds?.available !== false && meta?.Pricing
            ? {
                price: meta.Pricing.Price ?? null,
                regular: meta.Pricing.Regular ?? null,
                renewal: meta.Pricing.Renewal ?? null,
                hint: meta.Pricing.Hint ?? null,
              }
            : null,
        };
      })()
    : null;

  const detailPicks = (picksRaw?.picks ?? []).filter(
    (p) => p && (p.type === 'domain' || !p.type) && p.domain,
  );
  const searchPicks = (searchRaw?.picks ?? []).filter((p) => p && p.domain);
  const merged = mergePicks(searchPicks, detailPicks);
  let picks = merged.map((p) => enrichDomain(p, tldIndex, statusByDomain));

  let ranks = (searchRaw?.ranks ?? []).map((r) => enrichDomain(r, tldIndex, statusByDomain));

  if (category) {
    picks = picks.filter((p) => pickHasCategory(p.tld, category, tldIndex));
    ranks = ranks.filter((r) => pickHasCategory(r.tld, category, tldIndex));
  }

  picks = dedupeByDomain(picks);
  ranks = dedupeByDomain(ranks);

  const marketplace = (marketplaceRaw?.Items ?? []).map(summariseMarketplace);

  // Compose a flat list of TLDs that match the requested category, useful when
  // the agent wants to know what other TLDs are filed under a filter button.
  const categoryTlds: string[] = category
    ? tldList
        .filter((t) =>
          (t.Categories ?? []).some((c) => (c.CategoryName || '').toLowerCase() === category),
        )
        .map((t) => t.Name)
    : [];

  return {
    query,
    category: category || null,
    exact_match: exactMatch,
    picks,
    ranks,
    marketplace,
    marketplace_count: marketplaceRaw?.TotalCount ?? marketplace.length,
    category_tlds: categoryTlds,
    tld_catalog_count: tldList.length,
  };
}
