/** The browser fields used for platform defaults; kept small for unit tests. */
export interface PlatformSource {
  userAgent?: string;
  maxTouchPoints?: number;
}

/**
 * True for Safari on macOS, iOS, and iPadOS desktop-UA mode. Chromium/Firefox
 * variants on those platforms identify themselves with their own UA tokens and
 * must retain the ordinary defaults.
 */
export function isSafari(source: PlatformSource | undefined): boolean {
  const ua = source?.userAgent ?? "";
  if (!/Safari\//.test(ua)) return false;
  return !/(?:Chrome|Chromium|CriOS|FxiOS|Edg(?:A|iOS)?|OPR|Opera|Android)/.test(ua);
}
