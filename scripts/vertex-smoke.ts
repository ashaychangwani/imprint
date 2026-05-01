import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

const client = new AnthropicVertex({
  projectId: 'panw-tdp-dev',
  region: 'us-east5',
});

// Try a few likely model IDs to see what's deployed in the project.
const candidates = [
  'claude-sonnet-4-6@20260301',
  'claude-sonnet-4-6@latest',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5@20260301',
  'claude-sonnet-4-5',
  'claude-opus-4-5@20260301',
  'claude-opus-4-1@20260301',
  'claude-opus-4@20260301',
];

for (const model of candidates) {
  try {
    const r = await client.messages.create({
      model,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Say "ok" only.' }],
    });
    const text = r.content
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { type: string; text?: string }) => b.text ?? '')
      .join('');
    console.log(`✓ ${model} → ${text.trim()}`);
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Trim long error text
    console.log(`✗ ${model}: ${msg.slice(0, 200)}`);
  }
}
console.log('No working model found.');
process.exit(1);
