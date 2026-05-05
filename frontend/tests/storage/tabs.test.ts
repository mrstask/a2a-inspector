import {beforeEach, describe, expect, it} from 'vitest';
import {mountTabs} from '../../src/ui/tabs';

beforeEach(() => {
  document.body.innerHTML = `
    <nav id="bar"></nav>
    <section data-tab="chat">chat panel</section>
    <section data-tab="agentCard">card panel</section>
    <section data-tab="sessionDetails">session panel</section>
    <section data-tab="metadata">metadata panel</section>
    <section data-tab="debug">debug panel</section>
  `;
  localStorage.clear?.();
});

describe('ui/tabs', () => {
  it('renders tab buttons and activates chat by default', () => {
    const t = mountTabs(document.getElementById('bar') as HTMLElement);
    const buttons = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
    expect(buttons).toHaveLength(5);
    expect(t.getActive()).toBe('chat');
    expect(
      document.querySelector<HTMLElement>('[data-tab="chat"]')!.classList,
    ).toContain('is-active');
  });

  it('clicking a tab switches the active panel and persists', () => {
    const t = mountTabs(document.getElementById('bar') as HTMLElement);
    const cardBtn = document.querySelector<HTMLButtonElement>(
      '.tab-btn[data-tab="agentCard"]',
    )!;
    cardBtn.click();
    expect(t.getActive()).toBe('agentCard');
    const chatPanel = document.querySelector<HTMLElement>(
      '[data-tab="chat"]',
    )!;
    const cardPanel = document.querySelector<HTMLElement>(
      '[data-tab="agentCard"]',
    )!;
    expect(chatPanel.classList.contains('is-active')).toBe(false);
    expect(cardPanel.classList.contains('is-active')).toBe(true);
    expect(localStorage.getItem('a2a-inspector:activeTab')).toBe('agentCard');
  });

  it('restores the persisted tab on next mount', () => {
    localStorage.setItem('a2a-inspector:activeTab', 'debug');
    const t = mountTabs(document.getElementById('bar') as HTMLElement);
    expect(t.getActive()).toBe('debug');
    expect(
      document
        .querySelector<HTMLElement>('[data-tab="debug"]')!
        .classList.contains('is-active'),
    ).toBe(true);
  });

  it('switches to metadata as a first-class tab', () => {
    const t = mountTabs(document.getElementById('bar') as HTMLElement);
    document
      .querySelector<HTMLButtonElement>('.tab-btn[data-tab="metadata"]')!
      .click();

    expect(t.getActive()).toBe('metadata');
    expect(
      document
        .querySelector<HTMLElement>('[data-tab="metadata"]')!
        .classList.contains('is-active'),
    ).toBe(true);
  });
});
