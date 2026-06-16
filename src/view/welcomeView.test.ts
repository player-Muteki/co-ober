// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { WelcomeView } from './welcomeView';
import { installObsidianDomHelpers } from '../test/domHelpers';
import { t } from '../i18n/index';

installObsidianDomHelpers();

describe('WelcomeView', () => {
	it('show() creates correct DOM structure', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show(true);

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

	it('show(true) displays "connected" status', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show(true);

		const status = container.querySelector('.co-ober-welcome-status span');
		expect(status?.textContent).toBe(t().welcome.connected);
	});

	it('does not render auth methods when authMethods is empty', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container, () => ({ authMethods: [] }));

		view.show(true);

		expect(container.querySelector('.co-ober-welcome-auth-methods')).toBeNull();
	});

	it('renders auth methods and login command when authMethods is non-empty', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container, () => ({
			authMethods: [{ id: 'github', name: 'GitHub' }],
		}));

		view.show(true);

		const auth = container.querySelector('.co-ober-welcome-auth-methods');
		expect(auth).not.toBeNull();
		expect(auth?.textContent).toContain(t().welcome.authMethodsHint);
		expect(auth?.textContent).toContain('github: GitHub');
		expect(auth?.textContent).toContain(t().welcome.authLoginCommand);
	});

	it('show(false) displays "disconnected" status', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show(false);

		const status = container.querySelector('.co-ober-welcome-status span');
		expect(status?.textContent).toBe(t().welcome.disconnected);
	});

	it('hide() clears DOM', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show(true);
		expect(container.querySelector('.co-ober-welcome')).not.toBeNull();

		view.hide();
		expect(container.querySelector('.co-ober-welcome')).toBeNull();
	});

	it('updateStatus() updates existing status text', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show(false);
		const statusParent = container.querySelector('.co-ober-welcome-status');
		const statusSpan = statusParent?.querySelector('span');
		expect(statusSpan?.textContent).toBe(t().welcome.disconnected);

		view.updateStatus(true);
		expect(statusParent?.textContent).toBe(t().welcome.connected);
	});

	it('isVisible() correctly reflects current state', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		expect(view.isVisible()).toBe(false);

		view.show(true);
		expect(view.isVisible()).toBe(true);

		view.hide();
		expect(view.isVisible()).toBe(false);
	});

	it('consecutive show() clears old content', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show(true);
		view.show(false);

		const elements = container.querySelectorAll('.co-ober-welcome');
		expect(elements.length).toBe(1);

		const status = elements[0].querySelector('.co-ober-welcome-status span');
		expect(status?.textContent).toBe(t().welcome.disconnected);
	});
});
