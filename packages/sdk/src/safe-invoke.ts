/**
 * Invokes fn with args, containing any exception it throws so it cannot
 * propagate into this library's own control flow, be mistaken for this
 * library's own failure, or crash the host process. Per sdk-conformance's
 * "Integrator Code Cannot Destabilize The Host Process" requirement:
 * every callback this library invokes on the integrator's behalf — every
 * `onConfigRefreshed`/`onConfigRefreshError`/`onExposureDropped`/
 * `onExposureSubmitError` call — goes through this single point rather
 * than being invoked directly at each call site.
 *
 * There is deliberately no further diagnostic path here: reporting a
 * broken error-reporting callback's own failure through that same
 * callback risks an infinite loop, and this library has no other channel
 * to report it through.
 */
export function safeInvoke<Args extends unknown[]>(
  fn: ((...args: Args) => void) | undefined,
  ...args: Args
): void {
  if (!fn) {
    return;
  }

  try {
    fn(...args);
  } catch {
    // Contained deliberately — see this module's own doc comment.
  }
}
