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

		const el = container.querySelector('.copsidian-welcome');
		expect(el).not.toBeNull();

		const title = el?.querySelector('.copsidian-welcome-title');
		expect(title?.textContent).toBe(t().appName);

		const subtitle = el?.querySelector('.copsidian-welcome-subtitle');
		expect(subtitle?.textContent).toBe(t().appSubtitle);

		const shortcuts = el?.querySelectorAll('.copsidian-welcome-shortcuts div');
		expect(shortcuts?.length).toBe(4);
		expect(shortcuts?.[0].textContent).toBe(t().welcome.shortcuts.enter);

		const status = el?.querySelector('.copsidian-welcome-status span');
		expect(status?.textContent).toBe(t().welcome.connected);
	});

	it('show(true) displays "connected" status', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show(true);

		const status = container.querySelector('.copsidian-welcome-status span');
		expect(status?.textContent).toBe(t().welcome.connected);
	});

	it('show(false) displays "disconnected" status', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show(false);

		const status = container.querySelector('.copsidian-welcome-status span');
		expect(status?.textContent).toBe(t().welcome.disconnected);
	});

	it('hide() clears DOM', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show(true);
		expect(container.querySelector('.copsidian-welcome')).not.toBeNull();

		view.hide();
		expect(container.querySelector('.copsidian-welcome')).toBeNull();
	});

	it('updateStatus() updates existing status text', () => {
		const container = document.createElement('div');
		const view = new WelcomeView(container);

		view.show(false);
		const statusParent = container.querySelector('.copsidian-welcome-status');
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

		const elements = container.querySelectorAll('.copsidian-welcome');
		expect(elements.length).toBe(1);

		const status = elements[0].querySelector('.copsidian-welcome-status span');
		expect(status?.textContent).toBe(t().welcome.disconnected);
	});
});
