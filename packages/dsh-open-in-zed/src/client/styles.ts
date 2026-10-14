/**
 * Styles for the dsh-open-in-zed client half: one ownership-tagged <style>
 * element (the shell's client-module system claims UN-tagged styles for
 * whichever sibling plugin materializes next, and HMR deletes them by this
 * attribute on that sibling's rebuild — the dsh-taskboard 0.4.3 lesson).
 *
 * @module dsh-open-in-zed/client/styles
 */

/** Style element id (one per document). */
const STYLE_ID = 'dsh-open-in-zed-styles';

/** Ownership tag marking the element as ours for HMR. */
const OWNER_TAG = 'data-dsh-open-in-zed';

/** Stylesheet text: the header icon button (theme-token driven). */
const CSS = `
.dsh-zed-open-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0;
  border: none; border-radius: 6px;
  background: transparent; color: var(--dsw-text-secondary, inherit);
  cursor: pointer;
}
.dsh-zed-open-btn:hover {
  background: var(--dsw-hover, rgba(128,128,128,.12));
  color: var(--dsw-text-primary, inherit);
}
.dsh-zed-open-btn[data-busy="true"] { opacity: .5; pointer-events: none; }
.dsh-zed-open-btn svg { display: block; }
.dsh-zed-open-menuitem { justify-content: flex-start; }
`;

/**
 * Inject the stylesheet once per document.
 * @returns the disposer removing OUR element (safe to call twice).
 */
export function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  let element = document.getElementById(STYLE_ID);
  if (element === null) {
    element = document.createElement('style');
    element.id = STYLE_ID;
    element.setAttribute(OWNER_TAG, '');
    element.textContent = CSS;
    document.head.append(element);
  }
  return () => element?.remove();
}
