/**
 * Shared UI pieces for dsh-open-in-zed: the Zed glyph, copy, and the two
 * slot occupants (a session-header icon button and a Session "..." menu
 * row). Both occupants hide themselves without a session cwd and report
 * launch failures through window.alert (V1: no toast service dependency).
 *
 * @module dsh-open-in-zed/client/entries
 */
import * as React from 'react';
import { openInZed } from './api.ts';

/** Copy for the two supported locales (lang-tag fallback, no service dep). */
function copy(key: 'label' | 'menu' | 'failedTitle'): string {
  const zh = document.documentElement.lang.toLowerCase().startsWith('zh');
  const table: Record<string, { zh: string; en: string }> = {
    label: { zh: '用 Zed 打开工作区', en: 'Open workspace in Zed' },
    menu: { zh: '用 Zed 打开工作区', en: 'Open workspace in Zed' },
    failedTitle: { zh: '打开失败', en: 'Opening failed' },
  };
  const row = table[key];
  return zh ? row.zh : row.en;
}

/**
 * Minimal geometric Z glyph (Zed stand-in; no asset dependency).
 * @returns the 16px icon element.
 */
function ZedIcon(): React.ReactNode {
  return React.createElement(
    'svg',
    {
      width: 16,
      height: 16,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    React.createElement('path', { d: 'M3.5 3.5h9L3.5 12.5h9' }),
  );
}

/**
 * Launch zed for a path with busy handling; failures alert with the host's
 * message (install hint, forbidden path, …).
 * @param path - workspace directory.
 * @param setBusy - busy-state writer (optional).
 */
async function launch(
  path: string,
  setBusy?: (busy: boolean) => void,
): Promise<void> {
  setBusy?.(true);
  try {
    await openInZed(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[dsh-open-in-zed]', message);
    try {
      window.alert(`${copy('failedTitle')}\n${message}`);
    } catch {
      /* alert blocked (headless) — the console line above still records it */
    }
  } finally {
    setBusy?.(false);
  }
}

/** Narrow face of the sessions store hook the header slot injects. */
export type UseSessionsHook = (
  selector: (state: { byId: Record<string, { cwd?: string }> }) => unknown,
) => unknown;

/** Props the conversation.session.header.utilities renderer dispatches. */
export interface HeaderOccupantProps {
  sessionId: string;
  useSessions: UseSessionsHook;
}

/** Props the sidebar.workspaces.session.menu.item renderer dispatches. */
export interface MenuOccupantProps {
  sessionId: string;
  useMenuOpenState: () => [boolean, (open: boolean) => void];
}

/**
 * Build the session-header icon button occupant.
 * @param fallbackCwd - closure cwd reader for runtimes that skip the hook.
 * @returns the component.
 */
export function makeHeaderButton(
  fallbackCwd: (sessionId: string) => string | undefined,
): (props: HeaderOccupantProps) => React.ReactNode {
  return function OpenInZedHeaderButton(
    props: HeaderOccupantProps,
  ): React.ReactNode {
    // The sessions hook is itself hook-backed (useSyncExternalStore), so it
    // MUST run at the top of a render with a stable call count. A guard
    // component (below) keeps the hookless fallback path out of the same
    // function identity, and a missing cwd returns null AFTER all hooks.
    if (typeof props.useSessions !== 'function') {
      const fallback = fallbackCwd(props.sessionId);
      return fallback === undefined ? null : (
        <HeaderLaunchButton cwd={fallback} />
      );
    }
    return (
      <HookedHeaderButton
        sessionId={props.sessionId}
        useSessions={props.useSessions}
        fallbackCwd={fallbackCwd}
      />
    );
  };
}

/** Hook-backed header button: useSessions at the top, hooks never conditional. */
function HookedHeaderButton(
  props: HeaderOccupantProps & {
    fallbackCwd: (sessionId: string) => string | undefined;
  },
): React.ReactNode {
  const hooked = props.useSessions(
    (state: { byId: Record<string, { cwd?: string }> }) =>
      state.byId[props.sessionId]?.cwd,
  );
  const cwd =
    typeof hooked === 'string' && hooked.length > 0
      ? hooked
      : props.fallbackCwd(props.sessionId);
  if (cwd === undefined) return null;
  return <HeaderLaunchButton cwd={cwd} />;
}

/** The busy-aware launch button shared by both header render paths. */
function HeaderLaunchButton(props: { cwd: string }): React.ReactNode {
  const [busy, setBusy] = React.useState(false);
  return React.createElement(
    'button',
    {
      type: 'button',
      className: 'dsh-zed-open-btn',
      title: copy('label'),
      'aria-label': copy('label'),
      'data-busy': busy ? 'true' : 'false',
      onClick: () => {
        void launch(props.cwd, setBusy);
      },
    },
    React.createElement(ZedIcon),
  );
}

/**
 * Build the Session "..." menu row occupant (role=menuitem button).
 * @param getCwd - closure cwd reader (the menu slot injects no sessions hook).
 * @returns the component.
 */
export function makeMenuItem(
  getCwd: (sessionId: string) => string | undefined,
): (props: MenuOccupantProps) => React.ReactNode {
  return function OpenInZedMenuItem(props: MenuOccupantProps): React.ReactNode {
    const cwd = React.useMemo(() => getCwd(props.sessionId), [props.sessionId]);
    const setMenuOpen = props.useMenuOpenState()[1];
    if (cwd === undefined) return null;
    return React.createElement(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        className: 'dsh-zed-open-menuitem',
        onClick: () => {
          setMenuOpen(false);
          void launch(cwd);
        },
      },
      copy('menu'),
    );
  };
}
