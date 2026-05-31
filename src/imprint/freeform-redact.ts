import { Policies, type PolicyName, createRedactum } from 'redactum';

const FREEFORM_POLICIES: PolicyName[] = [
  Policies.EMAIL_ADDRESS,
  Policies.PHONE_NUMBER_US,
  Policies.PHONE_NUMBER_INTERNATIONAL,
  Policies.PHONE_NUMBER_UK,
  Policies.PHONE_NUMBER_CANADIAN,
  Policies.SSN,
  Policies.CREDIT_CARD,
  Policies.CREDIT_CARD_WITH_SEPARATORS,
  Policies.CREDIT_CARD_CVV,
  Policies.URL_WITH_CREDENTIALS,
  Policies.JWT_TOKEN,
  Policies.BASIC_AUTH_HEADER,
  Policies.BEARER_TOKEN_HEADER,
  Policies.API_KEY_HEADER,
  Policies.SESSION_ID_COOKIE,
  Policies.API_KEY_GENERIC,
  Policies.OPENAI_API_KEY,
  Policies.ANTHROPIC_API_KEY,
  Policies.GOOGLE_API_KEY,
  Policies.GCP_API_KEY,
  Policies.GITHUB_TOKEN,
  Policies.GITHUB_FINE_GRAINED_TOKEN,
  Policies.GITLAB_TOKEN,
  Policies.BITBUCKET_TOKEN,
  Policies.AWS_ACCESS_KEY,
  Policies.AWS_SECRET_KEY,
  Policies.AWS_SESSION_TOKEN,
  Policies.AZURE_STORAGE_CONNECTION_STRING,
  Policies.DIGITALOCEAN_TOKEN,
  Policies.HEROKU_API_KEY,
  Policies.RAILWAY_TOKEN,
  Policies.CLOUDFLARE_API_TOKEN,
  Policies.DOCKER_HUB_TOKEN,
  Policies.DOCKER_REGISTRY_TOKEN,
  Policies.NPM_TOKEN,
  Policies.PYPI_TOKEN,
  Policies.RUBYGEMS_API_KEY,
  Policies.QUAY_IO_TOKEN,
  Policies.JFROG_ARTIFACTORY_TOKEN,
  Policies.NEXUS_REPOSITORY_TOKEN,
  Policies.SLACK_WEBHOOK,
  Policies.DISCORD_WEBHOOK,
  Policies.WEBHOOK_URL,
  Policies.SLACK_TOKEN,
  Policies.DISCORD_TOKEN,
  Policies.TWILIO_AUTH_TOKEN,
  Policies.TWILIO_API_KEY,
  Policies.SENDGRID_API_KEY,
  Policies.STRIPE_KEY,
  Policies.MAILGUN_API_KEY,
  Policies.MAILCHIMP_API_KEY,
  Policies.MONGODB_CONNECTION_STRING,
  Policies.POSTGRESQL_CONNECTION_STRING,
  Policies.MYSQL_CONNECTION_STRING,
  Policies.REDIS_CONNECTION_STRING,
  Policies.ELASTICSEARCH_URL,
  Policies.RABBITMQ_CONNECTION_STRING,
  Policies.KAFKA_CONNECTION_STRING,
  Policies.CASSANDRA_CONNECTION_STRING,
  Policies.DATABASE_CONNECTION_STRING,
  Policies.DATABASE_URL,
  Policies.LDAP_CONNECTION_STRING,
  Policies.JDBC_CONNECTION_STRING,
  Policies.SMTP_CONNECTION_STRING,
  Policies.SSH_PRIVATE_KEY,
  Policies.RSA_PRIVATE_KEY,
  Policies.EC_PRIVATE_KEY,
  Policies.OPENSSH_PRIVATE_KEY,
  Policies.GENERIC_PRIVATE_KEY,
  Policies.PGP_PRIVATE_KEY,
  Policies.PASSWORD_ASSIGNMENT,
  Policies.ENVIRONMENT_VARIABLE_SECRET,
  // NOTE: the GENERIC_* catch-alls (GENERIC_PASSWORD/TOKEN/CREDENTIAL/SECRET) are
  // intentionally omitted — they match on value shape alone and fire on benign
  // data (e.g. `id=1234567890`), corrupting/over-redacting structured payloads.
  // Real secrets are still covered by the keyword-anchored and specific policies
  // above and below (PASSWORD_ASSIGNMENT, OAUTH_*, private keys, cloud tokens, PII).
  Policies.OAUTH_CLIENT_SECRET,
  Policies.OAUTH_REFRESH_TOKEN,
  Policies.OAUTH_ACCESS_TOKEN,
  Policies.OKTA_API_TOKEN,
  Policies.AUTH0_API_TOKEN,
  Policies.KEYCLOAK_CLIENT_SECRET,
  Policies.JENKINS_TOKEN,
  Policies.CIRCLECI_TOKEN,
  Policies.TRAVIS_CI_TOKEN,
  Policies.GITLAB_CI_TOKEN,
  Policies.AZURE_DEVOPS_TOKEN,
  Policies.BITBUCKET_TOKEN_ALT,
  Policies.SENTRY_DSN,
  Policies.NEW_RELIC_LICENSE_KEY,
  Policies.DATADOG_API_KEY,
  Policies.PAGERDUTY_INTEGRATION_KEY,
  Policies.GRAFANA_API_KEY,
  Policies.SPLUNK_HEC_TOKEN,
  Policies.BUGSNAG_API_KEY,
  Policies.ROLLBAR_ACCESS_TOKEN,
  Policies.AIRBRAKE_API_KEY,
  Policies.LOGDNA_INGESTION_KEY,
  Policies.LOGGLY_TOKEN,
  Policies.PAPERTRAIL_TOKEN,
  Policies.TERRAFORM_CLOUD_TOKEN,
  Policies.HASHICORP_VAULT_TOKEN,
  Policies.AWS_SECRETS_MANAGER_ARN,
  Policies.AZURE_KEY_VAULT_SECRET,
  Policies.GCP_SECRET_MANAGER,
  Policies.CONSUL_TOKEN,
  Policies.RANCHER_TOKEN,
  Policies.AGE_SECRET_KEY,
  Policies.MASTER_KEY,
];

const REDACTION_HINT_RE =
  /@|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.|\b\d{3}[-.\s]\d{2}[-.\s]\d{4}\b|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|\b\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}\b|api[_-]?key|auth|bearer|card|cookie|credential|key|password|postgres|mysql|mongodb|redis|secret|session|sk-|token|-----BEGIN/i;

const PROTECTED_PATTERNS = [
  /\[REDACTED:\d+\]/g,
  /\$\{credential\.[A-Za-z0-9_.-]+\}/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
  /\b[0-9a-f]{40}\b/gi,
];

const REDACTOR = createRedactum({
  policies: FREEFORM_POLICIES,
  replacement: () => '[REDACTED]',
});
const CACHE_MAX = 512;
const cache = new Map<string, FreeformRedaction>();

interface FreeformRedaction {
  redacted: string;
  redactionsCount: number;
}

interface Range {
  start: number;
  end: number;
}

export function redactFreeformText(text: string): FreeformRedaction {
  if (!hasFreeformRedactionHint(text)) {
    return { redacted: text, redactionsCount: 0 };
  }

  const protectedRanges = collectProtectedRanges(text);
  if (protectedRanges.length === 0) {
    return redactUnprotectedText(text);
  }

  let redacted = '';
  let cursor = 0;
  let redactionsCount = 0;
  for (const range of protectedRanges) {
    const segment = text.slice(cursor, range.start);
    const segmentResult = redactUnprotectedText(segment);
    redacted += segmentResult.redacted;
    redactionsCount += segmentResult.redactionsCount;
    redacted += text.slice(range.start, range.end);
    cursor = range.end;
  }

  const tail = redactUnprotectedText(text.slice(cursor));
  redacted += tail.redacted;
  redactionsCount += tail.redactionsCount;

  return { redacted, redactionsCount };
}

function redactUnprotectedText(text: string): FreeformRedaction {
  if (text.length === 0 || !hasFreeformRedactionHint(text)) {
    return { redacted: text, redactionsCount: 0 };
  }
  const cached = cache.get(text);
  if (cached) return cached;

  const result = REDACTOR.redactum(text);
  const redaction = {
    redacted: result.redactedText,
    redactionsCount: result.stats.totalFindings,
  };
  cache.set(text, redaction);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return redaction;
}

export function hasFreeformRedactionHint(text: string): boolean {
  return REDACTION_HINT_RE.test(text);
}

function collectProtectedRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (const pattern of PROTECTED_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);

  const merged: Range[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
    } else if (range.end > previous.end) {
      previous.end = range.end;
    }
  }
  return merged;
}
