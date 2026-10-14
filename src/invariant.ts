/** Package invariant companion for `@randerdouble/dsh-ui-usage-billing`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@randerdouble/dsh-ui-usage-billing'

export const name = 'usage-billing-invariant'
export const inject = ['invariants']

/** No runtime invariant: pure UI surface plugin with no lifecycle dependencies. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Host context carrying the invariant registry.
 * @returns the registration disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
