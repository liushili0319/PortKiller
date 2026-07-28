export function afterStartupPaint(callback: () => void, fallbackDelayMs = 120) {
  let finished = false;
  let fallbackId: ReturnType<typeof setTimeout> | null = null;
  let firstFrameId: number | null = null;
  let secondFrameId: number | null = null;

  function run() {
    if (finished) {
      return;
    }

    finished = true;

    if (fallbackId !== null) {
      clearTimeout(fallbackId);
      fallbackId = null;
    }

    callback();
  }

  fallbackId = setTimeout(run, fallbackDelayMs);

  if (typeof requestAnimationFrame === "function") {
    firstFrameId = requestAnimationFrame(() => {
      if (finished) {
        return;
      }

      secondFrameId = requestAnimationFrame(run);
    });
  }

  return () => {
    finished = true;

    if (fallbackId !== null) {
      clearTimeout(fallbackId);
    }

    if (typeof cancelAnimationFrame === "function") {
      if (firstFrameId !== null) {
        cancelAnimationFrame(firstFrameId);
      }

      if (secondFrameId !== null) {
        cancelAnimationFrame(secondFrameId);
      }
    }
  };
}
