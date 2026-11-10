import { join } from 'node:path';
import type { AuthBrowserObservation } from './auth-browser-discovery.ts';
import { writePrivateFile } from './private-file.ts';
import type { Session } from './types.ts';

/** A run-local working copy. Original demonstrations are never overwritten.
 * Live requests use the ordinary recording readers/tests and provenance fields. */
export class AuthDiscoveryEvidence {
  readonly session: Session;
  readonly sessionPath: string;
  private readonly identities = new Map<string, number>();
  private nextSeq: number;

  constructor(
    session: Session,
    private readonly toolDir: string,
  ) {
    this.session = structuredClone(session);
    this.nextSeq = Math.max(-1, ...session.requests.map((r) => r.seq)) + 1;
    this.sessionPath = join(toolDir, '.auth-evidence-session.json');
    this.save();
  }

  append(observation: AuthBrowserObservation): string {
    const observedAt = new Date().toISOString();
    const timestamp = Date.now() - Date.parse(this.session.startedAt);
    const index = observation.requests.map((request) => {
      const identity = `${observation.sourceId}:${request.seq}`;
      let seq = this.identities.get(identity);
      if (seq === undefined) {
        seq = this.nextSeq++;
        this.identities.set(identity, seq);
      }
      const prior = this.session.requests.findIndex((r) => r.seq === seq);
      const captured = {
        ...request,
        seq,
        timestamp: this.session.requests[prior]?.timestamp ?? timestamp,
      };
      if (prior < 0) this.session.requests.push(captured);
      else this.session.requests[prior] = captured;
      return {
        seq,
        method: captured.method,
        url: captured.url,
        status: captured.response?.status,
        hasResponseBody: captured.response?.body !== undefined,
      };
    });
    this.save();
    writePrivateFile(
      join(this.toolDir, '.auth-live-discovery.json'),
      JSON.stringify(
        {
          observedAt,
          identities: Object.fromEntries(this.identities),
          sessionPath: this.sessionPath,
          note: 'Appended live browser observations are separate demonstrations; replay must obtain fresh state.',
        },
        null,
        2,
      ),
    );
    return JSON.stringify({
      observedAt,
      page: observation.page,
      capturedRequests: index,
      captureErrors: observation.captureErrors.map((error) => ({
        ...error,
        seq: this.identities.get(`${observation.sourceId}:${error.seq}`),
      })),
      evidenceSessionPath: this.sessionPath,
      guidance:
        'Read captured requests/responses with the recording tools and cite their seq as recordingRequestSeq. IMPRINT_SESSION_PATH now includes this evidence. Discovery is not compiled replay verification.',
    });
  }

  private save(): void {
    writePrivateFile(this.sessionPath, JSON.stringify(this.session));
  }
}
