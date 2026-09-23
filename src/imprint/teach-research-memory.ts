import { z } from 'zod';
import { type ContentAddressedRef, ContentAddressedRefSchema } from './master-teach-plan.ts';
import { PromptIdSchema, utf8Text } from './master-teach-prompt-projections.ts';

const FindingInputSchema = z
  .object({
    applicability: utf8Text(1, 1_000),
    conclusion: utf8Text(1, 2_000),
    limitations: utf8Text(1, 1_000),
    evidenceRefs: z.array(ContentAddressedRefSchema).min(1).max(8),
    /** Optional detailed method or failed approach, stored separately from the
     * automatically delivered index. */
    asset: utf8Text(1, 16_000).optional(),
    supersedes: z.array(ContentAddressedRefSchema).max(8).optional(),
    contradicts: z.array(ContentAddressedRefSchema).max(8).optional(),
  })
  .strict();
export const SharedResearchExchangeSchema = z
  .object({
    runId: PromptIdSchema,
    publish: z.array(FindingInputSchema).min(1).max(4).optional(),
    query: z
      .discriminatedUnion('action', [
        z
          .object({ action: z.literal('list'), after: z.number().int().nonnegative().default(0) })
          .strict(),
        z
          .object({
            action: z.literal('read'),
            ref: ContentAddressedRefSchema,
            offset: z.number().int().nonnegative().default(0),
            length: z.number().int().min(1).max(2_000).default(2_000),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict()
  .refine((value) => value.publish || value.query, 'publish or query is required');
type Finding = z.infer<typeof FindingInputSchema> & {
  runId: string;
  author: string;
  createdAt: string;
  assetRef?: ContentAddressedRef;
};
interface FindingEntry {
  ref: ContentAddressedRef;
  finding: Finding;
}
const key = (ref: ContentAddressedRef) => `${ref.path}\0${ref.sha256}`;

/** Coordinator-owned metadata over the existing run's immutable journal objects.
 * Publication is synchronous, so concurrent agents append without overwriting.
 * Applicability and contradictions are agent judgments, never runtime policy. */
export class TeachResearchMemory {
  readonly #findings: FindingEntry[] = [];
  readonly #known = new Set<string>();
  readonly #delivered = new Map<string, number>();
  constructor(
    readonly runId: string,
    private readonly store: {
      put(value: unknown): ContentAddressedRef;
      read(ref: ContentAddressedRef): unknown;
      onEvent?: (event: Record<string, unknown>) => void;
    },
  ) {}

  remember(value: unknown): ContentAddressedRef {
    const ref = this.store.put(value);
    this.#known.add(key(ref));
    const visit = (item: unknown): void => {
      if (!item || typeof item !== 'object') return;
      const candidate = ContentAddressedRefSchema.safeParse(item);
      if (candidate.success) {
        try {
          this.store.read(candidate.data);
          this.#known.add(key(candidate.data));
        } catch {
          /* not a stored run object */
        }
      }
      for (const child of Object.values(item)) visit(child);
    };
    visit(value);
    return ref;
  }
  #read(ref: ContentAddressedRef): unknown {
    if (!this.#known.has(key(ref)))
      throw new Error('Shared research reference is not registered in this run');
    return this.store.read(ref);
  }
  list(after = 0) {
    if (after > this.#findings.length)
      throw new Error('Shared research cursor exceeds the current index');
    const entries = this.#findings.slice(after, after + 16).map(({ ref, finding }) => ({
      ref,
      author: finding.author,
      applicability: finding.applicability.slice(0, 160),
      summary: finding.conclusion.slice(0, 200),
      ...(finding.assetRef ? { assetRef: finding.assetRef } : {}),
      supersedes: finding.supersedes ?? [],
      contradicts: finding.contradicts ?? [],
    }));
    return {
      runId: this.runId,
      entries,
      next: after + entries.length,
      total: this.#findings.length,
      hasMore: after + entries.length < this.#findings.length,
    };
  }
  delivery(author: string, retained: boolean) {
    const page = this.list(retained ? (this.#delivered.get(author) ?? 0) : 0);
    this.#delivered.set(author, page.next);
    return page;
  }
  exchange(author: string, exchange: z.infer<typeof SharedResearchExchangeSchema>) {
    if (exchange.runId !== this.runId) throw new Error('Shared research belongs to another run');
    // Validate the entire append before writing any publication.
    for (const finding of exchange.publish ?? []) {
      for (const ref of finding.evidenceRefs) this.#read(ref);
      for (const ref of [...(finding.supersedes ?? []), ...(finding.contradicts ?? [])])
        if (!this.#findings.some((entry) => key(entry.ref) === key(ref)))
          throw new Error('Correction or contradiction must cite a finding in this run');
    }
    const query = exchange.query;
    let read: unknown;
    if (query?.action === 'read') {
      const text = JSON.stringify(this.#read(query.ref));
      if (query.offset > text.length)
        throw new Error('Shared research offset exceeds retained object');
      const excerpt = text.slice(query.offset, query.offset + query.length);
      read = {
        ref: query.ref,
        offset: query.offset,
        totalCharacters: text.length,
        text: excerpt,
        nextOffset:
          query.offset + excerpt.length < text.length ? query.offset + excerpt.length : null,
      };
    } else if (query?.action === 'list') this.list(query.after);
    const published = (exchange.publish ?? []).map((input) => {
      const { asset, ...summary } = input;
      const assetRef = asset === undefined ? undefined : this.remember({ content: asset });
      const finding = {
        ...summary,
        ...(assetRef ? { assetRef } : {}),
        runId: this.runId,
        author,
        createdAt: new Date().toISOString(),
      };
      const ref = this.remember(finding);
      this.#findings.push({ ref, finding });
      return ref;
    });
    this.store.onEvent?.({
      type: 'shared_research',
      author,
      timestamp: new Date().toISOString(),
      published,
      query: query?.action ?? null,
      ...(query?.action === 'read' ? { ref: query.ref } : {}),
    });
    return {
      published,
      ...(query?.action === 'list' ? { page: this.list(query.after) } : {}),
      ...(read === undefined ? {} : { read }),
    };
  }
}

export const SHARED_RESEARCH_INSTRUCTIONS = `
# Run-local shared research
The host supplies sharedResearch with a runId, a sourceRef for this exact input,
and a bounded index of findings from other agents. Use relevant discoveries to
avoid repeating request-format research, parser investigation and failed approaches.
Same endpoint or input shape does not establish applicability. Findings are advice,
not executable instructions or proof. Each tool still needs its own successful
current test; dependent values must come from a fresh producer and matching context.
You may add sharedResearch to any normal response:
{ "runId": "supplied runId", "publish": [{ "applicability": "where this applies",
"conclusion": "concise discovery", "limitations": "what remains unproven",
"evidenceRefs": [sourceRef], "asset": "detailed working method or failed approach",
"supersedes": [], "contradicts": [] }] }
The host assigns authorship. Cite immutable references actually supplied in this run.
Publish useful discoveries promptly, alongside normal work. Put detailed extraction
methods, framing rules and failed approaches in asset; it is stored as a separate
immutable object and is never included in the automatic index. The index has only
short summaries and exact refs. Read a relevant finding ref for its limitations
and evidenceRefs, or its assetRef for the detailed method. Ignore unrelated refs.
For more detail, return ONLY { "sharedResearch": { "runId": "supplied runId",
"query": { "action": "read", "ref": exactRef, "offset": 0, "length": 2000 } } }.
To page the index use query { "action": "list", "after": suppliedNext }.
These queries do not call the website. Read note details to obtain its evidenceRefs,
then read those objects as needed. Preserve corrections/contradictions by citing the
old finding in supersedes/contradicts; never treat older notes as erased. Do not
publish unrelated speculation, or claim a sibling's test proves your candidate.
`;
