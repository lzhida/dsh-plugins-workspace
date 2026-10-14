/**
 * Browser half entry for dsh-open-in-zed: contributes two entry points for
 * opening the current session's workspace directory in the Zed editor —
 *
 * 1. `conversation.session.header.utilities` (order -9): an icon button
 *    beside the shipped "Open In..." control (order -10). The official
 *    button's application menu is a BUILD-TIME catalog without a plugin
 *    extension point (dsh-host-open-in-app README), so a side-by-side
 *    control is the plugin-level integration.
 * 2. `sidebar.workspaces.session.menu.item` (order 500): a "..." menu row
 *    after the shipped rows (pin 100 / rename 200 / fork 300 / archive 400).
 *
 * Failure policy: mounting problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws.
 *
 * Export shape: `name` / `inject` / `apply`, no default.
 *
 * @module dsh-open-in-zed/client
 */
import { makeHeaderButton, makeMenuItem } from './entries.tsx';
import { injectStyles } from './styles.ts';

/** Client plugin name. */
export const name = 'dsh-open-in-zed/client';

/** Narrow face of the client sessions service (snapshot cwd lookup). */
interface SessionsFace {
  list?: {
    getSnapshot?: () => {
      byId?: Record<string, { cwd?: string }>;
    };
  };
}

/** Narrow slot face used here. */
interface SlotsFace {
  inject(key: string, callback: () => unknown): () => void;
  register(options: Record<string, unknown>, component: unknown): () => void;
}

/** Effect-hook face the runner provides on the client context. */
interface ClientContextFace {
  /** DSH client runtimes mount services as context properties. */
  slots?: SlotsFace;
  sessions?: SessionsFace;
  get?(name: string): unknown;
  effect?(fn: () => unknown, label?: string): void;
}

/** Hard service deps: slots contribute the UI; sessions resolves the cwd. */
export const inject = ['slots', 'sessions'];

/**
 * Client entry: inject styles and register both slot occupants.
 * @param ctx - the cordis client context.
 */
export function apply(ctx: ClientContextFace): void {
  try {
    // DSH mounts services as context properties (official client-ui pattern);
    // ctx.get is the generic fallback.
    const slots = (ctx.slots ??
      (ctx.get?.('slots') as SlotsFace | undefined)) as SlotsFace | undefined;
    if (
      slots === undefined ||
      typeof slots.inject !== 'function' ||
      typeof slots.register !== 'function'
    ) {
      // No slot system (legacy shell / headless): no UI to contribute.
      console.info('[dsh-open-in-zed] client: no slot system; UI skipped');
      return;
    }
    const disposeStyles = injectStyles();

    // DSH mounts services as context properties (official client-ui pattern)
    // and GUARDS them by the inject declaration — ctx.sessions is safe here
    // because "sessions" is declared; the generic getter is only a fallback.
    let sessions: SessionsFace | undefined = ctx.sessions;
    if (sessions === undefined) {
      try {
        sessions = ctx.get?.('sessions') as SessionsFace | undefined;
      } catch {
        sessions = undefined;
      }
    }
    const getCwd = (sessionId: string): string | undefined => {
      try {
        const byId = sessions?.list?.getSnapshot?.().byId;
        const cwd = byId?.[sessionId]?.cwd;
        return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
      } catch {
        return undefined;
      }
    };

    const disposers: Array<() => void> = [disposeStyles];
    const register = (
      key: string,
      options: Record<string, unknown>,
      component: unknown,
    ): void => {
      disposers.push(
        slots.inject(key, () => slots.register(options, component)),
      );
    };

    register(
      'conversation.session.header.utilities',
      {
        name: 'conversation.session.header.utilities',
        id: 'dsh-open-in-zed',
        order: -9,
      },
      makeHeaderButton(getCwd),
    );
    register(
      'sidebar.workspaces.session.menu.item',
      {
        name: 'sidebar.workspaces.session.menu.item',
        id: 'dsh-open-in-zed',
        order: 500,
      },
      makeMenuItem(getCwd),
    );

    ctx.effect?.(
      () => () => {
        for (const dispose of disposers.splice(0)) dispose();
      },
      'dsh-open-in-zed: client mount',
    );
  } catch (error) {
    console.error('[dsh-open-in-zed] client half failed to start:', error);
  }
}
