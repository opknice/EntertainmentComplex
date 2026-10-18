// A bounded session budget survives engine replacement, not channel changes.
function httpStatus(error) {
  const message = error?.message || String(error || '');
  const code = Number(error?.code);
  const network = code === 1001 ? error : error?.data?.find?.(entry => entry?.code === 1001);
  return Number(network?.data?.[1] || message.match(/HTTP[_ ]?([1-5]\d\d)/i)?.[1]);
}

export function recoverablePlaybackError(error) {
  const message = error?.message || String(error || '');
  const code = Number(error?.code);
  const status = httpStatus(error);
  if (status) return status === 408 || status === 429 || status >= 500;
  if ([1000, 1002, 1003].includes(code)) return true;
  if (/DRM|LICENSE|NOT_SUPPORTED|HIGHEST_QUALITY_UNAVAILABLE/i.test(message)) return false;
  return error?.recoverable === true || /stream_timeout|playback_timeout|video_error_[23]|NetworkError|Failed to fetch|Load failed|networkError|NetworkException|EarlyEof/i.test(message);
}

export function createRecoveryBudget() {
  let attempts = 0;
  let healthySince = null;
  return {
    next(error) {
      healthySince = null;
      if (!recoverablePlaybackError(error) || attempts >= 5) return null;
      const delay = [2000, 5000, 10000, 20000, 30000][attempts++];
      return { attempt: attempts, delay: httpStatus(error) === 429 ? Math.max(30000, delay) : delay };
    },
    progressing(now) {
      healthySince ??= now;
      if (now - healthySince >= 60000) attempts = 0;
    },
    stalled() { healthySince = null; },
    reset() { attempts = 0; healthySince = null; },
  };
}
