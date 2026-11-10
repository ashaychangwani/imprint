/** Recording-grounded authentication plan shared by agent interfaces. */
import { z } from 'zod';

export const AuthCaptureSchema = z.object({
  name: z.string().min(1),
  /** Capture source: json | response_header | cookie | text_regex. */
  source: z.string().min(1),
  /** Path / header name / cookie name / regex that locates the value. */
  locator: z.string().min(1),
  /** Where the captured value is injected downstream, e.g. "header:Authorization". */
  usedAs: z.string().default(''),
});

export const AuthToolPlanSchema = z
  .object({
    toolName: z.string(),
    /** Explicit model-selected retained context; omitted preserves legacy label reuse. */
    contextRef: z.string().min(1).optional(),
    /** Deliberately isolated context; mutually exclusive with contextRef. */
    newContext: z.boolean().optional(),
    credentialRequestSeqs: z.array(z.number().int().nonnegative()).default([]),
    authRequestSeqs: z.array(z.number().int().nonnegative()).default([]),
    credentialNames: z.array(z.string()).default([]),
    captures: z.array(AuthCaptureSchema).default([]),
    notes: z.string().default(''),
  })
  .optional();
export type AuthToolPlan = z.infer<typeof AuthToolPlanSchema>;
