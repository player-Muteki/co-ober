// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { WelcomeView, connectionStatus } from './welcomeView';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { t, setLocale } from '../i18n/index';
import zhLocale from '../i18n/zh';

installObsidianDomHelpers();

describe('WelcomeView', () => {
	it('show() creates correct DOM structure', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show('connected');

		const el = container.querySelector('.co-ober-welcome');
		expect(el).not.toBeNull();

		const title = el?.querySelector('.co-ober-welcome-title');
		expect(title?.textContent).toBe(t().appName);

		const subtitle = el?.querySelector('.co-ober-welcome-subtitle');
		expect(subtitle?.textContent).toBe(t().appSubtitle);

		const shortcuts = el?.querySelectorAll('.co-ober-welcome-shortcuts div');
		expect(shortcuts?.length).toBe(4);
		expect(shortcuts?.[0].textContent).toBe(t().welcome.shortcuts.enter);

		const status = el?.querySelector('.co-ober-welcome-status span');
		expect(status?.textContent).toBe(t().welcome.connected);
	});

	it('shows "connected" for a client that completed its handshake', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show('connected');

		const status = container.querySelector('.co-ober-welcome-status span');
		expect(status?.textContent).toBe(t().welcome.connected);
	});

	it('shows "connecting" while the agent is still being reached', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show('connecting');

		// A client object exists from the moment one is being built, so saying
		// "Connected" here told the reader to type into a composer whose every
		// send was about to fail — and saying "Disconnected" sent them to the
		// reconnect button for a connection that was already on its way.
		const status = container.querySelector('.co-ober-welcome-status span');
		expect(status?.textContent).toBe(t().welcome.connecting);
	});

	it('does not render auth methods when authMethods is empty', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container, () => ({ authMethods: [] }));

		view.show('connected');

		expect(container.querySelector('.co-ober-welcome-auth-methods')).toBeNull();
	});

	it('renders auth methods and login command when authMethods is non-empty', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container, () => ({
			authMethods: [{ id: 'github', name: 'GitHub' }],
		}));

		view.show('connected');

		const auth = container.querySelector('.co-ober-welcome-auth-methods');
		expect(auth).not.toBeNull();
		expect(auth?.textContent).toContain(t().welcome.authMethodsHint);
		expect(auth?.textContent).toContain('github: GitHub');
		expect(auth?.textContent).toContain(t().welcome.authLoginCommand);
	});

	it('withholds the auth-method hint until the handshake that reported it is in hand', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container, () => ({
			authMethods: [{ id: 'github', name: 'GitHub' }],
		}));

		view.show('connecting');

		// The login command is only an instruction for an agent that answered;
		// shown during a reconnect it tells the reader to fix an authentication
		// that was never the problem.
		expect(container.querySelector('.co-ober-welcome-auth-methods')).toBeNull();
	});

	it('show("disconnected") displays "disconnected" status', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show('disconnected');

		const status = container.querySelector('.co-ober-welcome-status span');
		expect(status?.textContent).toBe(t().welcome.disconnected);
	});

	it('hide() clears DOM', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show('connected');
		expect(container.querySelector('.co-ober-welcome')).not.toBeNull();

		view.hide();
		expect(container.querySelector('.co-ober-welcome')).toBeNull();
	});

	it('updateStatus() updates existing status text', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show('disconnected');
		const statusParent = container.querySelector('.co-ober-welcome-status');
		const statusSpan = statusParent?.querySelector('span');
		expect(statusSpan?.textContent).toBe(t().welcome.disconnected);

		view.updateStatus('connected');
		expect(statusParent?.textContent).toBe(t().welcome.connected);
	});

	it('updateStatus() rewrites the line for a connection that came in partway', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show('connecting');
		view.updateStatus('connected');

		expect(container.querySelector('.co-ober-welcome-status span')?.textContent).toBe(t().welcome.connected);
	});

	it('isVisible() correctly reflects current state', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		expect(view.isVisible()).toBe(false);

		view.show('connected');
		expect(view.isVisible()).toBe(true);

		view.hide();
		expect(view.isVisible()).toBe(false);
	});

	it('consecutive show() clears old content', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show('connected');
		view.show('disconnected');

		const elements = container.querySelectorAll('.co-ober-welcome');
		expect(elements.length).toBe(1);

		const status = elements[0].querySelector('.co-ober-welcome-status span');
		expect(status?.textContent).toBe(t().welcome.disconnected);
	});

	describe('connectionStatus()', () => {
		it('names no client as disconnected and a live one as connected', () => {
			expect(connectionStatus(null)).toBe('disconnected');
			expect(connectionStatus({ isConnected: () => true })).toBe('connected');
		});

		it('names a client that exists but has not finished connecting as connecting', () => {
			// This is the state the boolean lost: an agent runtime is held while
			// its subprocess is starting or while a drop is being retried, and a
			// screen built on "a client object exists" called both of those
			// connected.
			expect(connectionStatus({ isConnected: () => false })).toBe('connecting');
		});

		it('names a client whose reconnect loop has given up as disconnected (0.2.47 stage C)', () => {
			// The badge used to collapse "attempt in flight" and "attempts
			// exhausted" into one 'connecting' reading, so a pane that had
			// already painted "could not be reached after repeated reconnect
			// attempts" in its transcript kept showing the connecting glyph on
			// any later auto-repaint (tab switch, /new, rewind, restore). The
			// sibling reconnect button (CoOberView.ts:897-900) speaks the three
			// states as text/connecting/failed via its own `reconnectFailed`
			// field; the badge now reaches the same three-way split through the
			// client's own `isReconnectExhausted` flag instead of a duplicate
			// widget-side field.
			expect(connectionStatus({
				isConnected: () => false,
				isReconnectExhausted: () => true,
			})).toBe('disconnected');
		});

		it('leaves an unexhausted drop in the connecting reading', () => {
			// The fix must not trade one lie for another by calling every
			// down-client an abandoned one: while the retry loop is still in
			// flight the honest sentence is still "Connecting…".
			expect(connectionStatus({
				isConnected: () => false,
				isReconnectExhausted: () => false,
			})).toBe('connecting');
		});

		it('speaks two different badges for the two drop classes, so the split cannot be silently re-merged', () => {
			// Anti-remerge guard: the whole point of the split is that a
			// not-yet-given-up drop and a given-up drop paint differently. A
			// future edit that either dropped the branch or collapsed the two
			// return values would keep the individual assertions passing while
			// making the two situations unreadable again.
			const exhausted = connectionStatus({
				isConnected: () => false,
				isReconnectExhausted: () => true,
			});
			const retrying = connectionStatus({
				isConnected: () => false,
				isReconnectExhausted: () => false,
			});
			expect(exhausted).not.toBe(retrying);
		});
	});

	describe('locale subscription', () => {
		it('re-renders visible content when the locale changes', () => {
			setLocale('en');
			const container = document.createElement('div');
			const view = new WelcomeView(container);
			view.show('disconnected');

			setLocale('zh');
			expect(container.querySelector('.co-ober-welcome-title')?.textContent).toBe(zhLocale.appName);
			setLocale('en');
			expect(container.querySelector('.co-ober-welcome-title')?.textContent).toBe(t().appName);
			view.dispose();
		});

		it('keeps the state the reader was shown when the locale changes', () => {
			setLocale('en');
			const container = document.createElement('div');
			const view = new WelcomeView(container);
			view.show('connecting');

			setLocale('zh');
			try {
				// The rebuild paints from the stored state, so a pane that was
				// told "connecting" must not come back from a locale switch
				// claiming the agent is unreachable.
				expect(container.querySelector('.co-ober-welcome-status span')?.textContent)
					.toBe(zhLocale.welcome.connecting);
			} finally {
				setLocale('en');
				view.dispose();
			}
		});

		it('dispose() unsubscribes the locale listener and hides the view', () => {
			setLocale('en');
			const container = document.createElement('div');
			const view = new WelcomeView(container);
			view.show('disconnected');
			const showSpy = vi.spyOn(view, 'show');

			view.dispose();
			expect(view.isVisible()).toBe(false);

			showSpy.mockClear();
			setLocale('zh');
			expect(showSpy).not.toHaveBeenCalled();
			setLocale('en');
		});
	});
});
