import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { AcpJsonRpcTransport } from './AcpJsonRpcTransport';

describe('AcpJsonRpcTransport', () => {
  let input: PassThrough;
  let output: PassThrough;
  let transport: AcpJsonRpcTransport;

  beforeEach(() => {
    input = new PassThrough();
    output = new PassThrough();
    transport = new AcpJsonRpcTransport({ input, output }, 50); // small timeout
  });

  afterEach(() => {
    transport.dispose();
  });

  it('start() initializes readline and processes lines', async () => {
    transport.start();
    let handlerCalled = false;
    transport.onNotification('test', () => {
      handlerCalled = true;
    });

    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'test' }) + '\n');

    // wait for event loop to process
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(handlerCalled).toBe(true);
  });

  it('warns once per unknown notification method', async () => {
    transport.start();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (let i = 0; i < 2; i++) {
      input.write(JSON.stringify({ jsonrpc: '2.0', method: 'co-ober-test/unknown-note' }) + '\n');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(warn.mock.calls.filter((call) => String(call[0]).includes('co-ober-test/unknown-note'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('stays silent on $-prefixed notifications, ignorable by JSON-RPC convention', async () => {
    transport.start();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    input.write(JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest' }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('request() sends JSON-RPC message and resolves on response', async () => {
    transport.start();

    const requestPromise = transport.request<{ result: string }>('hello', { param: 1 });

    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const parsed = JSON.parse(sentMsg.trim());
    expect(parsed.method).toBe('hello');
    expect(parsed.id).toBeTypeOf('number');

    input.write(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { result: 'ok' } }) + '\n');

    const res = await requestPromise;
    expect(res).toEqual({ result: 'ok' });
  });

  it('request() rejects on timeout', async () => {
    transport.start();

    const requestPromise = transport.request('timeoutMethod', undefined, 10);

    await expect(requestPromise).rejects.toThrow(/timed out/);
  });

  it('request() timeout detaches the abort listener from the signal', async () => {
    transport.start();
    const added: Array<() => void> = [];
    const signal = {
      aborted: false,
      addEventListener: (_ev: string, handler: () => void) => {
        added.push(handler);
      },
      removeEventListener: vi.fn(),
    };

    await expect(
      transport.request('hangMethod', undefined, 10, signal as unknown as AbortSignal),
    ).rejects.toThrow(/timed out/);

    // A timed-out request must not leave its abort closure attached: agents
    // that reuse one long-lived signal would accumulate a listener per miss.
    expect(added).toHaveLength(1);
    expect(signal.removeEventListener).toHaveBeenCalledWith('abort', added[0]);
  });

  it('request() rejects when transport is disposed', async () => {
    transport.dispose();
    await expect(transport.request('method')).rejects.toThrow('Transport closed');
  });

  it('notify() sends notification without id', async () => {
    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    transport.notify('someEvent', { value: 42 });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const parsed = JSON.parse(sentMsg.trim());
    expect(parsed.method).toBe('someEvent');
    expect(parsed.id).toBeUndefined();
    expect(parsed.params).toEqual({ value: 42 });
  });

  it('notify() does not send if disposed', async () => {
    transport.dispose();
    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    transport.notify('someEvent', { value: 42 });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentMsg).toBe('');
  });

  it('onNotification() registers handler and receives params', async () => {
    transport.start();

    const handler = vi.fn();
    const unsubscribe = transport.onNotification('myNotification', handler);

    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'myNotification', params: { test: true } }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(handler).toHaveBeenCalledWith({ test: true });

    // test unsubscribe
    unsubscribe();
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'myNotification', params: { test: false } }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('onRequest() registers handler and sends response', async () => {
    transport.start();

    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    const unsubscribe = transport.onRequest('myRequest', async (params) => {
      return { echo: params };
    });

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'myRequest', params: 'hello' }) + '\n');

    await new Promise((resolve) => setTimeout(resolve, 20));

    const responses = sentMsg
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(responses[0]).toEqual({ jsonrpc: '2.0', id: 99, result: { echo: 'hello' } });

    // test unsubscribe — the request now has no handler, so it gets a method-not-found reply
    unsubscribe();
    sentMsg = '';
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'myRequest', params: 'hello2' }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterUnsub = JSON.parse(sentMsg.trim());
    expect(afterUnsub).toEqual({
      jsonrpc: '2.0',
      id: 100,
      error: { code: -32601, message: 'Method not found: myRequest' },
    });
  });

  it('answers unregistered server→client requests with -32601 so the agent does not block', async () => {
    transport.start();

    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 55, method: 'unknownMethod', params: {} }) + '\n');

    await new Promise((resolve) => setTimeout(resolve, 20));

    const responses = sentMsg
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(responses[0]).toEqual({
      jsonrpc: '2.0',
      id: 55,
      error: { code: -32601, message: 'Method not found: unknownMethod' },
    });
  });

  it('does not answer unregistered notifications (no id)', async () => {
    transport.start();

    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'unknownNotification' }) + '\n');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sentMsg).toBe('');
  });

  it('onRequest() registers handler and sends error when handler rejects', async () => {
    transport.start();

    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    transport.onRequest('failRequest', async () => {
      throw new Error('Something went wrong');
    });

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'failRequest' }) + '\n');

    await new Promise((resolve) => setTimeout(resolve, 20));

    const responses = sentMsg
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(responses[0]).toEqual({ jsonrpc: '2.0', id: 101, error: { code: -32000, message: 'Something went wrong' } });
  });

  it('answers unregistered string-id server→client requests with -32601, echoing the string id', async () => {
    transport.start();

    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 'srv-7', method: 'unknownMethod', params: {} }) + '\n');

    await new Promise((resolve) => setTimeout(resolve, 20));

    const responses = sentMsg
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(responses[0]).toEqual({
      jsonrpc: '2.0',
      id: 'srv-7',
      error: { code: -32601, message: 'Method not found: unknownMethod' },
    });
  });

  it('resolves a pending request on a null result', async () => {
    transport.start();

    const p = transport.request('voidMethod');
    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const reqId = JSON.parse(sentMsg.trim()).id;

    input.write(JSON.stringify({ jsonrpc: '2.0', id: reqId, result: null }) + '\n');

    await expect(p).resolves.toBeNull();
  });

  it('uses error.data text when the error object carries no message', async () => {
    transport.start();

    const p = transport.request('m');
    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const reqId = JSON.parse(sentMsg.trim()).id;

    input.write(JSON.stringify({ jsonrpc: '2.0', id: reqId, error: { code: -32000, data: 'session not found' } }) + '\n');

    await expect(p).rejects.toThrow('session not found');
  });

  it('dispose() rejects all pending requests', async () => {
    transport.start();

    const req1 = transport.request('m1');
    const req2 = transport.request('m2');

    transport.dispose();

    await expect(req1).rejects.toThrow('Transport closed');
    await expect(req2).rejects.toThrow('Transport closed');
    expect(transport.isClosed).toBe(true);
  });

  it('dispose() handles input close gracefully', async () => {
    transport.start();
    const req1 = transport.request('m1');

    input.end();

    await expect(req1).rejects.toThrow('JSON-RPC input closed');
    expect(transport.isClosed).toBe(true);
  });

  it('handleLine() ignores empty/invalid JSON', async () => {
    transport.start();
    const handler = vi.fn();
    transport.onNotification('test', handler);

    input.write('\n'); // empty
    input.write('   \n'); // whitespace
    input.write('not a json\n');
    input.write('{"jsonrpc": "2.0", "method": "test"}\n');

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('logs a warning for non-JSON lines and caps it at 5', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    transport.start();
    const handler = vi.fn();
    transport.onNotification('test', handler);

    for (let i = 0; i < 7; i++) {
      input.write(`garbage line ${i}\n`);
    }
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'test' }) + '\n');

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(warnSpy).toHaveBeenCalledTimes(5);
    expect(warnSpy).toHaveBeenCalledWith('[co-ober] non-JSON stdout line dropped:', 'garbage line 0');
    // Valid lines keep dispatching normally after malformed ones
    expect(handler).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('handleLine() dispatches to correct handlers', async () => {
    transport.start();

    const p = transport.request('m');
    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const parsed = JSON.parse(sentMsg.trim());
    const reqId = parsed.id;

    input.write(JSON.stringify({ jsonrpc: '2.0', id: reqId, error: { message: 'Some error' } }) + '\n');

    await expect(p).rejects.toThrow('Some error');
  });

  it('handleLine() ignores unknown errors', async () => {
    transport.start();

    const p = transport.request('m');
    let sentMsg = '';
    output.on('data', (chunk) => {
      sentMsg += chunk.toString();
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const parsed = JSON.parse(sentMsg.trim());
    const reqId = parsed.id;

    input.write(JSON.stringify({ jsonrpc: '2.0', id: reqId, error: {} }) + '\n');

    await expect(p).rejects.toThrow('Unknown error');
  });

  it('catches and logs output write errors', async () => {
    transport.start();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const badOutput = new PassThrough();
    badOutput.write = () => {
      throw new Error('Write failed');
    };

    const badTransport = new AcpJsonRpcTransport({ input, output: badOutput });

    badTransport.notify('m');

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('answers every request inside a JSON-RPC batch frame', async () => {
    transport.start();
    transport.onRequest('batch/echo', (params) => Promise.resolve({ echo: params }));

    let sent = '';
    output.on('data', (chunk) => {
      sent += chunk.toString();
    });

    input.write(
      JSON.stringify([
        { jsonrpc: '2.0', id: 11, method: 'batch/echo', params: { n: 1 } },
        { jsonrpc: '2.0', id: 12, method: 'batch/echo', params: { n: 2 } },
      ]) + '\n',
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toContain('"id":11');
    expect(sent).toContain('"id":12');
  });

  it('resolves every response carried by a batch frame', async () => {
    transport.start();
    const p1 = transport.request<number>('a');
    const p2 = transport.request<number>('b');
    await new Promise((resolve) => setTimeout(resolve, 0));

    input.write(
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, result: 10 },
        { jsonrpc: '2.0', id: 2, result: 20 },
      ]) + '\n',
    );

    await expect(p1).resolves.toBe(10);
    await expect(p2).resolves.toBe(20);
  });
});
