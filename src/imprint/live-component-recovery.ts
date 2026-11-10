import type { ComponentRecoveryOwner } from './component-recovery.ts';
import {
  type LiveComponentRecoveryInput,
  type MasterTeachAgentOptions,
  requestLiveComponentRecovery,
} from './master-teach-agents.ts';
import { currentUserInteraction, requestAgentInteraction } from './user-interaction.ts';

/** Select an existing owner; never infer one from names or HTTP status. */
export async function selectLiveComponentRecovery(
  input: Omit<
    LiveComponentRecoveryInput,
    'contexts' | 'components' | 'authenticationAvailable' | 'phase'
  > & {
    phase?: string;
    allowAuthentication?: boolean;
    owners: readonly ComponentRecoveryOwner[];
    agent: MasterTeachAgentOptions;
  },
): Promise<{ owner: ComponentRecoveryOwner; reason: string } | undefined> {
  const interaction = currentUserInteraction();
  const { agent, owners, allowAuthentication = true, ...failure } = input;
  const applicable = owners.filter((owner) =>
    owner.toolIds.includes(input.toolId ?? input.toolName),
  );
  const authenticationAvailable = allowAuthentication && (interaction?.hasAuthentication ?? false);
  if (!authenticationAvailable && applicable.length === 0) return undefined;
  if (new Set(applicable.map(({ id }) => id)).size !== applicable.length)
    throw new Error('Component recovery owner ids must be unique for a caller');
  const decision = await requestLiveComponentRecovery(
    {
      ...failure,
      phase: input.phase ?? 'live',
      authenticationAvailable,
      components: applicable.map(({ recover: _recover, ...component }) => ({
        ...component,
        toolIds: [...component.toolIds],
      })),
      contexts:
        interaction?.authenticationContexts().map((context) => ({
          contextRef: context.contextRef,
          label: context.label,
          workflowPath: context.workflowPath,
          latestAction: context.latestAction,
          latestOk: context.latestOk,
          latestStatus: context.latestStatus,
          latestError: context.latestError,
        })) ?? [],
    },
    agent,
  );
  if (decision.action === 'return_failure') return undefined;
  if (decision.action === 'recover_component') {
    const owner = applicable.find((owner) => owner.id === decision.componentId);
    return owner ? { owner, reason: decision.reason } : undefined;
  }
  return {
    owner: {
      id: `authentication:${decision.plan.contextRef ?? decision.plan.toolName}`,
      kind: 'authentication',
      label: decision.plan.toolName,
      toolIds: [input.toolId ?? input.toolName],
      recover: async () => {
        const result = await requestAgentInteraction(
          { action: 'authenticate', plan: decision.plan },
          agent.signal,
        );
        return result.status === 'authenticated';
      },
    },
    reason: decision.reason,
  };
}
