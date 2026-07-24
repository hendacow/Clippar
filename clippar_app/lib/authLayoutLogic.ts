/**
 * Auth-screen scroll layout logic.
 *
 * The login/signup screens vertically center their content (logo + form)
 * inside a ScrollView using `flexGrow: 1` + `justifyContent: 'center'`.
 * That looks right when everything fits, but React Native has a long-standing
 * quirk: when the content is TALLER than the scroll viewport, centering pushes
 * the top of the content (the logo) above the scrollable origin, so it is
 * clipped under the status bar / Dynamic Island and can't be scrolled back
 * into view.
 *
 * The fix is to center only when the content fits, and top-align (so the logo
 * stays reachable and fully visible) when it overflows. This tiny pure helper
 * makes that decision so it can be unit-tested and shared by both screens.
 */
export type AuthJustify = 'center' | 'flex-start';

/**
 * Decide how to justify auth-screen scroll content.
 *
 * @param contentHeight  measured height of the scroll content (onContentSizeChange)
 * @param viewportHeight measured height of the ScrollView frame (onLayout)
 * @returns 'center' when the content fits the viewport, else 'flex-start'
 *
 * Heights of 0 mean "not measured yet" — default to 'center' so the first
 * paint matches the fits-case (the common path on larger screens) and only
 * switches to top-align once a real overflow is measured.
 */
export function authContentJustify(
  contentHeight: number,
  viewportHeight: number
): AuthJustify {
  if (contentHeight <= 0 || viewportHeight <= 0) return 'center';
  return contentHeight > viewportHeight ? 'flex-start' : 'center';
}
