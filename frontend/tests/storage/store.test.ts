import {describe, expect, it, vi} from 'vitest';
import {createStore} from '../../src/state/store';

describe('state/store', () => {
  it('returns initial state', () => {
    const s = createStore();
    expect(s.getState().activeProfileId).toBeNull();
    expect(s.getState().connection.status).toBe('idle');
  });

  it('setState merges and notifies subscribers', () => {
    const s = createStore();
    const listener = vi.fn();
    s.subscribe(listener);
    s.setState({activeProfileId: 'p1'});
    expect(s.getState().activeProfileId).toBe('p1');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('select fires only on slice changes', () => {
    const s = createStore();
    const listener = vi.fn();
    s.select(st => st.activeProfileId, listener);
    s.setState({activeDialogId: 'd1'});
    expect(listener).not.toHaveBeenCalled();
    s.setState({activeProfileId: 'p1'});
    expect(listener).toHaveBeenCalledTimes(1);
    s.setState({activeProfileId: 'p1'});
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications', () => {
    const s = createStore();
    const listener = vi.fn();
    const off = s.subscribe(listener);
    off();
    s.setState({activeProfileId: 'p2'});
    expect(listener).not.toHaveBeenCalled();
  });
});
