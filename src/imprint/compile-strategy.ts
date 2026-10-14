import { z } from 'zod';

export const CompileStrategyKindSchema = z.enum(['api', 'playbook_fallback']);

export type CompileStrategyKind = z.infer<typeof CompileStrategyKindSchema>;
