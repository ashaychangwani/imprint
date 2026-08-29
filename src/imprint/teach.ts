/** Public entrypoint for the single fresh, foreground master-led teach flow. */

import {
  type FreshTeachOptions,
  type FreshTeachTerminalResult,
  runFreshMasterTeach,
} from './master-teach-controller.ts';

type TeachOptions = FreshTeachOptions;
type TeachResult = FreshTeachTerminalResult;

/**
 * Start from the selected current recording and return only after the run is
 * terminal. There is no resume, phase window, or partial-tool mode.
 */
export async function teach(opts: TeachOptions): Promise<TeachResult> {
  return await runFreshMasterTeach(opts);
}
