/**
 * Stop a directly spawned fixture and wait until Windows has released both its
 * listening socket and executable handle.
 *
 * `ChildProcess.kill()` only reports that a signal was sent. Returning at that
 * point leaves the next serial test free to race the still-running process.
 * Both waits are bounded so a broken fixture cannot hang an Actions runner.
 */
export async function stopFixtureProcess(child, label, timeoutMs = 10_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  if (await settlesWithin(exited, timeoutMs)) return;

  // The fixture is the process we spawn, not a cargo wrapper, so there is no
  // child tree to chase. SIGKILL maps to a forced termination on Windows.
  child.kill("SIGKILL");
  if (await settlesWithin(exited, 2_000)) return;

  throw new Error(`${label} did not exit within ${timeoutMs + 2_000} ms`);
}

async function settlesWithin(promise, timeoutMs) {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([promise.then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
