//#region lib/types/invariant.js
/** Package invariant companion for `@randerdouble/dsh-ui-usage-billing`. */
const PACKAGE_NAME = "@randerdouble/dsh-ui-usage-billing";
const name = "usage-billing-invariant";
const inject = ["invariants"];
/** No runtime invariant: pure UI surface plugin with no lifecycle dependencies. */
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Host context carrying the invariant registry.
* @returns the registration disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
