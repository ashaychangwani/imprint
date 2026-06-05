import architecture from '@docs/architecture.md?raw';
import captureProtocol from '@docs/capture-protocol.md?raw';
import credentialSharing from '@docs/credential-sharing.md?raw';
import decisions from '@docs/decisions.md?raw';
import design from '@docs/design.md?raw';
import gettingStarted from '@docs/getting-started.md?raw';
import glossary from '@docs/glossary.md?raw';
import integrations from '@docs/integrations.md?raw';
import mcpMaintenance from '@docs/mcp-maintenance.md?raw';
import notifications from '@docs/notifications.md?raw';
import playbookDebugging from '@docs/playbook-debugging.md?raw';
import security from '@docs/security.md?raw';
import tracing from '@docs/tracing.md?raw';
import troubleshooting from '@docs/troubleshooting.md?raw';

const docsManifest = [
  {
    category: 'Getting Started',
    items: [
      { slug: 'getting-started', title: 'Quick Start' },
      { slug: 'integrations', title: 'Integrations' },
      { slug: 'mcp-maintenance', title: 'MCP Maintenance' },
      { slug: 'glossary', title: 'Glossary' },
    ],
  },
  {
    category: 'Guides',
    items: [
      { slug: 'capture-protocol', title: 'Capture Protocol' },
      { slug: 'credential-sharing', title: 'Credential Sharing' },
      { slug: 'notifications', title: 'Notifications' },
      { slug: 'tracing', title: 'Tracing' },
    ],
  },
  {
    category: 'Troubleshooting',
    items: [
      { slug: 'troubleshooting', title: 'Troubleshooting' },
      { slug: 'playbook-debugging', title: 'Playbook Debugging' },
    ],
  },
  {
    category: 'Reference',
    items: [
      { slug: 'architecture', title: 'Architecture' },
      { slug: 'security', title: 'Security' },
      { slug: 'decisions', title: 'Design Decisions' },
      { slug: 'design', title: 'Product Strategy' },
    ],
  },
];

const docsContent = {
  'getting-started': gettingStarted,
  integrations: integrations,
  'mcp-maintenance': mcpMaintenance,
  glossary: glossary,
  'capture-protocol': captureProtocol,
  'credential-sharing': credentialSharing,
  notifications: notifications,
  troubleshooting: troubleshooting,
  'playbook-debugging': playbookDebugging,
  architecture: architecture,
  security: security,
  decisions: decisions,
  design: design,
  tracing: tracing,
};

export { docsManifest, docsContent };
